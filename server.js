'use strict';
/**
 * JM Web —— 零依赖 Node 服务器
 *  - /api/*   业务接口（签名转发上游、AES 解密、会话 Cookie、图片代理）
 *  - 其余 GET 从 public/ 提供静态文件（SPA，回退 index.html）
 *
 * 环境变量：
 *  PORT            监听端口（默认 3210）
 *  HOST            监听地址（默认 0.0.0.0）
 *  ACCESS_PASSWORD 设置后所有 /api 需要访问口令（简单访问保护）
 *  JM_API_BASE     固定 API 域名（逗号分隔；设置后锁定，接口不可更改）
 *  JM_UA           上游 UA（默认 okhttp/4.9.3）
 *  JM_TIMEOUT      上游单域名超时 ms（默认 20000）
 *  JM_TOTAL_TIMEOUT 上游全部域名总时间预算 ms（默认 35000）
 *  JMW_DATA_DIR    数据目录（默认 ./data）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const { ApiError, upstreamRequest, assertPublicUrl, API_VERSION } = require('./lib/jm-api');
const { parsePhotoHtml } = require('./lib/photo');
const sessions = require('./lib/sessions');
const settings = require('./lib/settings');

const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || '';

const SAFE_RASTER_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const MAX_IMAGE_BYTES = Math.min(100 * 1024 * 1024, Math.max(1024 * 1024, Number(process.env.JMW_MAX_IMAGE_BYTES) || 25 * 1024 * 1024));
const MAX_IMAGE_REDIRECTS = 4;
const MAX_IMAGE_CONCURRENCY = Math.min(100, Math.max(1, Number(process.env.JMW_MAX_IMAGE_CONCURRENCY) || 24));
let activeImageRequests = 0;

const API_METHODS = Object.freeze({
  '/config': ['GET'],
  '/config/api-host': ['POST'],
  '/auth': ['POST'],
  '/me': ['GET'],
  '/login': ['POST'],
  '/logout': ['POST'],
  '/daily': ['GET'],
  '/daily_chk': ['POST'],
  '/home': ['GET'],
  '/promote_list': ['GET'],
  '/album': ['GET'],
  '/search': ['GET'],
  '/categories': ['GET'],
  '/categories_filter': ['GET'],
  '/week': ['GET'],
  '/week_filter': ['GET'],
  '/comments': ['GET'],
  '/user_comments': ['GET'],
  '/comment': ['POST'],
  '/like': ['POST'],
  '/favorite': ['POST'],
  '/favorites': ['GET'],
  '/history': ['GET'],
  '/chapter': ['GET'],
  '/img': ['GET'],
  '/setting': ['GET'],
});

/* ----------------------------- 启动检查 ----------------------------- */

if (typeof fetch !== 'function') {
  console.error('[启动失败] 需要 Node.js 18 或更高版本（内置 fetch）');
  process.exit(1);
}
if (typeof Response !== 'undefined' && !new Response().headers.getSetCookie) {
  console.warn('[警告] 当前 Node 版本不支持 getSetCookie()（需要 18.14.1+），登录态将无法保持');
}
if (!ACCESS_PASSWORD) {
  console.warn('[警告] 未设置 ACCESS_PASSWORD：任何访客都可以使用本站，并可在设置中切换自己的 API 线路');
}

// 环境变量指定的 API 域名优先级最高且锁定（仅内存，不写入设置文件）
if (process.env.JM_API_BASE) {
  const hosts = process.env.JM_API_BASE.split(',').map((s) => settings.normalizeHost(s.trim())).filter(Boolean);
  if (hosts.length) settings.setEnvApiHosts(hosts);
  else console.warn('[警告] JM_API_BASE 未包含合法域名，已忽略');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "worker-src 'self' blob:",
].join('; ');

/* ----------------------------- 工具函数 ----------------------------- */

function baseHeaders(extra) {
  return Object.assign({ 'X-Content-Type-Options': 'nosniff' }, extra);
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, baseHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  }));
  res.end(body);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new ApiError('请求体过大', 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (_) {
    throw new ApiError('请求体不是合法 JSON', 400);
  }
}

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq > 0 && pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return '';
}

/** 长度相同前提下的时间安全比较 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** 简单固定窗口限流（内存实现，重启清零） */
const rateBuckets = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(key, b);
  }
  b.count++;
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) if (now > v.resetAt) rateBuckets.delete(k);
  }
  return b.count <= limit;
}

