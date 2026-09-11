const VERSION = 'sandlock-pwa-v1.1.0-accountsync24h';
const STATIC_CACHE = `${VERSION}-static`;
const RUNTIME_CACHE = `${VERSION}-runtime`;
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './config.js',
  './app.js?v=accountsync24h-1',
  './pwa.js',
  './manifest.webmanifest',
  './assets/beach-map.png',
  './assets/beach-map-portrait.png',
  './assets/locker-map.png',
  './assets/locker-concept.png',
  './assets/beach-map-dynamic.png',
  './assets/beach-map-base.png',
  './assets/locker-closed.png',
  './assets/mindforge-logo.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
  './icons/icon-180.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(STATIC_CACHE).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => ![STATIC_CACHE, RUNTIME_CACHE].includes(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Navigation: network-first so updates are picked up, with offline shell fallback.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(RUNTIME_CACHE).then(c => c.put('./index.html', copy));
        return res;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Same-origin assets: cache-first, background refresh.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then(cached => {
        const refresh = fetch(req).then(res => {
          if (res && res.ok) caches.open(RUNTIME_CACHE).then(c => c.put(req, res.clone()));
          return res;
        }).catch(() => cached);
        return cached || refresh;
      })
    );
    return;
  }

  // External dependencies (MQTT.js): network-first and retain a successful copy for reloads.
  if (url.hostname === 'unpkg.com') {
    event.respondWith(
      fetch(req).then(res => {
        caches.open(RUNTIME_CACHE).then(c => c.put(req, res.clone()));
        return res;
      }).catch(() => caches.match(req))
    );
  }
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});
