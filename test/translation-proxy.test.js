'use strict';

// /api/translation/page 代理的行为测试：用本地 HTTP 假服务覆盖准入、期限、
// 取消与安全边界，不依赖真实 OCR 镜像、server.js 或任何外部 API。

const assert = require('assert');
const http = require('http');
const { PassThrough } = require('stream');
const { createTranslationProxy } = require('../lib/translation-proxy');

const TOKEN = 'test-service-token';
const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

class ApiError extends Error {
  constructor(message, status, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.expose = options.expose === true;
    this.publicMessage = options.publicMessage || '';
    this.cause = options.cause;
  }
}

function baseHeaders(extra = {}) {
  return { 'X-Content-Type-Options': 'nosniff', ...extra };
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, baseHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    ...extraHeaders,
  }));
  res.end(body);
}

function mockReq(body, headers = {}) {
  const stream = new PassThrough();
  stream.headers = headers;
  if (body) stream.end(body);
  else stream.end();
  return stream;
}

function slowReq(chunk, intervalMs, headers = {}) {
  const stream = new PassThrough();
  stream.headers = headers;
  let stopped = false;
  const push = () => {
    if (stopped || stream.destroyed) return;
    stream.write(chunk, () => setTimeout(push, intervalMs));
  };
  push();
  // 模拟器必须可停止，否则自调度定时器会让测试进程无法退出。
  stream.stop = () => { stopped = true; };
  return stream;
}

