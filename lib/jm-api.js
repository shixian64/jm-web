'use strict';
/**
 * JM API 客户端（参照 jm-mobile / jmcomic-next 的 Retrofit 协议实现）
 *
 * 协议要点（均来自上述客户端源码）：
 *  - 每个请求带 header:  tokenparam = "{ts},{API_VERSION}", token = md5("{ts}" + SECRET)
 *  - 响应为 { code, data, errorMsg }，code===200 时 data 是
 *    AES-256-ECB/PKCS5Padding 加密后 Base64，密钥即 token（32 位 hex 字符串）
 *  - chapter_view_template 返回 HTML（未加密），内嵌 images/imghost/jmid/cache 与
 *    aid / scramble_id / speed
 *
 * 域名故障切换策略：
 *  - GET：网络错误 / 超时 / 5xx / 403 → 尝试下一个域名（受总时间预算约束）
 *  - POST：仅确定请求未被送达的错误（DNS 解析失败、连接被拒）才换域名重发，
 *    避免超时后重发导致重复登录/重复评论/重复签到
 *  - 401（凭证问题）与业务 code!=200：立即抛出，不换域名
 */

const crypto = require('crypto');
const dns = require('dns');
const net = require('net');

const API_SECRET = '185Hcomic3PAPP7R';
const API_VERSION = '1.8.2';

// 内置 API 域名（与 jmcomic-next LocalSetting.apiList 一致，可被环境变量/设置页覆盖）
const BUILTIN_API_HOSTS = [
  'https://www.cdnhth.club',
  'https://www.cdnmhwscc.vip',
  'https://www.jmapiproxyxxx.vip',
  'https://www.cdnxxx-proxy.xyz',
  'https://www.jmeadpoolcdn.life',
];

// 内置图片（封面等）域名，与 jmcomic-next ComicCoverUrlResolver 一致
const BUILTIN_IMAGE_HOSTS = [
  'https://cdn-msp.jmapiproxy1.cc',
  'https://cdn-msp.jmapiproxy2.cc',
  'https://cdn-msp2.jmapiproxy2.cc',
  'https://cdn-msp3.jmapinodeudzn.net',
  'https://cdn-msp.jmapinodeudzn.net',
  'https://cdn-msp3.jmapiproxy2.cc',
];

function positiveTimeout(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  // Node 计时器与 AbortSignal.timeout 都要求有界的整数毫秒。
  return Math.min(0x7fffffff, Math.max(1, Math.floor(parsed)));
}

const UA = process.env.JM_UA || 'okhttp/4.9.3';
const TIMEOUT = positiveTimeout(process.env.JM_TIMEOUT, 20000);
// 所有域名轮询的总时间预算（防止 5 域名 × 20s 远超前端超时）
const TOTAL_TIMEOUT = positiveTimeout(process.env.JM_TOTAL_TIMEOUT, 35000);
const MAX_API_RESPONSE_BYTES = Math.min(
  32 * 1024 * 1024,
  Math.max(1024 * 1024, Number(process.env.JMW_MAX_API_RESPONSE_BYTES) || 16 * 1024 * 1024)
);

