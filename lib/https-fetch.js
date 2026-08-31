'use strict';

// 基于 Node 核心 https 的最小 Fetch 兼容层。它允许为真实 TLS 连接注入 lookup，
// 而不仅是在请求前做一次 DNS 预检；响应仍转换为 WHATWG Response 供现有代码消费。
const https = require('https');
const net = require('net');
const zlib = require('zlib');
const { Readable, pipeline } = require('stream');

// Fetch 规范规定这些状态不能带响应体。ClientResponse 仍然是一个可读流，
// 因此需要单独排空它，但不能把该流传给 Response 构造器。
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
// Node 默认只给 autoSelectFamily 的单地址连接约 250ms。在高延迟网络中，
// IPv4 尚未完成握手而 IPv6 又不可达时会被误判为所有地址均超时。
const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT = 1000;

function normalizedAddress(row, hostname) {
  const address = typeof row === 'string' ? row : String(row?.address || '');
  const detectedFamily = net.isIP(address);
  if (!detectedFamily) throw new Error(`DNS 返回了无效地址（${hostname}）`);
  const declaredFamily = Number(row?.family) || detectedFamily;
  if (declaredFamily !== detectedFamily) throw new Error(`DNS 地址族不匹配（${hostname}）`);
  return { address, family: detectedFamily };
}

function lookupCallback(lookup) {
  if (typeof lookup !== 'function') return undefined;
  return (hostname, options, callback) => {
    const lookupOptions = typeof options === 'number' ? { family: options } : (options || {});
    // 从一个已兑现的 Promise 开始，确保自定义 lookup 的同步异常也通过 callback
    // 返回，而不是逃逸到 net/https 的内部调用栈。
    Promise.resolve().then(() => lookup(hostname, lookupOptions)).then((result) => {
      const sourceRows = Array.isArray(result) ? result : (result ? [result] : []);
      const rows = sourceRows.map((row) => normalizedAddress(row, hostname));
      if (!rows.length) throw new Error(`DNS 未返回地址（${hostname}）`);
      return rows;
    }).then((rows) => {
      if (lookupOptions.all) {
        callback(null, rows);
        return;
      }
      callback(null, rows[0].address, rows[0].family);
    }).catch((error) => callback(error));
  };
}

function decodedStream(stream, encoding) {
  const value = String(encoding || '').trim().toLowerCase();
  const encodings = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (!encodings.length || encodings.every((item) => item === 'identity')) {
    return { stream, decoded: false };
  }
  // Content-Encoding 按应用顺序列出，解码必须逆序。只在整个链都受支持且
  // 层数有界时处理，避免“解了一半却仍声称原编码”的不一致。
  if (encodings.length > 4 || encodings.some((item) => !['gzip', 'x-gzip', 'deflate', 'br', 'identity'].includes(item))) {
    return { stream, decoded: false };
  }
  const decoders = [];
  try {
    for (const item of encodings.reverse()) {
      if (item === 'identity') continue;
      if (item === 'gzip' || item === 'x-gzip') decoders.push(zlib.createGunzip());
      else if (item === 'deflate') decoders.push(zlib.createInflate());
      else if (item === 'br') decoders.push(zlib.createBrotliDecompress());
    }
    if (!decoders.length) return { stream, decoded: false };

    // pipe() 不会把源流错误可靠地转发给解压流。pipeline() 会在上游断开、
    // AbortSignal 取消或压缩数据损坏时销毁整条链，让 Response.body 正确报错。
    pipeline(stream, ...decoders, () => {});
    return { stream: decoders[decoders.length - 1], decoded: true };
  } catch (error) {
    for (const decoder of decoders) if (!decoder.destroyed) decoder.destroy();
    throw error;
  }
}

function appendResponseHeaders(rawHeaders, decoded) {
  const headers = new Headers();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    if (decoded && /^(content-encoding|content-length)$/i.test(name)) continue;
    headers.append(name, rawHeaders[i + 1]);
  }
  return headers;
}

function responseSetCookies(incoming) {
  const header = incoming.headers?.['set-cookie'];
  if (Array.isArray(header)) return header.map(String);
  if (header != null) return [String(header)];
  const rawHeaders = incoming.rawHeaders || [];
  const cookies = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (/^set-cookie$/i.test(String(rawHeaders[i]))) cookies.push(String(rawHeaders[i + 1]));
  }
  return cookies;
}

