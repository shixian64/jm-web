'use strict';

// /api/translation/page 的服务端代理。独立成模块以支持不起 server.js 的
// 隔离假服务行为测试；宿主（server.js）注入 ApiError/baseHeaders/sendJson
// 与全局 fetch。边界规则：
//  1) 全局/单客户端并发槽位在读取上传体之前获取；等待数量、等待时间与
//     上传读取时间均有上限，被拒绝的请求必须排空请求体以保住 keep-alive。
//  2) 一条整体截止时间覆盖上传、服务 POST、服务响应体、结果 GET 与结果
//     响应体，并与客户端断开信号组合；所有成功、错误、超时和取消路径都
//     释放槽位并清理监听器/定时器。
//  3) 服务端令牌只出现在发往翻译服务的 Authorization 头里，不进入浏览器
//     响应或日志；图片 MIME、上传/结果字节上限、结果 origin+路径白名单与
//     private 缓存语义保持不变。

function drainRequest(req) {
  // 拒绝发生在读取请求体之前时放行请求流，避免残留字节破坏 keep-alive
  // 上的下一个请求；已由 readRequestBody 接管的流不在此处理。
  if (req && typeof req.resume === 'function') req.resume();
}

function abortLike(error) {
  return Boolean(error) && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

// 上传/任务准入闸门：全局 + 单客户端上限、有界等待队列、等待超时、
// 等待者取消后不得再被授予槽位。
class AdmissionGate {
  constructor({ globalLimit, perClientLimit, waitingLimit, waitTimeoutMs, onError }) {
    this.globalLimit = Math.max(1, Number(globalLimit) || 1);
    this.perClientLimit = Math.max(1, Number(perClientLimit) || 1);
    this.waitingLimit = Math.max(0, Number(waitingLimit) || 0);
    this.waitTimeoutMs = Math.max(1, Number(waitTimeoutMs) || 1);
    this.onError = onError || (() => {});
    this.active = 0;
    this.perClient = new Map();
    this.waiters = [];
  }

  stats() {
    return {
      active: this.active,
      waiting: this.waiters.filter((w) => !w.done).length,
      globalLimit: this.globalLimit,
      perClientLimit: this.perClientLimit,
      waitingLimit: this.waitingLimit,
    };
  }

  _canAcquire(clientKey) {
    return this.active < this.globalLimit
      && (this.perClient.get(clientKey) || 0) < this.perClientLimit;
  }

  _commit(clientKey) {
    this.active += 1;
    this.perClient.set(clientKey, (this.perClient.get(clientKey) || 0) + 1);
  }

  async acquire(clientKey, signal) {
    if (signal?.aborted) throw abortError(signal);
    if (this._canAcquire(clientKey)) {
      this._commit(clientKey);
      return;
    }
    if (this.waiters.length >= this.waitingLimit) {
      const error = new Error('翻译服务排队已满');
      error.code = 'translation_wait_full';
      throw error;
    }
    await new Promise((resolve, reject) => {
      const waiter = { clientKey, signal, done: false, resolve, reject, timer: null, onAbort: null };
      waiter.timer = setTimeout(() => {
        const error = new Error('翻译服务排队等待超时');
        error.code = 'translation_wait_timeout';
        this._settleWaiter(waiter, error);
      }, this.waitTimeoutMs);
      waiter.timer.unref?.();
      if (signal) {
        waiter.onAbort = () => this._settleWaiter(waiter, abortError(signal));
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
      this._pump();
    });
  }

  _settleWaiter(waiter, error) {
    if (waiter.done) return;
    waiter.done = true;
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
    if (error) waiter.reject(error);
    else waiter.resolve();
  }

  _pump() {
    // 按到达顺序授予第一个合格等待者；已取消（断开）的等待者只做清理，
    // 绝不能在取消之后又拿到槽位。
    for (let i = 0; i < this.waiters.length;) {
      const waiter = this.waiters[i];
      if (waiter.done) {
        this.waiters.splice(i, 1);
        continue;
      }
      if (waiter.signal?.aborted) {
        this._settleWaiter(waiter, abortError(waiter.signal));
        continue;
      }
      if (!this._canAcquire(waiter.clientKey)) {
        i += 1;
        continue;
      }
      this._commit(waiter.clientKey);
      this._settleWaiter(waiter, null);
      return;
    }
  }

  release(clientKey) {
    this.active = Math.max(0, this.active - 1);
    const count = (this.perClient.get(clientKey) || 1) - 1;
    if (count > 0) this.perClient.set(clientKey, count);
    else this.perClient.delete(clientKey);
    this._pump();
  }
}

function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('客户端已断开');
  error.name = 'AbortError';
  return error;
}

// 组合“客户端断开”与“绝对截止时间”：到期触发 abort(reason)，dispose 必须
// 在请求路径结束时调用以清理定时器与监听器。
function linkedDeadline(parent, deadlineAt, message) {
  const controller = new AbortController();
  let disposed = false;
  const abortWith = (reason) => {
    const error = reason instanceof Error ? reason : new Error(message);
    controller.abort(error);
  };
  const onParentAbort = () => abortWith(parent?.reason);
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener('abort', onParentAbort, { once: true });
  const remaining = Math.max(0, deadlineAt - Date.now());
  const timer = setTimeout(() => abortWith(new Error(message)), remaining);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      if (parent?.removeEventListener) parent.removeEventListener('abort', onParentAbort);
    },
  };
}

