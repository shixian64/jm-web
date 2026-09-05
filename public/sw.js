/* JM Web 离线外壳 Service Worker。
 * 漫画图片由 IndexedDB 显式管理，这里只缓存应用静态资源，绝不缓存登录/API 响应。
 */

'use strict';

const CACHE_VERSION = 'jmw-shell-v12';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/css/app.css',
  '/css/favorites.css',
  '/css/offline.css',
  '/js/booterr.js',
  '/js/api.js',
  '/js/advanced.js',
  '/js/app.js',
  '/js/content-actions.js',
  '/js/content-filter.js',
  '/js/descramble-core.js',
  '/js/descramble.js',
  '/js/descramble-worker.js',
  '/js/download-view.js',
  '/js/downloads.js',
  '/js/export.js',
  '/js/gate.js',
  '/js/icons.js',
  '/js/md5.js',
  '/js/navigation.js',
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
  const stagingName = `${CACHE_VERSION}-staging`;
  const existingNames = await caches.keys();
  const targetExisted = existingNames.includes(CACHE_VERSION);
  await caches.delete(stagingName).catch(() => {});
  try {
    const responses = await Promise.all(SHELL.map(async (url) => {
      const response = await fetch(url, { cache: 'reload', credentials: 'same-origin' });
      if (!response.ok) throw new Error(`无法预缓存 ${url}（${response.status}）`);
      return [url, response];
    }));

    // 先完整写入临时缓存；任一核心模块失败时，当前可用版本保持不动。
    const staging = await caches.open(stagingName);
    const staged = await Promise.allSettled(responses.map(([url, response]) => staging.put(url, response)));
    const stageFailure = staged.find((result) => result.status === 'rejected');
    if (stageFailure) throw stageFailure.reason;

    const target = await caches.open(CACHE_VERSION);
    // Cache Storage 没有原子 rename；刷新已经存在的同版本缓存时先保存
    // 外壳键快照，复制中途失败即可回滚，避免留下新旧模块混合的半套缓存。
    const previous = targetExisted
      ? await Promise.all(SHELL.map(async (url) => [url, await target.match(url)]))
      : null;
    const copied = await Promise.allSettled(SHELL.map(async (url) => {
      const response = await staging.match(url);
      if (!response) throw new Error(`临时缓存缺少 ${url}`);
      await target.put(url, response);
    }));
    const copyFailure = copied.find((result) => result.status === 'rejected');
    if (copyFailure) {
      if (!targetExisted) {
        // 首次安装不能留下同版本的半套外壳。
        await caches.delete(CACHE_VERSION).catch(() => {});
      } else {
        // 尝试逐键恢复旧快照；若存储本身持续失败，删除目标缓存比继续
        // 提供混合版本更安全，下一次在线导航会重新建立完整缓存。
        const restored = await Promise.allSettled(previous.map(async ([url, response]) => {
          if (response) return target.put(url, response.clone());
          if (typeof target.delete !== 'function') throw new Error('Cache.delete 不可用');
          return target.delete(url);
        }));
        if (restored.some((result) => result.status === 'rejected')) {
          await caches.delete(CACHE_VERSION).catch(() => {});
        }
      }
      throw copyFailure.reason;
    }
  } finally {
    await caches.delete(stagingName).catch(() => {});
  }
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

function isAppEntryUrl(value) {
  try {
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin
      && (url.pathname === '/' || url.pathname === '/index.html');
  } catch (_) {
    return false;
  }
}

async function isAppEntryHtml(request, response) {
  if (!isAppEntryUrl(request.url) || !response || !response.ok) return false;
  const finalUrl = response.url || request.url;
  if (!isAppEntryUrl(finalUrl)) return false;
  const contentType = response.headers && response.headers.get('content-type');
  if (String(contentType || '').split(';', 1)[0].trim().toLowerCase() !== 'text/html') return false;
  try {
    const html = await response.clone().text();
    return /<div\b[^>]*\bid=['"]app['"][^>]*>/i.test(html)
      && /<script\b[^>]*\bsrc=['"]\/js\/app\.js['"][^>]*>/i.test(html);
  } catch (_) {
    return false;
  }
}

async function openShellCache() {
  try {
    return await caches.open(CACHE_VERSION);
  } catch (_) {
    return null;
  }
}

async function navigationResponse(request) {
  const cache = await openShellCache();
  try {
    const response = await fetch(request);
    // 只允许真正的根入口 HTML 刷新离线首页。导航到 JS/CSS 等静态资源时，
    // request.mode 同样可能是 navigate，不能因此把资源正文写入 /index.html。
    if (cache && await isAppEntryHtml(request, response)) {
      await cache.put('/index.html', response.clone()).catch(() => {});
    }
    return response;
  } catch (_) {
    // 限定当前版本缓存，避免升级窗口内命中旧版或其他 Cache Storage 的同名键。
    if (cache) {
      try {
        return (await cache.match('/index.html')) || (await cache.match('/')) || Response.error();
      } catch (_) {}
    }
    return Response.error();
  }
}

async function staticResponse(request) {
  const cache = await openShellCache();
  let cached;
  if (cache) {
    try { cached = await cache.match(request, { ignoreSearch: false }); } catch (_) {}
  }
  try {
    // 在线时先做 ETag 协商，部署新静态文件后立即生效；断网才回退离线副本。
    // 旧的 cache-first 会在 sw.js 本身未改动时永久返回上一版模块。
    const response = await fetch(request, { cache: 'no-cache' });
    if (cache && response.ok && response.type === 'basic') {
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
