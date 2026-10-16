'use strict';

// 屋台 POS の画面だけをキャッシュする(圏外やサーバー停止中でも開けるように)。
// 会計は POS が端末内に保存して、つながったときに自動で送信する。
const CACHE = 'yatai-pos-v1';
const SHELL = ['/pos/', '/socket.io/socket.io.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('yatai-pos-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// ネットワーク優先(最新版を使う)、つながらないときだけキャッシュを返す
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const key = req.mode === 'navigate' ? '/pos/' : url.pathname === '/socket.io/socket.io.js' ? req : null;
  if (!key) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(key, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(key)) || Response.error()),
  );
});
