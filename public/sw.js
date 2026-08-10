/* ────────────────────────────────────────────────────────────────────────────
 * Service worker for Field Mode.
 *
 * Field Mode supports limited offline use through three cache strategies:
 *
 *   shell   — the page, styles and scripts. Cache-first, refreshed in the
 *             background.
 *   tiles   — basemap imagery. Cache-first and retained until the cache
 *             version changes.
 *   data    — the member's claim geometry. Network-first with a cached
 *             fallback.
 *
 * Other requests pass through unchanged. API writes are never served from
 * cache.
 * ──────────────────────────────────────────────────────────────────────────── */

const VERSION = 'v3';
const SHELL_CACHE = `nspa-shell-${VERSION}`;
const TILE_CACHE = `nspa-tiles-${VERSION}`;
const DATA_CACHE = `nspa-data-${VERSION}`;

const SHELL_ASSETS = [
  '/field.html',
  '/modules/field.js',
  '/styles/styles.css',
  '/modules/portal.js',
  '/icon.svg',
  '/manifest.webmanifest',
  'https://unpkg.com/leaflet/dist/leaflet.js',
  'https://unpkg.com/leaflet/dist/leaflet.css',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // Cache assets independently so one unavailable CDN asset does not fail installation.
      .then(cache => Promise.allSettled(SHELL_ASSETS.map(url => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith('nspa-') && !k.endsWith(VERSION)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

const isTile = url =>
  /basemaps\.cartocdn\.com|tile\.openstreetmap|server\.arcgisonline\.com|tile\.opentopomap\.org/.test(url.hostname);

const isClaimData = url =>
  url.origin === self.location.origin && url.pathname === '/api/claims/geometry';

const isShell = url =>
  url.origin === self.location.origin &&
  (url.pathname === '/field.html' || url.pathname === '/styles/styles.css' ||
   url.pathname === '/modules/field.js' || url.pathname === '/modules/portal.js' || url.pathname === '/icon.svg' ||
   url.pathname === '/manifest.webmanifest');

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) {
    // Refresh in the background for the next visit.
    fetch(request).then(res => { if (res.ok) cache.put(request, res.clone()); }).catch(() => {});
    return hit;
  }
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (error) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw error;
  }
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch { return; }

  if (isTile(url)) {
    // Tiles use cache-first behavior for offline map access.
    event.respondWith(cacheFirst(request, TILE_CACHE).catch(() => Response.error()));
  } else if (isClaimData(url)) {
    event.respondWith(networkFirst(request, DATA_CACHE));
  } else if (isShell(url)) {
    // Use network-first for shell assets so deployments take effect quickly.
    // Cached shell assets remain available as an offline fallback.
    event.respondWith(networkFirst(request, SHELL_CACHE));
  } else if (request.mode === 'navigate' && url.origin === self.location.origin) {
    // Offline navigation falls back to the offline-capable field page.
    event.respondWith(
      fetch(request).catch(async () => (await caches.match('/field.html')) || Response.error())
    );
  }
});

/* Bulk tile prefetch with progress reporting. */
self.addEventListener('message', event => {
  const msg = event.data || {};
  if (msg.type !== 'cache-tiles') return;

  event.waitUntil((async () => {
    const cache = await caches.open(TILE_CACHE);
    const urls = msg.urls || [];
    let done = 0;
    let failed = 0;

    // Small batches avoid long stalls on weak connections.
    const BATCH = 6;
    for (let i = 0; i < urls.length; i += BATCH) {
      await Promise.all(urls.slice(i, i + BATCH).map(async url => {
        try {
          if (await cache.match(url)) { done++; return; }
          const res = await fetch(url, { mode: 'no-cors' });
          await cache.put(url, res);
          done++;
        } catch {
          failed++;
        }
      }));
      const clients = await self.clients.matchAll();
      clients.forEach(c => c.postMessage({ type: 'cache-progress', done, failed, total: urls.length }));
    }

    const clients = await self.clients.matchAll();
    clients.forEach(c => c.postMessage({ type: 'cache-complete', done, failed, total: urls.length }));
  })());
});
