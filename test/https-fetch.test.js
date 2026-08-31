'use strict';

const assert = require('assert');
const https = require('https');
const zlib = require('zlib');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { httpsFetch } = require('../lib/https-fetch');
const { readResponseText } = require('../lib/jm-api');

const KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEAupA3lCdthMe77xZrJfpURFLCdklOLjxQdc0YMUfXZBQnPOvH
N1X2xNYPDRnvAfGn6wg0q1hzt2bipM8VlKwC2r27J+2pPt3TNo6W5itcI3Y2J7Yl
FKODnRau1tlBcZL90eeSJdKhtvWgWgY1WF5jvCjGwYAHA3DBOoK5to3hUCR+N89U
8EPEa7ZvlArOeqRRBc3fsqFgpljDvCxredEhoRc95pzl27292RIR5rB4CSl+kj/2
P4QUS6aZmNgNqcZkMQio9IKauUsKGbdtIp+0gcoYjzkdd10yJAEwjWdzYeZcQj9T
Z1UlVP8pY4NOMebtdrxuLgvuVwBivZvKbvGtQQIDAQABAoIBAA23rGp/kqkscXhV
LugyNY93gVZmsfGq3CSpQaHf/Smd5LuxP2rlbnlPHviw4zbCoLzik9LUdF+0GC6T
jmvp0OTqBfCb5DGb6FuO1PAUGJh/6N/3H9daZYM/p3fjLhFuhCyyqPeQevUDrvhn
k/UNLaqoWeLg6cMaP47wjTyrxnkYsXXfQCPV13a+xhzVuuFcv2o+MOWDqdS64ROn
tFp5nyaV9uwV0rAN2w3wHmkoFRjZLGDEHA9ZzPCbg56/yPngzfjtTbURjAQUhlbz
LDoiotsoJRS6LOlyxTo8OaXdXS1JKO6vcejZ7zB6EanfaDZULuS5u2xOMuSwK9DO
e7hPrAUCgYEA9dC0UaRDUaJgFsET9eKrUmMOURGGvYUyyFHMHjDwxS8I1pzBV4Id
QcWnXhQZkjWmkn50QuhvCIUBnla2qMlb2S5SlTGSE2IFmlQvvJ221SjJj+dHpujK
9+WQehLj8MAfWzIoPLdZBxqQqe23QLl6ye9hbZDeg2h/j2YpDWyETUUCgYEAwksL
O98OEpIuGTM8j/Bu/7muAUOPQbBq4hzPks20nl0XjdC7JelKQXZk7tt5oA/7FKst
qRbH5FJXWkKFSQDjQLcSbeVuZ+I4Oc92wnIwqL7N6zl3vpbE+tnqXSSK0Bg+SVyt
dMi5IzaoxPp2NcfFeKeHnsR76e9WJuxHDeC86c0CgYEAgfjkHvbXkWZloCJex3ge
VeWCQGMf9z1iaIC3iI8f/2KrLa6cnAR0K76yjA/cpW4wsOyj1GzJqJuLC4mV8xDk
u6S+jZw0PINrqvowc26AqZxzVt9XB223Q/PhvGoYk8dBzRpsJA5dyF/HddH3PwXT
YsprnV8oCBtMtymxMyPZoHECgYBf2XuqRqj/mmPphLBM5jUsLSLddsHWizy/Xa09
ZAPF2HEFQkMBOeyrDMhQWa/PufKIyMXW0+k7BzAW1BhC4pA53dbWpkfoMd7BDkst
M/4zUSXu9EPRnzl/8z8+QgfFDyCzOmhL47YJ3C44NsNYVrxhgGxUc+QZjTv4KboH
66XmxQKBgQCa/+bksfeGgAl0Oa54nyQake7Kwwr8jgE4OL4ZyRCCqGNoPX++y3Z8
/gBEJmFeTBW/FKxw5XwK2ZelUXvb7CgRmr2xdK1b9ZZUa85/oX7JDvCzusZqi8KX
u+UteT6g7cP7J8gZ7D7shOjLXhtFXPYUAhY1mTrboOz6qJR5hzJxEg==
-----END RSA PRIVATE KEY-----`;

const CERT = `-----BEGIN CERTIFICATE-----
MIIC6jCCAdKgAwIBAgIUIXG9U5/cgdpoX3dwj5d4Vy85GAIwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTIwMDEwMTAwMDAwMFoYDzIxMjAw
MTAxMDAwMDAwWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQC6kDeUJ22Ex7vvFmsl+lREUsJ2SU4uPFB1zRgxR9dk
FCc868c3VfbE1g8NGe8B8afrCDSrWHO3ZuKkzxWUrALavbsn7ak+3dM2jpbmK1wj
djYntiUUo4OdFq7W2UFxkv3R55Il0qG29aBaBjVYXmO8KMbBgAcDcME6grm2jeFQ
JH43z1TwQ8Rrtm+UCs56pFEFzd+yoWCmWMO8LGt50SGhFz3mnOXbvb3ZEhHmsHgJ
KX6SP/Y/hBRLppmY2A2pxmQxCKj0gpq5SwoZt20in7SByhiPOR13XTIkATCNZ3Nh
5lxCP1NnVSVU/yljg04x5u12vG4uC+5XAGK9m8pu8a1BAgMBAAGjMjAwMC4GA1Ud
EQQnMCWCCWxvY2FsaG9zdIINZmFsbGJhY2sudGVzdIIJaXB2Ni50ZXN0MA0GCSqG
SIb3DQEBCwUAA4IBAQBS/pVYP3lodnnlB8vtO9yExWWw0ioIxYtaU+0zJbfBMDWf
y8vNjKfGnL3YexXzCYGO/MRoc0614zaX+lZByprrhEPCHbKXZzEF0WvGgPOnZW0d
TWdBYH+5rN8bWiqteLU36jHvaQXQ5QlQBJoRBpoQOlvHkaBzT+segjvA4p+EHDL4
Z5d+x+ldRQN4F02HnQRWZVszEoz6hrpqy5WXB/u0g6p4cMDfeGnZxN/lAPzxyijN
1h+iKdDYzfn6I4Eb5E5y9wAuyAGFD2mBK6I2smmilX6hXlNs0MRRpZKVWI8Ywg12
jjI9bBm+f8xOP0pKz7d42vD6kiI2m2WytS994Tm+
-----END CERTIFICATE-----`;

const PAYLOAD = 'streaming HTTPS response / 中文 / '.repeat(256);
const GZIP = zlib.gzipSync(Buffer.from(PAYLOAD));
const BROTLI = zlib.brotliCompressSync(Buffer.from(PAYLOAD));
const STACKED = zlib.brotliCompressSync(GZIP);
const GZIP_BOMB = zlib.gzipSync(Buffer.alloc(256 * 1024, 65));
const activeTimers = new Set();
let slow205Closed = false;

function later(fn, ms) {
  const timer = setTimeout(() => {
    activeTimers.delete(timer);
    fn();
  }, ms);
  activeTimers.add(timer);
  return timer;
}

function handler(req, res) {
  if (req.url === '/gzip') {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Encoding': 'gzip',
      'Content-Length': GZIP.length,
    });
    res.write(GZIP.subarray(0, Math.max(1, Math.floor(GZIP.length / 2))));
    later(() => res.end(GZIP.subarray(Math.max(1, Math.floor(GZIP.length / 2)))), 8);
    return;
  }
  if (req.url === '/br') {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Encoding': 'br',
      'Content-Length': BROTLI.length,
    });
    res.write(BROTLI.subarray(0, Math.max(1, Math.floor(BROTLI.length / 2))));
    later(() => res.end(BROTLI.subarray(Math.max(1, Math.floor(BROTLI.length / 2)))), 8);
    return;
  }
  if (req.url === '/stacked') {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Encoding': 'gzip, br',
      'Content-Length': STACKED.length,
    });
    res.end(STACKED);
    return;
  }
  if (req.url === '/bad-gzip') {
    res.writeHead(200, { 'Content-Encoding': 'gzip' });
    res.end('this is not a gzip stream');
    return;
  }
  if (req.url === '/gzip-bomb') {
    res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': GZIP_BOMB.length });
    res.end(GZIP_BOMB);
    return;
  }
  if (req.url === '/cookies') {
    res.writeHead(200, {
      'Set-Cookie': ['a=1; Path=/; HttpOnly', 'b=two; SameSite=Lax'],
    });
    res.end('cookies');
    return;
  }
  if (req.url === '/slow-headers') {
    later(() => {
      if (!res.destroyed) res.end('too late');
    }, 300);
    return;
  }
  if (req.url === '/slow-body') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('prefix');
    later(() => {
      if (!res.destroyed) res.end('suffix');
    }, 300);
    return;
  }
  if (req.url === '/slow-205') {
    slow205Closed = false;
    res.writeHead(205, { 'Transfer-Encoding': 'chunked' });
    const timer = setInterval(() => {
      if (!res.destroyed) res.write('x');
    }, 10);
    activeTimers.add(timer);
    res.once('close', () => {
      slow205Closed = true;
      clearInterval(timer);
      activeTimers.delete(timer);
    });
    res.write('x');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('plain');
}

function createServer() {
  const server = https.createServer({ key: KEY, cert: CERT }, handler);
  server.on('tlsClientError', () => {});
  return server;
}

async function listen(server, host) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host, port: 0, ipv6Only: host === '::1' });
  });
  return server.address().port;
}

async function closeServer(server) {
  if (!server?.listening) return;
  const closed = new Promise((resolve) => server.close(resolve));
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await closed;
}

async function run(name, fn) {
  await fn();
  console.log(`${name} OK`);
}

async function withFakeResponse(config, fn) {
  const originalRequest = https.request;
  const incoming = new PassThrough();
  incoming.statusCode = config.status || 200;
  incoming.statusMessage = config.statusMessage || 'OK';
  incoming.headers = { ...(config.headers || {}) };
  incoming.rawHeaders = (config.rawHeaders || []).slice();

  const req = new EventEmitter();
  req.destroyed = false;
  req.writes = [];
  req.write = (chunk) => req.writes.push(Buffer.from(chunk));
  req.destroy = () => { req.destroyed = true; };
  let onResponse;
  req.end = () => queueMicrotask(() => {
    onResponse(incoming);
    if (!incoming.destroyed) incoming.end(config.body || '');
  });
  https.request = (options, callback) => {
    req.options = options;
    onResponse = callback;
    return req;
  };

  try {
    return await fn({ incoming, req });
  } finally {
    https.request = originalRequest;
    if (!incoming.destroyed) incoming.destroy();
  }
}

function isAbort(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

(async () => {
  const ipv4Server = createServer();
  let ipv6Server;
  const originalGlobalAgent = https.globalAgent;
  const testAgent = new https.Agent({ ca: CERT, keepAlive: false });
  https.globalAgent = testAgent;

  try {
    const port = await listen(ipv4Server, '127.0.0.1');
    const url = (path) => `https://fallback.test:${port}${path}`;
    const fallbackLookup = async (_hostname, options) => {
      assert.strictEqual(options.all, true, 'autoSelectFamily 应请求完整地址列表');
      return [
        { address: '::1', family: 6 },
        { address: '127.0.0.1', family: 4 },
      ];
    };

    await run('204/205/304 no-body', async () => {
      for (const status of [204, 205, 304]) {
        await withFakeResponse({
          status,
          headers: { 'content-encoding': 'gzip' },
          rawHeaders: ['Content-Encoding', 'gzip', 'Content-Length', '7'],
          body: 'ignored',
        }, async ({ incoming }) => {
          const response = await httpsFetch('https://no-body.test/', {}, async () => [{ address: '127.0.0.1', family: 4 }]);
          assert.strictEqual(response.status, status);
          assert.strictEqual(response.body, null);
          assert.strictEqual(await response.text(), '');
          await new Promise((resolve) => setImmediate(resolve));
          assert.strictEqual(incoming.destroyed, true, `status ${status} 的底层连接未关闭`);
        });
      }
    });

    await run('违规无限 205 不得后台排空', async () => {
      const response = await httpsFetch(url('/slow-205'), {}, fallbackLookup);
      assert.strictEqual(await response.text(), '');
      await new Promise((resolve) => later(resolve, 50));
      assert.strictEqual(slow205Closed, true, '调用方完成后底层 205 连接仍在后台读取');
    });

    await run('Response 构造异常会清理请求', async () => {
      const NativeResponse = global.Response;
      const marker = new Error('response constructor failed');
      try {
        global.Response = class BrokenResponse {
          constructor() { throw marker; }
        };
        await withFakeResponse({ status: 200, body: 'x' }, async ({ incoming, req }) => {
          await assert.rejects(httpsFetch('https://constructor.test/'), (error) => error === marker);
          assert.strictEqual(incoming.destroyed, true);
          assert.strictEqual(req.destroyed, true);
        });
      } finally {
        global.Response = NativeResponse;
      }
    });

    await run('解压初始化异常会清理请求', async () => {
      const descriptor = Object.getOwnPropertyDescriptor(zlib, 'createGunzip');
      const marker = new Error('gunzip initialization failed');
      try {
        Object.defineProperty(zlib, 'createGunzip', {
          ...descriptor,
          value: () => { throw marker; },
        });
        await withFakeResponse({
          status: 200,
          headers: { 'content-encoding': 'gzip' },
          rawHeaders: ['Content-Encoding', 'gzip'],
        }, async ({ incoming, req }) => {
          await assert.rejects(httpsFetch('https://decoder.test/'), (error) => error === marker);
          assert.strictEqual(incoming.destroyed, true);
          assert.strictEqual(req.destroyed, true);
        });
      } finally {
        Object.defineProperty(zlib, 'createGunzip', descriptor);
      }
    });

    await run('gzip 流式解压', async () => {
      const response = await httpsFetch(url('/gzip'), {}, fallbackLookup);
      assert.strictEqual(await response.text(), PAYLOAD);
      assert.strictEqual(response.headers.get('content-encoding'), null);
      assert.strictEqual(response.headers.get('content-length'), null);
    });

    await run('brotli 流式解压', async () => {
      const response = await httpsFetch(url('/br'), {}, fallbackLookup);
      assert.strictEqual(await response.text(), PAYLOAD);
      assert.strictEqual(response.headers.get('content-encoding'), null);
      assert.strictEqual(response.headers.get('content-length'), null);
    });

    await run('多重 Content-Encoding 逆序解压', async () => {
      const response = await httpsFetch(url('/stacked'), {}, fallbackLookup);
      assert.strictEqual(await response.text(), PAYLOAD);
      assert.strictEqual(response.headers.get('content-encoding'), null);
      assert.strictEqual(response.headers.get('content-length'), null);
    });

    await run('损坏压缩流向 Response.body 报错', async () => {
      const response = await httpsFetch(url('/bad-gzip'), {}, fallbackLookup);
      await assert.rejects(response.arrayBuffer());
    });

    await run('解压后响应上限阻断压缩炸弹', async () => {
      const response = await httpsFetch(url('/gzip-bomb'), {}, fallbackLookup);
      await assert.rejects(
        () => readResponseText(response, 64 * 1024, '测试响应'),
        (error) => error.code === 502 && /过大/.test(error.message)
      );
    });

    await run('多地址 IPv6 到 IPv4 回退', async () => {
      const response = await httpsFetch(url('/plain'), {}, fallbackLookup);
      assert.strictEqual(await response.text(), 'plain');
    });

    await run('IPv6 直连', async () => {
      ipv6Server = createServer();
      let ipv6Port;
      try {
        ipv6Port = await listen(ipv6Server, '::1');
      } catch (error) {
        if (!['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) throw error;
        console.log(`IPv6 unavailable (${error.code}), skipped`);
        return;
      }
      const response = await httpsFetch(`https://ipv6.test:${ipv6Port}/plain`, {}, async (_hostname, options) => {
        assert.strictEqual(options.all, true);
        return [{ address: '::1', family: 6 }];
      });
      assert.strictEqual(await response.text(), 'plain');
    });

    await run('Set-Cookie 独立保留', async () => {
      const response = await httpsFetch(url('/cookies'), {}, fallbackLookup);
      assert.strictEqual(typeof response.headers.getSetCookie, 'function');
      assert.deepStrictEqual(response.headers.getSetCookie(), [
        'a=1; Path=/; HttpOnly',
        'b=two; SameSite=Lax',
      ]);
      const copy = response.headers.getSetCookie();
      copy.length = 0;
      assert.strictEqual(response.headers.getSetCookie().length, 2, 'getSetCookie 不应泄露内部数组');
      assert.strictEqual(await response.text(), 'cookies');
    });

    await run('请求前取消', async () => {
      const controller = new AbortController();
      const marker = new Error('cancel before request');
      controller.abort(marker);
      let lookupCalls = 0;
      await assert.rejects(httpsFetch(url('/plain'), { signal: controller.signal }, async () => {
        lookupCalls += 1;
        return [{ address: '127.0.0.1', family: 4 }];
      }), (error) => error === marker);
      assert.strictEqual(lookupCalls, 0);
    });

    await run('响应头前取消', async () => {
      const controller = new AbortController();
      const marker = new Error('cancel before headers');
      const pending = httpsFetch(url('/slow-headers'), { signal: controller.signal }, fallbackLookup);
      later(() => controller.abort(marker), 25);
      await assert.rejects(pending, (error) => error === marker);
    });

    await run('响应体读取期间取消', async () => {
      const controller = new AbortController();
      const marker = new Error('cancel while reading');
      const response = await httpsFetch(url('/slow-body'), { signal: controller.signal }, fallbackLookup);
      controller.abort(marker);
      await assert.rejects(response.text(), (error) => error === marker);
    });

    console.log('https-fetch all pass');
  } finally {
    for (const timer of activeTimers) clearTimeout(timer);
    activeTimers.clear();
    await closeServer(ipv6Server);
    await closeServer(ipv4Server);
    testAgent.destroy();
    https.globalAgent = originalGlobalAgent;
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