function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

/* ----------------------------- 会话/鉴权 ----------------------------- */

function ensureJar(req, res) {
  const sid = getCookie(req, 'jmw_sid');
  let jar = sid ? sessions.loadJar(sid) : null;
  if (!jar) {
    jar = sessions.createJar();
    res.setHeader(
      'Set-Cookie',
      `jmw_sid=${jar.sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7776000`
    );
  }
  // 旧版可能在会话文件中留下任意 Host；升级后一律清除非受信值。
  if (jar.apiHost && !settings.isTrustedApiHost(jar.apiHost)) {
    jar.apiHost = '';
    sessions.scheduleSave(jar);
  }
  return jar;
}

// 访问口令令牌 = sha256(服务器随机密钥 + 口令)：泄露 Cookie 也无法离线爆破出明文口令
let ACCESS_SECRET = '';
try {
  ACCESS_SECRET = fs.readFileSync(path.join(settings.DATA_DIR, '.secret'), 'utf8').trim();
} catch (_) {}
if (!ACCESS_SECRET) {
  ACCESS_SECRET = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(settings.DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(settings.DATA_DIR, '.secret'), ACCESS_SECRET, { mode: 0o600 });
  } catch (e) {
    console.warn('[警告] 无法持久化访问密钥，重启后口令 Cookie 将失效:', e.message);
  }
}

function authToken() {
  return crypto.createHash('sha256').update(`${ACCESS_SECRET}:${ACCESS_PASSWORD}`).digest('hex');
}

function checkAccess(req) {
  if (!ACCESS_PASSWORD) return true;
  return safeEqual(getCookie(req, 'jmw_auth'), authToken());
}

function checkPassword(password) {
  // 比较双方口令的 sha256（长度恒定），可用 timingSafeEqual 防时序侧信道
  const given = crypto.createHash('sha256').update(String(password)).digest();
  const expected = crypto.createHash('sha256').update(ACCESS_PASSWORD).digest();
  return crypto.timingSafeEqual(given, expected);
}

/* ----------------------------- 图片代理 ----------------------------- */

async function cancelBody(response) {
  try { if (response && response.body) await response.body.cancel(); } catch (_) {}
}

function validateImageUrl(url) {
  let u;
  try {
    u = url instanceof URL ? url : new URL(url);
  } catch (_) {
    throw new ApiError('非法图片地址', 400);
  }
  if (u.protocol !== 'https:' || u.username || u.password) {
    throw new ApiError('图片地址必须使用无用户信息的 HTTPS', 400);
  }
  const origin = settings.normalizeHost(u.origin);
  if (!origin || !settings.imageHosts().includes(origin)) {
    throw new ApiError('图片域名不在白名单内：' + u.host, 403);
  }
  u.hash = '';
  return u;
}

