// KanaGrid Service Worker — SPDX-License-Identifier: MIT

// この値は手で変更しない。GitHub Pages への公開時に scripts/build-pages.js が
// 'kanagrid-<コミットの短縮ハッシュ>' に置き換える（.github/workflows/deploy-pages.yml）。
const CACHE_NAME = 'kanagrid-a9cb29e';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './dict.js',
  './app.js',
  './manifest.json',
  './icon.svg',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

// 新しい版は install 後に待機（waiting）し、旧版で開いている画面がすべて閉じられた後（次回起動時）に有効になる。
// 会話中の画面が突然切り替わらないよう、skipWaiting() は呼ばない。
// 取得はブラウザの HTTP キャッシュを通さない（cache: 'reload'）。GitHub Pages は max-age=600 で配信するため、
// HTTP キャッシュを使うと、公開直前に開いていた端末で新しい版のキャッシュに古いファイルが入ってしまう。
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' })))
    )
  );
});

// 設定画面の「今すぐ更新する」が押されたときだけ、待機中の新しい版にすぐ切り替える
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  // 外部オリジン（公開版の Cloudflare Web Analytics 等）はキャッシュせず、ブラウザに任せる
  if (new URL(event.request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request)
        .then((networkResponse) => {
          if (
            networkResponse &&
            networkResponse.status === 200 &&
            networkResponse.type === 'basic'
          ) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return new Response('', { status: 503, statusText: 'Offline' });
        });
    })
  );
});
