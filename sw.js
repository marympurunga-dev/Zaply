const CACHE = 'zucket-v8';
const SHELL = ['/', '/manifest.json', '/icon-192.png', '/icon-512.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
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
  // the app itself: open straight from the saved copy (even with mobile data on but no bundle), refresh it in the background
  const isPage = req.mode === 'navigate';
  const key = isPage ? '/' : req;
  e.respondWith(caches.open(CACHE).then((c) => c.match(key, { ignoreSearch: isPage }).then((hit) => {
    const net = fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') c.put(key, res.clone());
      return res;
    });
    if (hit) { net.catch(() => {}); return hit; }
    return net.catch(() => caches.match('/'));
  })));
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch (x) {}
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
      if (cs.some((c) => c.visibilityState === 'visible')) return; // app is open: no popup needed
      return self.registration.showNotification(d.title || 'Zucket', {
        body: d.body || 'New message',
        icon: '/icon-192.png', badge: '/icon-badge.png',
        tag: d.tag || 'zaply', renotify: true, vibrate: [200, 100, 200], silent: false, requireInteraction: false, data: { from: d.from || '' },
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