/** 手动跟随重定向，每一跳都重新验证 HTTPS 与精确 origin 白名单。 */
async function fetchImageResponse(urlStr, timeoutMs, dnsLookup) {
  let current = validateImageUrl(urlStr);
  const deadline = Date.now() + timeoutMs;
  for (let hop = 0; hop <= MAX_IMAGE_REDIRECTS; hop++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ApiError('图片获取超时', 504);
    // 紧邻 fetch 对每一跳的当前 DNS A/AAAA 做非公网拒绝。
    await assertPublicUrl(current, dnsLookup);
    const fetchRemaining = deadline - Date.now();
    if (fetchRemaining <= 0) throw new ApiError('图片获取超时', 504);
    const response = await fetch(current.href, {
      headers: { 'User-Agent': 'okhttp/4.9.3', Referer: current.origin + '/' },
      signal: AbortSignal.timeout(fetchRemaining),
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await cancelBody(response);
      if (!location) throw new ApiError('图片重定向缺少 Location', 502);
      if (hop >= MAX_IMAGE_REDIRECTS) throw new ApiError('图片重定向次数过多', 502);
      current = validateImageUrl(new URL(location, current));
      continue;
    }
    return { response, finalUrl: current };
  }
  throw new ApiError('图片重定向次数过多', 502);
}

/** 只接收安全栅格图片 MIME，并对解压后实际读取字节数设硬上限。 */
async function readRasterImage(response) {
  const mime = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (!SAFE_RASTER_MIME.has(mime)) {
    await cancelBody(response);
    throw new ApiError(`上游返回了非安全栅格图片类型：${mime || '未知'}`, 415);
  }
  if (!response.body) throw new ApiError('上游图片响应为空', 502);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    await cancelBody(response);
    throw new ApiError(`图片超过 ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)} MiB 上限`, 413);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new ApiError(`图片超过 ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)} MiB 上限`, 413);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (e) {
    try { await reader.cancel(); } catch (_) {}
    if (e instanceof ApiError) throw e;
    throw new ApiError('读取上游图片失败：' + e.message, 502);
  }
  return { mime, body: Buffer.concat(chunks, total) };
}

async function sendUpstreamImage(res, response, cacheDays) {
  const image = await readRasterImage(response);
  if (res.destroyed) return;
  res.writeHead(200, baseHeaders({
    'Cache-Control': `public, max-age=${cacheDays * 86400}, immutable`,
    'Content-Type': image.mime,
    'Content-Length': image.body.length,
  }));
  res.end(image.body);
}

function imageErrorStatus(e) {
  return e instanceof ApiError && e.code >= 400 && e.code < 600 ? e.code : 502;
}

async function proxyImage(res, urlStr, cacheDays = 7) {
  try {
    const { response } = await fetchImageResponse(urlStr, 30000);
    if (!response.ok || !response.body) {
      await cancelBody(response);
      return sendJson(res, 502, { error: `图片获取失败（HTTP ${response.status}）` });
    }
    await sendUpstreamImage(res, response, cacheDays);
  } catch (e) {
    if (!res.headersSent) sendJson(res, imageErrorStatus(e), { error: '图片获取失败：' + e.message });
    else res.destroy();
  }
}

// 图片路径代理：按域名列表依次尝试，失败域名 60 秒内跳过（负缓存）
const imageHostFailedUntil = new Map();

/** path 形式：在图片域名列表中依次尝试（记住成功的域名） */
async function proxyImagePath(res, p) {
  if (!/^\/media\//.test(p)) return sendJson(res, 400, { error: '非法路径' });
  const hosts = settings.imageHosts();
  const now = Date.now();
  let lastError = '所有图片域名均无法获取该资源';
  let lastStatus = 502;
  for (const host of hosts) {
    const failedAt = imageHostFailedUntil.get(host);
    if (failedAt && now < failedAt) continue;
    try {
      const target = host.replace(/\/+$/, '') + p;
      const { response } = await fetchImageResponse(target, 8000);
      if (!response.ok || !response.body) {
        lastError = `HTTP ${response.status}`;
        await cancelBody(response);
        continue;
      }
      await sendUpstreamImage(res, response, 1);
      imageHostFailedUntil.delete(host);
      settings.setPreferredImageHost(host);
      return;
    } catch (e) {
      lastError = e.message || lastError;
      lastStatus = imageErrorStatus(e);
      // 只对网络层故障做负缓存；MIME/重定向安全拒绝不污染域名健康状态。
      if (!(e instanceof ApiError)) imageHostFailedUntil.set(host, now + 60000);
      /* 尝试下一个域名 */
    }
  }
  if (imageHostFailedUntil.size > 200) imageHostFailedUntil.clear();
  sendJson(res, lastStatus, { error: lastError });
}

/* ----------------------------- API 路由 ----------------------------- */

async function api(req, res, u) {
  const route = u.pathname.replace(/^\/api/, '');
  const q = u.searchParams;
  // /api/auth 在口令验证前调用：避免未通过口令的扫描请求也创建会话文件
  const jar = route === '/auth' ? { cookies: {}, user: null, apiHost: '' } : ensureJar(req, res);

  // 透传到上游的快捷封装（会话内 API 域名覆盖优先）
  const call = (opts) => upstreamRequest({
    hosts: settings.apiHosts(jar.apiHost),
    cookieHosts: settings.trustedApiHosts(),
    jar,
    ...opts,
  });

  switch (route) {
    /* ---- 基础 ---- */
    case '/config':
      return sendJson(res, 200, {
        apiVersion: API_VERSION,
        apiHosts: settings.apiHosts(jar.apiHost),
        currentApiHost: settings.isTrustedApiHost(jar.apiHost)
          ? settings.normalizeHost(jar.apiHost)
          : (settings.isTrustedApiHost(settings.get().apiHost) ? settings.normalizeHost(settings.get().apiHost) : ''),
        apiHostLocked: settings.isApiHostLocked(),
        imageHosts: settings.imageHosts(),
        hasAccessPassword: !!ACCESS_PASSWORD,
      });

    case '/config/api-host': {
      if (settings.isApiHostLocked()) {
        return sendJson(res, 403, { error: 'API 域名已由环境变量 JM_API_BASE 固定，无法修改' });
      }
      if (ACCESS_PASSWORD && !checkAccess(req)) {
        return sendJson(res, 403, { error: '仅限站点管理员修改' });
      }
      const body = await readJsonBody(req);
      const host = settings.normalizeHost(String(body.apiHost || ''));
      if (body.apiHost && !host) {
        return sendJson(res, 400, { error: '仅允许安全的 HTTPS API 域名' });
      }
      if (host && !settings.isTrustedApiHost(host)) {
        return sendJson(res, 400, { error: '只能选择服务器内置或 JM_API_BASE 预先配置的 API 域名' });
      }
      // 保存到当前浏览器会话，不影响其他访客
      jar.apiHost = host;
      sessions.scheduleSave(jar);
      return sendJson(res, 200, { ok: true, apiHosts: settings.apiHosts(jar.apiHost) });
    }

    /* ---- 访问口令 ---- */
    case '/auth': {
      if (!rateLimit(`auth:${clientIp(req)}`, 10, 5 * 60 * 1000)) {
        return sendJson(res, 429, { error: '尝试次数过多，请 5 分钟后再试' });
      }
      const body = await readJsonBody(req);
      if (checkPassword(String(body.password || ''))) {
        res.setHeader(
          'Set-Cookie',
          `jmw_auth=${authToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`
        );
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 401, { error: '口令错误' });
    }

    /* ---- 用户 ---- */
    case '/me':
      return sendJson(res, 200, { user: jar.user });

    case '/login': {
      if (!rateLimit(`login:${clientIp(req)}`, 10, 5 * 60 * 1000)) {
        return sendJson(res, 429, { error: '尝试次数过多，请 5 分钟后再试' });
      }
      const body = await readJsonBody(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!username || !password) return sendJson(res, 400, { error: '请输入用户名和密码' });
      const out = await call({ method: 'POST', path: '/login', form: [
        { name: 'username', value: username },
        { name: 'password', value: password },
      ] });
      if (out && out.data) {
        jar.user = out.data;
        sessions.scheduleSave(jar);
      }
      return sendJson(res, 200, out);
    }

    case '/logout':
      sessions.destroyJar(jar.sid);
      res.setHeader('Set-Cookie', 'jmw_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
      return sendJson(res, 200, { ok: true });

    case '/daily':
      return sendJson(res, 200, await call({ path: '/daily', query: { user_id: q.get('user_id') } }));

    case '/daily_chk': {
      const body = await readJsonBody(req);
      return sendJson(res, 200, await call({ method: 'POST', path: '/daily_chk', form: [
        { name: 'user_id', value: String(body.user_id || '') },
        { name: 'daily_id', value: String(body.daily_id || '') },
      ] }));
    }

    /* ---- 漫画 ---- */
    case '/home':
      return sendJson(res, 200, await call({ path: '/promote' }));

    case '/promote_list':
      return sendJson(res, 200, await call({ path: '/promote_list', query: {
        id: q.get('id') || '',
        page: q.get('page') || '1',
      } }));

    case '/album':
      return sendJson(res, 200, await call({ path: '/album', query: { id: q.get('id') } }));

    case '/search':
      return sendJson(res, 200, await call({ path: '/search', query: {
        page: q.get('page') || '1',
        o: q.get('o') || 'mr',
        search_query: q.get('q') || '',
      } }));

    case '/categories':
      return sendJson(res, 200, await call({ path: '/categories' }));

    case '/categories_filter':
      return sendJson(res, 200, await call({ path: '/categories/filter', query: {
        page: q.get('page') || '1',
        c: q.get('c') || '',
        o: q.get('o') || 'mr',
      } }));

    case '/week':
      return sendJson(res, 200, await call({ path: '/week' }));

    case '/week_filter':
      return sendJson(res, 200, await call({ path: '/week/filter', query: {
        page: q.get('page') || '1',
        id: q.get('id') || '',
        type: q.get('type') || '',
      } }));

    case '/comments':
      return sendJson(res, 200, await call({ path: '/forum', query: {
        page: q.get('page') || '1',
        aid: q.get('aid') || '',
        mode: 'manhua',
      } }));

    case '/user_comments':
      return sendJson(res, 200, await call({ path: '/forum', query: {
        page: q.get('page') || '1',
        uid: q.get('uid') || '',
      } }));

    case '/comment': {
      const body = await readJsonBody(req);
      const content = String(body.content || '');
      if (!content.trim()) return sendJson(res, 400, { error: '评论内容不能为空' });
      const form = [
        { name: 'comment', value: content },
        { name: 'aid', value: String(body.aid || '') },
        { name: 'status', value: String(body.status ?? '0') },
      ];
      if (body.comment_id) form.push({ name: 'comment_id', value: String(body.comment_id) });
      return sendJson(res, 200, await call({ method: 'POST', path: '/comment', form }));
    }

    case '/like':
      return sendJson(res, 200, await call({ method: 'POST', path: '/like', form: [
        { name: 'id', value: String(q.get('id') || '') },
      ] }));

    case '/favorite':
      return sendJson(res, 200, await call({ method: 'POST', path: '/favorite', form: [
        { name: 'aid', value: String(q.get('aid') || '') },
      ] }));

    case '/favorites':
      return sendJson(res, 200, await call({ path: '/favorite', query: {
        page: q.get('page') || '1',
        o: q.get('o') || 'mr',
        folder_id: q.get('folder_id') || '0',
      } }));

    case '/history':
      return sendJson(res, 200, await call({ path: '/watch_list', query: { page: q.get('page') || '1' } }));

    case '/chapter': {
      const id = q.get('id');
      const shunt = q.get('shunt') || '1';
      if (!id || !/^\d+$/.test(id)) return sendJson(res, 400, { error: '缺少 id' });
      const html = await call({ path: '/chapter_view_template', query: {
        id,
        app_img_shunt: shunt,
        mode: 'vertical',
        page: '0',
        express: 'off',
        v: String(Math.floor(Date.now() / 1000)),
      } });
      let parsed;
      try {
        parsed = parsePhotoHtml(String(html));
      } catch (e) {
        // 上游返回异常页面属上游问题，按 502 返回而非 500 内部错误
        throw new ApiError(e.message || '解析章节 HTML 失败', 502);
      }
      if (parsed.imghost) settings.addImageHost(parsed.imghost);
      return sendJson(res, 200, { code: 200, data: parsed });
    }

    /* ---- 图片代理 ---- */
    case '/img': {
      const upath = q.get('path');
      const abs = q.get('u');
      if (!abs && !upath) return sendJson(res, 400, { error: '缺少 path 或 u 参数' });
      if (activeImageRequests >= MAX_IMAGE_CONCURRENCY) {
        return sendJson(res, 503, { error: '图片代理并发请求过多，请稍后重试' }, { 'Retry-After': '1' });
      }
      activeImageRequests++;
      try {
        if (abs) return await proxyImage(res, abs, 30);
        return await proxyImagePath(res, upath.startsWith('/') ? upath : '/' + upath);
      } finally {
        activeImageRequests--;
      }
    }

    case '/setting': {
      // 远端设置（img_host 等），同时并入图片域名白名单
      const out = await call({ path: '/setting' });
      try {
        if (out && out.data && out.data.img_host) {
          const host = settings.normalizeHost(String(out.data.img_host));
          if (host) settings.set({ imgHost: host });
        }
      } catch (_) {}
      return sendJson(res, 200, out);
    }

    default:
      return sendJson(res, 404, { error: '接口不存在：' + route });
  }
}

/* ----------------------------- 静态文件 ----------------------------- */

function serveStatic(req, res, u) {
  let p;
  try {
    p = decodeURIComponent(u.pathname);
  } catch (_) {
    res.writeHead(400, baseHeaders());
    return res.end('Bad Request');
  }
  // Node 的 fs API 会对含 NUL 的路径同步抛错；在进入异步文件操作前拒绝，
  // 避免 async request listener 产生未处理 rejection 并终止进程。
  if (p.includes('\0')) {
    res.writeHead(400, baseHeaders());
    return res.end('Bad Request');
  }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  // 防目录穿越：必须在 public 内（附加分隔符，避免 public* 兄弟目录被前缀匹配放行）
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, baseHeaders());
    return res.end('Forbidden');
  }
  fs.stat(file, (err, st) => {
    const afterRead = (e2, buf) => {
      if (e2) {
        // SPA 回退：非资源请求一律回 index.html
        if (!path.extname(p)) {
          return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e3, buf2) => {
            if (e3) {
              res.writeHead(500, baseHeaders());
              return res.end('index.html missing');
            }
            res.writeHead(200, baseHeaders({
              'Content-Type': MIME['.html'],
              'Content-Security-Policy': CSP,
              'Cache-Control': 'no-cache',
            }));
            res.end(buf2);
          });
        }
        res.writeHead(404, baseHeaders());
        return res.end('Not Found');
      }
      // ETag 协商缓存：资源更新即时生效，未变更走 304
      const etag = `W/"${st.size}-${st.mtimeMs}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, baseHeaders({ ETag: etag }));
        return res.end();
      }
      const ext = path.extname(file).toLowerCase();
      const headers = baseHeaders({
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      if (ext === '.html') headers['Content-Security-Policy'] = CSP;
      headers.ETag = etag;
      res.writeHead(200, headers);
      res.end(buf);
    };
    if (err) return afterRead(err);
    fs.readFile(file, afterRead);
  });
}

/* ----------------------------- 服务器 ----------------------------- */

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let u;
  try {
    u = new URL(req.url, 'http://localhost');
  } catch (_) {
    res.writeHead(400, baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
    return res.end('Bad Request');
  }
  res.on('finish', () => {
    if (u.pathname.startsWith('/api/') && u.pathname !== '/api/img') {
      console.log(`[api] ${req.method} ${u.pathname}${u.search} -> ${res.statusCode} (${Date.now() - started}ms)`);
    }
  });

  // 容器/反代健康检查：不验证访问口令，不创建会话，不访问上游。
  if (u.pathname === '/healthz') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: '不支持的请求方法' }, { Allow: 'GET, HEAD' });
    }
    const body = JSON.stringify({ ok: true });
    res.writeHead(200, baseHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    }));
    return res.end(req.method === 'HEAD' ? undefined : body);
  }

  if (u.pathname === '/api' || u.pathname.startsWith('/api/')) {
    try {
      const route = u.pathname.replace(/^\/api/, '');
      const allowed = Object.prototype.hasOwnProperty.call(API_METHODS, route) ? API_METHODS[route] : null;
      if (!allowed) return sendJson(res, 404, { error: '接口不存在：' + route });
      if (!allowed.includes(req.method)) {
        return sendJson(res, 405, { error: '不支持的请求方法' }, { Allow: allowed.join(', ') });
      }
      if (ACCESS_PASSWORD && u.pathname !== '/api/auth' && !checkAccess(req)) {
        return sendJson(res, 401, { error: '需要访问口令', needAuth: true });
      }
      await api(req, res, u);
    } catch (e) {
      const status = e instanceof ApiError ? (e.code >= 400 && e.code < 600 ? e.code : 502) : 500;
      if (!(e instanceof ApiError)) console.error('[api] 内部错误:', e);
      if (!res.headersSent) sendJson(res, status, { error: e.message || '服务器内部错误' });
      else res.end();
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, baseHeaders());
    return res.end();
  }
  serveStatic(req, res, u);
});

function startServer() {
  return server.listen(PORT, HOST, () => {
    console.log(`JM Web 已启动: http://localhost:${PORT}  (Node ${process.version})`);
    if (ACCESS_PASSWORD) console.log('访问口令保护已开启');
    console.log(`API 域名候选: ${settings.apiHosts().join(', ')}`);
    if (settings.isApiHostLocked()) console.log('（已由 JM_API_BASE 锁定，设置页不可切换）');
  });
}

/* ----------------------------- 优雅退出 ----------------------------- */

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n收到 ${signal}，正在保存状态…`);
  try { sessions.flushAll(); } catch (_) {}
  try { settings.flushNow(); } catch (_) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
if (require.main === module) {
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  startServer();
}

module.exports = {
  server,
  startServer,
  API_METHODS,
  validateImageUrl,
  fetchImageResponse,
  readRasterImage,
  MAX_IMAGE_BYTES,
  SAFE_RASTER_MIME,
};
