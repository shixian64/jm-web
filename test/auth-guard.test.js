'use strict';

// 第 4 批行为测试：集中同源校验（CSRF）矩阵、可信代理链矩阵（不可信转发头
// 不得伪造 clientIp/Secure）、401 的门禁失效/JM 失效分流与防 me 循环、
// 路由错误文案区分，以及 app.js 单实例重验证接线。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { checkSameOrigin, createProxyTrust, normalizeIp } = require('../lib/origin-guard');

/* ---------------- 同源校验矩阵 ---------------- */

const check = (headers, { scheme = 'http', host = 'app.example' } = {}) =>
  checkSameOrigin({ headers, scheme, host });

// 跨源表单/请求必须拒绝。
assert.equal(check({ origin: 'https://evil.example' }).ok, false, '跨源 Origin 必须拒绝');
assert.equal(check({ origin: 'https://app.example' }, { scheme: 'https' }).ok, true, '同源 Origin 放行');
assert.equal(check({ origin: 'http://app.example:3210' }, { host: 'app.example:3210' }).ok, true, '同源（带端口）放行');
assert.equal(check({ origin: 'http://app.example:8080' }, { host: 'app.example:3210' }).ok, false, '端口不同必须拒绝');
assert.equal(check({ origin: 'https://app.example' }).ok, false, 'scheme 不同（https Origin vs http 请求）必须拒绝');
// same-site 但不同 origin 必须拒绝。
assert.equal(check({ origin: 'https://other.app.example', 'sec-fetch-site': 'same-site' }).ok, false, 'same-site 不同 origin 必须拒绝');
assert.equal(check({ 'sec-fetch-site': 'same-site' }).ok, false, 'Sec-Fetch-Site: same-site 必须拒绝');
assert.equal(check({ 'sec-fetch-site': 'cross-site' }).ok, false, 'Sec-Fetch-Site: cross-site 必须拒绝');
assert.equal(check({ 'sec-fetch-site': 'same-origin', origin: 'http://app.example' }).ok, true, '同源 fetch 元数据 + 匹配 Origin 放行');
assert.equal(check({ 'sec-fetch-site': 'none' }).ok, true, 'Sec-Fetch-Site: none（用户直接发起）且无 Origin 放行');
// Origin: null 与矛盾来源元数据必须拒绝。
assert.equal(check({ origin: 'null' }).ok, false, 'Origin: null 必须拒绝');
assert.equal(check({ origin: 'not a url' }).ok, false, '非法 Origin 必须拒绝');
assert.equal(check({ 'sec-fetch-site': 'cross-site', origin: 'http://app.example' }).ok, false, '矛盾元数据（cross-site + 同源 Origin）必须拒绝');
assert.equal(checkSameOrigin({ headers: { origin: 'http://app.example' }, scheme: 'http', host: undefined }).ok, false, 'Host 缺失但有 Origin 必须拒绝');
assert.equal(checkSameOrigin({ headers: { origin: 'http://app.example', referer: 'https://evil.example/' }, scheme: 'http', host: 'app.example' }).ok, false, 'Origin 与 Referer 矛盾必须拒绝');
assert.equal(check({ origin: 'http://app.example', referer: 'http://app.example/page' }).ok, true, 'Origin 与同源 Referer 一致放行');
// Referer 回退。
assert.equal(check({ referer: 'http://app.example/favorites' }).ok, true, '同源 Referer 放行');
assert.equal(check({ referer: 'https://evil.example/x' }).ok, false, '跨源 Referer 必须拒绝');
assert.equal(check({ referer: '::bad::' }).ok, false, '非法 Referer 必须拒绝');
// 无来源证据（curl/脚本/老浏览器）：兼容放行，认证要求不变（明确契约）。
assert.equal(check({}).ok, true, '无来源证据放行（SameSite=Lax 为主防线）');
assert.equal(check({}).reason, 'no_source_evidence');

/* ---------------- 可信代理链矩阵 ---------------- */

const req = (remoteAddress, headers = {}, extra = {}) => ({
  headers,
  socket: { remoteAddress, ...extra },
});

