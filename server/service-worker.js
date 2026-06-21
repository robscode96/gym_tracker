// Generates the service worker source with the current build version baked in.
// Because the build id changes on each deploy, the bytes of this file change,
// the browser detects an update on launch, and the new version activates +
// reloads automatically (see public/js/app.js).

export function serviceWorker(build) {
  return `// Gym Tracker service worker — build ${build}
const VERSION = ${JSON.stringify(build)};
const CACHE = 'gym-' + VERSION;
const ASSETS = [
  '/', '/index.html',
  '/css/styles.css',
  '/js/api.js', '/js/ui.js', '/js/charts.js', '/js/app.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {}));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // API calls always hit the network (never cached).
  if (url.pathname.startsWith('/api/')) return;
  // App navigations: network-first, fall back to cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/index.html')));
    return;
  }
  // Other static assets: cache-first with background refresh.
  event.respondWith(caches.match(req).then((cached) => {
    const network = fetch(req).then((resp) => {
      if (resp && resp.status === 200) {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return resp;
    }).catch(() => cached);
    return cached || network;
  }));
});
`;
}
