const CACHE_NAME = 'mxdev-swiss-tool-v1.15.1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Basic core resources to cache
      return cache.addAll([
        '/',
        '/index.html',
        '/styles/main.css',
        '/js/core.js',
        '/js/components/command-palette.js',
        '/js/vendor/chart.js',
        '/js/vendor/mermaid.min.js',
        '/logo.png'
      ]).catch(err => {
        console.warn('Install caching failed:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Network-first strategy for dynamic tool loading, fallback to cache
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;

  const url = new URL(event.request.url);
  // Only cache standard HTTP/HTTPS requests
  const isHttp = url.protocol === 'http:' || url.protocol === 'https:';
  // Skip caching local Node bridge API endpoints. /status and /update/* must
  // always hit the network: the update flow polls them to detect the bridge
  // restarting with a new version, and a cached copy would report stale data.
  const isApi = url.pathname === '/detect-project' ||
                url.pathname === '/postgres' ||
                url.pathname === '/m2ee' ||
                url.pathname === '/logs' ||
                url.pathname === '/status' ||
                url.pathname === '/mock-config' ||
                url.pathname === '/project-insights' ||
                url.pathname === '/prometheus' ||
                url.pathname.startsWith('/otel/') ||
                url.pathname.startsWith('/update/') ||
                url.pathname.startsWith('/api/');

  if (!isHttp || isApi) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200 && (response.type === 'basic' || response.type === 'cors')) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, clone).catch(err => {
              console.warn('SW cache put error:', err);
            });
          });
        }
        return response;
      })
      .catch(async () => {
        const cachedResponse = await caches.match(event.request);
        if (cachedResponse) {
          return cachedResponse;
        }
        // If not in cache and network failed, return standard 404 Response instead of undefined
        return new Response('Resource offline or unavailable', {
          status: 404,
          statusText: 'Not Found',
          headers: { 'Content-Type': 'text/plain' }
        });
      })
  );
});
