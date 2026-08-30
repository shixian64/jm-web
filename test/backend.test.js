'use strict';

const assert = require('assert');
const crypto = require('crypto');
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

const settings = require('../lib/settings');
const sessions = require('../lib/sessions');
const { upstreamRequest } = require('../lib/jm-api');
const {
  server,
  fetchImageResponse,
  readRasterImage,
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

(async () => {
  const originalFetch = global.fetch;
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

    // 端到端：healthz、method allowlist 与畸形请求目标。
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    let response = await originalFetch(`http://127.0.0.1:${port}/healthz`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get('set-cookie'), null);
    assert.deepStrictEqual(await response.json(), { ok: true });
    assert.strictEqual(sessionFileCount(), 0);

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
    const sidCookie = response.headers.get('set-cookie').split(';', 1)[0];
    response = await originalFetch(`http://127.0.0.1:${port}/api/config/api-host`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sidCookie },
      body: JSON.stringify({ apiHost: settings.apiHosts()[0] }),
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

    for (let i = 0; i < 2005; i++) sessions.createJar();
    sessions.flushAll();
    assert.ok(sessionFileCount() <= 2000, `session files: ${sessionFileCount()}`);

    console.log('backend security/regression all pass');
  } finally {
    global.fetch = originalFetch;
    await closeServer();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
