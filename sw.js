/* Sentry Box Weekly Planner — offline worker.
   ----------------------------------------------------------------------
   Its only job is to let the app open without a connection. It is
   deliberately NETWORK-FIRST for the planner itself: when you are online
   you always get the version that is on GitHub, and the cached copy is
   only a fallback for when the network is slow or absent. A cache-first
   worker would be faster but could strand a phone on an old version of
   the planner, which is far worse than a second's wait.

   It never touches Microsoft sign-in or OneDrive requests, and no planner
   data is stored here — your data lives in the app's own storage and in
   your OneDrive sync file, never in this cache.
   ---------------------------------------------------------------------- */

const CACHE = 'sb-planner-app-v1-20';
const SHELL = ['./', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

// Take over straight away so a new version is in charge on the next open,
// rather than waiting for every tab to be closed first.
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* An escape hatch: the page can tell this worker to stand down and wipe its
   caches, so a bad cache can always be cleared without uninstalling. */
self.addEventListener('message', e => {
  if (e.data === 'sb-sw-reset') {
    e.waitUntil(
      caches.keys()
        .then(keys => Promise.all(keys.map(k => caches.delete(k))))
        .then(() => self.registration.unregister())
    );
  }
});

const FONT_HOSTS = /(^|\.)fonts\.(googleapis|gstatic)\.com$/;

self.addEventListener('fetch', e => {
  const req = e.request;

  // Only ever deal with plain GETs. Anything that changes something on a
  // server must go straight to the network, untouched.
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  if (url.origin !== self.location.origin) {
    // Fonts are versioned and immutable, so serving them from cache is safe
    // and makes the app usable offline.
    if (FONT_HOSTS.test(url.hostname)) {
      e.respondWith(
        caches.match(req).then(hit => hit || fetch(req).then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
          }
          return res;
        }).catch(() => hit))
      );
    }
    // Everything else off-origin — Microsoft sign-in, Graph, OneDrive — is
    // left completely alone. Intercepting any of it would break sign-in.
    return;
  }

  const isPage = req.mode === 'navigate';

  e.respondWith((async () => {
    // Network first, with a short leash so a dead connection doesn't hang
    // the app waiting for a timeout.
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), isPage ? 6000 : 10000);
      // Going network-first is not enough on its own: this fetch would still
      // be answered by the browser's own HTTP cache, and GitHub Pages marks
      // pages cacheable for several minutes. A phone reopened inside that
      // window would keep getting the old planner and look like it had not
      // updated. For the page itself, ask for a fresh copy explicitly.
      // A navigation Request cannot be re-wrapped, so build a plain one.
      const hit = isPage
        ? fetch(new Request(req.url, { cache: 'reload', credentials: 'same-origin' }), { signal: ctrl.signal })
        : fetch(req, { signal: ctrl.signal });
      const res = await hit;
      clearTimeout(timer);
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (_) {
      // Offline or too slow: fall back to whatever we have.
      const hit = await caches.match(req);
      if (hit) return hit;
      if (isPage) {
        const shell = await caches.match('./');
        if (shell) return shell;
      }
      return new Response('Offline, and this part has not been saved for offline use.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  })());
});