{
  // 不可信直连客户自带的 XFF / X-Forwarded-Proto 不得伪造 clientIp 或 Secure。
  const trust = createProxyTrust({});
  assert.equal(trust.clientIp(req('203.0.113.5', { 'x-forwarded-for': '1.2.3.4' })), '203.0.113.5',
    '不可信对端的 XFF 不得改变 clientIp');
  assert.equal(trust.requestIsSecure(req('203.0.113.5', { 'x-forwarded-proto': 'https' })), false,
    '不可信对端的 X-Forwarded-Proto 不得伪造 Secure');
  // 环回默认可信。
  assert.equal(trust.clientIp(req('127.0.0.1', { 'x-forwarded-for': '198.51.100.7' })), '198.51.100.7');
  assert.equal(trust.requestIsSecure(req('127.0.0.1', { 'x-forwarded-proto': 'https' })), true);
  assert.equal(trust.requestIsSecure(req('127.0.0.1', { 'x-forwarded-proto': 'https, http' })), false,
    '被追加的 X-Forwarded-Proto 链必须整体拒绝');
  // IPv4-mapped IPv6 归一化后同样处理。
  assert.equal(trust.clientIp(req('::ffff:127.0.0.1', { 'x-forwarded-for': '198.51.100.8' })), '198.51.100.8');
  assert.equal(normalizeIp('::ffff:203.0.113.9'), '203.0.113.9');
  // 垃圾 token 让整个 XFF 不被采信。
  assert.equal(trust.clientIp(req('127.0.0.1', { 'x-forwarded-for': '1.2.3.4, evil.example' })), '127.0.0.1');
  // TLS socket 直连本身就是 https。
  assert.equal(trust.requestIsSecure(req('203.0.113.5', {}, { encrypted: true })), true);
}

{
  // 只信任显式配置的精确 CIDR，不广泛信任私网：网段外对端的头不采信。
  const trust = createProxyTrust({ trustProxy: '172.18.0.0/16' });
  assert.equal(trust.clientIp(req('172.18.0.9', { 'x-forwarded-for': '198.51.100.10' })), '198.51.100.10',
    '配置网段内的代理可被解析');
  assert.equal(trust.clientIp(req('172.19.0.9', { 'x-forwarded-for': '198.51.100.11' })), '172.19.0.9',
    '配置网段外的私网地址不受信（不得默认信任整个私网）');
  assert.equal(trust.requestIsSecure(req('172.19.0.9', { 'x-forwarded-proto': 'https' })), false,
    '网段外对端不得伪造 Secure');
  // 多级可信链：从最靠近应用的一跳剥离可信代理。
  const chained = createProxyTrust({ trustProxy: '198.51.100.0/24' });
  assert.equal(
    chained.clientIp(req('198.51.100.1', { 'x-forwarded-for': '203.0.113.5, 198.51.100.2' })),
    '203.0.113.5',
    'XFF 链应剥离可信代理到第一个非可信 IP',
  );
}

/* ---------------- 401 分流与防 me 循环（api.js 行为） ---------------- */

