'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const turn = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

(async () => {
  const { createNavigationCache } = await import(pathToFileURL(path.resolve(__dirname, '../public/js/navigation-cache.js')));
  let now = 1;
  const cache = createNavigationCache({ now: () => now, maxEntries: 3, maxBytes: 2000 });
  let calls = 0;
  let value = { data: { id: 7, is_favorite: true } };
  const loader = async () => { calls++; return value; };
  const first = await cache.read('album:7', loader, { freshMs: 100, maxAgeMs: 500 });
  first.data.is_favorite = false;
  assert.equal((await cache.read('album:7', loader)).data.is_favorite, true, '视图修改不得污染缓存');
  assert.equal(calls, 1);
  now += 150;
  const updated = deferred();
  value = { data: { id: 7, is_favorite: true, series: [1, 2] } };
  assert.deepEqual(await cache.read('album:7', loader, {
    freshMs: 100, maxAgeMs: 500, onUpdate: updated.resolve,
  }), { data: { id: 7, is_favorite: true } });
  assert.deepEqual((await updated.promise).data.series, [1, 2]);
  assert.equal(calls, 2);
  now += 150;
  const failed = deferred();
  const old = await cache.read('album:7', async () => { throw new Error('offline'); }, {
    freshMs: 100, maxAgeMs: 500, onError: failed.resolve,
  });
  assert.equal((await failed.promise).message, 'offline');
  assert.deepEqual(cache.get('album:7').value, old, '后台失败保留完整旧值');
  now += 501;
  const waiting = deferred();
  let returned = false;
  const expired = cache.read('album:7', () => waiting.promise, { maxAgeMs: 500 }).then(() => { returned = true; });
  await turn();
  assert.equal(returned, false, '超过最大陈旧窗口必须等待网络');
  waiting.resolve(value);
  await expired;
  await assert.rejects(cache.read('bad', async () => null, { validate: (x) => !!x }), /数据格式异常/);
  assert.equal(cache.get('bad'), null);

  // Single-flight 请求由所有消费者共同拥有，取消一个路由不能取消另一个。
  const network = deferred();
  const a = new AbortController(); const b = new AbortController();
  let sharedSignal; let sharedCalls = 0;
  const sharedLoader = (signal) => { sharedSignal = signal; sharedCalls++; return network.promise; };
  const readA = cache.read('shared', sharedLoader, { signal: a.signal });
  const readB = cache.read('shared', sharedLoader, { signal: b.signal });
  const cancelledA = assert.rejects(readA, { name: 'AbortError' });
  await turn();
  a.abort();
  await cancelledA;
  assert.equal(sharedSignal.aborted, false);
  network.resolve({ ok: true });
  assert.deepEqual(await readB, { ok: true });
  assert.equal(sharedCalls, 1);

  const abandoned = deferred();
  const route = new AbortController();
  const readAbandoned = cache.read('abandoned', () => abandoned.promise, { signal: route.signal });
  const cancelled = assert.rejects(readAbandoned, { name: 'AbortError' });
  await turn(); route.abort(); await cancelled;
  abandoned.resolve({ secret: 'old user' });
  await turn();
  assert.equal(cache.get('abandoned'), null, '忽略 abort 的上游也不得回填');
  const oldToken = cache.token();
  cache.invalidate();
  assert.equal(cache.put('late', { old: true }, { token: oldToken }), null);
  const late = deferred();
  const flight = cache.read('late', () => late.promise);
  const obsolete = assert.rejects(flight, { name: 'AbortError' });
  await turn(); cache.invalidate(); await obsolete;
  late.resolve({ old: true }); await turn();
  assert.equal(cache.get('late'), null);

  cache.put('a', 1); cache.put('b', 2); cache.put('c', 3); cache.get('a'); cache.put('d', 4);
  assert.equal(cache.get('b'), null, 'LRU 淘汰最久未使用项');
  assert.equal(cache.put('oversized', 'x'.repeat(1100)), null);
  const revision = cache.put('snapshot', { pages: ['old-1', 'old-2'] });
  cache.put('snapshot', { pages: ['new-1', 'new-2'] }, { expectedRevision: revision });
  assert.equal(cache.put('snapshot', { pages: ['old-1'] }, { expectedRevision: revision }), null,
    '旧视图的 cleanup 不能覆盖已完整重验证的新快照');

  // API 接入必须覆盖实际变更入口、跨标签认证及 401，而非只验证缓存帮助函数。
  const writes = [];
  global.localStorage = { getItem: () => null, setItem: (...args) => writes.push(args), removeItem() {} };
  global.window = new EventTarget();
  global.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, classList: { toggle() {} } },
    querySelector: () => null,
  };
  const { api, navigationState } = await import(pathToFileURL(path.resolve(__dirname, '../public/js/api.js')));
  const { setting, updateSetting } = await import(pathToFileURL(path.resolve(__dirname, '../public/js/store.js')));
  let albumFetches = 0;
  let albumFavorite = true;
  let identity = 'A';
  let status = 200;
  let pendingLogin = null;
  let lateUnauthorized = null;
  let pendingMe = null;
  let loginBody = null;
  const response = (data, code = 200) => new Response(JSON.stringify(data), { status: code });
  global.fetch = async (url) => {
    if (url === '/api/me' && pendingMe) return pendingMe.promise;
    if (url.startsWith('/api/favorites') && lateUnauthorized) return lateUnauthorized.promise;
    if (url === '/api/login' && pendingLogin) return pendingLogin.promise;
    if (url === '/api/login') return response(loginBody || { data: { id: 'B' } });
    if (url === '/api/me') return response({ user: identity ? { id: identity } : null });
    if (url.startsWith('/api/album')) {
      albumFetches++;
      return response(status === 401 ? { error: 'expired' } : { data: { id: 7, is_favorite: albumFavorite } }, status);
    }
    return response({ ok: true, data: { is_favorite: albumFavorite } });
  };
  await api.me();
  await api.cachedAlbum(7); await api.cachedAlbum(7);
  assert.equal(albumFetches, 1);
  const key = navigationState.key('mr', 0);
  navigationState.save(key, { pages: [{ data: { list: [{ id: 7 }] } }] });
  albumFavorite = false;
  await api.favorite(7);
  assert.equal(navigationState.get(key), null);
  assert.equal((await api.cachedAlbum(7)).data.is_favorite, false, '批量取消收藏也必须失效详情');
  const folderToken = navigationState.token();
  await api.favoriteFolder('edit', '1', 'renamed');
  assert.notEqual(navigationState.token(), folderToken);
  await api.like(7); await api.cachedAlbum(7);
  assert.equal(albumFetches, 3);
  await api.setApiHost('https://trusted.example'); await api.cachedAlbum(7);
  assert.equal(albumFetches, 4);
  updateSetting({ dataSource: 'network' }); await api.cachedAlbum(7);
  assert.equal(albumFetches, 5);
  assert.equal(setting.dataSource, 'network');

  pendingLogin = deferred();
  const login = api.login('B', 'test-password');
  navigationState.save(navigationState.key('mr', 0), { old: true });
  pendingLogin.resolve(response({ data: { id: 'B' } }));
  await login;
  pendingLogin = null; identity = 'B';
  assert.equal(navigationState.get(navigationState.key('mr', 0)), null,
    '登录完成后的失效不能依赖调用方仍在登录页面');
  lateUnauthorized = deferred();
  const oldRequest = api.favorites('mr', 1);
  const old401 = assert.rejects(oldRequest, (error) => error.status === 401);
  await api.login('B', 'test-password');
  const newUserKey = navigationState.key('mr', 0);
  navigationState.save(newUserKey, { currentUser: true });
  lateUnauthorized.resolve(response({ error: 'old session expired' }, 401));
  await old401;
  assert.deepEqual(navigationState.get(newUserKey).value, { currentUser: true },
    '旧账号迟到的 401 不得清除新账号缓存');
  lateUnauthorized = null;
  await api.cachedAlbum(7); await api.logout(); await api.cachedAlbum(7);
  assert.equal(albumFetches, 7);
  const storage = new Event('storage');
  storage.key = 'jmw_navigation_cache_invalidation';
  storage.newValue = JSON.stringify({ kind: 'auth' });
  window.dispatchEvent(storage);
  await api.cachedAlbum(7);
  assert.equal(albumFetches, 8, '其它标签账号切换后必须丢弃本标签详情');
  pendingMe = deferred();
  const profile = api.me();
  await api.like(7);
  pendingMe.resolve(response({ user: { id: 'B' } }));
  assert.equal((await profile).user.id, 'B', '普通点赞不得取消并行的账号资料读取');
  pendingMe = null;
  status = 401;
  await assert.rejects(api.cachedAlbum(7, null, { force: true }), (error) => error.status === 401);
  status = 200;
  await api.cachedAlbum(7);
  assert.equal(albumFetches, 10, '401 必须清空旧缓存且保留原错误状态');
  assert(writes.filter(([name]) => name === 'jmw_navigation_cache_invalidation')
    .every(([, text]) => !text.includes('test-password') && !text.includes('pages')),
  '跨标签通知不可持久化凭据或业务数据');
  console.log('navigation cache TTL/abort/identity/invalidation all pass');
})().catch((error) => { console.error(error); process.exitCode = 1; });
