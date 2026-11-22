/**
 * SmartFurniture v8.0 — Service Worker 100 % Offline (PWA)
 * En build de producción, `smartFurniturePwaPrecachePlugin` (vite.config.ts)
 * inyecta automáticamente `CACHE_NAME` con hash determinista y la lista
 * completa `PRECACHE_URLS` (HTML, manifest, icon, todos los ./assets/* y las 14 ./ejemplos/*).
 */
const CACHE_NAME = '__SW_CACHE_NAME__'.includes('__')
  ? 'smartfurniture-pwa-v80-dev'
  : '__SW_CACHE_NAME__';
const PRECACHE_URLS = /* __SW_PRECACHE_MANIFEST__ */ [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const cacheInBackground = (request, response) => {
    if (response && response.ok && response.type === 'basic') {
      const clone = response.clone();
      event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone)),
      );
    }
  };

  // Navegación HTML: network-first con fallback instantáneo a ./index.html en caché
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          cacheInBackground(req, resp);
          return resp;
        })
        .catch(async () => {
          const cachedNav = await caches.match(req);
          if (cachedNav) return cachedNav;
          const fallback = await caches.match('./index.html');
          if (fallback) return fallback;
          return new Response(
            'SmartFurniture v8.0 sin conexión: recurso aún no almacenado en caché.',
            {
              status: 503,
              headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            },
          );
        }),
    );
    return;
  }

  // Recursos estáticos (JS, CSS, imágenes, SVG, JSON): cache-first con respaldo de red
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        return cached;
      }
      return fetch(req)
        .then((resp) => {
          cacheInBackground(req, resp);
          return resp;
        })
        .catch(
          () =>
            new Response(
              'SmartFurniture v8.0 sin conexión: recurso aún no almacenado en caché.',
              {
                status: 503,
                headers: { 'Content-Type': 'text/plain; charset=utf-8' },
              },
            ),
        );
    }),
  );
});
