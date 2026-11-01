// sw.js - SafeHer Service Worker with relative caching for GitHub Pages subfolders

var CACHE_NAME = 'safeher-v3';
var ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
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
  './assets/logo.png',
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
  // Let external requests (e.g. tile server, fonts, cdn) go through network with cache fallback
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(function(cachedResponse) {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).then(function(networkResponse) {
        return networkResponse;
      }).catch(function() {
        return caches.match('./index.html');
      });
    })
  );
});
