// HOTSPOT Service Worker v2.7.0 — PWA shell
//
// This app is useless without a network (it syncs live positions between
// phones), so there is no meaningful offline mode to precache for. The previous
// version precached unversioned paths like './app.js' while the page actually
// requests './app.js?v=2.6.4' — different cache keys, so the fallback never
// matched. The precache was dead weight that could only ever serve stale code.
//
// What remains is what is actually wanted: a registered worker so the app is
// installable to the home screen, network-first for everything, and a
// version-scoped cache used only when the network fails outright.
const VERSION = 'v2.7.0';
const CACHE_NAME = 'hotspot-' + VERSION;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only ever touch same-origin GETs. Never interfere with the Firebase
  // Realtime Database socket, PeerJS signalling, or map tiles.
  if (req.method !== 'GET') return;
  let sameOrigin = false;
  try { sameOrigin = new URL(req.url).origin === self.location.origin; } catch (e) { return; }
  if (!sameOrigin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        // Cache under the full URL including its ?v= query, so a hit can only
        // ever be the exact build that asked for it.
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