function requestBody(value) {
  if (value == null || typeof value === 'string' || Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  throw new TypeError('httpsFetch 不支持该请求体类型');
}

function requestAbortReason(signal) {
  if (signal && signal.reason !== undefined) return signal.reason;
  return new DOMException('Aborted', 'AbortError');
}

function bindResponseAbort(signal, incoming, stream) {
  if (!signal || !stream) return;
  const onAbort = () => {
    // ClientRequest 的原生 signal 支持主要负责终止 socket；这里同时给响应流
    // 传递调用方原始 reason，和原生 fetch 行为一致；非 Error reason 才回退
    // 到稳定的 AbortError，避免 stream.destroy() 收到非错误值。
    const reason = requestAbortReason(signal);
    const error = reason instanceof Error ? reason : new DOMException('The operation was aborted.', 'AbortError');
    if (!stream.destroyed) stream.destroy(error);
    if (stream !== incoming && !incoming.destroyed) incoming.destroy();
  };
  const cleanup = () => signal.removeEventListener('abort', onAbort);
  signal.addEventListener('abort', onAbort, { once: true });
  stream.once('close', cleanup);
  if (signal.aborted) onAbort();
}

/**
 * 支持本项目用到的 GET/POST、Buffer/字符串 body、AbortSignal 和 manual redirect。
 * 自动重定向必须由调用方逐跳验证后处理，因此无论 init.redirect 为何都不跟随。
 */
function httpsFetch(input, init = {}, lookup) {
  let url;
  let body;
  try {
    url = input instanceof URL ? input : new URL(input);
    body = requestBody(init.body);
  } catch (error) {
    return Promise.reject(error);
  }
  if (url.protocol !== 'https:') return Promise.reject(new Error('httpsFetch 仅允许 HTTPS'));
  if (init.signal?.aborted) return Promise.reject(requestAbortReason(init.signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const destroyAfterInitError = (incoming, stream, error) => {
      // 不把 error 传给 destroy()：此处可能尚未为流安装 error 监听器，直接
      // destroy(error) 会在拒绝 Promise 之外再制造一次 uncaughtException。
      if (stream && stream !== incoming && !stream.destroyed) stream.destroy();
      if (incoming && !incoming.destroyed) incoming.destroy();
      if (req && !req.destroyed) req.destroy();
      rejectOnce(error);
    };

    try {
      req = https.request({
        protocol: 'https:',
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: String(init.method || 'GET').toUpperCase(),
        headers: init.headers || {},
        lookup: lookupCallback(lookup),
        // Node 18.13+ 会按 lookup 返回的地址列表逐一尝试，同时兼容 IPv4/IPv6。
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT,
        signal: init.signal,
      }, (incoming) => {
        if (settled) {
          incoming.destroy();
          return;
        }
        if (init.signal?.aborted) {
          destroyAfterInitError(incoming, null, requestAbortReason(init.signal));
          return;
        }

        let stream;
        try {
          const status = incoming.statusCode || 502;
          const hasNullBody = NULL_BODY_STATUSES.has(status);
          const encoding = incoming.headers?.['content-encoding'];
          const decoded = hasNullBody ? { stream: null, decoded: false } : decodedStream(incoming, encoding);
          stream = decoded.stream;
          const headers = appendResponseHeaders(incoming.rawHeaders || [], decoded.decoded);
          const response = new Response(hasNullBody ? null : Readable.toWeb(stream), {
            status,
            statusText: incoming.statusMessage || '',
            headers,
          });
          const setCookies = responseSetCookies(incoming);
          try {
            Object.defineProperty(response.headers, 'getSetCookie', {
              configurable: true,
              value: () => setCookies.slice(),
            });
          } catch (_) {}

          if (hasNullBody) {
            // 204/205/304 按规范没有可消费的响应体。不能在后台无界 resume()：
            // 违规的 205 chunked 上游可以永不结束，而调用方已拿到 null body 并会
            // 清理自己的 deadline。直接关闭该响应/连接，代价只是放弃罕见状态的
            // keep-alive 复用，换取明确的资源上界。
            incoming.on('error', () => {});
            incoming.destroy();
          } else bindResponseAbort(init.signal, incoming, stream);
          settled = true;
          resolve(response);
        } catch (error) {
          destroyAfterInitError(incoming, stream, error);
        }
      });
    } catch (error) {
      rejectOnce(error);
      return;
    }

    req.on('error', (error) => {
      rejectOnce(init.signal?.aborted ? requestAbortReason(init.signal) : error);
    });
    try {
      if (body != null) req.write(body);
      req.end();
    } catch (error) {
      if (!req.destroyed) req.destroy();
      rejectOnce(error);
    }
  });
}

module.exports = { httpsFetch };
