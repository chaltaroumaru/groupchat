'use strict';

// アプリ本体(HTML / JS / CSS / アイコン)だけをキャッシュする。
// チャットの内容や画像(/api)は権限確認が必要なためキャッシュしない。
const CACHE = 'groupchat-shell-v1';
const SHELL = ['/', '/app.js', '/style.css', '/socket.io/socket.io.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png'];

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
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function isShell(url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith('/api/')) return false;
  if (url.pathname.startsWith('/socket.io/')) return url.pathname === '/socket.io/socket.io.js';
  return true;
}

// ネットワーク優先(最新版を使う)、圏外のときだけキャッシュを返す
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!isShell(url)) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req.mode === 'navigate' ? '/' : req, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(req.mode === 'navigate' ? '/' : req)) || Response.error()),
  );
});
