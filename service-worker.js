/* Service worker: caches the app shell so the app works fully offline. */

const CACHE_VERSION = 'v11';
const CACHE_NAME = `sales-management-shell-${CACHE_VERSION}`;

// Must match the SDK_VERSION constant in js/firebase-init.js. Each of these 3
// files is a self-contained bundle that only imports firebase-app.js
// internally (checked directly against the CDN) — no further sub-chunk URLs
// to track, so precaching exactly these makes the SDK available offline
// starting from the very first successful load, not just the second one.
const FIREBASE_SDK_VERSION = '12.16.0';
const FIREBASE_SDK_BASE = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;
const RUNTIME_CACHE_ORIGINS = ['https://www.gstatic.com'];

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/firebase-init.js',
  `${FIREBASE_SDK_BASE}/firebase-app.js`,
  `${FIREBASE_SDK_BASE}/firebase-auth.js`,
  `${FIREBASE_SDK_BASE}/firebase-firestore.js`,
  './js/db.js',
  './js/router.js',
  './js/products.js',
  './js/customers.js',
  './js/sales.js',
  './js/reports.js',
  './js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/favicon-64.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('sales-management-shell-') && key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  const requestOrigin = new URL(request.url).origin;
  const isCacheableOrigin = requestOrigin === self.location.origin || RUNTIME_CACHE_ORIGINS.includes(requestOrigin);

  // Only handle GET requests to same-origin or explicitly allow-listed origins; let everything else pass through.
  if (request.method !== 'GET' || !isCacheableOrigin) {
    return;
  }

  // Navigations: try network first (to pick up updates), fall back to cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Other assets: cache-first, then update the cache from the network in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});
