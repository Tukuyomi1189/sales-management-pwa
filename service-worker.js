/* Service worker: caches the app shell so the app works fully offline. */

const CACHE_VERSION = 'v18';
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
  './js/register.js',
  './js/history.js',
  './js/settings.js',
  './js/reports.js',
  './js/settlement.js',
  './js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/favicon-64.png',
];

// Each CACHE_VERSION is an atomic snapshot of the app: every file in it comes from the
// same deploy. Two rules keep it that way (mixing old and new files breaks the app, e.g.
// a new register.js calling a db.js function the old db.js doesn't have):
//   1. Precache with `cache: 'reload'` so files come from the server, not from the
//      browser's HTTP cache (GitHub Pages lets browsers reuse files for 10 minutes, so a
//      plain addAll right after a deploy can store the PREVIOUS version's files).
//   2. Never rewrite an existing version's cache in the background; a new deploy reaches
//      users only through a new CACHE_VERSION → new service worker → 「新しいバージョン」
//      banner → reload, which swaps every file at once.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS.map((url) => new Request(url, { cache: 'reload' }))))
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

  // Navigations: serve the app shell from THIS version's cache so the HTML always matches
  // the cached JS/CSS. (Serving fresh HTML from the network next to cached scripts is what
  // produced half-updated screens.) The browser still checks service-worker.js on every
  // navigation, and app.js calls registration.update() when the app comes to the front.
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.open(CACHE_NAME)
        .then((cache) => cache.match('./index.html'))
        .then((cached) => cached || fetch(request))
    );
    return;
  }

  // Other assets: cache-first. Anything not precached (rare) is fetched once and added.
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response && response.ok) cache.put(request, response.clone());
          return response;
        });
      })
    )
  );
});