// 有界读取上传请求体：超限后保持 flowing 丢弃后续字节（413 响应仍可发出）；
// 支持组合信号中断（客户端断开 / 上传期限）。终止时必须清空已缓冲字节并
// 移除请求流监听器，否则停传连接会一直占着内存与并发槽位。
function readRequestBody(req, limit, signal, limitError) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const onData = (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        finish(limitError);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      finish(null, Buffer.concat(chunks));
    };
    const onError = (error) => finish(error);
    const onAbort = () => finish(abortError(signal));
    const finish = (error, buffer) => {
      if (settled) return;
      settled = true;
      if (signal?.removeEventListener) signal.removeEventListener('abort', onAbort);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      chunks.length = 0;
      if (error) reject(error);
      else resolve(buffer);
    };
    if (signal?.aborted) {
      finish(abortError(signal));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

// 有界读取上游响应体：超限取消流并报错；支持组合信号中断。
async function readBounded(response, limit, label, signal) {
  if (signal?.aborted) throw abortError(signal);
  const reader = response.body?.getReader?.();
  // fetch 的无响应体场景为 null；不得用 text() 降级为无界全量读取。
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  let complete = false;
  let onAbort;
  const aborted = signal ? new Promise((_, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  }) : null;
  try {
    for (;;) {
      const { done, value } = await (aborted ? Promise.race([reader.read(), aborted]) : reader.read());
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error(`${label}超过字节上限`);
      chunks.push(Buffer.from(value));
    }
    complete = true;
    return Buffer.concat(chunks);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    if (!complete) {
      // cancel 自身也可能挂起，不能让它延长请求截止期限。
      try { Promise.resolve(reader.cancel()).catch(() => {}); } catch (_) {}
    }
    try { reader.releaseLock(); } catch (_) {}
  }
}

function discardResponse(response) {
  // 状态码 / MIME 校验失败时尚未开始 readBounded，也必须主动回收连接。
  try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch (_) {}
}

function endResponse(res, output, signal) {
  // end() 只把数据交给 Writable，慢连接仍可能持有整张图片。只有 finish
  // 才能释放请求槽位；close/error/总 deadline 则销毁连接并结束等待。
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      res.removeListener('finish', onFinish);
      res.removeListener('close', onClose);
      res.removeListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
      if (error) {
        // 不传 error 给 destroy，避免清理监听后再触发未处理的 error 事件。
        try { res.destroy(); } catch (_) {}
        reject(error);
      } else resolve();
    };
    const onFinish = () => settle();
    const onClose = () => settle(res.writableFinished ? null : abortError());
    const onError = (error) => settle(error);
    const onAbort = () => settle(abortError(signal));
    res.once('finish', onFinish);
    res.once('close', onClose);
    res.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    if (res.destroyed) return onClose();
    try { res.end(output); } catch (error) { settle(error); }
  });
}

