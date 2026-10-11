'use strict';

// /api/translation/page 代理的行为测试：用本地 HTTP 假服务覆盖准入、期限、
// 取消与安全边界，不依赖真实 OCR 镜像、server.js 或任何外部 API。

const assert = require('assert');
const http = require('http');
const { EventEmitter, getEventListeners } = require('events');
const { PassThrough } = require('stream');
const { createTranslationProxy, readBounded } = require('../lib/translation-proxy');

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

function mockRes({ autoFinish = true } = {}) {
  return Object.assign(new EventEmitter(), {
    status: 0,
    headers: null,
    body: null,
    headersSent: false,
    ended: false,
    writableEnded: false,
    writableFinished: false,
    destroyed: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
    end(data) {
      this.ended = this.writableEnded = true;
      this.body = data ? Buffer.from(data) : Buffer.alloc(0);
      if (autoFinish) this.finish();
    },
    finish() { this.writableFinished = true; this.emit('finish'); },
    destroy() { this.destroyed = true; this.emit('close'); },
  });
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

    // 重定向不能绕过固定的 API/结果路径；同源 307 也会携带令牌和原始图片。
    {
      const proxy = makeProxy(port);
      const getsBefore = service.capture.gets.length;
      service.capture.onPost = (_record, res) => {
        res.writeHead(307, { Location: '/unexpected-upload-target' });
        res.end();
      };
      await assert.rejects(() => run(proxy, mockReq(WEBP, { 'content-type': 'image/webp' })),
        (error) => error instanceof ApiError && error.status === 502);
      assert.strictEqual(service.capture.gets.length, getsBefore, 'POST 重定向不得被自动请求');

      service.capture.onPost = (_record, res) => {
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ status: 'ready', imageUrl: '/v1/results/' + 'a'.repeat(64) + '.webp' }));
      };
      service.capture.onGet = (url, res) => {
        if (url.startsWith('/v1/results/')) {
          res.writeHead(302, { Location: '/unexpected-result-target' });
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'image/webp' });
          res.end(WEBP);
        }
      };
      await assert.rejects(() => run(proxy, mockReq(WEBP, { 'content-type': 'image/webp' })),
        (error) => error instanceof ApiError && error.status === 502);
      assert.strictEqual(service.capture.gets.length, getsBefore + 1, 'GET 重定向不得被自动请求');
      service.capture.onPost = null;
      service.capture.onGet = null;
      assert.strictEqual(proxy.gate.stats().active, 0);
    }

    // 合法 pathname 不等于可信 URL：用户信息、查询及片段均不得夹带。
    for (const imageUrl of [
      '/v1/results/' + 'a'.repeat(64) + '.webp?redirect=outside',
      '/v1/results/' + 'a'.repeat(64) + '.webp#fragment',
      `http://user:password@127.0.0.1:${port}/v1/results/` + 'a'.repeat(64) + '.webp',
    ]) {
      const getsBefore = service.capture.gets.length;
      service.capture.onPost = (_record, res) => {
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ status: 'ready', imageUrl }));
      };
      await assert.rejects(() => run(makeProxy(port), mockReq(WEBP, { 'content-type': 'image/webp' })),
        (error) => error instanceof ApiError && error.status === 502);
      assert.strictEqual(service.capture.gets.length, getsBefore);
    }
    service.capture.onPost = null;

    // res.end() 只是提交缓冲；finish 前不能归还槽位，否则慢客户端可无界积压图片。
    {
      const proxy = makeProxy(port, { waitingLimit: 0 });
      service.capture.onPost = (_record, res) => {
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ status: 'ready', imageUrl: '/v1/results/' + 'a'.repeat(64) + '.webp' }));
      };
      const res = mockRes({ autoFinish: false });
      let settled = false;
      const sending = run(proxy, mockReq(WEBP, { 'content-type': 'image/webp' }), { res })
        .finally(() => { settled = true; });
      for (let i = 0; i < 100 && !res.ended; i++) await wait(5);
      assert.strictEqual(res.ended, true);
      assert.strictEqual(settled, false, '写入已结束不代表客户端发送完成');
      assert.strictEqual(proxy.gate.stats().active, 1, 'finish 前必须持有槽位');
      const blocked = mockRes();
      await run(proxy, mockReq(WEBP, { 'content-type': 'image/webp' }), { res: blocked, clientKey: 'other' });
      assert.strictEqual(blocked.status, 429);
      res.finish();
      await sending;
      assert.strictEqual(proxy.gate.stats().active, 0);
      for (const event of ['finish', 'close', 'error']) assert.strictEqual(res.listenerCount(event), 0);
      service.capture.onPost = null;
    }

    // 总期限继续覆盖慢速回传；超时/断开/响应流错误都应销毁连接和清理监听。
    for (const failure of ['deadline', 'close', 'abort', 'error']) {
      const controller = new AbortController();
      const proxy = makeProxy(port, { deadlineMs: failure === 'deadline' ? 150 : 5000 });
      service.capture.onPost = (_record, res) => {
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ status: 'ready', imageUrl: '/v1/results/' + 'a'.repeat(64) + '.webp' }));
      };
      const res = mockRes({ autoFinish: false });
      const sending = run(proxy, mockReq(WEBP, { 'content-type': 'image/webp' }), {
        res, requestSignal: controller.signal,
      });
      const rejected = assert.rejects(() => sending, (error) => failure === 'deadline'
        ? error instanceof ApiError && error.status === 504
        : failure === 'error' ? error.message === 'response failed' : error.name === 'AbortError');
      for (let i = 0; i < 100 && !res.ended; i++) await wait(5);
      assert.strictEqual(res.ended, true);
      assert.strictEqual(proxy.gate.stats().active, 1);
      if (failure === 'close') res.emit('close');
      if (failure === 'abort') controller.abort();
      if (failure === 'error') res.emit('error', new Error('response failed'));
      await rejected;
      assert.strictEqual(res.destroyed, true, `${failure} 必须关闭未完成的响应`);
      assert.strictEqual(proxy.gate.stats().active, 0);
      for (const event of ['finish', 'close', 'error']) assert.strictEqual(res.listenerCount(event), 0);
      assert.strictEqual(getEventListeners(controller.signal, 'abort').length, 0);
      service.capture.onPost = null;
    }

    // 使用真实 Node Writable 背压，而非手动模拟 finish：无消费者的
    // PassThrough 会停在 writableEnded=true / writableFinished=false。
    {
      const proxy = makeProxy(port, {
        deadlineMs: 150,
        fetchImpl: async (_url, options) => options.method === 'POST'
          ? Response.json({ status: 'ready', imageUrl: '/v1/results/' + 'a'.repeat(64) + '.webp' })
          : new Response(WEBP, { headers: { 'Content-Type': 'image/webp' } }),
      });
      const response = new PassThrough({ highWaterMark: 1 });
      response.writeHead = () => { response.headersSent = true; };
      try {
        const sending = run(proxy, mockReq(WEBP, { 'content-type': 'image/webp' }), { res: response });
        const rejected = assert.rejects(() => sending, (error) => error instanceof ApiError && error.status === 504);
        for (let i = 0; i < 100 && !response.writableEnded; i++) await wait(5);
        assert.strictEqual(response.writableEnded, true);
        assert.strictEqual(response.writableFinished, false, '暂停读取必须产生真实响应背压');
        assert.strictEqual(proxy.gate.stats().active, 1);
        await rejected;
        assert.strictEqual(response.destroyed, true);
        assert.strictEqual(proxy.gate.stats().active, 0);
        for (const event of ['finish', 'close', 'error']) assert.strictEqual(response.listenerCount(event), 0);
      } finally {
        response.destroy();
      }
    }

    // MIME 拒绝发生在读取之前时也必须取消响应，而非依赖 GC 归还连接。
    {
      let cancelled = false;
      let calls = 0;
      const proxy = makeProxy(port, { fetchImpl: async () => {
        if (++calls === 1) return Response.json({
          status: 'ready', imageUrl: '/v1/results/' + 'a'.repeat(64) + '.webp',
        });
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
          headers: { 'Content-Type': 'text/html' },
        });
      } });
      await assert.rejects(() => run(proxy, mockReq(WEBP, { 'content-type': 'image/webp' })),
        (error) => error instanceof ApiError && error.status === 502);
      assert.strictEqual(cancelled, true);
      assert.strictEqual(proxy.gate.stats().active, 0);
    }

    // 每次读取结束都移除 abort 监听，并释放 reader；取消时主动关闭停传的响应体。
    {
      const controller = new AbortController();
      const response = new Response(WEBP);
      assert.deepStrictEqual(await readBounded(response, 1024, 'test', controller.signal), WEBP);
      assert.strictEqual(getEventListeners(controller.signal, 'abort').length, 0);
      assert.strictEqual(response.body.locked, false);

      let cancelled = false;
      const stalled = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
      const aborted = new AbortController();
      const reading = readBounded(stalled, 1024, 'test', aborted.signal);
      aborted.abort();
      await assert.rejects(() => reading, (error) => error.name === 'AbortError');
      assert.strictEqual(cancelled, true);
      assert.strictEqual(stalled.body.locked, false);
      assert.strictEqual(getEventListeners(aborted.signal, 'abort').length, 0);

      const preAborted = new AbortController();
      preAborted.abort();
      await assert.rejects(() => readBounded(new Response(WEBP), 1024, 'test', preAborted.signal),
        (error) => error.name === 'AbortError');

      const oversized = new Response(new ReadableStream({
        start(stream) { stream.enqueue(new Uint8Array(32)); },
        cancel() { return new Promise(() => {}); },
      }));
      // 不等待不可控的 cancel Promise，否则字节上限分支本身会无限挂起。
      await assert.rejects(() => Promise.race([
        readBounded(oversized, 16, 'test', controller.signal),
        wait(250).then(() => { throw new Error('cancel stalled'); }),
      ]), /超过字节上限/);
      assert.strictEqual(oversized.body.locked, false);
      assert.strictEqual(getEventListeners(controller.signal, 'abort').length, 0);
    }

    console.log('translation proxy admission/deadline/safety all pass');
  } finally {
    await service.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
