/**
 * Minimal Service Worker for offline HLS playback.
 * Intercepts fetch requests to /offline-hls/* and serves matching
 * segments from the 'offline-media' Cache API store.
 */
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/offline-hls/')) {
    const cacheKey = url.pathname.slice('/offline-hls/'.length);
    event.respondWith(
      caches.open('offline-media').then(async (cache) => {
        const resp = await cache.match(cacheKey);
        if (resp) return resp;
        return new Response('Not found in offline cache', { status: 404 });
      })
    );
  }
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
