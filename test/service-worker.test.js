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
  if (responseUrl) Object.defineProperty(response, 'url', { value: new URL(responseUrl, ORIGIN).href });
  return response;
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
  const shellSet = new Set(shell);
  assert.strictEqual(shellSet.size, shell.length, 'SHELL 不得包含重复缓存键');
  assert(shellSet.has('/js/navigation.js'), 'SHELL 必须包含 app.js 的 navigation.js 依赖');

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
    return networkResponse(`shell:${url}`, 'application/octet-stream');
  });
  await assert.rejects(() => failedInstallHarness.precache(), /无法预缓存/);
  const failedInstallNames = await failedInstallHarness.cacheStorage.keys();
  assert.ok(precacheFetches >= failedInstallHarness.shell.length,
    '预缓存应先验证整套网络响应');
  assert.ok(!failedInstallNames.includes(failedInstallHarness.cacheVersion),
    '预缓存失败不得留下同版本的半套目标缓存');
  assert.ok(!failedInstallNames.includes(`${failedInstallHarness.cacheVersion}-staging`),
    '预缓存失败必须清理临时缓存');

  // 同版本缓存刷新期间若目标 put 失败，不得留下新旧模块混合；
  // 让目标缓存只在第二个键写入时失败，验证事务性回滚。
  const rollbackHarness = createWorkerHarness(async (request) => {
    const url = typeof request === 'string' ? request : request.url;
    return networkResponse(`new:${url}`, 'application/octet-stream');
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
