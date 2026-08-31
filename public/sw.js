/* JM Web 离线外壳 Service Worker。
 * 漫画图片由 IndexedDB 显式管理，这里只缓存应用静态资源，绝不缓存登录/API 响应。
 */

'use strict';

const CACHE_VERSION = 'jmw-shell-v5';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/css/app.css',
  '/css/offline.css',
  '/js/booterr.js',
  '/js/api.js',
  '/js/advanced.js',
  '/js/app.js',
  '/js/content-actions.js',
  '/js/content-filter.js',
  '/js/descramble.js',
  '/js/download-view.js',
  '/js/downloads.js',
  '/js/export.js',
  '/js/gate.js',
  '/js/icons.js',
  '/js/md5.js',
  '/js/offline.js',
  '/js/reader.js',
  '/js/reader-settings.js',
  '/js/recommend.js',
  '/js/store.js',
  '/js/ui.js',
  '/js/user.js',
  '/js/views.js',
];

async function precache() {
  const cache = await caches.open(CACHE_VERSION);
  // 外壳文件是一个版本整体：任一核心模块缺失就保留旧 Worker，不能激活
  // 一个刷新后才发现模块 404 的“半套”离线版本。
  await Promise.all(SHELL.map(async (url) => {
    const response = await fetch(url, { cache: 'reload', credentials: 'same-origin' });
    if (!response.ok) throw new Error(`无法预缓存 ${url}（${response.status}）`);
    await cache.put(url, response);
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith('jmw-shell-') && name !== CACHE_VERSION).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'PRECACHE_SHELL') event.waitUntil(precache());
  if (type === 'SKIP_WAITING') self.skipWaiting();
  if (type === 'CLEAR_SHELL_CACHE') event.waitUntil(caches.delete(CACHE_VERSION));
});

async function navigationResponse(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put('/index.html', response.clone()).catch(() => {});
    }
    return response;
  } catch (_) {
    return (await caches.match('/index.html')) || (await caches.match('/')) || Response.error();
  }
}

async function staticResponse(request) {
  const cached = await caches.match(request, { ignoreSearch: false });
  try {
    // 在线时先做 ETag 协商，部署新静态文件后立即生效；断网才回退离线副本。
    // 旧的 cache-first 会在 sw.js 本身未改动时永久返回上一版模块。
    const response = await fetch(request, { cache: 'no-cache' });
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response.ok || !cached ? response : cached;
  } catch (_) {
    return cached || Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // 会话、设置、图片代理一律网络直连；离线正文只从 IndexedDB 读取。
  if (url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;
  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(request));
    return;
  }
  if (/\.(?:js|mjs|css|html|webmanifest|svg|png|jpe?g|webp|gif|ico|woff2?)$/i.test(url.pathname)) {
    event.respondWith(staticResponse(request));
  }
});