function createTranslationProxy({
  serviceUrl,
  token,
  imageMimes,
  maxPageBytes,
  maxJsonBytes = 2 * 1024 * 1024,
  globalLimit = 4,
  perClientLimit = 2,
  waitingLimit = 16,
  waitTimeoutMs = 5000,
  uploadTimeoutMs = 30000,
  deadlineMs = 120000,
  fetchImpl = fetch,
  ApiError,
  baseHeaders,
  sendJson,
}) {
  const gate = new AdmissionGate({ globalLimit, perClientLimit, waitingLimit, waitTimeoutMs });

  function serviceHeaders(contentType) {
    const headers = { 'Content-Type': contentType };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  function allowedQuery(u) {
    const allowed = ['aid', 'photoId', 'pageIndex', 'targetLang', 'pipeline', 'waitMs'];
    const query = new URLSearchParams();
    for (const key of allowed) {
      const value = String(u.searchParams.get(key) || '').trim();
      if (value) query.set(key, value);
    }
    return query;
  }

  function mapUpstreamError(error, requestSignal, deadlineSignal, message, publicMessage) {
    // 客户端断开：原样上抛交给宿主的断开处理；其次区分“我们的截止时间”
    // 与真实上游故障——abort(reason) 传播的错误不一定是 AbortError，必须
    // 以信号状态而不是错误名称判定。
    if (requestSignal?.aborted) return error;
    if (deadlineSignal?.aborted) {
      return new ApiError(message, 504, { expose: true, publicMessage });
    }
    if (abortLike(error)) return error;
    return new ApiError(message, 502, { expose: true, publicMessage, cause: error });
  }

  async function handle({ req, res, u, requestSignal, clientKey }) {
    if (!serviceUrl) {
      drainRequest(req);
      throw new ApiError('翻译服务未配置', 503, { expose: true, publicMessage: '翻译服务暂不可用' });
    }
    if (!token) {
      // 空 token 契约：与 Python 侧一致，缺少令牌即禁用翻译能力并明确提示。
      drainRequest(req);
      throw new ApiError('翻译服务未配置访问令牌，翻译能力已禁用', 503, {
        expose: true,
        publicMessage: '翻译服务未启用（缺少 TRANSLATION_SERVICE_TOKEN）',
      });
    }
    const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    if (!imageMimes.has(contentType)) {
      drainRequest(req);
      throw new ApiError('请以 image/* 二进制上传图片', 415);
    }

    // 槽位先于上传体读取：等待满/等待超时都要排空请求体再拒绝。
    try {
      await gate.acquire(clientKey, requestSignal);
    } catch (error) {
      drainRequest(req);
      if (error.code === 'translation_wait_full' || error.code === 'translation_wait_timeout') {
        return sendJson(res, 429, {
          status: 'busy',
          error: 'translation_queue_full',
          retryAfterMs: 2000,
        }, { 'Retry-After': '2' });
      }
      throw error;
    }

    const deadlineAt = Date.now() + deadlineMs;
    const upload = linkedDeadline(requestSignal, Math.min(deadlineAt, Date.now() + uploadTimeoutMs), '翻译上传超时');
    const call = linkedDeadline(requestSignal, deadlineAt, '翻译服务响应超时');
    let upstream;
    let translated;
    try {
      let source;
      try {
        source = await readRequestBody(req, maxPageBytes, upload.signal, new ApiError('图片文件超过大小限制', 413));
      } catch (error) {
        if (requestSignal?.aborted) throw error;
        if (upload.signal.aborted) {
          // 上传超时：剩余字节数不可预知，不能为保 keep-alive 无界排空。
          // 先回 504，再销毁请求连接，确保已缓冲字节、流监听器与槽位全部释放。
          sendJson(res, 504, { error: '翻译上传超时，请重试' }, { 'Retry-After': '2' });
          try { req.destroy(); } catch (_) {}
          return;
        }
        throw error;
      }
      if (!source.length) throw new ApiError('图片请求体为空', 400);

      let endpoint;
      try {
        endpoint = new URL('/v1/translate/page', `${serviceUrl}/`);
        endpoint.search = allowedQuery(u).toString();
      } catch (_) {
        throw new ApiError('翻译服务地址配置无效', 503, { expose: true, publicMessage: '翻译服务暂不可用' });
      }

      try {
        upstream = await fetchImpl(endpoint, {
            method: 'POST',
            redirect: 'error',
            headers: serviceHeaders(contentType),
            body: source,
            signal: call.signal,
          });
        } catch (error) {
          throw mapUpstreamError(error, requestSignal, call.signal, '翻译服务连接超时', '翻译请求超时，请稍后重试');
        }

        const responseBody = await readBounded(upstream, maxJsonBytes, '翻译服务响应', call.signal);
        let payload = null;
        try { payload = responseBody.length ? JSON.parse(responseBody.toString('utf8')) : null; } catch (_) {}
        if (!upstream.ok) {
          const status = upstream.status === 429 ? 429 : (upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502);
          return sendJson(res, status, {
            status: payload?.status || 'error',
            error: status === 429 ? 'translation_queue_full' : 'translation_unavailable',
            retryAfterMs: payload?.retryAfterMs || 2000,
          }, status === 429 ? { 'Retry-After': '2' } : {});
        }
        if (!payload || typeof payload !== 'object') {
          throw new ApiError('翻译服务响应格式无效', 502);
        }
        if (payload.status !== 'ready' || !payload.imageUrl) {
          return sendJson(res, 202, {
            status: payload.status || 'queued',
            jobId: payload.jobId || null,
            pollAfterMs: payload.pollAfterMs || 1000,
          }, { 'Retry-After': '1' });
        }

        let resultUrl;
        try { resultUrl = new URL(String(payload.imageUrl), `${serviceUrl}/`); } catch (_) {
          throw new ApiError('翻译结果地址无效', 502);
        }
        const serviceOrigin = new URL(`${serviceUrl}/`).origin;
        if (resultUrl.origin !== serviceOrigin || resultUrl.username || resultUrl.password
          || resultUrl.search || resultUrl.hash || !/^\/v1\/results\/[0-9a-f]{64}\.webp$/.test(resultUrl.pathname)) {
          throw new ApiError('翻译结果地址不受信任', 502);
        }
        try {
          translated = await fetchImpl(resultUrl, {
            redirect: 'error',
            headers: serviceHeaders('application/json'),
            signal: call.signal,
          });
        } catch (error) {
          throw mapUpstreamError(error, requestSignal, call.signal, '翻译结果获取超时', '翻译请求超时，请稍后重试');
        }
        if (!translated.ok) throw new ApiError('翻译结果获取失败', 502);
        const resultType = String(translated.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
        if (resultType !== 'image/webp') throw new ApiError('翻译结果不是 WebP 图片', 502);
        const output = await readBounded(translated, maxPageBytes, '翻译结果', call.signal);
        if (!output.length) throw new ApiError('翻译结果为空', 502);
        res.writeHead(200, baseHeaders({
          'Content-Type': 'image/webp',
          'Content-Length': output.length,
          'Cache-Control': 'private, max-age=86400',
          'X-Translation-Status': 'ready',
          'X-Translation-Cache-Hit': payload.cacheHit === true ? '1' : '0',
        }));
        return await endResponse(res, output, call.signal);
      } catch (error) {
        // 截止时间触发时（客户端未断开）统一映射为可公开的 504，而不是
        // 让原始 abort/reader 错误落进宿主的 500 分支。
        if (!(error instanceof ApiError) && (requestSignal?.aborted || call.signal.aborted || abortLike(error))) {
          if (!requestSignal?.aborted && call.signal.aborted) {
            throw new ApiError('翻译服务响应超时', 504, { expose: true, publicMessage: '翻译请求超时，请稍后重试' });
          }
          throw error;
        }
        if (!(error instanceof ApiError) && error instanceof Error && /超过字节上限/.test(error.message)) {
          throw new ApiError(error.message, 502, { expose: true, publicMessage: '翻译服务暂不可用' });
        }
        throw error;
      } finally {
      discardResponse(upstream);
      discardResponse(translated);
      upload.dispose();
      call.dispose();
      gate.release(clientKey);
    }
  }

  return { handle, gate };
}

module.exports = {
  createTranslationProxy,
  AdmissionGate,
  drainRequest,
  linkedDeadline,
  readRequestBody,
  readBounded,
};
