/* Afterglow service worker: makes the site installable and usable offline.
   Bump VERSION whenever you deploy changed files so visitors get the new ones. */
const VERSION = 'afterglow-v6';
const CORE = ['./', 'index.html', 'styles.css', 'js/gl.js', 'js/audio.js', 'js/app.js', 'manifest.webmanifest', 'logo.png', 'icons/favicon.png', 'icons/favicon-32.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url), fonts = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (url.origin !== location.origin && !fonts) return;
  // network first for our own files (so updates show up), cache first for fonts; fall back to cache when offline
  e.respondWith((async () => {
    const cache = await caches.open(VERSION), hit = await cache.match(req, { ignoreSearch: true });
    if (fonts && hit) return hit;
    try { const res = await fetch(req); if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()); return res; }
    catch (err) { return hit || (req.mode === 'navigate' ? cache.match('index.html') : Response.error()); }
  })());
});
