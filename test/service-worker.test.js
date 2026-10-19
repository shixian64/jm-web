'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const ORIGIN = 'https://jm-web.test';
const workerSource = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');

function cacheKey(input) {
  const value = typeof input === 'string' ? input : input.url;
  return new URL(value, ORIGIN).href;
}

class MemoryCache {
  constructor() {
    this.entries = new Map();
    this.matchError = null;
    this.putError = null;
  }

  async put(request, response) {
    if (this.putError) throw this.putError;
    this.entries.set(cacheKey(request), response.clone());
  }

  async match(request) {
    if (this.matchError) throw this.matchError;
    const response = this.entries.get(cacheKey(request));
    return response ? response.clone() : undefined;
  }

  async delete(request) {
    return this.entries.delete(cacheKey(request));
  }
}

function createWorkerHarness(initialFetch) {
  const listeners = new Map();
  const stores = new Map();
  let fetchImpl = initialFetch;
  let openError = null;
  const cacheStorage = {
    async open(name) {
      if (openError) throw openError;
      if (!stores.has(name)) stores.set(name, new MemoryCache());
      return stores.get(name);
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      return stores.delete(name);
    },
    // 保留全局 match，以便回归测试证明导航 fallback 不会误用它。
    async match(request) {
      for (const cache of stores.values()) {
        const response = await cache.match(request);
        if (response) return response;
      }
      return undefined;
    },
  };
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    clients: { claim: async () => {} },
    skipWaiting() {},
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
  };
  const context = vm.createContext({
    URL,
    Response,
    caches: cacheStorage,
    fetch: (...args) => fetchImpl(...args),
    self,
  });
  vm.runInContext(`${workerSource}\n;globalThis.__swTest = { CACHE_VERSION, SHELL, precache, navigationResponse, staticResponse };`, context,
    { filename: path.join(PUBLIC, 'sw.js') });

  return {
    cacheStorage,
    cacheVersion: context.__swTest.CACHE_VERSION,
    shell: Array.from(context.__swTest.SHELL),
    setFetch(next) {
      fetchImpl = next;
    },
    setOpenError(error) {
      openError = error;
    },
    async precache() {
      return context.__swTest.precache();
    },
    async navigate(pathname) {
      const listener = listeners.get('fetch');
      assert(listener, 'Service Worker 必须注册 fetch 处理器');
      let responsePromise;
      listener({
        request: { method: 'GET', mode: 'navigate', url: new URL(pathname, ORIGIN).href },
        respondWith(value) {
          responsePromise = Promise.resolve(value);
        },
      });
      assert(responsePromise, `导航 ${pathname} 必须由 Service Worker 响应`);
      return responsePromise;
    },
    async staticRequest(pathname) {
      return context.__swTest.staticResponse({
        method: 'GET', mode: 'cors', url: new URL(pathname, ORIGIN).href,
      });
    },
  };
}

function networkResponse(body, contentType, responseUrl = '') {
  const response = new Response(body, { status: 200, headers: { 'Content-Type': contentType } });
  Object.defineProperty(response, 'type', { value: 'basic' });
  if (responseUrl) Object.defineProperty(response, 'url', { value: new URL(responseUrl, ORIGIN).href });
  return response;
}

function shellResponse(request, prefix = 'shell') {
  const url = typeof request === 'string' ? request : request.url;
  const pathname = new URL(url, ORIGIN).pathname;
  if (pathname === '/' || pathname === '/index.html') {
    return networkResponse(fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'), 'text/html', url);
  }
  const mime = pathname.endsWith('.js') ? 'text/javascript'
    : pathname.endsWith('.css') ? 'text/css'
      : pathname.endsWith('.png') ? 'image/png' : 'application/manifest+json';
  return networkResponse(`${prefix}:${url}`, mime, url);
}

function collectModuleDependencies(entry) {
  const pending = [entry];
  const visited = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    const filename = path.join(PUBLIC, ...current.split('/').filter(Boolean));
    assert(fs.existsSync(filename), `入口依赖不存在：${current}`);
    const source = fs.readFileSync(filename, 'utf8');
    const specifiers = [
      ...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g),
      ...source.matchAll(/\bimport\s*['"]([^'"]+)['"]/g),
      ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((match) => match[1]);
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) continue;
      const dependency = new URL(specifier, `${ORIGIN}${current}`).pathname;
      if (!visited.has(dependency)) pending.push(dependency);
    }
  }
  return visited;
}

