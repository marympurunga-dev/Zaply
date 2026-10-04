const CACHE = 'zaply-v3';
const SHELL = ['/', '/manifest.json', '/icon-192.png', '/icon-512.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match('/')))
  );
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch (x) {}
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
      if (cs.some((c) => c.visibilityState === 'visible')) return; // app is open: no popup needed
      return self.registration.showNotification(d.title || 'Zaply', {
        body: d.body || 'New message',
        icon: '/icon-192.png', badge: '/icon-192.png',
        tag: d.tag || 'zaply', renotify: true, data: { from: d.from || '' },
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
