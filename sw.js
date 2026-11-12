// sw.js - SafeHer Service Worker with offline caching for GitHub Pages
var CACHE_NAME = 'safeher-v92';

var ASSETS = [
  './',
  './index.html',
  './offline.html',
  './track.html',
  './admin.html',
  './privacy.html',
  './404.html',
  './manifest.json',
  './manifest.webmanifest',
  './css/style.css',
  './js/config.js',
  './js/storage.js',
  './js/api.js',
  './js/i18n.js',
  './js/helpdata.js',
  './js/help_rights.js',
  './js/app.js',
  './js/onboarding.js',
  './js/auth.js',
  './js/pin.js',
  './js/home.js',
  './js/contacts.js',
  './js/tips.js',
  './js/profile.js',
  './js/sos.js',
  './js/map.js',
  './js/share_location.js',
  './js/police.js',
  './js/places.js',
  './js/ride.js',
  './js/volunteer.js',
  './js/volunteer-apply.js',
  './js/timer.js',
  './js/fakecall.js',
  './js/evidence.js',
  './js/vault.js',
  './js/escort.js',
  './js/notifications.js',
  './js/pocket_guard.js',
  './js/live_sentinel.js',
  './assets/logo.png',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-maskable.png',
  './assets/onboard1.svg',
  './assets/onboard2.svg',
  './assets/onboard3.svg',
  './assets/success.svg'
];

self.addEventListener('install', function(event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return Promise.allSettled(
        ASSETS.map(function(url) {
          return fetch(new Request(url, { cache: 'reload' })).then(function(response) {
            if (response && response.ok) {
              return cache.put(url, response);
            }
          }).catch(function(err) {
            console.warn('[SW] Pre-cache failed for', url, err);
          });
        })
      );
    })
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; }).map(function(k) {
          console.log('[SW] Deleting stale cache:', k);
          return caches.delete(k);
        })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(event) {
  if (event.request.method !== 'GET') return;

  var url = new URL(event.request.url);

  // Never cache backend API calls or live location/places APIs
  if (
    url.pathname.includes('/api/') ||
    url.pathname.endsWith('/api') ||
    url.hostname.includes('overpass') ||
    url.hostname.includes('nominatim')
  ) {
    return;
  }

  // Navigation requests: Network-first with mobile timeout, fallback to cached index.html
  if (event.request.mode === 'navigate') {
    event.respondWith(
      new Promise(function(resolve, reject) {
        var didRespond = false;
        var timeoutId = setTimeout(function() {
          if (!didRespond) {
            didRespond = true;
            caches.match(event.request, { ignoreSearch: true }).then(function(match) {
              if (match) return resolve(match);
              return caches.match('./index.html', { ignoreSearch: true }).then(function(idxMatch) {
                if (idxMatch) return resolve(idxMatch);
                return caches.match('./', { ignoreSearch: true }).then(function(rootMatch) {
                  if (rootMatch) return resolve(rootMatch);
                  return caches.match('./offline.html', { ignoreSearch: true }).then(function(offMatch) {
                    if (offMatch) return resolve(offMatch);
                    reject(new Error('Offline fallback failed'));
                  });
                });
              });
            }).catch(reject);
          }
        }, 3500);

        fetch(event.request).then(function(response) {
          if (!didRespond) {
            didRespond = true;
            clearTimeout(timeoutId);
            if (response && response.status === 200) {
              var copy = response.clone();
              caches.open(CACHE_NAME).then(function(cache) {
                cache.put(event.request, copy);
                cache.put('./index.html', copy.clone());
              });
            }
            resolve(response);
          }
        }).catch(function(err) {
          if (!didRespond) {
            didRespond = true;
            clearTimeout(timeoutId);
            caches.match(event.request, { ignoreSearch: true }).then(function(response) {
              if (response) return resolve(response);
              return caches.match('./index.html', { ignoreSearch: true }).then(function(indexMatch) {
                if (indexMatch) return resolve(indexMatch);
                return caches.match('./', { ignoreSearch: true }).then(function(rootMatch) {
                  if (rootMatch) return resolve(rootMatch);
                  return caches.match('./offline.html', { ignoreSearch: true }).then(function(offMatch) {
                    if (offMatch) return resolve(offMatch);
                    reject(err);
                  });
                });
              });
            }).catch(function() {
              reject(err);
            });
          }
        });
      })
    );
    return;
  }

  // Static CSS & JS: Network-first to always reflect updates immediately, cache fallback for offline
  if (url.pathname.endsWith('.css') || url.pathname.endsWith('.js')) {
    event.respondWith(
      fetch(event.request).then(function(networkResponse) {
        if (networkResponse && networkResponse.status === 200) {
          var copy = networkResponse.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, copy);
          });
        }
        return networkResponse;
      }).catch(function() {
        return caches.match(event.request, { ignoreSearch: true });
      })
    );
    return;
  }

  // Other static assets (images, icons, fonts): Cache-first with network fallback
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(function(cachedResponse) {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).then(function(networkResponse) {
        if (networkResponse && networkResponse.status === 200) {
          var copy = networkResponse.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, copy);
          });
        }
        return networkResponse;
      }).catch(function() {
        if (event.request.destination === 'document') {
          return caches.match('./offline.html', { ignoreSearch: true });
        }
      });
    })
  );
});

// ─── Web Push Event Handling ─────────────────────────────────
self.addEventListener('push', function(event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'SafeHer Alert', body: event.data ? event.data.text() : 'Emergency Notification' };
  }

  var title = data.title || 'SafeHer Alert';
  var isSilent = !!data.silent;
  var options = {
    body: data.body || 'Emergency notification received.',
    icon: './assets/logo.png',
    badge: './assets/logo.png',
    silent: isSilent,
    vibrate: isSilent ? [] : [200, 100, 200],
    tag: data.tag || ('safeher-alert-' + Date.now()),
    renotify: true,
    data: {
      screen: (data.data && data.data.screen) || 'home',
      url: './',
      alert_id: data.data && data.data.alert_id
    }
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ─── Notification Click Handling ─────────────────────────────
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var notifData = event.notification.data || {};
  var targetScreen = notifData.screen || 'home';
  var targetUrl = './?screen=' + encodeURIComponent(targetScreen);

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(windowClients) {
      // Focus existing open app window and route to target screen
      for (var i = 0; i < windowClients.length; i++) {
        var client = windowClients[i];
        if (client.url && 'focus' in client) {
          client.postMessage({ type: 'NAVIGATE_SCREEN', screen: targetScreen });
          return client.focus();
        }
      }
      // If no window is open, launch a new window to the screen
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
