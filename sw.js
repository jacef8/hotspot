// HOTSPOT Service Worker v3.5.2 — PWA shell
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
const VERSION = 'v3.5.2';
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

// The pinned libraries and fonts the page loads from CDNs: the scripts carry
// a fixed version in their path and the font files never change, so a cached
// copy is always the one asked for. Nothing live is on this list: the
// database, PeerJS signalling and map tiles are never touched.
function isPinnedLibrary(url) {
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return true;
  if (url.hostname === 'unpkg.com' || url.hostname === 'cdn.jsdelivr.net') return /@\d/.test(url.pathname);
  if (url.hostname === 'www.gstatic.com') return url.pathname.startsWith('/firebasejs/');
  return false;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only same-origin GETs and the pinned libraries above.
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  const sameOrigin = url.origin === self.location.origin;
  const library = !sameOrigin && isPinnedLibrary(url);
  if (!sameOrigin && !library) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        // Cache under the full URL including its ?v= query, so a hit can only
        // ever be the exact build that asked for it. A library script loaded
        // by a plain <script> tag comes back opaque (no status to read); it
        // is kept too, and only ever used when the network fails outright.
        if (res && (res.ok || (library && res.type === 'opaque'))) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
