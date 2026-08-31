'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
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
const {
  ApiError, upstreamRequest, assertPublicUrl, positiveTimeout,
  MAX_API_RESPONSE_BYTES, BUILTIN_API_HOSTS,
} = require('../lib/jm-api');
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

async function withProtectedServer(run) {
  const protectedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-protected-test-'));
  const entry = path.join(__dirname, '..', 'server.js');
  const script = `
    const { server } = require(${JSON.stringify(entry)});
    server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
    process.on('message', (message) => {
      if (message === 'close') server.close(() => process.exit(0));
    });
  `;
  const child = spawn(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ACCESS_PASSWORD: 'protected-test-password',
      JMW_DATA_DIR: protectedDataDir,
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    const protectedPort = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`protected server start timeout: ${stderr}`)), 5000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`protected server exited early (${code ?? signal}): ${stderr}`));
      });
      child.once('message', (message) => {
        if (!message || !Number.isInteger(message.port)) return;
        clearTimeout(timer);
        resolve(message.port);
      });
    });
    await run(protectedPort);
  } finally {
    if (child.exitCode === null && child.connected) child.send('close');
    if (child.exitCode === null) {
      await new Promise((resolve) => {
        let timer;
        const finish = () => { clearTimeout(timer); resolve(); };
        child.once('exit', finish);
        timer = setTimeout(() => { child.kill(); finish(); }, 3000);
        if (child.exitCode !== null) finish();
      });
    }
    fs.rmSync(protectedDataDir, { recursive: true, force: true });
  }
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
    assert.strictEqual(
      features.normalizeGithubReleaseUrl('owner/repo', 'https://github.com/owner/repo/releases/tag/v1.2.3'),
      'https://github.com/owner/repo/releases/tag/v1.2.3'
    );
    for (const unsafeReleaseUrl of [
      'http://github.com/owner/repo/releases',
      'https://evil.example/owner/repo/releases',
      'https://github.com/other/repo/releases',
      'https://user:pass@github.com/owner/repo/releases',
    ]) assert.strictEqual(features.normalizeGithubReleaseUrl('owner/repo', unsafeReleaseUrl), '');

    // 更新检查以 200 降级时也不能把 DNS/TLS/代理底层错误塞进 message；
    // 详细信息只进入服务端 stderr，浏览器获得稳定通用文案。
    const originalLookup = require('dns').promises.lookup;
    const originalRepo = process.env.JMW_UPDATE_REPO;
    const originalConsoleErrorForUpdate = console.error;
    const updateSecret = 'PRIVATE_UPDATE_DNS_DETAIL_6c19';
    let updateDiagnostic = '';
    require('dns').promises.lookup = async () => { throw new Error(updateSecret); };
    process.env.JMW_UPDATE_REPO = 'owner/repo';
    console.error = (...args) => { updateDiagnostic += args.map(String).join(' '); };
    let degradedUpdate;
    try {
      degradedUpdate = await features.checkUpdate();
    } finally {
      require('dns').promises.lookup = originalLookup;
      if (originalRepo === undefined) delete process.env.JMW_UPDATE_REPO;
      else process.env.JMW_UPDATE_REPO = originalRepo;
      console.error = originalConsoleErrorForUpdate;
    }
    assert.strictEqual(degradedUpdate.message, '更新检查暂时不可用，请稍后重试。');
    assert.ok(!JSON.stringify(degradedUpdate).includes(updateSecret));
    assert.ok(updateDiagnostic.includes(updateSecret));
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
    assert.deepStrictEqual(BUILTIN_API_HOSTS.slice(0, 2), [
      'https://www.cdngwc.net',
      'https://www.cdngwc.cc',
    ]);

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

    // 根级与资源目录的静态 404 都必须禁止负缓存；否则 CDN 可能在
    // 新版本资源已经上线后继续命中旧的 404。
    for (const pathname of ['/__missing_release_asset__.js', '/js/__missing_release_asset__.js']) {
      response = await originalFetch(`http://127.0.0.1:${port}${pathname}`);
      assert.strictEqual(response.status, 404, pathname);
      assert.strictEqual(response.headers.get('cache-control'), 'no-store', pathname);
      assert.match(response.headers.get('content-type') || '', /^text\/plain\b/i, pathname);
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
    const publicConfig = await response.json();
    assert.deepStrictEqual(publicConfig.advanced.doh, { available: true });
    assert.ok(!JSON.stringify(publicConfig).includes('customUrl'), '公共配置不得泄露自定义 DoH 地址');
    response = await originalFetch(`http://127.0.0.1:${port}/api/config/api-host`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sidCookie },
      body: JSON.stringify({ apiHost: settings.apiHosts()[0] }),
    });
    assert.strictEqual(response.status, 200);

    // 所有读取具名字段的 JSON POST 路由都必须把顶层 null 统一拒绝为 400，
    // 不能因 body.foo 触发 TypeError 并变成 500。
    const nullBodyRoutes = [
      'config/api-host', 'auth', 'login', 'daily_chk', 'comment',
      'comment_vote', 'favorite_folder', 'history/delete', 'ai/search',
    ];
    for (const route of nullBodyRoutes) {
      response = await originalFetch(`http://127.0.0.1:${port}/api/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: sidCookie },
        body: 'null',
      });
      assert.strictEqual(response.status, 400, `${route} null body`);
      assert.match((await response.json()).error, /JSON 对象/, route);
    }
    // 数组及 JSON 原始值同样不是接口契约中的对象。
    for (const rawBody of ['[]', '"text"', '123', 'true']) {
      response = await originalFetch(`http://127.0.0.1:${port}/api/daily_chk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: sidCookie },
        body: rawBody,
      });
      assert.strictEqual(response.status, 400, rawBody);
      assert.match((await response.json()).error, /JSON 对象/, rawBody);
    }
    response = await originalFetch(`http://127.0.0.1:${port}/api/daily_chk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sidCookie },
      body: '{',
    });
    assert.strictEqual(response.status, 400);
    assert.match((await response.json()).error, /合法 JSON/);
    response = await originalFetch(`http://127.0.0.1:${port}/api/daily_chk`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Cookie: sidCookie },
      body: '{}',
    });
    assert.strictEqual(response.status, 415);
    assert.match((await response.json()).error, /application\/json/);

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
      headers: { 'Content-Type': 'application/json', Cookie: sidCookie },
    });
    dohState = await response.json();
    assert.strictEqual(dohState.enabled, true);
    assert.strictEqual(dohState.current, 'aliyun');

    // 配置契约必须使用真正的 JSON boolean；字符串 "false" 不能被
    // JavaScript truthy coercion 误当成启用，且失败请求不得改变现有状态。
    for (const invalid of [
      { enabled: 'false' }, { autoStart: 0 }, { preferIpv6: 'true' },
      { provider: false }, { customName: {} }, { customUrl: [] },
    ]) {
      response = await originalFetch(`http://127.0.0.1:${port}/api/doh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: sidCookie },
        body: JSON.stringify(invalid),
      });
      assert.strictEqual(response.status, 400, JSON.stringify(invalid));
      assert.strictEqual(features.getDohState().enabled, true, JSON.stringify(invalid));
      assert.strictEqual(features.getDohState().current, 'aliyun', JSON.stringify(invalid));
    }
    response = await originalFetch(`http://127.0.0.1:${port}/api/doh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sidCookie },
      body: JSON.stringify({
        enabled: false,
        provider: 'aliyun',
        customName: 'PRIVATE_DOH_NAME_91ad',
        customUrl: 'https://dns.example/dns-query',
      }),
    });
    assert.strictEqual(response.status, 200);

    // 未配置 ACCESS_PASSWORD 时，本机仍可管理全局 DoH；任何代理链都必须
    // fail closed，容器/NAT/反向代理部署需显式配置访问口令。
    for (const forwardedFor of ['198.51.100.77', 'not-an-ip', '']) {
      response = await originalFetch(`http://127.0.0.1:${port}/api/doh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': forwardedFor },
        body: JSON.stringify({ enabled: true, provider: 'google' }),
      });
      assert.strictEqual(response.status, 403, forwardedFor);
      assert.strictEqual(response.headers.get('set-cookie'), null, forwardedFor);
    }
    assert.strictEqual(features.getDohState().enabled, false, '远端请求不得改变全局 DoH 状态');

    const evilHostRaw = await rawRequest(port,
      'GET /api/logs HTTP/1.1\r\nHost: evil.example\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n');
    assert.match(evilHostRaw, /^HTTP\/1\.1 403 /, '非回环 Host 必须拒绝，防止 DNS rebinding');
    for (const host of [`localhost:${port}`, `[::1]:${port}`]) {
      const loopbackHostRaw = await rawRequest(port,
        `GET /api/logs HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n`);
      assert.match(loopbackHostRaw, /^HTTP\/1\.1 200 /, `规范回环 Host 应允许：${host}`);
    }
    const blockedOperationHeaders = [
      { Origin: 'http://evil.example', 'Content-Type': 'application/json' },
      { 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' },
      { Forwarded: 'for=198.51.100.4', 'Content-Type': 'application/json' },
      { 'X-Real-IP': '198.51.100.5', 'Content-Type': 'application/json' },
      { 'CF-Connecting-IP': '198.51.100.6', 'Content-Type': 'application/json' },
      { 'X-Forwarded-Host': '127.0.0.1', 'Content-Type': 'application/json' },
      { 'X-Forwarded-Proto': 'http', 'Content-Type': 'application/json' },
      { 'X-Forwarded-Port': '3210', 'Content-Type': 'application/json' },
      { Via: '1.1 proxy.example', 'Content-Type': 'application/json' },
    ];
    for (const headers of blockedOperationHeaders) {
      response = await originalFetch(`http://127.0.0.1:${port}/api/logs`, { headers });
      assert.strictEqual(response.status, 403, JSON.stringify(headers));
      assert.strictEqual(response.headers.get('set-cookie'), null, JSON.stringify(headers));
    }
    response = await originalFetch(`http://127.0.0.1:${port}/api/doh`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    });
    assert.strictEqual(response.status, 415, '本机 JSON 运维写操作必须拒绝 simple text/plain');
    response = await originalFetch(`http://127.0.0.1:${port}/api/doh`, {
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.8' },
    });
    assert.strictEqual(response.status, 200, '普通网络页仍应能读取脱敏 DoH 摘要');
    const restrictedDoh = await response.json();
    assert.strictEqual(restrictedDoh.restricted, true);
    assert.strictEqual(restrictedDoh.customName, '');
    assert.strictEqual(restrictedDoh.customUrl, '');
    assert.ok(!JSON.stringify(restrictedDoh).includes('PRIVATE_DOH_NAME_91ad'));
    assert.ok(!JSON.stringify(restrictedDoh).includes('dns.example'));
    response = await originalFetch(`http://127.0.0.1:${port}/api/doh/test`, {
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.8' },
    });
    assert.strictEqual(response.status, 403, 'DoH 测试同样属于运维边界');

    // 未知服务端异常需要保留本机诊断信息，但 500 响应不得回显内部错误详情。
    const originalGetDohState = features.getDohState;
    const originalConsoleError = console.error;
    const sensitiveMarker = 'INTERNAL_ONLY_ERROR_DETAIL_7f3e';
    let diagnosticOutput = '';
    features.getDohState = () => { throw new Error(sensitiveMarker); };
    console.error = (...args) => { diagnosticOutput += args.map(String).join(' '); };
    try {
      response = await originalFetch(`http://127.0.0.1:${port}/api/doh`, {
        headers: { 'Content-Type': 'application/json', Cookie: sidCookie },
      });
    } finally {
      features.getDohState = originalGetDohState;
      console.error = originalConsoleError;
    }
    assert.strictEqual(response.status, 500);
    const internalErrorBody = await response.text();
    assert.deepStrictEqual(JSON.parse(internalErrorBody), { error: '服务器内部错误' });
    assert.ok(!internalErrorBody.includes(sensitiveMarker));
    assert.ok(diagnosticOutput.includes(sensitiveMarker), '服务端日志应保留内部异常诊断');

    // ApiError 也可能包装上游/内部原文；5xx 默认不可公开，只有显式 expose 才允许回显。
    const apiErrorMarker = 'UPSTREAM_API_ERROR_DETAIL_4b9c';
    diagnosticOutput = '';
    features.getDohState = () => { throw new ApiError(apiErrorMarker, 502); };
    console.error = (...args) => { diagnosticOutput += args.map(String).join(' '); };
    try {
      response = await originalFetch(`http://127.0.0.1:${port}/api/doh`, {
        headers: { 'Content-Type': 'application/json', Cookie: sidCookie },
      });
    } finally {
      features.getDohState = originalGetDohState;
      console.error = originalConsoleError;
    }
    assert.strictEqual(response.status, 502);
    const apiErrorBody = await response.text();
    assert.deepStrictEqual(JSON.parse(apiErrorBody), { error: '服务器内部错误' });
    assert.ok(!apiErrorBody.includes(apiErrorMarker));
    assert.ok(diagnosticOutput.includes(apiErrorMarker), '未公开 ApiError 仍应写入服务端诊断');

    const invalidStatusMarker = 'INVALID_UPSTREAM_STATUS_2d11';
    features.getDohState = () => { throw new ApiError(invalidStatusMarker, '400.5'); };
    console.error = () => {};
    try {
      response = await originalFetch(`http://127.0.0.1:${port}/api/doh`, {
        headers: { 'Content-Type': 'application/json', Cookie: sidCookie },
      });
    } finally {
      features.getDohState = originalGetDohState;
      console.error = originalConsoleError;
    }
    assert.strictEqual(response.status, 502, '畸形上游 code 必须规范化，不能传给 writeHead');
    assert.deepStrictEqual(await response.json(), { error: '服务器内部错误' });
    response = await originalFetch(`http://127.0.0.1:${port}/healthz`);
    assert.strictEqual(response.status, 200, '畸形错误码后服务必须仍存活');

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
    response = await authAttempt('203.0.113.11', 'wrong');
    assert.strictEqual(response.status, 401, '反代后的不同客户不应共享限流桶');
    assert.strictEqual(response.headers.get('set-cookie'), null, '未配置口令时不得签发空口令令牌');

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

    // 图片代理有自己的局部 catch；内部/上游 ApiError 5xx 同样不得绕过中央脱敏策略。
    const imagePrivateMarker = 'PRIVATE_IMAGE_FAILURE_82ce';
    let imageDiagnostics = '';
    const imageConsoleError = console.error;
    global.fetch = async () => { throw new ApiError(imagePrivateMarker, 502); };
    features.dohLookup = publicDns;
    console.error = (...args) => { imageDiagnostics += args.map(String).join(' '); };
    try {
      response = await originalFetch(`http://127.0.0.1:${port}/api/img?u=${encodeURIComponent(`${settings.imageHosts()[0]}/private.png`)}`);
      assert.strictEqual(response.status, 502);
      const directImageError = await response.text();
      assert.deepStrictEqual(JSON.parse(directImageError), { error: '图片获取失败' });
      assert.ok(!directImageError.includes(imagePrivateMarker));

      response = await originalFetch(`http://127.0.0.1:${port}/api/img?path=${encodeURIComponent('/media/private.png')}`);
      assert.strictEqual(response.status, 502);
      const pathImageError = await response.text();
      assert.deepStrictEqual(JSON.parse(pathImageError), { error: '图片获取失败' });
      assert.ok(!pathImageError.includes(imagePrivateMarker));
    } finally {
      console.error = imageConsoleError;
      global.fetch = originalFetch;
      features.dohLookup = originalDohLookup;
    }
    assert.ok(imageDiagnostics.includes(imagePrivateMarker), '图片内部错误仍应保留服务端诊断');

    // 日志接口属于实例级运维能力：远端客户不可读、不可清空；本机默认可用。
    features.addLog('info', 'OPERATIONAL_BOUNDARY_MARKER');
    for (const method of ['GET', 'DELETE']) {
      response = await originalFetch(`http://127.0.0.1:${port}/api/logs`, {
        method,
        headers: { 'X-Forwarded-For': '198.51.100.88' },
      });
      assert.strictEqual(response.status, 403, `remote logs ${method}`);
      assert.strictEqual(response.headers.get('set-cookie'), null, `remote logs ${method}`);
    }
    response = await originalFetch(`http://127.0.0.1:${port}/api/logs`, {
      headers: { Cookie: sidCookie },
    });
    assert.strictEqual(response.status, 200);
    assert.ok((await response.json()).logs.some((x) => x.message === 'OPERATIONAL_BOUNDARY_MARKER'));

    // API 请求会进入有界内存日志；DELETE 清空旧日志，但自身审计记录仍应保留。
    response = await originalFetch(`http://127.0.0.1:${port}/api/logs`, {
      method: 'DELETE', headers: { Cookie: sidCookie },
    });
    assert.strictEqual(response.status, 200);
    const querySecret = 'QUERY_SECRET_43fd9b';
    response = await originalFetch(`http://127.0.0.1:${port}/api/config?token=${querySecret}&q=private`, {
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
    assert.ok(!JSON.stringify(logResult.logs).includes(querySecret), '访问日志不得记录原始查询串');
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

    // 配置 ACCESS_PASSWORD 后，运维接口必须先通过口令；通过口令的远端
    // 管理员仍可正常读取日志和修改 DoH，不被“仅本机”默认策略误伤。
    await withProtectedServer(async (protectedPort) => {
      const protectedBase = `http://127.0.0.1:${protectedPort}`;
      const remoteHeaders = { 'X-Forwarded-For': '198.51.100.99' };
      let protectedResponse = await originalFetch(`${protectedBase}/api/logs`, {
        headers: remoteHeaders,
      });
      assert.strictEqual(protectedResponse.status, 401);
      protectedResponse = await originalFetch(`${protectedBase}/api/doh`, {
        method: 'POST',
        headers: { ...remoteHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, provider: 'google' }),
      });
      assert.strictEqual(protectedResponse.status, 401);

      protectedResponse = await originalFetch(`${protectedBase}/api/auth`, {
        method: 'POST',
        headers: { ...remoteHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'protected-test-password' }),
      });
      assert.strictEqual(protectedResponse.status, 200);
      const authCookie = (protectedResponse.headers.get('set-cookie') || '').split(';', 1)[0];
      assert.match(authCookie, /^jmw_auth=[a-f0-9]{64}$/);

      protectedResponse = await originalFetch(`${protectedBase}/api/logs`, {
        headers: { ...remoteHeaders, Cookie: authCookie },
      });
      assert.strictEqual(protectedResponse.status, 200);
      protectedResponse = await originalFetch(`${protectedBase}/api/doh`, {
        method: 'POST',
        headers: { ...remoteHeaders, Cookie: authCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, provider: 'google' }),
      });
      assert.strictEqual(protectedResponse.status, 200);
      assert.strictEqual((await protectedResponse.json()).enabled, true);
    });

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

    // 退役分流常只剩 Web/停放路由并对 API 返回 404/410；幂等 GET
    // 必须换线，非幂等 POST 不得因此重放。
    for (const retiredStatus of [404, 410]) {
      calls = [];
      global.fetch = async (url, opts) => {
        calls.push(url);
        return calls.length === 1
          ? new Response('retired', { status: retiredStatus })
          : encryptedResponse(opts.headers.token, { marker: `retired-${retiredStatus}-ok` });
      };
      result = await upstreamRequest({
        path: '/promote', hosts: ['https://retired.example', 'https://live.example'],
        jar: { cookies: {} }, cookieHosts: [], dnsLookup: publicDns,
      });
      assert.strictEqual(calls.length, 2);
      assert.strictEqual(result.data.marker, `retired-${retiredStatus}-ok`);
    }

    calls = [];
    global.fetch = async (url) => { calls.push(url); return new Response('retired', { status: 404 }); };
    await assert.rejects(
      () => upstreamRequest({
        path: '/promote', hosts: ['https://one.example', 'https://two.example'],
        jar: { cookies: {} }, cookieHosts: [], dnsLookup: publicDns,
      }),
      (error) => error.code === 502 && /线路不支持/.test(error.message)
    );
    assert.strictEqual(calls.length, 2);

    // 资源型 GET 的真实 404 必须保留，不得因全局 failover 被误报成 502。
    calls = [];
    global.fetch = async (url) => { calls.push(url); return new Response('missing', { status: 404 }); };
    await assert.rejects(
      () => upstreamRequest({
        path: '/album', query: { id: 'missing' },
        hosts: ['https://one.example', 'https://two.example'],
        jar: { cookies: {} }, cookieHosts: [], dnsLookup: publicDns,
      }),
      (error) => error.code === 404
    );
    assert.strictEqual(calls.length, 1);

    calls = [];
    global.fetch = async (url) => { calls.push(url); return new Response('retired', { status: 404 }); };
    await assert.rejects(
      () => upstreamRequest({
        method: 'POST', path: '/login', form: [],
        hosts: ['https://one.example', 'https://two.example'],
        jar: { cookies: {} }, cookieHosts: [], dnsLookup: publicDns,
      }),
      (error) => error.code === 404
    );
    assert.strictEqual(calls.length, 1);

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
