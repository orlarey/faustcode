// apps/sw.js — the service worker of the apps faustcode installs
// (the pwa button of the run view, pwa-export.js : installPwaApp).
//
// Its scope is this directory (…/faustcode/apps/) : the pages of faustcode
// do not go through it. faustcode writes the files of each app to the cache
// `faustcode-apps`, at apps/<id>/… ; this worker serves them from there, so
// an app is a page of this origin, installable, and runs offline. The
// service worker of the PWA template is not used here : a browser fetches
// the script of a service worker from the network, never from a cache.

const CACHE = 'faustcode-apps';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  if (url.pathname === new URL('sw.js', scope).pathname) return;
  event.respondWith(serve(url));
});

async function serve(url) {
  const cache = await caches.open(CACHE);
  const path = url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname;
  const hit = await cache.match(url.origin + path);
  if (hit) return hit;
  // apps/<id> : the app is at apps/<id>/
  if (!/\.[A-Za-z0-9]+$/.test(path) && (await cache.match(`${url.origin}${path}/index.html`))) {
    return Response.redirect(`${url.origin}${path}/`, 301);
  }
  return new Response(`Not an app installed by faustcode : ${url.pathname}\n`, {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
