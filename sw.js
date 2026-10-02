const CACHE_PREFIX = `yeloroute-shell-${new URL('./', self.location.href).pathname}-`;
const CACHE = `${CACHE_PREFIX}v8`;
const SHELL = ['./', './index.html', './app.js', './routing-core.js', './styles.css', './icon.svg', './truck.svg', './manifest.webmanifest', './vendor/leaflet.js', './vendor/leaflet.css'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE).map(key => caches.delete(key))))));
// Never cache or prefetch external map tiles. Offline mode covers the local UI only.
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  if (new URL(event.request.url).pathname.startsWith('/api/')) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