function mockRes() {
  return {
    status: 0,
    headers: null,
    body: null,
    headersSent: false,
    ended: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
    end(data) { this.ended = true; this.body = data ? Buffer.from(data) : Buffer.alloc(0); },
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 假翻译服务：mode 控制行为，capture 记录收到的请求（含 Authorization）。
function startFakeService() {
  const capture = { posts: [], gets: [] };
  const pending = [];
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/translate/page')) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const record = { url: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks) };
        capture.posts.push(record);
        pending.push({ req, res, record });
        if (capture.onPost) capture.onPost(record, res);
      });
      return;
    }
    capture.gets.push({ url: req.url, authorization: req.headers.authorization });
    if (capture.onGet) { capture.onGet(req.url, res); return; }
    res.writeHead(200, { 'Content-Type': 'image/webp' });
    res.end(WEBP);
  });
  return {
    capture,
    respond(index, handler) {
      const entry = pending[index];
      if (!entry || entry.res.writableEnded || entry.res.destroyed) return;
      try { handler(entry); } catch (_) { try { entry.res.destroy(); } catch (__) {} }
    },
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    // 挂起用例留下的 keep-alive/半开连接会阻止 close 完成，统一销毁。
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

function makeProxy(port, overrides = {}) {
  return createTranslationProxy({
    serviceUrl: `http://127.0.0.1:${port}`,
    token: TOKEN,
    imageMimes: new Set(['image/jpeg', 'image/png', 'image/webp']),
    maxPageBytes: 1024 * 1024,
    ApiError,
    baseHeaders,
    sendJson,
    globalLimit: 1,
    perClientLimit: 1,
    waitingLimit: 2,
    waitTimeoutMs: 400,
    uploadTimeoutMs: 100000,
    deadlineMs: 100000,
    ...overrides,
  });
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const run = (proxy, req, overrides = {}) => proxy.handle({
  req,
  res: overrides.res || mockRes(),
  u: new URL('http://local/api/translation/page'),
  requestSignal: overrides.requestSignal,
  clientKey: overrides.clientKey || 'client-a',
});

async function main() {
  const service = startFakeService();
  const port = await service.listen();
  try {
    // 1) 正常路径：token 只发往服务、不进浏览器响应；private 缓存与 WebP 语义保持。
    {
      const proxy = makeProxy(port);
      service.capture.onPost = (record, res) => {
        assert.strictEqual(record.authorization, `Bearer ${TOKEN}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ready', imageUrl: '/v1/results/' + 'a'.repeat(64) + '.webp' }));
      };
      const res = mockRes();
      await run(proxy, mockReq(WEBP, { 'content-type': 'image/webp' }), { res });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers['Content-Type'], 'image/webp');
      assert.match(res.headers['Cache-Control'], /^private, max-age=86400$/);
      assert.deepStrictEqual(res.body, WEBP);
      assert.ok(!JSON.stringify(res.headers).includes(TOKEN) && !res.body.includes(Buffer.from(TOKEN)));
      assert.strictEqual(proxy.gate.stats().active, 0, '完成后槽位必须归还');
      service.capture.onPost = null;
    }

    // 2) 空 token：能力禁用并明确提示，且排空请求体。
    {
      const proxy = makeProxy(port, { token: '' });
      const req = mockReq(WEBP, { 'content-type': 'image/webp' });
      let resumed = false;
      req.resume = () => { resumed = true; req.resume = PassThrough.prototype.resume; };
      await assert.rejects(() => run(proxy, req), (error) => error instanceof ApiError && error.status === 503);
      assert.ok(resumed, '空 token 拒绝必须排空请求体');
    }

    // 3) 非图片 MIME：415 且排空请求体，不新增转发。
    {
      const proxy = makeProxy(port);
      const postsBefore = service.capture.posts.length;
      const req = mockReq('{"x":1}', { 'content-type': 'application/json' });
      let resumed = false;
      req.resume = () => { resumed = true; req.resume = PassThrough.prototype.resume; };
      await assert.rejects(() => run(proxy, req), (error) => error instanceof ApiError && error.status === 415);
      assert.ok(resumed, 'MIME 拒绝必须排空请求体');
      assert.strictEqual(service.capture.posts.length, postsBefore, '拒绝不得转发到翻译服务');
    }

    // 4) 排队满（waitingLimit=0）：立即 429 busy，且排空请求体。
    {
      const proxy = makeProxy(port, { globalLimit: 1, waitingLimit: 0 });
      const hold = mockReq(WEBP, { 'content-type': 'image/webp' });
      const firstDone = run(proxy, hold); // 占住唯一槽位（服务挂起，稍后手动响应）
      await wait(20);
      const req = mockReq(WEBP, { 'content-type': 'image/webp' });
      let resumed = false;
      req.resume = () => { resumed = true; req.resume = PassThrough.prototype.resume; };
      const res = mockRes();
      await run(proxy, req, { res });
      assert.strictEqual(res.status, 429);
      assert.strictEqual(JSON.parse(res.body).error, 'translation_queue_full');
      assert.ok(resumed, '排队满拒绝必须排空请求体');
      assert.strictEqual(proxy.gate.stats().active, 1, '占用者不受影响');
      service.respond(service.capture.posts.length - 1, ({ res: serviceRes }) => {
        serviceRes.writeHead(200, { 'Content-Type': 'application/json' });
        serviceRes.end(JSON.stringify({ status: 'ready', imageUrl: '/v1/results/' + 'b'.repeat(64) + '.webp' }));
      });
      await firstDone;
      assert.strictEqual(proxy.gate.stats().active, 0, '释放后槽位归零');
    }

    // 5) 等待超时：占用未释放时第二个请求等待 waitTimeoutMs 后 429。
    {
      const proxy = makeProxy(port, { waitTimeoutMs: 150 });
      const hold = mockReq(WEBP, { 'content-type': 'image/webp' });
      const firstDone = run(proxy, hold);
      await wait(20);
      const res = mockRes();
      await run(proxy, mockReq(WEBP, { 'content-type': 'image/webp' }), { res, clientKey: 'client-b' });
      assert.strictEqual(res.status, 429, '等待超时必须返回 429 busy');
      service.respond(service.capture.posts.length - 1, ({ res: serviceRes }) => serviceRes.destroy());
      await assert.rejects(() => firstDone, (error) => error instanceof ApiError || error?.code === 'ECONNRESET');
      await wait(30);
      assert.strictEqual(proxy.gate.stats().active, 0);
      assert.strictEqual(proxy.gate.stats().waiting, 0, '超时等待者必须被清理');
    }

    // 6) 客户端断开：等待中的请求被取消后不得再获槽位；全部路径结束后槽位归零。
    {
      const proxy = makeProxy(port, { waitTimeoutMs: 5000 });
      const hold = mockReq(WEBP, { 'content-type': 'image/webp' });
      const firstDone = run(proxy, hold);
      await wait(20);
      const clientSignal = new AbortController();
      const waiting = run(proxy, mockReq(WEBP, { 'content-type': 'image/webp' }), {
        clientKey: 'client-b', requestSignal: clientSignal.signal,
      });
      await wait(20);
      assert.strictEqual(proxy.gate.stats().waiting, 1);
      clientSignal.abort();
      await assert.rejects(() => waiting, (error) => error.name === 'AbortError' || error.message === '客户端已断开');
      assert.strictEqual(proxy.gate.stats().waiting, 0, '取消的等待者必须立即移出队列');
      service.respond(service.capture.posts.length - 1, ({ res: serviceRes }) => serviceRes.destroy());
      await assert.rejects(() => firstDone);
      await wait(30);
      assert.strictEqual(proxy.gate.stats().active, 0, '任一路径结束后槽位回到初始值');
    }

    // 7) 单客户端上限：第二个并发请求（同客户端）排队超时 429；不同客户端可并行。
    {
      const proxy = makeProxy(port, { globalLimit: 2, perClientLimit: 1, waitTimeoutMs: 120 });
      const first = run(proxy, mockReq(WEBP, { 'content-type': 'image/webp' }));
      const secondOther = run(proxy, mockReq(WEBP, { 'content-type': 'image/webp' }), { clientKey: 'client-z' });
      await wait(20);
      const res = mockRes();
      await run(proxy, mockReq(WEBP, { 'content-type': 'image/webp' }), { res });
      assert.strictEqual(res.status, 429, '同客户端超并发必须被拒');
      service.respond(service.capture.posts.length - 1, ({ res: r }) => r.destroy());
      service.respond(service.capture.posts.length - 2, ({ res: r }) => r.destroy());
      await Promise.allSettled([first, secondOther]);
      await wait(30);
      assert.strictEqual(proxy.gate.stats().active, 0);
    }

    // 8) 服务永不返回响应头：整体 deadline 触发 504，槽位归还。
    {
      const quick = makeProxy(port, { deadlineMs: 150, uploadTimeoutMs: 100000 });
      const pending = run(quick, mockReq(WEBP, { 'content-type': 'image/webp' }));
      await assert.rejects(() => pending, (error) => error instanceof ApiError && error.status === 504);
      await wait(20);
      assert.strictEqual(quick.gate.stats().active, 0, '超时路径必须释放槽位');
      service.respond(service.capture.posts.length - 1, ({ res: r }) => r.destroy());
    }

    // 9) 服务响应体永不结束：deadline 覆盖响应体读取，504 且槽位归还。
    {
      const quick = makeProxy(port, { deadlineMs: 180 });
      const pending = run(quick, mockReq(WEBP, { 'content-type': 'image/webp' }));
      await wait(30);
      service.respond(service.capture.posts.length - 1, ({ res: r }) => {
        r.writeHead(200, { 'Content-Type': 'application/json' });
        r.write('{"status":"ready","imageUr'); // 只发一半，永不结束
      });
      await assert.rejects(() => pending, (error) => error instanceof ApiError && error.status === 504);
      await wait(20);
      assert.strictEqual(quick.gate.stats().active, 0);
    }

    // 10) 慢速上传：上传期限触发后回 504、销毁连接、槽位归还、不转发；
    //     已缓冲字节与请求流监听器必须释放（停传连接不得占内存/槽位）。
    {
      const quick = makeProxy(port, { uploadTimeoutMs: 120, deadlineMs: 100000 });
      const postsBefore = service.capture.posts.length;
      const req = slowReq(Buffer.alloc(64 * 1024, 1), 60, { 'content-type': 'image/webp' });
      const res = mockRes();
      await run(quick, req, { res });
      assert.strictEqual(res.status, 504, '上传超时必须返回 504');
      assert.strictEqual(quick.gate.stats().active, 0, '上传超时后槽位必须归还');
      assert.strictEqual(service.capture.posts.length, postsBefore, '上传超时不得转发到翻译服务');
      assert.strictEqual(req.listenerCount('data'), 0, '超时后不得残留请求流 data 监听器');
      assert.strictEqual(req.listenerCount('end'), 0, '超时后不得残留请求流 end 监听器');
      assert.ok(req.destroyed, '上传超时必须销毁请求连接释放缓冲');
      req.stop();

      // 停传连接（发过数据后永久挂起）：同样被期限覆盖，且槽位立即可复用。
      const stalled = new PassThrough();
      stalled.headers = { 'content-type': 'image/webp' };
      stalled.write(Buffer.alloc(1024, 1)); // 只发一块，之后永不结束
      const stalledRes = mockRes();
      const stalledDone = run(quick, stalled, { res: stalledRes });
      service.capture.onPost = (record, r) => {
        r.writeHead(200, { 'Content-Type': 'application/json' });
        r.end(JSON.stringify({ status: 'ready', imageUrl: '/v1/results/' + 'f'.repeat(64) + '.webp' }));
      };
      await stalledDone;
      assert.strictEqual(stalledRes.status, 504, '停传连接必须被上传期限中断');
      assert.ok(stalled.destroyed, '停传连接超时后必须被销毁');
      assert.strictEqual(stalled.listenerCount('data'), 0);
      assert.strictEqual(quick.gate.stats().active, 0, '停传连接不得继续占用槽位');
      const res2 = mockRes();
      await run(quick, mockReq(WEBP, { 'content-type': 'image/webp' }), { res: res2, clientKey: 'client-x' });
      service.capture.onPost = null;
      assert.strictEqual(res2.status, 200, '槽位释放后后续请求必须可用');
      assert.strictEqual(quick.gate.stats().active, 0);
    }

    // 11) 上传超过字节上限：413（读取阶段拒绝）。
    {
      const proxy = makeProxy(port, { maxPageBytes: 1024 });
      await assert.rejects(
        () => run(proxy, mockReq(Buffer.alloc(4096, 1), { 'content-type': 'image/webp' })),
        (error) => error instanceof ApiError && error.status === 413,
      );
      assert.strictEqual(proxy.gate.stats().active, 0);
    }

    // 12) 非法结果 URL / MIME：跨源与路径不合法拒绝；结果不是 WebP 拒绝。
    {
      const proxy = makeProxy(port);
      service.capture.onPost = (record, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ready', imageUrl: 'http://evil.example/v1/results/' + 'c'.repeat(64) + '.webp' }));
      };
      await assert.rejects(() => run(proxy, mockReq(WEBP, { 'content-type': 'image/webp' })),
        (error) => error instanceof ApiError && error.status === 502);
      service.capture.onPost = (record, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ready', imageUrl: '/v1/results/' + 'd'.repeat(64) + '.png' }));
      };
      await assert.rejects(() => run(proxy, mockReq(WEBP, { 'content-type': 'image/webp' })),
        (error) => error instanceof ApiError && error.status === 502);
      service.capture.onPost = (record, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ready', imageUrl: '/v1/results/' + 'e'.repeat(64) + '.webp' }));
      };
      service.capture.onGet = (url, res) => {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(WEBP);
      };
      await assert.rejects(() => run(proxy, mockReq(WEBP, { 'content-type': 'image/webp' })),
        (error) => error instanceof ApiError && error.status === 502);
      service.capture.onPost = null;
      service.capture.onGet = null;
      assert.strictEqual(proxy.gate.stats().active, 0);
    }

    // 13) 202 排队分支与 429 透传：槽位同样释放。
    {
      const proxy = makeProxy(port);
      service.capture.onPost = (record, res) => {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'queued', jobId: 'abc', pollAfterMs: 500 }));
      };
      const res = mockRes();
      await run(proxy, mockReq(WEBP, { 'content-type': 'image/webp' }), { res });
      assert.strictEqual(res.status, 202);
      assert.strictEqual(JSON.parse(res.body).jobId, 'abc');
      assert.strictEqual(proxy.gate.stats().active, 0);
      service.capture.onPost = (record, res) => {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'busy', retryAfterMs: 900 }));
      };
      const busy = mockRes();
      await run(proxy, mockReq(WEBP, { 'content-type': 'image/webp' }), { res: busy });
      assert.strictEqual(busy.status, 429);
      assert.strictEqual(JSON.parse(busy.body).error, 'translation_queue_full');
      assert.strictEqual(proxy.gate.stats().active, 0);
      service.capture.onPost = null;
    }

    console.log('translation proxy admission/deadline/safety all pass');
  } finally {
    await service.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