function unsafeIPv4(ip) {
  const [a, b, c] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    // RFC 2544 基准测试网段在 VPN/容器网络中也常被内部使用，不能当公网。
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function ipv6Bytes(ip) {
  ip = ip.toLowerCase().split('%')[0];
  if (ip.includes('.')) {
    const idx = ip.lastIndexOf(':');
    const v4 = ip.slice(idx + 1);
    if (net.isIP(v4) !== 4) return null;
    const b = v4.split('.').map(Number);
    ip = `${ip.slice(0, idx)}:${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const words = [...left, ...Array(missing).fill('0'), ...right];
  if (words.length !== 8 || words.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  return words.flatMap((x) => {
    const n = parseInt(x, 16);
    return [n >>> 8, n & 255];
  });
}

function unsafeIp(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return unsafeIPv4(ip);
  if (kind !== 6) return true;
  const b = ipv6Bytes(ip);
  if (!b) return true;
  return (
    b.every((x) => x === 0) ||
    (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) ||
    (b.slice(0, 10).every((x) => x === 0) && b[10] === 255 && b[11] === 255) ||
    (b[0] & 0xfe) === 0xfc ||
    (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) ||
    b[0] === 0xff ||
    (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8)
  );
}

/**
 * 在每次出站请求前解析当前 DNS 结果，任一 A/AAAA 记录为非公网即拒绝。
 * 这不能让 fetch 与校验共用同一 socket 解析结果，但结合上层精确 origin
 * 白名单，可阻断用户提交临时 rebinding 域名和已解析到内网的记录。
 */
function abortReason(signal) {
  if (signal && signal.reason instanceof Error) return signal.reason;
  const error = new Error('请求已取消');
  error.name = 'AbortError';
  return error;
}

function withTimeout(promise, timeoutMs, message, signal) {
  if (signal && signal.aborted) return Promise.reject(abortReason(signal));
  const racers = [Promise.resolve(promise)];
  let timer;
  let onAbort;
  if (timeoutMs > 0) {
    const ms = Math.max(1, Math.floor(Number(timeoutMs) || 0));
    racers.push(new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ApiError(message, 504)), ms);
    }));
  }
  if (signal) {
    racers.push(new Promise((_, reject) => {
      onAbort = () => reject(abortReason(signal));
      signal.addEventListener('abort', onAbort, { once: true });
    }));
  }
  return Promise.race(racers).finally(() => {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  });
}

async function assertPublicUrl(input, lookup = dns.promises.lookup, timeoutMs = 0, signal) {
  if (signal && signal.aborted) throw abortReason(signal);
  let u;
  try { u = input instanceof URL ? input : new URL(input); } catch (_) {
    throw new ApiError('远程地址不合法', 400);
  }
  if (u.protocol !== 'https:' || u.username || u.password) {
    throw new ApiError('远程地址必须使用无用户信息的 HTTPS', 400);
  }
  let host = u.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home') || host.endsWith('.home.arpa')) {
    throw new ApiError('远程主机不得为本地/内网名称', 403);
  }
  if (net.isIP(host)) {
    if (unsafeIp(host)) throw new ApiError('远程主机不得为环回、私网或链路本地地址', 403);
    return [host];
  }
  let answers;
  try {
    const pending = lookup(host, { all: true, verbatim: true, signal });
    answers = timeoutMs > 0 || signal
      ? await withTimeout(pending, timeoutMs, `DNS 解析超时（${host}）`, signal)
      : await pending;
  } catch (e) {
    if (signal && signal.aborted) throw abortReason(signal);
    if (e instanceof ApiError) throw e;
    throw new ApiError(`DNS 解析失败（${host}）：${e.message}`, 502);
  }
  if (!Array.isArray(answers)) answers = answers && answers.address ? [answers] : [];
  if (!answers.length) throw new ApiError(`DNS 未返回地址（${host}）`, 502);
  if (answers.some((x) => !x || unsafeIp(String(x.address || '')))) {
    throw new ApiError(`DNS 解析到非公网地址（${host}）`, 403);
  }
  return answers.map((x) => x.address);
}

function md5(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

function sign() {
  const ts = Math.floor(Date.now() / 1000);
  const token = md5(`${ts}${API_SECRET}`);
  return { ts, token, tokenparam: `${ts},${API_VERSION}` };
}

/** AES-256-ECB/PKCS5Padding 解密（密钥即 token 的 32 位 hex 字符串） */
function decryptData(b64, token) {
  const raw = Buffer.from(b64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-ecb', Buffer.from(token, 'utf8'), null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(raw), decipher.final()]).toString('utf8');
}

/** 构建 multipart/form-data（对齐 Retrofit @Multipart 的 Part 语义） */
function multipartBody(parts) {
  const boundary = '----JMW' + crypto.randomBytes(12).toString('hex');
  const chunks = [];
  for (const p of parts) {
    if (p.value === undefined || p.value === null) continue;
    if (typeof p.value === 'string' && p.value.includes(boundary)) {
      throw new ApiError('表单内容包含非法字符', 400);
    }
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}\r\n`,
        'utf8'
      )
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(chunks) };
}

/** 解析 Set-Cookie，保留 name=value（JM 只依赖 AVS 等少数 cookie） */
function parseSetCookies(setCookies) {
  const out = {};
  for (const line of setCookies || []) {
    const idx = line.indexOf(';');
    const pair = (idx === -1 ? line : line.slice(0, idx)).trim();
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (eq > 0 && /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) &&
        value.length <= 4096 && !/[\r\n]/.test(value)) out[name] = value;
  }
  return out;
}

function cookieHeader(cookies) {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

class ApiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** 请求是否确定未被送达（仅这类错误允许 POST 换域名重发） */
function requestNeverSent(e) {
  // global fetch/undici 通常把网络码放在 cause.code，Node 核心 https 则直接
  // 放在 error.code。两种出站实现都可能被注入，不能因此让可安全重试的
  // POST 在第一条未建立连接的线路上直接失败。
  const safeCodes = new Set([
    'ENOTFOUND', 'EAI_AGAIN', 'ENODATA',
    'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL',
  ]);
  for (let current = e, depth = 0; current && depth < 4; depth++, current = current.cause) {
    if (safeCodes.has(current.code)) return true;
  }
  return false;
}

async function cancelBody(response) {
  try {
    if (response && response.body) await response.body.cancel();
  } catch (_) {}
}

function linkedAbortSignal(timeoutMs, parentSignal, message = '上游请求超时') {
  const controller = new AbortController();
  const onAbort = () => {
    if (!controller.signal.aborted) controller.abort(abortReason(parentSignal));
  };
  if (parentSignal) {
    if (parentSignal.aborted) onAbort();
    else parentSignal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(new ApiError(message, 504));
  }, positiveTimeout(timeoutMs, TIMEOUT));
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', onAbort);
    },
  };
}

