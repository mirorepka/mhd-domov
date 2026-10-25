// Aplikácia funguje aj bez internetu: keď je internet, berie sa vždy najnovšia verzia
// (aj cestovný poriadok); keď nie je, použije sa posledná uložená.
const CACHE = 'bus-domov-v8';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'data/network.json', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'kamarat/', 'kamarat/index.html', 'kamarat/manifest.webmanifest'];
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const network = fetch(e.request, { cache: 'no-cache' }).then((res) => {
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    });
    const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS));
    try {
      const res = await Promise.race([network, timeout]);
      if (res) return res;
    } catch { /* bez internetu */ }
    return (await cache.match(e.request)) || network;
  })());
});