function verifyShellInventory(shell) {
  assert.match(workerSource, /const CACHE_VERSION = 'jmw-shell-v18'/, '外壳/版本化模块策略变更必须升级缓存版本');
  const shellSet = new Set(shell);
  assert.strictEqual(shellSet.size, shell.length, 'SHELL 不得包含重复缓存键');
  assert(shellSet.has('/js/navigation.js'), 'SHELL 必须包含 app.js 的 navigation.js 依赖');
  assert(shellSet.has('/js/navigation-cache.js'), 'SHELL 必须包含返回导航缓存模块');

  for (const url of shell) {
    const pathname = url === '/' ? '/index.html' : new URL(url, ORIGIN).pathname;
    const filename = path.join(PUBLIC, ...pathname.split('/').filter(Boolean));
    assert(fs.existsSync(filename), `SHELL 文件不存在：${url}`);
    assert(fs.statSync(filename).isFile(), `SHELL 项不是文件：${url}`);
  }

  const required = new Set(['/', '/index.html']);
  const index = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  for (const match of index.matchAll(/\b(?:src|href)="(\/[^"?#]*)/g)) required.add(match[1]);

  const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8'));
  const visitManifest = (value) => {
    if (Array.isArray(value)) return value.forEach(visitManifest);
    if (!value || typeof value !== 'object') return;
    if (typeof value.src === 'string' && value.src.startsWith('/')) {
      required.add(new URL(value.src, ORIGIN).pathname);
    }
    Object.values(value).forEach(visitManifest);
  };
  visitManifest(manifest);
  for (const dependency of collectModuleDependencies('/js/app.js')) required.add(dependency);

  const missing = [...required].filter((url) => !shellSet.has(url)).sort();
  assert.deepStrictEqual(missing, [], `SHELL 缺少入口依赖：${missing.join(', ')}`);
}

(async () => {
  const harness = createWorkerHarness(async () => {
    throw new Error('测试尚未配置网络响应');
  });
  verifyShellInventory(harness.shell);

  const cache = await harness.cacheStorage.open(harness.cacheVersion);
  const knownGood = '<!doctype html><title>known-good-shell</title>';
  await cache.put('/index.html', networkResponse(knownGood, 'text/html; charset=utf-8'));

  // 复现原缺陷：地址栏导航到 JS 时 mode=navigate，但不得覆盖离线首页。
  harness.setFetch(async () => networkResponse('console.log("asset")', 'text/javascript'));
  const assetNavigation = await harness.navigate('/js/app.js');
  assert.strictEqual(await assetNavigation.text(), 'console.log("asset")');
  assert.strictEqual(await (await cache.match('/index.html')).text(), knownGood,
    'JS 导航响应不得污染 /index.html');

  // 即使请求的是根入口，错误 MIME 的成功响应也不得进入 HTML fallback 缓存。
  harness.setFetch(async () => networkResponse('not html', 'application/javascript'));
  await harness.navigate('/');
  assert.strictEqual(await (await cache.match('/index.html')).text(), knownGood,
    '错误 MIME 的根导航响应不得污染 /index.html');

  harness.setFetch(async () => networkResponse('<!doctype html><title>proxy error</title>', 'text/html'));
  await harness.navigate('/');
  assert.strictEqual(await (await cache.match('/index.html')).text(), knownGood,
    '缺少应用入口标记的 HTML 不得污染 /index.html');

  const realIndex = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  harness.setFetch(async () => networkResponse(realIndex, 'text/html', '/signin'));
  await harness.navigate('/');
  assert.strictEqual(await (await cache.match('/index.html')).text(), knownGood,
    '重定向到非入口 URL 的 HTML 不得污染 /index.html');

  // SPA 兜底路径和重定向页不承担更新离线入口的职责，只接受明确的 / 或 /index.html。
  harness.setFetch(async () => networkResponse('<!doctype html><title>other-page</title>', 'text/html'));
  await harness.navigate('/some-page');
  assert.strictEqual(await (await cache.match('/index.html')).text(), knownGood,
    '非入口路径的 HTML 不得覆盖 /index.html');

  const refreshed = realIndex;
  harness.setFetch(async () => networkResponse(refreshed, 'text/html; charset=UTF-8'));
  await harness.navigate('/index.html?deploy=next');
  assert.strictEqual(await (await cache.match('/index.html')).text(), refreshed,
    '合法入口 HTML 应更新离线首页');

  // 旧版本缓存先插入一个污染项；断网时必须只读取当前 CACHE_VERSION。
  const offlineHarness = createWorkerHarness(async () => {
    throw new TypeError('Failed to fetch');
  });
  const oldCache = await offlineHarness.cacheStorage.open('jmw-shell-v5');
  await oldCache.put('/index.html', networkResponse('console.log("old poison")', 'text/javascript'));
  const currentCache = await offlineHarness.cacheStorage.open(offlineHarness.cacheVersion);
  await currentCache.put('/index.html', networkResponse(knownGood, 'text/html'));
  const offlineResponse = await offlineHarness.navigate('/');
  assert.strictEqual(await offlineResponse.text(), knownGood,
    '断网导航必须返回当前版本的 /index.html');
  assert.match(offlineResponse.headers.get('content-type') || '', /^text\/html\b/i);

  // Cache Storage 被浏览器策略、配额或损坏阻断时，在线请求必须退化为网络直连。
  const noCacheHarness = createWorkerHarness(async () =>
    networkResponse(realIndex, 'text/html; charset=utf-8'));
  noCacheHarness.setOpenError(new Error('Cache Storage unavailable'));
  const onlineWithoutCache = await noCacheHarness.navigate('/');
  assert.strictEqual(await onlineWithoutCache.text(), realIndex,
    '缓存打开失败不得阻断在线导航');
  noCacheHarness.setFetch(async () => networkResponse('asset-online', 'text/javascript'));
  const staticWithoutCache = await noCacheHarness.staticRequest('/js/app.js');
  assert.strictEqual(await staticWithoutCache.text(), 'asset-online',
    '缓存打开失败不得阻断在线静态资源');

  const matchFailureHarness = createWorkerHarness(async () =>
    networkResponse('asset-after-match-error', 'text/javascript'));
  const brokenMatchCache = await matchFailureHarness.cacheStorage.open(matchFailureHarness.cacheVersion);
  brokenMatchCache.matchError = new Error('cache.match failed');
  const staticAfterMatchFailure = await matchFailureHarness.staticRequest('/js/app.js');
  assert.strictEqual(await staticAfterMatchFailure.text(), 'asset-after-match-error',
    '缓存读取失败不得发生在网络请求之前并中断响应');

  noCacheHarness.setFetch(async () => { throw new TypeError('network also unavailable'); });
  const noNetworkOrCache = await noCacheHarness.navigate('/');
  assert.strictEqual(noNetworkOrCache.status, 0,
    '网络和缓存同时不可用时应返回 Response.error');

  let precacheFetches = 0;
  const failedInstallHarness = createWorkerHarness(async (request) => {
    precacheFetches++;
    const url = typeof request === 'string' ? request : request.url;
    if (url === '/js/navigation.js') return new Response('missing', { status: 404 });
    return shellResponse(request);
  });
  await assert.rejects(() => failedInstallHarness.precache(), /无法预缓存/);
  const failedInstallNames = await failedInstallHarness.cacheStorage.keys();
  assert.ok(precacheFetches >= failedInstallHarness.shell.length,
    '预缓存应先验证整套网络响应');
  assert.ok(!failedInstallNames.includes(failedInstallHarness.cacheVersion),
    '预缓存失败不得留下同版本的半套目标缓存');
  assert.ok(!failedInstallNames.includes(`${failedInstallHarness.cacheVersion}-staging`),
    '预缓存失败必须清理临时缓存');

  // HTTP 200 并不代表外壳有效：反代错误页/登录重定向不能替换整套可用缓存。
  for (const badPath of ['/', '/js/app.js', '/css/app.css', '/icons/icon-192.png']) {
    const poisonHarness = createWorkerHarness(async (request) => request === badPath
      ? networkResponse('<html>proxy error</html>', 'text/html') : shellResponse(request));
    await assert.rejects(() => poisonHarness.precache(), /无法预缓存/,
      `必须拒绝错误的预缓存响应：${badPath}`);
    assert.deepStrictEqual(await poisonHarness.cacheStorage.keys(), [], '无效外壳不得留下缓存');
  }
  const redirectHarness = createWorkerHarness(async (request) => request === '/js/app.js'
    ? networkResponse('export {}', 'text/javascript', '/signin') : shellResponse(request));
  await assert.rejects(() => redirectHarness.precache(), /无法预缓存/, '重定向资源不得预缓存');

  // 多标签同时准备离线外壳必须合并，不能竞争同一个 staging 缓存。
  let concurrentFetches = 0;
  let releaseFetches;
  const fetchBarrier = new Promise((resolve) => { releaseFetches = resolve; });
  const concurrentHarness = createWorkerHarness(async (request) => {
    concurrentFetches++;
    await fetchBarrier;
    return shellResponse(request);
  });
  const preloads = [concurrentHarness.precache(), concurrentHarness.precache()];
  releaseFetches();
  await Promise.all(preloads);
  assert.strictEqual(concurrentFetches, concurrentHarness.shell.length, '并发预缓存只能下载一套外壳');
  await concurrentHarness.precache();
  assert.strictEqual(concurrentFetches, concurrentHarness.shell.length * 2, '完成后应允许重新刷新');
  failedInstallHarness.setFetch((request) => shellResponse(request));
  await failedInstallHarness.precache(); // 失败的 single-flight 也必须释放。

  const staticCacheHarness = createWorkerHarness((request) => shellResponse(request));
  const boundedCache = await staticCacheHarness.cacheStorage.open(staticCacheHarness.cacheVersion);
  await staticCacheHarness.staticRequest('/js/app.js');
  assert.ok(await boundedCache.match('/js/app.js'), '合法模块必须可离线缓存');
  staticCacheHarness.setFetch(async () => networkResponse('<html>proxy error</html>', 'text/html'));
  const validFallback = await staticCacheHarness.staticRequest('/js/app.js');
  assert.strictEqual(await validFallback.text(), 'shell:https://jm-web.test/js/app.js',
    '错误 MIME 的 HTTP 200 必须使用现有模块，而不是破坏启动');
  assert.strictEqual(await (await boundedCache.match('/js/app.js')).text(), 'shell:https://jm-web.test/js/app.js');
  staticCacheHarness.setFetch((request) => shellResponse(request));
  for (let index = 0; index < 12; index++) {
    await staticCacheHarness.staticRequest(`/js/app.js?nonce=${index}`);
    await staticCacheHarness.staticRequest(`/not-shell-${index}.js`);
  }
  assert.strictEqual(boundedCache.entries.size, 1, '随机路径和 query 不得无限扩张离线外壳缓存');

  // import map 版本化模块：不强制 no-cache 回源（交给 immutable HTTP 缓存），
  // 成功响应写回同一路径的外壳键，断网时按路径回退。
  const versionedInits = [];
  const versionedHarness = createWorkerHarness(async (request, init) => {
    versionedInits.push(init);
    return shellResponse(request, 'versioned');
  });
  const versionedCache = await versionedHarness.cacheStorage.open(versionedHarness.cacheVersion);
  const versionedResponse = await versionedHarness.staticRequest('/js/api.js?v=AbCdEf123456_-xy');
  assert.strictEqual(await versionedResponse.text(), 'versioned:https://jm-web.test/js/api.js?v=AbCdEf123456_-xy');
  assert.strictEqual(versionedInits[0], undefined, '版本化模块不得附加 cache: no-cache');
  assert.strictEqual(await (await versionedCache.match('/js/api.js')).text(),
    'versioned:https://jm-web.test/js/api.js?v=AbCdEf123456_-xy', '版本化模块应写回无 query 外壳键');
  assert.strictEqual(versionedCache.entries.size, 1, '版本化请求不得新增 query 缓存键');
  await versionedHarness.staticRequest('/js/api.js');
  assert.strictEqual(versionedInits[1] && versionedInits[1].cache, 'no-cache', '无版本 URL 仍需 ETag 协商');
  versionedHarness.setFetch(async () => { throw new TypeError('offline'); });
  const versionedOffline = await versionedHarness.staticRequest('/js/api.js?v=ZZZZZZZZZZZZ');
  assert.match(await versionedOffline.text(), /^versioned:/, '断网时版本化模块按路径回退离线副本');
  for (const search of ['?v=short', '?v=AbCdEf123456&x=1', '?x=AbCdEf123456']) {
    versionedHarness.setFetch((request) => shellResponse(request, 'other'));
    await versionedHarness.staticRequest(`/js/store.js${search}`);
  }
  assert.ok(!(await versionedCache.match('/js/store.js')), '非版本化 query 不得写入外壳缓存');

  // 同版本缓存刷新期间若目标 put 失败，不得留下新旧模块混合；
  // 让目标缓存只在第二个键写入时失败，验证事务性回滚。
  const rollbackHarness = createWorkerHarness(async (request) => {
    const url = typeof request === 'string' ? request : request.url;
    return shellResponse(request, 'new');
  });
  const rollbackCache = await rollbackHarness.cacheStorage.open(rollbackHarness.cacheVersion);
  for (const url of rollbackHarness.shell) {
    await rollbackCache.put(url, networkResponse(`old:${url}`, 'application/octet-stream'));
  }
  const originalPut = rollbackCache.put.bind(rollbackCache);
  let targetPutCount = 0;
  rollbackCache.put = async (request, response) => {
    targetPutCount++;
    if (targetPutCount === 2) throw new Error('simulated target put failure');
    return originalPut(request, response);
  };
  await assert.rejects(() => rollbackHarness.precache(), /simulated target put failure/);
  const rollbackNames = await rollbackHarness.cacheStorage.keys();
  assert.ok(!rollbackNames.includes(`${rollbackHarness.cacheVersion}-staging`),
    '同版本预缓存失败也必须清理临时缓存');
  if (rollbackNames.includes(rollbackHarness.cacheVersion)) {
    const restored = await rollbackHarness.cacheStorage.open(rollbackHarness.cacheVersion);
    for (const url of rollbackHarness.shell) {
      assert.strictEqual(await (await restored.match(url)).text(), `old:${url}`,
        `同版本失败后应恢复旧缓存：${url}`);
    }
  }

  console.log(`service worker shell/navigation all pass (${harness.shell.length} cached assets)`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