/** 按解压后的实际字节读取响应；Content-Length 只作为提前拒绝，不作为信任边界。 */
async function readResponseBuffer(response, maxBytes = MAX_API_RESPONSE_BYTES, label = '上游响应', signal) {
  const limit = Math.max(1, Math.floor(Number(maxBytes) || MAX_API_RESPONSE_BYTES));
  const rawLength = response && response.headers && response.headers.get('content-length');
  if (rawLength && /^\d+$/.test(rawLength) && Number(rawLength) > limit) {
    await cancelBody(response);
    throw new ApiError(`${label}过大`, 502);
  }
  if (!response || !response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await withTimeout(reader.read(), 0, '', signal);
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > limit) throw new ApiError(`${label}过大`, 502);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    try { await reader.cancel(error); } catch (_) {}
    throw error;
  } finally {
    try { reader.releaseLock(); } catch (_) {}
  }
}

async function readResponseText(response, maxBytes = MAX_API_RESPONSE_BYTES, label = '上游响应', signal) {
  return (await readResponseBuffer(response, maxBytes, label, signal)).toString('utf8');
}

function originCookieStore(jar, origin, create) {
  if (!jar || !origin) return null;
  if (!jar.cookiesByOrigin || typeof jar.cookiesByOrigin !== 'object' || Array.isArray(jar.cookiesByOrigin)) {
    if (!create) return null;
    jar.cookiesByOrigin = {};
  }
  let store = jar.cookiesByOrigin[origin];
  if (!store || typeof store !== 'object' || Array.isArray(store)) {
    if (!create) return null;
    store = {};
    jar.cookiesByOrigin[origin] = store;
  }
  return store;
}

/**
 * 向上游发起一次 API 请求。
 * hosts: 候选域名列表；jar: { cookiesByOrigin: { [origin]: {...} } } 可选
 * expectJson: 为 false 时直接返回原始文本（chapter_view_template）
 * 返回解密后的 JSON 对象（或原始 HTML 字符串）
 */
