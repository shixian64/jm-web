'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { EventEmitter, once } = require('events');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-backend-test-'));
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
  apiHost: 123,
  customApiHosts: {},
  extraImageHosts: {},
  imgHost: [],
}));
process.env.JMW_DATA_DIR = dataDir;
delete process.env.ACCESS_PASSWORD;
delete process.env.JM_API_BASE;
delete process.env.AI_API_KEY;
delete process.env.TAVILY_API_KEY;
process.env.JMW_TRUST_PROXY = '10.0.0.0/8';
process.env.JM_TIMEOUT = '80';
process.env.JM_TOTAL_TIMEOUT = '160';
process.env.JMW_MAX_IMAGE_BYTES = String(1 << 20);
process.env.JMW_MAX_API_RESPONSE_BYTES = String(1 << 20);

const settings = require('../lib/settings');
const sessions = require('../lib/sessions');
const features = require('../lib/features');
const { upstreamRequest, assertPublicUrl, positiveTimeout, MAX_API_RESPONSE_BYTES } = require('../lib/jm-api');
const {
  server,
  bindClientAbort,
  clientIp,
  requestIsSecure,
  rateLimit,
  fetchImageResponse,
  readRasterImage,
  imageCacheControl,
  sendUpstreamImage,
  proxyEventStream,
  MAX_IMAGE_BYTES,
} = require('../server');

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

function encryptedResponse(token, value) {
  const cipher = crypto.createCipheriv('aes-256-ecb', Buffer.from(token, 'utf8'), null);
  cipher.setAutoPadding(true);
  const data = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(value))),
    cipher.final(),
  ]).toString('base64');
  return new Response(JSON.stringify({ code: 200, data }), { status: 200 });
}

function sessionFileCount() {
  return fs.readdirSync(path.join(dataDir, 'sessions')).filter((x) => x.endsWith('.json')).length;
}

async function rawRequest(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const chunks = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('raw request timeout'));
    }, 3000);
    socket.on('connect', () => socket.write(request));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('latin1'));
    });
  });
}

