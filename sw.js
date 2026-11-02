// sw.js - SafeHer Service Worker with offline caching for GitHub Pages
var CACHE_NAME = 'safeher-v9';
var ASSETS = [
  './',
  './index.html',
  './offline.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/config.js',
  './js/storage.js',
  './js/api.js',
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
  './js/police.js',
  './js/volunteer.js',
  './js/timer.js',
  './js/fakecall.js',
  './js/i18n.js',
  './js/evidence.js',
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
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return Promise.allSettled(
        ASSETS.map(function(url) {
          return cache.add(url);
        })
      );
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; }).map(function(k) {
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

  // Navigation requests: try network, fall back to cached shell or offline fallback page
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(function() {
        return caches.match(event.request).then(function(response) {
          if (response) return response;
          return caches.match('./index.html').then(function(indexMatch) {
            return indexMatch || caches.match('./offline.html');
          });
        });
      })
    );
    return;
  }

  // Static assets: cache-first with network fallback
  event.respondWith(
    caches.match(event.request).then(function(cachedResponse) {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).then(function(networkResponse) {
        return networkResponse;
      }).catch(function() {
        if (event.request.destination === 'document') {
          return caches.match('./offline.html');
        }
      });
    })
  );
});