async function upstreamRequest({
  method = 'GET', path, query = {}, form = null, hosts, jar, cookieHosts,
  dnsLookup, fetchImpl = fetch, signal,
}) {
  method = String(method || 'GET').toUpperCase();
  const expectJson = !/chapter_view_template/.test(path);

  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  let body = null;
  let contentType = null;
  if (form) {
    const mp = multipartBody(form);
    body = mp.body;
    contentType = mp.contentType;
  }

  let lastErr = null;
  const list = hosts && hosts.length ? hosts : BUILTIN_API_HOSTS;
  // Cookie 只能发往服务器明确信任的 origin。即使调用方误把其他 Host
  // 放入候选列表，也不会带出 AVS 等登录 Cookie。
  const cookieOrigins = new Set((cookieHosts || BUILTIN_API_HOSTS).map((x) => {
    try { return new URL(x).origin; } catch (_) { return ''; }
  }).filter(Boolean));
  const deadline = Date.now() + TOTAL_TIMEOUT;
  for (let i = 0; i < list.length; i++) {
    if (signal && signal.aborted) throw abortReason(signal);
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const host = list[i].replace(/\/+$/, '');
    const url = `${host}${path}${qs ? `?${qs}` : ''}`;
    try {
      // 每次 fetch 前检查当前全部 A/AAAA，避免受信域名被错误 DNS/重绑定到内网。
      await assertPublicUrl(
        host,
        dnsLookup || dns.promises.lookup,
        Math.min(TIMEOUT, remaining),
        signal
      );
    } catch (e) {
      if (signal && signal.aborted) throw abortReason(signal);
      lastErr = e instanceof ApiError ? e : new ApiError(e.message || 'DNS 安全校验失败', 502);
      continue; // 尚未发送请求，GET/POST 均可安全尝试下一个候选
    }
    const fetchRemaining = deadline - Date.now();
    if (fetchRemaining <= 0) break;
    let hostOrigin = '';
    try { hostOrigin = new URL(host).origin; } catch (_) {}
    const cookieTrusted = cookieOrigins.has(hostOrigin);
    const cookieStore = cookieTrusted ? originCookieStore(jar, hostOrigin, false) : null;
    const { token, tokenparam } = sign();
    const headers = {
      'User-Agent': UA,
      token,
      tokenparam,
    };
    if (cookieStore && Object.keys(cookieStore).length) headers.Cookie = cookieHeader(cookieStore);
    if (contentType) headers['Content-Type'] = contentType;

    let res;
    const attempt = linkedAbortSignal(Math.min(TIMEOUT, fetchRemaining), signal);
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body,
        // API 域名不允许透过 30x 把带 Cookie 的请求导向未信任主机。
        redirect: 'manual',
        signal: attempt.signal,
        // features.outboundFetch 用该 lookup 固定安全校验后的真实连接地址；
        // 标准 fetch 实现会忽略未知的项目私有字段。
        jmwLookup: dnsLookup,
      });
    } catch (e) {
      attempt.cleanup();
      if (signal && signal.aborted) throw abortReason(signal);
      const timedOut = attempt.signal.aborted && attempt.signal.reason instanceof Error
        ? attempt.signal.reason : null;
      if (method !== 'GET' && !requestNeverSent(e)) {
        if (timedOut instanceof ApiError) throw timedOut;
        throw new ApiError('网络错误：' + e.message, 504);
      }
      lastErr = timedOut || e;
      continue; // 网络层错误（超时/DNS/连接失败）→ 尝试下一个域名
    }

    try {
    if (res.status >= 300 && res.status < 400) {
      lastErr = new ApiError(`上游返回了不允许的重定向（HTTP ${res.status}）`, 502);
      await cancelBody(res);
      if (method === 'GET') continue;
      throw lastErr;
    }
    if (res.status >= 500) {
      lastErr = new ApiError(`上游服务器错误（HTTP ${res.status}）`, res.status);
      await cancelBody(res);
      if (method === 'GET') continue;
      throw lastErr; // 非幂等 POST 可能已执行，不得换域名重放
    }
    if (res.status === 403 && method === 'GET' && i < list.length - 1) {
      lastErr = new ApiError('请求被上游拒绝（HTTP 403）', 403);
      await cancelBody(res);
      continue; // 域名常被逐一封锁 → 尝试下一个
    }
    if (res.status === 401 || res.status === 403) {
      await cancelBody(res);
      throw new ApiError('请求被上游拒绝（HTTP ' + res.status + '），请尝试更换 API 域名', res.status);
    }
    if (res.status >= 400) {
      await cancelBody(res);
      throw new ApiError(`请求失败（HTTP ${res.status}）`, res.status);
    }

    // 只接收受信 origin 的 Cookie（登录后获得 AVS）。
    if (jar && cookieTrusted) {
      const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      const received = parseSetCookies(set);
      if (Object.keys(received).length) Object.assign(originCookieStore(jar, hostOrigin, true), received);
    }

    let text;
    try {
      text = await readResponseText(res, MAX_API_RESPONSE_BYTES, '上游 API 响应', attempt.signal);
    } catch (e) {
      if (signal && signal.aborted) throw abortReason(signal);
      const timedOut = attempt.signal.aborted && attempt.signal.reason instanceof Error
        ? attempt.signal.reason : null;
      lastErr = timedOut instanceof ApiError
        ? timedOut
        : (e instanceof ApiError ? e : new ApiError('读取上游响应失败：' + e.message, 502));
      if (method === 'GET') continue;
      throw lastErr;
    }

    if (!expectJson) return text;

    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      // JSON 接口的 HTML/纯文本风控页都不是成功响应。
      lastErr = new ApiError('上游返回了非 JSON 异常响应，请尝试更换 API 域名', 502);
      if (method === 'GET') continue;
      throw lastErr;
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      lastErr = new ApiError('上游返回了非对象 JSON 异常响应', 502);
      if (method === 'GET') continue;
      throw lastErr;
    }
    if (json.code === 200) {
      if (typeof json.data === 'string' && json.data.length > 0) {
        try {
          json.data = JSON.parse(decryptData(json.data, token));
        } catch (e) {
          lastErr = new ApiError('响应解密失败：' + e.message, 502);
          if (method === 'GET') continue;
          throw lastErr;
        }
      }
      return json;
    }
    throw new ApiError(json.errorMsg || `接口错误（code=${json.code}）`, json.code);
    } finally {
      attempt.cleanup();
    }
  }
  if (lastErr instanceof ApiError) throw lastErr;
  throw new ApiError('无法连接上游 API（已尝试所有域名）：' + (lastErr ? lastErr.message : ''), 504);
}

module.exports = {
  ApiError,
  BUILTIN_API_HOSTS,
  BUILTIN_IMAGE_HOSTS,
  API_VERSION,
  TIMEOUT,
  TOTAL_TIMEOUT,
  MAX_API_RESPONSE_BYTES,
  positiveTimeout,
  md5,
  sign,
  decryptData,
  assertPublicUrl,
  linkedAbortSignal,
  readResponseBuffer,
  readResponseText,
  upstreamRequest,
};