async function closeServer() {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

class MockServerResponse extends EventEmitter {
  constructor(backpressureOnce = false, autoDrain = true) {
    super();
    this.backpressureOnce = backpressureOnce;
    this.autoDrain = autoDrain;
    this.destroyed = false;
    this.headersSent = false;
    this.writableEnded = false;
    this.chunks = [];
  }

  writeHead(status, headers) {
    this.statusCode = status;
    this.headers = headers;
    this.headersSent = true;
  }

  write(chunk) {
    const copy = Buffer.from(chunk);
    this.chunks.push(copy);
    this.emit('write', copy);
    if (this.backpressureOnce) {
      this.backpressureOnce = false;
      if (this.autoDrain) setImmediate(() => this.emit('drain'));
      return false;
    }
    return true;
  }

  end(chunk) {
    if (chunk) this.chunks.push(Buffer.from(chunk));
    this.writableEnded = true;
    this.emit('finish');
  }

  destroy() {
    this.destroyed = true;
    this.emit('close');
  }
}

(async () => {
  const originalFetch = global.fetch;
  const originalOutboundFetch = features.outboundFetch;
  // 业务路由测试使用可控 fetch 桩；真实 TLS/lookup 行为由 https-fetch.test.js 覆盖。
  features.outboundFetch = (input, init) => global.fetch(input, init);
  try {
    // settings.json 类型损坏时应回退到安全值。
    assert.deepStrictEqual(settings.get().customApiHosts, []);
    assert.deepStrictEqual(settings.get().extraImageHosts, []);
    for (const host of [
      'http://example.com', 'https://localhost', 'https://127.0.0.1',
      'https://10.0.0.1', 'https://169.254.169.254', 'https://[::1]',
      'https://user:pass@example.com', 'https://example.com/path',
    ]) assert.strictEqual(settings.normalizeHost(host), '', host);
    assert.strictEqual(settings.normalizeHost('example.com'), 'https://example.com');
    assert.strictEqual(settings.isTrustedApiHost('https://example.com'), false);
    assert.strictEqual(settings.isTrustedApiHost(settings.apiHosts()[0]), true);
    await assert.rejects(
      () => assertPublicUrl('https://198.18.0.1/'),
      (error) => error.code === 403,
      'RFC 2544 内部/基准测试网段不得作为公网出站目标'
    );

    // JM_API_BASE 锁定是强制出站边界，任何 dataSource 都不得回退内置域名。
    settings.setEnvApiHosts(['https://locked.example']);
    for (const source of ['builtin', 'network', 'mixed']) {
      assert.deepStrictEqual(settings.apiHostsForSource(source, ''), ['https://locked.example']);
    }
    assert.deepStrictEqual(settings.allDataSourceHosts(), ['https://locked.example']);
    settings.setEnvApiHosts([]);

    // 非法、非正数或超大的超时配置不得变成无界 DNS 等待或触发 RangeError。
    for (const value of [undefined, '', 'nope', '-1', '0', 'Infinity']) {
      assert.strictEqual(positiveTimeout(value, 20000), 20000, String(value));
    }
    assert.strictEqual(positiveTimeout('80.9', 20000), 80);
    assert.strictEqual(positiveTimeout(String(Number.MAX_SAFE_INTEGER), 20000), 0x7fffffff);

    // 直连对端不采信 XFF；只有环回或 JMW_TRUST_PROXY 显式配置的对端可剥离代理链。
    assert.strictEqual(clientIp({
      socket: { remoteAddress: '198.51.100.20' },
      headers: { 'x-forwarded-for': '203.0.113.20' },
    }), '198.51.100.20');
    assert.strictEqual(clientIp({
      socket: { remoteAddress: '10.1.2.3' },
      headers: { 'x-forwarded-for': '203.0.113.20, 10.9.8.7' },
    }), '203.0.113.20');
    assert.strictEqual(clientIp({
      socket: { remoteAddress: '10.1.2.3' },
      headers: { 'x-forwarded-for': 'not-an-ip' },
    }), '10.1.2.3');
    assert.strictEqual(requestIsSecure({ socket: { encrypted: true }, headers: {} }), true);
    assert.strictEqual(requestIsSecure({
      socket: { remoteAddress: '198.51.100.20' }, headers: { 'x-forwarded-proto': 'https' },
    }), false, '不可信直连不得伪造 X-Forwarded-Proto');
    assert.strictEqual(requestIsSecure({
      socket: { remoteAddress: '10.1.2.3' }, headers: { 'x-forwarded-proto': 'https' },
    }), true, '可信反代明确声明 HTTPS 时使用 Secure Cookie');
    assert.strictEqual(requestIsSecure({
      socket: { remoteAddress: '10.1.2.3' }, headers: { 'x-forwarded-proto': 'https, http' },
    }), false, '拒绝含歧义链的 X-Forwarded-Proto');

    // 端到端：healthz、method allowlist 与畸形请求目标。
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    let response = await originalFetch(`http://127.0.0.1:${port}/healthz`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get('set-cookie'), null);
    assert.deepStrictEqual(await response.json(), { ok: true });
    assert.strictEqual(sessionFileCount(), 0);

    response = await originalFetch(`http://127.0.0.1:${port}/`);
    assert.strictEqual(response.status, 200);
    const csp = response.headers.get('content-security-policy') || '';
    for (const directive of ["frame-ancestors 'none'", "base-uri 'self'", "object-src 'none'", "form-action 'self'"]) {
      assert.ok(csp.includes(directive), directive);
    }

    // 静态资源和 SPA 回退的 HEAD 元数据应与 GET 一致，且绝不返回实体。
    for (const pathname of ['/js/app.js', '/a-client-route']) {
      const get = await originalFetch(`http://127.0.0.1:${port}${pathname}`);
      const getBytes = (await get.arrayBuffer()).byteLength;
      const head = await originalFetch(`http://127.0.0.1:${port}${pathname}`, { method: 'HEAD' });
      assert.strictEqual(head.status, get.status, pathname);
      assert.strictEqual(Number(head.headers.get('content-length')), getBytes, pathname);
      assert.strictEqual(head.headers.get('etag'), get.headers.get('etag'), pathname);
      assert.strictEqual((await head.arrayBuffer()).byteLength, 0, pathname);
    }

    response = await originalFetch(`http://127.0.0.1:${port}/api/logout`);
    assert.strictEqual(response.status, 405);
    assert.strictEqual(response.headers.get('allow'), 'POST');
    assert.strictEqual(response.headers.get('set-cookie'), null);
    response = await originalFetch(`http://127.0.0.1:${port}/api/config`, { method: 'POST' });
    assert.strictEqual(response.status, 405);
    assert.strictEqual(response.headers.get('allow'), 'GET');
    assert.strictEqual(sessionFileCount(), 0);

    response = await originalFetch(`http://127.0.0.1:${port}/api/config/api-host`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiHost: 'https://example.com' }),
    });
    assert.strictEqual(response.status, 400);
    const plainSetCookie = response.headers.get('set-cookie');
    assert.ok(!/;\s*Secure/i.test(plainSetCookie));
    const sidCookie = plainSetCookie.split(';', 1)[0];

    response = await originalFetch(`http://127.0.0.1:${port}/api/config`, {
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    assert.match(response.headers.get('set-cookie') || '', /;\s*Secure/i);
    response = await originalFetch(`http://127.0.0.1:${port}/api/config/api-host`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sidCookie },
      body: JSON.stringify({ apiHost: settings.apiHosts()[0] }),
    });
    assert.strictEqual(response.status, 200);

    // 评论、评论点赞和漫画点赞只能由显式 POST 触发，GET 不得误执行上游写操作。
    for (const route of ['comment', 'comment_vote', 'like']) {
      response = await originalFetch(`http://127.0.0.1:${port}/api/${route}`, {
        headers: { Cookie: sidCookie },
      });
      assert.strictEqual(response.status, 405, route);
      assert.strictEqual(response.headers.get('allow'), 'POST', route);
    }

    // 未配置密钥时 AI/联网搜索应明确返回 503，不能伪装成 500 或空流。
    response = await originalFetch(`http://127.0.0.1:${port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sidCookie },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }),
    });
    assert.strictEqual(response.status, 503);
    assert.match((await response.json()).error, /AI_API_KEY/);
    response = await originalFetch(`http://127.0.0.1:${port}/api/ai/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sidCookie },
      body: JSON.stringify({ query: 'test', provider: 'tavily' }),
    });
    assert.strictEqual(response.status, 503);
    assert.match((await response.json()).error, /TAVILY_API_KEY/);

    // DoH 选择应同时反映到 GET 接口与磁盘状态，随后关闭以免影响其余上游桩测试。
    response = await originalFetch(`http://127.0.0.1:${port}/api/doh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sidCookie },
      body: JSON.stringify({ enabled: true, provider: 'aliyun' }),
    });
    assert.strictEqual(response.status, 200);
    let dohState = await response.json();
    assert.strictEqual(dohState.enabled, true);
    assert.strictEqual(dohState.current, 'aliyun');
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(path.join(dataDir, 'features.json'), 'utf8')),
      {
        dohEnabled: true, dohAutoStart: false, dohProvider: 'aliyun',
        dohCustomName: '', dohCustomUrl: '', dohPreferIpv6: false,
      }
    );
    response = await originalFetch(`http://127.0.0.1:${port}/api/doh`, {
      headers: { Cookie: sidCookie },
    });
    dohState = await response.json();
    assert.strictEqual(dohState.enabled, true);
    assert.strictEqual(dohState.current, 'aliyun');
    response = await originalFetch(`http://127.0.0.1:${port}/api/doh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sidCookie },
      body: JSON.stringify({ enabled: false, provider: 'aliyun' }),
    });
    assert.strictEqual(response.status, 200);

    const raw = await rawRequest(port, 'GET http://[::1 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    assert.match(raw, /^HTTP\/1\.1 400 /);
    response = await originalFetch(`http://127.0.0.1:${port}/healthz`);
    assert.strictEqual(response.status, 200, '畸形 URL 后服务应存活');

    const nulPath = await rawRequest(port, 'GET /foo%00 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    assert.match(nulPath, /^HTTP\/1\.1 400 /);
    response = await originalFetch(`http://127.0.0.1:${port}/healthz`);
    assert.strictEqual(response.status, 200, '编码 NUL 路径后服务应存活');

    // 本机反代的 XFF 链从右向左剥离：客户伪造左侧 token 不能绕过限流，
    // 而另一个客户 IP 不应被全局误伤。
    const authAttempt = (xff, password) => originalFetch(`http://127.0.0.1:${port}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': xff },
      body: JSON.stringify({ password }),
    });
    for (let i = 0; i < 10; i++) {
      response = await authAttempt(`198.51.100.${i + 1}, 203.0.113.10`, 'wrong');
      assert.strictEqual(response.status, 401);
    }
    response = await authAttempt('192.0.2.200, 203.0.113.10', 'wrong');
    assert.strictEqual(response.status, 429, '伪造 XFF 左侧链不得绕过同一客户限流');
    response = await authAttempt('203.0.113.11', '');
    assert.strictEqual(response.status, 200, '反代后的不同客户不应共享限流桶');

    // 超限请求体应返回可读 413，而不是在写响应前 reset socket。
    response = await originalFetch(`http://127.0.0.1:${port}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.12' },
      body: JSON.stringify({ password: 'x'.repeat((1 << 20) + 1) }),
    });
    assert.strictEqual(response.status, 413);
    assert.match((await response.json()).error, /请求体过大/);

    // 本地收藏夹支持增、改、移动、筛选和删除，并能跨进程重载保留映射。
    const postJson = (route, body) => originalFetch(`http://127.0.0.1:${port}/api/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sidCookie },
      body: JSON.stringify(body),
    });
    response = await postJson('favorite_folder', { type: 'add', folder_name: '待读' });
    assert.strictEqual(response.status, 200);
    let folderResult = await response.json();
    const folder = folderResult.data.folder_list.find((x) => x.name === '待读');
    assert.ok(folder && /^\d{13,20}$/.test(folder.id), `folder id: ${folder && folder.id}`);

    response = await postJson('favorite_folder', {
      type: 'edit', folder_id: folder.id, folder_name: '本周待读',
    });
    assert.strictEqual(response.status, 200);
    folderResult = await response.json();
    assert.strictEqual(folderResult.data.folder_list.find((x) => x.id === folder.id).name, '本周待读');
    response = await postJson('favorite_folder', { type: 'move', aid: '123', folder_id: folder.id });
    assert.strictEqual(response.status, 200);

    sessions.flushAll();
    const sid = sidCookie.slice(sidCookie.indexOf('=') + 1);
    const storedSession = JSON.parse(fs.readFileSync(path.join(dataDir, 'sessions', `${sid}.json`), 'utf8'));
    assert.strictEqual(storedSession.favoriteFolderMap['123'], folder.id);
    delete require.cache[require.resolve('../lib/sessions')];
    const reloadedSessions = require('../lib/sessions');
    const reloadedJar = reloadedSessions.loadJar(sid);
    assert.strictEqual(reloadedJar.favoriteFolders.find((x) => x.id === folder.id).name, '本周待读');
    assert.strictEqual(reloadedJar.favoriteFolderMap['123'], folder.id);

    // 所有真实上游请求统一使用加密响应桩；同时记录 method/path/body 验证写操作。
    const originalDohLookup = features.dohLookup;
    features.dohLookup = publicDns;
    const endpointCalls = [];
    global.fetch = async (url, opts = {}) => {
      const target = new URL(String(url));
      endpointCalls.push({ target, opts });
      if (target.pathname === '/favorite') {
        return encryptedResponse(opts.headers.token, { list: [
          { id: '123', name: 'mapped' },
          { aid: '456', name: 'unmapped' },
        ] });
      }
      if (target.pathname === '/watch_list') {
        return encryptedResponse(opts.headers.token, { list: [
          { id: '123', name: 'visible' },
          { aid: '456', name: 'hidden' },
        ] });
      }
      if (target.pathname === '/comment_vote' || target.pathname === '/like') {
        return encryptedResponse(opts.headers.token, { ok: true });
      }
      throw new Error(`unexpected upstream request: ${target.href}`);
    };

    response = await originalFetch(
      `http://127.0.0.1:${port}/api/favorites?folder_id=${encodeURIComponent(folder.id)}`,
      { headers: { Cookie: sidCookie } }
    );
    assert.strictEqual(response.status, 200);
    let favorites = await response.json();
    assert.deepStrictEqual(favorites.data.list.map((x) => String(x.id || x.aid)), ['123']);
    assert.strictEqual(favorites.data.local_folder_map['123'], folder.id);
    assert.strictEqual(
      endpointCalls.find((x) => x.target.pathname === '/favorite').target.searchParams.get('folder_id'),
      '0'
    );

    response = await postJson('comment_vote', { comment_id: '77', vote_type: 'down' });
    assert.strictEqual(response.status, 200);
    const voteCall = endpointCalls.find((x) => x.target.pathname === '/comment_vote');
    assert.strictEqual(voteCall.opts.method, 'POST');
    assert.match(voteCall.opts.body.toString(), /name="comment_id"\r\n\r\n77\r\n/);
    assert.match(voteCall.opts.body.toString(), /name="vote_type"\r\n\r\ndown\r\n/);
    response = await postJson('comment_vote', { comment_id: 'oops', vote_type: 'up' });
    assert.strictEqual(response.status, 400);

    response = await originalFetch(`http://127.0.0.1:${port}/api/like?id=88`, {
      method: 'POST', headers: { Cookie: sidCookie },
    });
    assert.strictEqual(response.status, 200);
    const likeCall = endpointCalls.find((x) => x.target.pathname === '/like');
    assert.strictEqual(likeCall.opts.method, 'POST');
    assert.match(likeCall.opts.body.toString(), /name="id"\r\n\r\n88\r\n/);

    response = await postJson('history/delete', { id: '456' });
    assert.strictEqual(response.status, 200);
    response = await originalFetch(`http://127.0.0.1:${port}/api/history?page=1`, {
      headers: { Cookie: sidCookie },
    });
    assert.strictEqual(response.status, 200);
    const history = await response.json();
    assert.deepStrictEqual(history.data.list.map((x) => String(x.id || x.aid)), ['123']);
    response = await postJson('history/delete', { id: '../456' });
    assert.strictEqual(response.status, 400);

    response = await postJson('favorite_folder', { type: 'del', folder_id: folder.id });
    assert.strictEqual(response.status, 200);
    folderResult = await response.json();
    assert.deepStrictEqual(folderResult.data.folder_list.map((x) => x.id), ['0']);
    response = await postJson('favorite_folder', { type: 'move', aid: '123', folder_id: folder.id });
    assert.strictEqual(response.status, 404, '已删除收藏夹不得继续接收漫画');
    global.fetch = originalFetch;
    features.dohLookup = originalDohLookup;

    // API 请求会进入有界内存日志；DELETE 清空旧日志，但自身审计记录仍应保留。
    response = await originalFetch(`http://127.0.0.1:${port}/api/logs`, {
      method: 'DELETE', headers: { Cookie: sidCookie },
    });
    assert.strictEqual(response.status, 200);
    response = await originalFetch(`http://127.0.0.1:${port}/api/config`, {
      headers: { Cookie: sidCookie },
    });
    assert.strictEqual(response.status, 200);
    await new Promise((resolve) => setImmediate(resolve));
    response = await originalFetch(`http://127.0.0.1:${port}/api/logs?limit=2`, {
      headers: { Cookie: sidCookie },
    });
    assert.strictEqual(response.status, 200);
    let logResult = await response.json();
    assert.ok(logResult.logs.length <= 2);
    assert.ok(logResult.logs.some((x) => /GET \/api\/config -> 200/.test(x.message)));
    response = await originalFetch(`http://127.0.0.1:${port}/api/logs`, {
      method: 'DELETE', headers: { Cookie: sidCookie },
    });
    assert.strictEqual(response.status, 200);
    await new Promise((resolve) => setImmediate(resolve));
    response = await originalFetch(`http://127.0.0.1:${port}/api/logs`, {
      headers: { Cookie: sidCookie },
    });
    logResult = await response.json();
    assert.ok(logResult.logs.some((x) => /DELETE \/api\/logs -> 200/.test(x.message)));
    assert.ok(!logResult.logs.some((x) => /GET \/api\/config -> 200/.test(x.message)));

    await closeServer();

    // GET 可 failover；非幂等 POST 收到 5xx 不重放；GET 解密失败可 failover。
    let calls = [];
    global.fetch = async (url, opts) => {
      calls.push(url);
      return calls.length === 1
        ? new Response('fail', { status: 500 })
        : encryptedResponse(opts.headers.token, { marker: 'get-ok' });
    };
    let result = await upstreamRequest({
      path: '/x', hosts: ['https://one.example', 'https://two.example'],
      jar: { cookies: {} }, cookieHosts: [], dnsLookup: publicDns,
    });
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(result.data.marker, 'get-ok');

    calls = [];
    global.fetch = async (url) => { calls.push(url); return new Response('fail', { status: 500 }); };
    await assert.rejects(() => upstreamRequest({
      method: 'POST', path: '/comment', form: [],
      hosts: ['https://one.example', 'https://two.example'],
      jar: { cookies: {} }, cookieHosts: [], dnsLookup: publicDns,
    }));
    assert.strictEqual(calls.length, 1);

    // Node 核心 https 的“尚未建立连接”错误把 code 放在顶层；POST 可安全换线。
    calls = [];
    global.fetch = async (url, opts) => {
      calls.push(url);
      if (calls.length === 1) throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      return encryptedResponse(opts.headers.token, { marker: 'post-connect-failover-ok' });
    };
    result = await upstreamRequest({
      method: 'POST', path: '/login', form: [],
      hosts: ['https://one.example', 'https://two.example'],
      jar: { cookiesByOrigin: {} }, cookieHosts: [], dnsLookup: publicDns,
    });
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(result.data.marker, 'post-connect-failover-ok');

    calls = [];
    global.fetch = async (url, opts) => {
      calls.push(url);
      return calls.length === 1
        ? new Response(JSON.stringify({ code: 200, data: 'bad-ciphertext' }))
        : encryptedResponse(opts.headers.token, { marker: 'decrypt-ok' });
    };
    result = await upstreamRequest({
      path: '/x', hosts: ['https://one.example', 'https://two.example'],
      jar: { cookies: {} }, cookieHosts: [], dnsLookup: publicDns,
    });
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(result.data.marker, 'decrypt-ok');

    // JSON 接口返回 HTTP 200 纯文本也应视为线路故障。
    calls = [];
    global.fetch = async (url, opts) => {
      calls.push(url);
      return calls.length === 1
        ? new Response('Access denied', { status: 200, headers: { 'Content-Type': 'text/plain' } })
        : encryptedResponse(opts.headers.token, { marker: 'plain-text-failover-ok' });
    };
    result = await upstreamRequest({
      path: '/x', hosts: ['https://one.example', 'https://two.example'],
      jar: { cookies: {} }, cookieHosts: [], dnsLookup: publicDns,
    });
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(result.data.marker, 'plain-text-failover-ok');

    // failover 前必须 cancel 未消费的错误响应体，避免连接/下载残留。
    calls = [];
    let cancelledBodies = 0;
    global.fetch = async (url, opts) => {
      calls.push(url);
      if (calls.length === 1) {
        return new Response(new ReadableStream({
          pull() {},
          cancel() { cancelledBodies++; },
        }), { status: 500 });
      }
      return encryptedResponse(opts.headers.token, { marker: 'cancel-ok' });
    };
    result = await upstreamRequest({
      path: '/x', hosts: ['https://one.example', 'https://two.example'],
      jar: { cookies: {} }, cookieHosts: [], dnsLookup: publicDns,
    });
    assert.strictEqual(result.data.marker, 'cancel-ok');
    assert.strictEqual(cancelledBodies, 1);

    // DNS 查询本身也必须受单线路/总时间预算约束。
    const neverDns = () => new Promise(() => {});
    const apiDnsStarted = Date.now();
    await assert.rejects(
      () => upstreamRequest({
        path: '/x', hosts: ['https://one.example'],
        jar: { cookies: {} }, cookieHosts: [], dnsLookup: neverDns,
      }),
      (error) => error.code === 504 && /DNS 解析超时/.test(error.message)
    );
    assert.ok(Date.now() - apiDnsStarted < 1000, 'API DNS 不得超过时间预算悬挂');

    let leakedCookie = '';
    global.fetch = async (_url, opts) => {
      leakedCookie = opts.headers.Cookie || '';
      return new Response('', { status: 401 });
    };
    await assert.rejects(() => upstreamRequest({
      path: '/x', hosts: ['https://untrusted.example'],
      jar: { cookies: { AVS: 'secret' } }, cookieHosts: ['https://trusted.example'], dnsLookup: publicDns,
    }));
    assert.strictEqual(leakedCookie, '');

    // 接收与发送 Cookie 都必须按精确 origin 隔离，受信候选之间也不得串线。
    const isolatedJar = { cookiesByOrigin: {} };
    global.fetch = async (_url, opts) => {
      leakedCookie = opts.headers.Cookie || '';
      const responseWithCookie = encryptedResponse(opts.headers.token, { marker: 'cookie-stored' });
      Object.defineProperty(responseWithCookie.headers, 'getSetCookie', {
        configurable: true,
        value: () => ['AVS=origin-secret; Path=/; HttpOnly'],
      });
      return responseWithCookie;
    };
    result = await upstreamRequest({
      path: '/x', hosts: ['https://trusted.example'], jar: isolatedJar,
      cookieHosts: ['https://trusted.example', 'https://other.example'], dnsLookup: publicDns,
    });
    assert.strictEqual(result.data.marker, 'cookie-stored');
    assert.strictEqual(leakedCookie, '');
    assert.strictEqual(isolatedJar.cookiesByOrigin['https://trusted.example'].AVS, 'origin-secret');

    global.fetch = async (_url, opts) => {
      leakedCookie = opts.headers.Cookie || '';
      return new Response('', { status: 401 });
    };
    await assert.rejects(() => upstreamRequest({
      path: '/x', hosts: ['https://other.example'], jar: isolatedJar,
      cookieHosts: ['https://trusted.example', 'https://other.example'], dnsLookup: publicDns,
    }));
    assert.strictEqual(leakedCookie, '', '一个受信 origin 的 Cookie 不得发送给另一个受信 origin');
    await assert.rejects(() => upstreamRequest({
      path: '/x', hosts: ['https://trusted.example'], jar: isolatedJar,
      cookieHosts: ['https://trusted.example', 'https://other.example'], dnsLookup: publicDns,
    }));
    assert.strictEqual(leakedCookie, 'AVS=origin-secret');

    calls = [];
    global.fetch = async (url) => { calls.push(url); return new Response('x'); };
    await assert.rejects(
      () => upstreamRequest({
        path: '/x', hosts: ['https://trusted.example'], jar: { cookies: {} },
        cookieHosts: ['https://trusted.example'],
        dnsLookup: async () => [{ address: '10.0.0.8', family: 4 }],
      }),
      (error) => error.code === 403
    );
    assert.strictEqual(calls.length, 0, 'API DNS 解析到私网时不得执行 fetch');

    // 图片重定向每跳白名单验证；拒绝 HTML/SVG/超大体。
    calls = [];
    global.fetch = async (url) => {
      calls.push(url);
      return new Response('', { status: 302, headers: { Location: 'https://evil.example/final' } });
    };
    await assert.rejects(
      () => fetchImageResponse(`${settings.imageHosts()[0]}/a`, 1000, publicDns),
      (error) => error.code === 403
    );
    assert.strictEqual(calls.length, 1);
    calls = [];
    global.fetch = async (url) => { calls.push(url); return new Response('x'); };
    await assert.rejects(
      () => fetchImageResponse(`${settings.imageHosts()[0]}/a`, 1000, async () => [{ address: '127.0.0.1', family: 4 }]),
      (error) => error.code === 403
    );
    assert.strictEqual(calls.length, 0, '解析到私网时不得执行 fetch');
    const imageDnsStarted = Date.now();
    await assert.rejects(
      () => fetchImageResponse(`${settings.imageHosts()[0]}/a`, 50, neverDns),
      (error) => error.code === 504 && /DNS 解析超时/.test(error.message)
    );
    assert.ok(Date.now() - imageDnsStarted < 500, '图片 DNS 不得超过该请求 deadline 悬挂');

    // 客户端在 fetch 返回 headers 前断开时，必须立即中止上游而非占用图片并发槽到 deadline。
    let fetchStarted;
    const fetchStartedPromise = new Promise((resolve) => { fetchStarted = resolve; });
    let observedFetchSignal;
    global.fetch = async (_url, opts) => {
      observedFetchSignal = opts.signal;
      fetchStarted();
      return new Promise((_, reject) => {
        const rejectAbort = () => reject(opts.signal.reason || new Error('aborted'));
        if (opts.signal.aborted) rejectAbort();
        else opts.signal.addEventListener('abort', rejectAbort, { once: true });
      });
    };
    const preHeaderRes = new MockServerResponse();
    const preHeaderAbort = bindClientAbort(preHeaderRes);
    const preHeaderRequest = fetchImageResponse(
      `${settings.imageHosts()[0]}/a`, 1000, publicDns, preHeaderAbort.signal
    );
    await fetchStartedPromise;
    preHeaderRes.destroy();
    await assert.rejects(
      () => preHeaderRequest,
      (error) => error.code === 'JMW_CLIENT_DISCONNECTED'
    );
    assert.strictEqual(observedFetchSignal.aborted, true);
    preHeaderAbort.cleanup();

    // DNS 尚未返回时断开也应立即结束等待（底层系统 lookup 可能继续，但请求不再被它占用）。
    let dnsStarted;
    const dnsStartedPromise = new Promise((resolve) => { dnsStarted = resolve; });
    const pendingDns = () => {
      dnsStarted();
      return new Promise(() => {});
    };
    const preDnsRes = new MockServerResponse();
    const preDnsAbort = bindClientAbort(preDnsRes);
    const preDnsRequest = fetchImageResponse(
      `${settings.imageHosts()[0]}/a`, 1000, pendingDns, preDnsAbort.signal
    );
    await dnsStartedPromise;
    const dnsAbortStarted = Date.now();
    preDnsRes.destroy();
    await assert.rejects(
      () => preDnsRequest,
      (error) => error.code === 'JMW_CLIENT_DISCONNECTED'
    );
    assert.ok(Date.now() - dnsAbortStarted < 200, '客户端断开后不得继续等待 DNS');
    preDnsAbort.cleanup();

    for (const mime of ['text/html', 'image/svg+xml']) {
      await assert.rejects(
        () => readRasterImage(new Response('x', { headers: { 'Content-Type': mime } })),
        (error) => error.code === 415
      );
    }
    await assert.rejects(
      () => readRasterImage(new Response('x', { headers: {
        'Content-Type': 'image/png',
        'Content-Length': String(MAX_IMAGE_BYTES + 1),
      } })),
      (error) => error.code === 413
    );

    assert.strictEqual(imageCacheControl(7, false), 'public, max-age=604800, immutable');
    assert.strictEqual(imageCacheControl(7, true), 'private, max-age=604800, immutable');

    // 图片转发应在上游完整结束前就写出首块，并遵循 drain 背压。
    let releaseImage;
    const streamed = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('first-'));
        releaseImage = () => {
          controller.enqueue(new TextEncoder().encode('second'));
          controller.close();
        };
      },
    }), { headers: { 'Content-Type': 'image/png' } });
    const streamedRes = new MockServerResponse(true);
    const firstWrite = once(streamedRes, 'write');
    const streamingPromise = sendUpstreamImage(streamedRes, streamed, 1);
    const [firstChunk] = await firstWrite;
    assert.strictEqual(firstChunk.toString(), 'first-');
    assert.strictEqual(streamedRes.writableEnded, false, '首块应在上游结束前写出');
    assert.strictEqual(streamedRes.headers['Content-Length'], undefined);
    releaseImage();
    await streamingPromise;
    assert.strictEqual(Buffer.concat(streamedRes.chunks).toString(), 'first-second');
    assert.strictEqual(streamedRes.writableEnded, true);

    // 下游停止读取且不断开时，drain 等待必须有界并取消上游。
    let stalledCancelled = 0;
    const stalled = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('blocked'));
      },
      cancel() { stalledCancelled++; },
    }), { headers: { 'Content-Type': 'image/png' } });
    const stalledRes = new MockServerResponse(true, false);
    await assert.rejects(
      () => sendUpstreamImage(stalledRes, stalled, 1, undefined, 25),
      /\u5ba2户端读取图片超时/
    );
    assert.strictEqual(stalledCancelled, 1, '背压超时后应取消上游响应体');

    // 无 Content-Length 的流也必须按实际字节中止，且不写出越界块。
    const overLimit = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(600 * 1024));
        controller.enqueue(new Uint8Array(600 * 1024));
        controller.close();
      },
    }), { headers: { 'Content-Type': 'image/png' } });
    const limitedRes = new MockServerResponse();
    await assert.rejects(
      () => sendUpstreamImage(limitedRes, overLimit, 1),
      (error) => error.code === 413
    );
    assert.strictEqual(limitedRes.chunks.reduce((n, chunk) => n + chunk.length, 0), 600 * 1024);

    // AI 响应即使在取得 reader 前失败，也必须释放其总超时/父 signal 监听器。
    const originalCleanupResponse = features.cleanupResponse;
    let aiCleanups = 0;
    features.cleanupResponse = () => { aiCleanups++; };
    const readerError = new Error('reader unavailable');
    await assert.rejects(
      () => proxyEventStream(new MockServerResponse(), {
        body: { getReader() { throw readerError; } },
      }),
      (error) => error === readerError
    );
    assert.strictEqual(aiCleanups, 1);
    features.cleanupResponse = originalCleanupResponse;

    // 持久用户状态有独立上限，避免异常上游对象长期占据整个会话 LRU。
    assert.deepStrictEqual(sessions.sanitizeUser({ id: 1, name: 'tester' }), { id: 1, name: 'tester' });
    assert.strictEqual(sessions.sanitizeUser({ oversized: 'x'.repeat(300 * 1024) }), null);

    // logout/延迟保存不得复活文件，磁盘会话数有硬上限。
    const jar = sessions.createJar();
    sessions.flushAll();
    const jarFile = path.join(dataDir, 'sessions', `${jar.sid}.json`);
    assert.strictEqual(fs.existsSync(jarFile), true);
    sessions.destroyJar(jar.sid);
    jar.user = { uid: 'late-write' };
    sessions.scheduleSave(jar);
    sessions.flushAll();
    assert.strictEqual(fs.existsSync(jarFile), false);

    // 正在处理请求的 jar 在超过 LRU 上限时仍必须保持同一对象。
    const activeJar = sessions.createJar();
    sessions.retainJar(activeJar);
    const staleJar = sessions.createJar();
    for (let i = 0; i < 2005; i++) sessions.createJar();
    sessions.flushAll();
    assert.strictEqual(sessions.loadJar(activeJar.sid), activeJar, '在用 jar 不得被 LRU 驱逐');
    assert.strictEqual(staleJar.retired, true, '竞态样本必须先经过 LRU 驱逐');

    // 已被驱逐的旧异步引用也不得在 logout 后延迟复活文件。
    sessions.destroyJar(staleJar.sid);
    staleJar.user = { uid: 'evicted-late-write' };
    sessions.scheduleSave(staleJar);
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.strictEqual(
      fs.existsSync(path.join(dataDir, 'sessions', `${staleJar.sid}.json`)),
      false
    );
    sessions.releaseJar(activeJar);
    sessions.destroyJar(activeJar.sid);
    assert.ok(sessionFileCount() <= 2000, `session files: ${sessionFileCount()}`);

    console.log('backend security/regression all pass');
  } finally {
    global.fetch = originalFetch;
    features.outboundFetch = originalOutboundFetch;
    await closeServer();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