(async () => {
  const events = [];
  const storageWrites = [];
  let responses = [];
  global.localStorage = {
    getItem: () => null,
    setItem: (...args) => storageWrites.push(args),
    removeItem() {},
  };
  global.window = new EventTarget();
  global.window.scrollY = 0;
  global.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, classList: { toggle() {} } },
    querySelector: () => null,
  };
  global.CustomEvent = global.CustomEvent || class CustomEvent extends Event {
    constructor(type, options = {}) { super(type, options); this.detail = options.detail; }
  };
  window.addEventListener('jmw-access-required', () => events.push('access-required'));
  window.addEventListener('jmw-auth-changed', () => events.push('auth-changed'));
  global.fetch = async () => {
    const next = responses.shift();
    return {
      ok: next.ok,
      status: next.status,
      json: async () => next.body,
    };
  };

  const { api, apiRequest } = await import(pathToFileURL(path.resolve(__dirname, '../public/js/api.js')));
  const turn = () => new Promise((resolve) => setImmediate(resolve));

  // 1) 站点门禁失效：401 + needAuth 派发 jmw-access-required，且不派发账号变更。
  responses = [{ ok: false, status: 401, body: { error: '需要访问口令', needAuth: true } }];
  await assert.rejects(() => api.home(), (error) => error.status === 401 && error.needAuth === true);
  await turn();
  assert.deepEqual(events, ['access-required'], 'needAuth 401 只派发门禁重验证事件');

  // 2) JM 登录失效（无 needAuth）：先建立登录态（me 的身份变迁会合法派发一次），
  //    再 401 → 因失效恰好派发一次 auth-changed。
  events.length = 0;
  responses = [{ ok: true, status: 200, body: { user: { id: 42, username: 'u' } } }];
  await api.me();
  events.length = 0;
  responses = [{ ok: false, status: 401, body: { error: '请重新登录' } }];
  await assert.rejects(() => api.favorites('mr', 1));
  await turn();
  assert.deepEqual(events, ['auth-changed'], 'JM 失效恰好派发一次账号清理事件');

  // 3) 防 me 循环：账号清理后的后续 401（lastIdentity 已为 null）不再派发。
  events.length = 0;
  responses = [{ ok: false, status: 401, body: { error: '请重新登录' } }];
  await assert.rejects(() => api.me());
  responses = [{ ok: false, status: 401, body: { error: '请重新登录' } }];
  await assert.rejects(() => api.me());
  await turn();
  assert.deepEqual(events, [], '已清理状态下的重复 401 不得再派发（防 me 循环）');

  // 4) 登录/退出期间的旧世代 401 不得清掉新账户、不得派发任何事件。
  events.length = 0;
  responses = [{ ok: true, status: 200, body: { user: { id: 42 } } }];
  await api.me();
  const lateRejection = Promise.allSettled([
    (async () => {
      responses = [{ ok: false, status: 401, body: { error: '迟到的旧会话 401' } }];
      await assert.rejects(() => api.favorites('mr', 1));
    })(),
    (async () => {
      await turn();
      responses = [{ ok: true, status: 200, body: { data: { ok: 1 } } }];
      await api.login('user', 'pass');
    })(),
  ]);
  await lateRejection;
  await turn();
  // login 内部会派发 auth-changed（登录成功），但不允许出现 access-required。
  assert.equal(events.includes('access-required'), false, '登录期间的旧 401 不得拉起门禁');

  // 5) 401 失效同时写入跨标签失效广播（不持久化业务数据）。
  assert.ok(storageWrites.some(([key]) => key === 'jmw_navigation_cache_invalidation'),
    '401 后必须广播导航缓存失效');

  // 6) 完整生命周期：请求 A 触发门禁 → 门禁期间发出的请求 B 仍在途 →
  //    验证成功（世代切换）→ B 迟到返回 needAuth 401：不得再次派发重开 gate。
  events.length = 0;
  {
    const deferredB = (() => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; })();
    let fetchCalls = 0;
    global.fetch = async (url) => {
      fetchCalls += 1;
      if (String(url).includes('/auth')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (fetchCalls === 1) {
        return { ok: false, status: 401, json: async () => ({ error: '需要访问口令', needAuth: true }) };
      }
      const body = await deferredB.promise;
      return { ok: false, status: 401, json: async () => body };
    };
    // A：立即 401，触发门禁（dispatch #1）。
    await assert.rejects(() => api.home(), (error) => error.needAuth === true);
    await turn();
    assert.equal(events.filter((name) => name === 'access-required').length, 1);
    // B：门禁期间发出，响应被挂起。
    const bResult = api.home().then(() => new Error('unexpected success'), (error) => error);
    await turn();
    // 用户完成验证 → api.auth 成功 → 认证世代切换。
    await api.auth('password');
    // B 的 401 此刻才返回：世代已过期，不得再次拉起 gate。
    deferredB.resolve({ error: '需要访问口令', needAuth: true });
    const bError = await bResult;
    assert.equal(bError.needAuth, true, '迟到响应仍应携带 401 错误本身');
    await turn();
    assert.equal(events.filter((name) => name === 'access-required').length, 1,
      '门禁验证成功后，迟到旧请求的 needAuth 401 不得再次拉起 gate');
  }
  global.fetch = async () => {
    const next = responses.shift();
    return { ok: next.ok, status: next.status, json: async () => next.body };
  };

  // 执行 reader/download 的真实 JSON 包装函数，而非只断言导入共享帮助函数。
  // 它们过去独立 fetch，丢失 needAuth 且完全绕过全局门禁事件。
  const readerSource = fs.readFileSync(path.resolve(__dirname, '../public/js/reader.js'), 'utf8');
  const downloadSource = fs.readFileSync(path.resolve(__dirname, '../public/js/downloads.js'), 'utf8');
  const readerRequestSource = readerSource.slice(readerSource.indexOf('  async function readerRequest('),
    readerSource.indexOf('  /* ---------- DOM 骨架'));
  const downloadRequestSource = downloadSource.slice(downloadSource.indexOf('async function fetchJson('),
    downloadSource.indexOf('async function fetchBlob('));
  for (const [name, source, functionName] of [
    ['reader', readerRequestSource, 'readerRequest'], ['download', downloadRequestSource, 'fetchJson'],
  ]) {
    const signal = new AbortController().signal;
    const call = new Function('apiRequest', 'selectedDataSource', 'signal',
      `${source}; return ${functionName};`)(apiRequest, () => 'builtin', signal);
    events.length = 0;
    responses = [{ ok: false, status: 401, body: { error: '需要访问口令', needAuth: true } }];
    await assert.rejects(() => call('/chapter?id=1', signal), (error) => error.status === 401 && error.needAuth === true,
      `${name} 必须保留 401 门禁错误信息`);
    assert.deepEqual(events, ['access-required'], `${name} 也必须触发共享门禁重验证`);
    const body = { data: { images: [] } };
    responses = [{ ok: true, status: 200, body }];
    assert.deepEqual(await call('/chapter?id=1', signal), body, `${name} 不得改变响应包装`);
    responses = [{ ok: true, status: 200, body: null }];
    await assert.rejects(() => call('/chapter?id=1', signal), /无法识别/, `${name} 保留无效 JSON 的明确错误`);
  }

  /* ---------------- 路由错误文案区分（ui.js） ---------------- */

  const { routeErrorMessage } = await import(pathToFileURL(path.resolve(__dirname, '../public/js/ui.js')));
  assert.equal(routeErrorMessage({ status: 401, needAuth: true }), '需要访问口令，请先完成验证。');
  assert.equal(routeErrorMessage({ status: 401 }), 'JM 登录已失效，请重新登录。');
  assert.equal(routeErrorMessage({ status: 403 }), '当前操作需要站点管理员权限。');
  assert.equal(routeErrorMessage({ status: 502 }), '服务暂时不可用，请稍后重试。');
  assert.equal(routeErrorMessage({ status: 0 }), '页面加载失败，请稍后重试。');

  /* ---------------- app.js 单实例重验证与启动顺序（接线断言） ---------------- */

  const appSource = fs.readFileSync(path.resolve(__dirname, '../public/js/app.js'), 'utf8');
  const revalidateStart = appSource.indexOf('async function revalidateAccess');
  const revalidateEnd = appSource.indexOf('window.addEventListener(\'jmw-access-required\'', revalidateStart);
  assert.ok(revalidateStart >= 0 && revalidateEnd > revalidateStart, '必须存在门禁重验证入口');
  const revalidateSource = appSource.slice(revalidateStart, revalidateEnd);
  assert.match(revalidateSource, /if \(accessGateOpen\) return;/, '并发 401 不得重复创建 gate');
  assert.match(revalidateSource, /accessGateOpen = false;\s*\n\s*refreshAvatar\(\);/,
    '验证成功后必须复位单实例标记并刷新头像');
  assert.match(revalidateSource, /render\(prepareHashNavigation\(\)\);/, '验证成功后只恢复当前路由');
  assert.equal(
    (appSource.match(/addEventListener\('jmw-access-required'/g) || []).length, 1,
    '重验证监听器只能注册一次',
  );
  // 冷启动顺序：本地锁先于任何网络探测（boot 内 prepareAdvancedRuntime/isLocalAppLocked
  // 先于 /api/me fetch）。
  const bootStart = appSource.indexOf('async function boot()');
  const bootSource = appSource.slice(bootStart, appSource.indexOf('let avatarRefreshSeq', bootStart));
  const lockPos = bootSource.indexOf('prepareAdvancedRuntime()');
  const lockCheckPos = bootSource.indexOf('isLocalAppLocked()');
  const probePos = bootSource.indexOf("fetch('/api/me'");
  assert.ok(lockPos >= 0 && lockCheckPos > lockPos && probePos > lockCheckPos,
    '冷启动必须先装本地锁运行时再探测网络');

  console.log('auth guard origin/proxy/401 wiring all pass');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
