// HOTSPOT Service Worker v2.5.15 — PWA Standalone Engine
const CACHE_NAME = 'hotspot-v2.5.15';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './geo.js',
  './audio.js',
  './replay.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Network first fallback to cache for static assets
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
