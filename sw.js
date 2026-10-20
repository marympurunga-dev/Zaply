const CACHE = 'zanply-v11';
const PREFS = 'zanply-prefs';
const SHELL = ['/', '/manifest.json', '/icon-192.png', '/icon-512.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== PREFS).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const same = url.origin === location.origin;
  // live data (messages, profiles, codes) always goes to the network; the app handles being offline itself
  if (same && url.pathname.startsWith('/api/')) return;
  // profile pictures: keep a copy so they still show with no internet
  if (!same) {
    if (url.hostname === 'res.cloudinary.com' && req.destination === 'image') {
      e.respondWith(caches.open(CACHE).then((c) => c.match(req).then((hit) => {
        const net = fetch(req).then((res) => { if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone()); return res; }).catch(() => hit);
        return hit || net;
      })));
    }
    return;
  }
  const isPage = req.mode === 'navigate';
  const key = isPage ? '/' : req;
  // the app page: ask the network first (so a new version shows up straight away), fall back to the saved copy
  // when there is no internet or the connection is too slow
  if (isPage) {
    e.respondWith(caches.open(CACHE).then((c) => {
      const net = fetch(req).then((res) => { if (res.ok && res.type === 'basic') c.put(key, res.clone()); return res; });
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 3500));
      return Promise.race([net, timeout]).catch(() => c.match(key, { ignoreSearch: true }).then((hit) => hit || net.catch(() => caches.match('/'))));
    }));
    return;
  }
  // other files: open straight from the saved copy and refresh it in the background
  e.respondWith(caches.open(CACHE).then((c) => c.match(key).then((hit) => {
    const net = fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') c.put(key, res.clone());
      return res;
    });
    if (hit) { net.catch(() => {}); return hit; }
    return net.catch(() => caches.match('/'));
  })));
});

function readPrefs() {
  return caches.open(PREFS).then((c) => c.match('/__prefs')).then((r) => (r ? r.json() : {})).catch(() => ({}));
}
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch (x) {}
  e.waitUntil(
    Promise.all([self.clients.matchAll({ type: 'window', includeUncontrolled: true }), readPrefs()]).then(([cs, P]) => {
      if (cs.some((c) => c.visibilityState === 'visible')) return; // app is open: no popup needed
      if (P.popup === 'off') return;
      return self.registration.showNotification(d.title || 'Zanply', {
        body: d.body || 'New message',
        icon: '/icon-192.png', badge: '/icon-badge.png',
        tag: d.tag || 'zaply', renotify: true,
        vibrate: Array.isArray(P.vib) ? P.vib : [200, 100, 200],
        silent: !!P.silent, requireInteraction: false, data: { from: d.from || '' },
      });
    })
  );
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const from = (e.notification.data && e.notification.data.from) || '';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
      if (cs.length) { cs[0].postMessage({ openChat: from }); return cs[0].focus(); }
      return self.clients.openWindow('/?chat=' + encodeURIComponent(from));
    })
  );
});
