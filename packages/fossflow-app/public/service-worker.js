// The build replaces these markers with actual files and their content version.
const PRECACHE_FILES = /* precache-manifest */ [];
const VERSION = /* precache-version */ 'unbuilt';
const SCOPE = new URL(self.registration.scope);
const CACHE_PREFIX = `fossflow:${SCOPE.href}:`;
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;
const ASSETS = new Set(PRECACHE_FILES.map(path => new URL(path, SCOPE).href));
const INDEX_URL = new URL('index.html', SCOPE).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    // Never install the unbuilt template or obsolete hard-coded bundle names.
    if (!ASSETS.has(INDEX_URL)) throw new Error('Missing build precache manifest');
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll([...ASSETS].map(url => new Request(url, { cache: 'reload' })));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== SCOPE.origin ||
      !url.pathname.startsWith(SCOPE.pathname)) return;

  // Only the generated static files belong in this cache, never API/user data.
  url.search = '';
  const isAppNavigation = request.mode === 'navigate' &&
    (url.href === SCOPE.href || url.href === INDEX_URL);
  const assetUrl = isAppNavigation ? INDEX_URL : url.href;
  if (!ASSETS.has(assetUrl)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Navigation stays current online; immutable build assets remain cache-first.
    if (!isAppNavigation) {
      const cached = await cache.match(assetUrl);
      if (cached) return cached;
    }
    try {
      // Do not replace versioned precache contents with another deployment.
      return await fetch(request);
    } catch (error) {
      const cached = await cache.match(assetUrl);
      if (cached) return cached;
      throw error;
    }
  })());
});
