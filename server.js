'use strict';
/**
 * JM Web —— 零依赖 Node 服务器
 *  - /api/*   业务接口（签名转发上游、AES 解密、会话 Cookie、图片代理）
 *  - 其余 GET 从 public/ 提供静态文件（SPA，回退 index.html）
 *
 * 环境变量：
 *  PORT            监听端口（默认 3210）
 *  HOST            监听地址（默认 127.0.0.1）
 *  ACCESS_PASSWORD 设置后所有 /api 需要访问口令（简单访问保护）
 *  JM_API_BASE     固定 API 域名（逗号分隔；设置后锁定，接口不可更改）
 *  JM_UA           上游 UA（默认 okhttp/4.9.3）
 *  JM_TIMEOUT      上游单域名超时 ms（默认 20000）
 *  JM_TOTAL_TIMEOUT 上游全部域名总时间预算 ms（默认 35000）
 *  JMW_MAX_CHAPTER_IMAGES 单章节图片数量上限（默认 2000）
 *  JMW_MAX_IMAGE_CONCURRENCY 图片代理全局并发（默认 12）
 *  JMW_MAX_IMAGE_CONCURRENCY_PER_IP 单客户端图片代理并发（默认 6）
 *  JMW_IMAGE_CACHE_BYTES 图片成功响应内存缓存总上限（默认 64 MiB）
 *  JMW_IMAGE_CACHE_ENTRY_BYTES 单张图片内存缓存上限（默认 2 MiB）
 *  JMW_IMAGE_CACHE_TTL 图片内存缓存有效期秒数（默认 86400）
 *  JMW_IMAGE_QUEUE_LIMIT 图片代理等待队列上限（默认 96）
 *  JMW_IMAGE_QUEUE_TIMEOUT 图片代理排队最长等待毫秒（默认 3000）
 *  TRANSLATION_SERVICE_URL 翻译服务地址；留空则阅读器自动回退原图
 *  TRANSLATION_SERVICE_TOKEN 翻译服务内部访问令牌
 *  TRANSLATION_MAX_PAGE_BYTES 翻译单页请求/响应上限（默认 25 MiB）
 *  JMW_TRUST_PROXY 可信反代 IP/CIDR（逗号分隔；环回默认可信）
 *  JMW_DATA_DIR    数据目录（默认 ./data）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { URL } = require('url');

const {
  ApiError, upstreamRequest, assertPublicUrl, readResponseBuffer, API_VERSION,
  setOriginCookie,
} = require('./lib/jm-api');
const { parsePhotoHtml } = require('./lib/photo');
const sessions = require('./lib/sessions');
const settings = require('./lib/settings');
const features = require('./lib/features');
const { ChapterAiScheduler, chapterSourceTitle, effectiveChapterTitle } = require('./lib/chapter-ai');

const configuredPort = Number(process.env.PORT || 3210);
const portIsValid = Number.isInteger(configuredPort) && configuredPort >= 1 && configuredPort <= 65535;
const PORT = portIsValid ? configuredPort : 3210;
if (process.env.PORT && !portIsValid) {
  console.warn(`[警告] PORT=${JSON.stringify(process.env.PORT)} 非法，已回退到 3210（允许 1-65535 的整数）`);
}
// 直接运行默认只监听回环；容器内需要端口发布时由镜像显式设置 0.0.0.0。
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || '';
const MIN_ACCESS_PASSWORD_BYTES = 16;

// 逗号分隔的可信反代 IP/CIDR。环回对端默认作为本机反代信任；
// 其他直连客户即使伪造 X-Forwarded-For 也不会被采信。
const TRUST_PROXY = process.env.JMW_TRUST_PROXY || '';
const trustedProxyBlockList = new net.BlockList();

const SAFE_RASTER_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const MAX_IMAGE_BYTES = Math.min(100 * 1024 * 1024, Math.max(1024 * 1024, Number(process.env.JMW_MAX_IMAGE_BYTES) || 25 * 1024 * 1024));
const MAX_IMAGE_REDIRECTS = 4;
// 图片代理是最容易被预加载/多标签页放大的资源。全局上限保护实例，
// 每客户端上限避免单个浏览器占满全部连接；两者都可由部署者按容量测试调整。
const MAX_IMAGE_CONCURRENCY = Math.min(100, Math.max(1, Number(process.env.JMW_MAX_IMAGE_CONCURRENCY) || 12));
const MAX_IMAGE_CONCURRENCY_PER_IP = Math.min(
  MAX_IMAGE_CONCURRENCY,
  Math.max(1, Number(process.env.JMW_MAX_IMAGE_CONCURRENCY_PER_IP) || 6),
);
const MAX_IMAGE_CACHE_BYTES = Math.min(
  256 * 1024 * 1024,
  Math.max(0, Number.isFinite(Number(process.env.JMW_IMAGE_CACHE_BYTES))
    ? Number(process.env.JMW_IMAGE_CACHE_BYTES) : 64 * 1024 * 1024),
);
const MAX_IMAGE_CACHE_ENTRY_BYTES = Math.min(
  4 * 1024 * 1024,
  MAX_IMAGE_CACHE_BYTES || 0,
  Math.max(0, Number.isFinite(Number(process.env.JMW_IMAGE_CACHE_ENTRY_BYTES))
    ? Number(process.env.JMW_IMAGE_CACHE_ENTRY_BYTES) : 2 * 1024 * 1024),
);
const IMAGE_CACHE_TTL_MS = Math.min(
  7 * 24 * 60 * 60 * 1000,
  Math.max(60 * 1000, (Number.isFinite(Number(process.env.JMW_IMAGE_CACHE_TTL))
    ? Number(process.env.JMW_IMAGE_CACHE_TTL) : 24 * 60 * 60) * 1000),
);
const IMAGE_QUEUE_LIMIT = Math.min(
  512,
  Math.max(0, Number.isFinite(Number(process.env.JMW_IMAGE_QUEUE_LIMIT))
    ? Math.floor(Number(process.env.JMW_IMAGE_QUEUE_LIMIT)) : 96),
);
const IMAGE_QUEUE_TIMEOUT = Math.min(
  30 * 1000,
  Math.max(100, Number.isFinite(Number(process.env.JMW_IMAGE_QUEUE_TIMEOUT))
    ? Math.floor(Number(process.env.JMW_IMAGE_QUEUE_TIMEOUT)) : 3000),
);
const IMAGE_DRAIN_TIMEOUT = 15000;
const IMAGE_PATH_TOTAL_TIMEOUT = 30000;
const TRANSLATION_SERVICE_URL = String(process.env.TRANSLATION_SERVICE_URL || '').trim().replace(/\/+$/, '');
const TRANSLATION_SERVICE_TOKEN = String(process.env.TRANSLATION_SERVICE_TOKEN || '');
const TRANSLATION_MAX_PAGE_BYTES = Math.min(
  100 * 1024 * 1024,
  Math.max(1024 * 1024, Number(process.env.TRANSLATION_MAX_PAGE_BYTES) || 25 * 1024 * 1024),
);
const TRANSLATION_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
let activeImageRequests = 0;
const imageRequestsByClient = new Map();
// 只缓存成功的封面/缩略图，按字节和 TTL 双重限制；章节原图通常走流式转发，
// 不会因为开启缓存而把大图长期留在 Node 堆中。
const imageCache = new Map();
let imageCacheBytes = 0;
// 同一封面在首屏突发请求期间只允许一个请求回源，其余请求等待该响应
// 完成后复用缓存；非缓存正文不会进入此表。
const imageCacheFlights = new Map();
const imageWaitQueue = [];
const imageWaitersByClient = new Map();
const MAX_AI_CONCURRENCY = Math.min(20, Math.max(1, Number(process.env.JMW_MAX_AI_CONCURRENCY) || 4));
const MAX_SEARCH_CONCURRENCY = Math.min(40, Math.max(1, Number(process.env.JMW_MAX_SEARCH_CONCURRENCY) || 8));
const MAX_AI_STREAM_BYTES = Math.min(
  64 * 1024 * 1024,
  Math.max(1024 * 1024, Number(process.env.JMW_MAX_AI_STREAM_BYTES) || 16 * 1024 * 1024)
);
let activeAiRequests = 0;
let activeSearchRequests = 0;

const chapterAi = new ChapterAiScheduler({
  dataDir: process.env.JMW_DATA_DIR || path.join(__dirname, 'data'),
  model: process.env.AI_MODEL || 'grok-4.6',
  apiKey: process.env.AI_API_KEY || '',
  baseUrl: process.env.AI_BASE_URL || 'https://newapi.shixian.me/v1',
  intervalMs: process.env.CHAPTER_AI_INTERVAL_MS || 30000,
  maxRetries: process.env.CHAPTER_AI_MAX_RETRIES || 3,
  maxConcurrency: process.env.CHAPTER_AI_CONCURRENCY || 1,
  modelTimeoutMs: process.env.AI_TIMEOUT || 120000,
  modelFetch: features.outboundFetch,
  discover: async (scheduler) => {
    const jar = { cookiesByOrigin: {}, user: null, apiHost: '' };
    const callPublic = (pathName, query = {}) => upstreamRequest({ path: pathName, query, hosts: settings.apiHostsForSource('mixed', ''), cookieHosts: settings.allDataSourceHosts(), jar, dnsLookup: features.dohLookup, fetchImpl: features.outboundFetch });
    const feeds = await Promise.all([callPublic('/promote'), callPublic('/week')]);
    const aids = new Set();
    const rankWeights = new Map();
    for (const feed of feeds) {
      const value = feed?.data || feed;
      const rows = Array.isArray(value) ? value : (value?.list || value?.albums || value?.items || []);
      rows.slice(0, 20).forEach((row, index) => { const aid = String(row?.aid || row?.id || row?.AID || ''); if (/^\d{1,16}$/.test(aid)) { aids.add(aid); rankWeights.set(aid, Math.max(rankWeights.get(aid) || 0, Math.max(5, 100 - index * 4))); } });
    }
    scheduler.applyRankWeights(rankWeights);
    for (const aid of [...aids].slice(0, 10)) {
      try {
        const out = await callPublic('/album', { id: aid });
        const value = out?.data || out; const rows = Array.isArray(value?.series) ? value.series : [];
        rows.slice(0, 20).forEach((row, index) => { const photoId = String(row?.id || ''); if (/^\d+$/.test(photoId)) scheduler.enqueue(aid, photoId, scheduler.priorityFor(aid) + 50 - index); });
      } catch (_) {}
    }
  },
  fetchChapter: async (aid, photoId) => {
    const jar = { cookiesByOrigin: {}, user: null, apiHost: '' };
    const html = await upstreamRequest({
      path: '/chapter_view_template',
      query: { id: photoId, app_img_shunt: '1', mode: 'vertical', page: '0', express: 'off', v: String(Math.floor(Date.now() / 1000)) },
      hosts: settings.apiHostsForSource('mixed', ''), cookieHosts: settings.allDataSourceHosts(), jar,
      dnsLookup: features.dohLookup, fetchImpl: features.outboundFetch,
    });
    const parsed = parsePhotoHtml(String(html));
    if (parsed.imghost) settings.addImageHost(parsed.imghost);
    let name = '';
    try {
      const album = await upstreamRequest({ path: '/album', query: { id: aid }, hosts: settings.apiHostsForSource('mixed', ''), cookieHosts: settings.allDataSourceHosts(), jar, dnsLookup: features.dohLookup, fetchImpl: features.outboundFetch });
      const value = album?.data || album;
      const rows = Array.isArray(value?.series) ? value.series : (Array.isArray(value?.chapters) ? value.chapters : []);
      const row = rows.find((item) => String(item?.id || item?.photoId || '') === String(photoId));
      name = chapterSourceTitle(row);
    } catch (_) {}
    return { ...parsed, aid, name };
  },
  fetchImage: async (url) => {
    const fetched = await fetchImageResponse(url, 30000, features.dohLookup);
    try {
      if (!fetched.response.ok || !fetched.response.body) throw new Error(`图片请求失败（HTTP ${fetched.response.status}）`);
      const buffer = await readResponseBuffer(fetched.response, MAX_IMAGE_BYTES, '章节图片', fetched.signal);
      if (!buffer.length) throw new Error('图片响应为空');
      return buffer;
    } finally { fetched.cleanup(); }
  },
  logger: (level, message) => features.addLog(level, message),
});
chapterAi.start();

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
  '/comment_vote': ['POST'],
  '/like': ['POST'],
  '/favorite': ['POST'],
  '/favorite_folder': ['POST'],
  '/favorites': ['GET'],
  '/history': ['GET'],
  '/history/delete': ['POST'],
  '/chapter': ['GET'],
  '/img': ['GET'],
  '/translation/page': ['POST'],
  '/setting': ['GET'],
  '/ai/config': ['GET'],
  '/ai/chat': ['POST'],
  '/chapter-ai': ['GET'],
  '/chapter-ai/enqueue': ['POST'],
  '/ai/search': ['POST'],
  '/doh': ['GET', 'POST'],
  '/doh/test': ['GET'],
  '/logs': ['GET', 'DELETE'],
  '/update': ['GET'],
});

/* ----------------------------- 启动检查 ----------------------------- */

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 20 || typeof fetch !== 'function') {
  console.error('[启动失败] 需要 Node.js 20 或更高版本');
  process.exit(1);
}
if (!ACCESS_PASSWORD) {
  console.warn('[警告] 未设置 ACCESS_PASSWORD：普通功能不受口令保护；运维日志和全局 DoH 仅允许无反代的直接回环访问，容器/反代部署需配置口令');
} else if (Buffer.byteLength(ACCESS_PASSWORD, 'utf8') < MIN_ACCESS_PASSWORD_BYTES) {
  // 不在日志中输出口令或实际长度；保留启动以便管理员通过健康检查进入并
  // 轮换配置，但明确标记为不可接受的生产安全基线。
  console.error(`[严重警告] ACCESS_PASSWORD 必须至少 ${MIN_ACCESS_PASSWORD_BYTES} 字节，请在发布前轮换为高熵随机口令`);
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
  '.webmanifest': 'application/manifest+json; charset=utf-8',
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
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
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

// 收藏夹/历史可能在本地分组或隐藏记录过滤后变成空页，前端仍需要知道
// 上游是否重复返回了同一页。只发送稳定指纹，不把未展示的条目内容额外
// 暴露给浏览器；优先使用 JM 号，异常条目才退化到少量展示字段。
function sourceKeyText(value) {
  if (Array.isArray(value)) return value.map(sourceKeyText).filter(Boolean).join(',');
  if (value && typeof value === 'object') return sourceKeyText(value.name ?? value.title ?? value.slug);
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return '';
  return String(value).trim();
}

function sourceItemId(item) {
  if (!item || typeof item !== 'object') return '';
  return sourceKeyText(item.id) || sourceKeyText(item.aid) || sourceKeyText(item.AID);
}

function sourceItemKey(item) {
  if (!item || typeof item !== 'object') return sourceKeyText(item);
  const id = sourceItemId(item);
  if (id) return `id:${id}`;
  const parts = [
    item.name, item.title, item.image, item.cover, item.cover_url, item.coverUrl, item.author,
  ].map(sourceKeyText);
  if (parts.some(Boolean)) return `meta:${parts.join('\u001f').toLocaleLowerCase()}`;
  try {
    const raw = JSON.stringify(item);
    return raw && raw !== '{}' ? `raw:${raw.slice(0, 1024)}` : '';
  } catch (_) {
    return '';
  }
}

function sourcePageKey(items) {
  const keys = (Array.isArray(items) ? items : []).map(sourceItemKey).filter(Boolean).sort();
  if (!keys.length) return '';
  return crypto.createHash('sha256').update(JSON.stringify(keys)).digest('hex').slice(0, 32);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (c) => {
      // 超限后仍保持 flowing 并丢弃后续字节，让 413 响应能正常发出；
      // 直接 req.destroy() 会先把承载响应的同一 socket 重置。
      if (settled) return;
      size += c.length;
      if (size > limit) {
        settled = true;
        chunks.length = 0;
        reject(new ApiError('请求体过大', 413));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

async function readJsonBody(req) {
  const contentType = String((req.headers && req.headers['content-type']) || '')
    .split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json' && !/^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(contentType)) {
    // 已能在读取正文前判定 415，但仍让 IncomingMessage 进入 flowing 模式并
    // 丢弃剩余字节，避免未消费请求体占住 keep-alive 连接或阻塞后续请求。
    if (typeof req.resume === 'function') req.resume();
    throw new ApiError('Content-Type 必须为 application/json', 415);
  }
  const buf = await readBody(req);
  if (!buf.length) return {};
  let value;
  try {
    value = JSON.parse(buf.toString('utf8'));
  } catch (_) {
    throw new ApiError('请求体不是合法 JSON', 400);
  }
  // 所有当前 POST 接口都使用具名字段；拒绝 null、数组和 JSON 原始值，
  // 避免下游读取 body.foo 时抛出 TypeError，也让各接口保持一致的 400 语义。
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ApiError('请求体必须是 JSON 对象', 400);
  }
  return value;
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
    if (!b && rateBuckets.size >= 5000) {
      for (const [k, value] of rateBuckets) if (now > value.resetAt) rateBuckets.delete(k);
      // 全是活跃桶时拒绝新的唯一 key，避免攻击者用伪造/大量来源撑爆内存。
      if (rateBuckets.size >= 5000) return false;
    }
    b = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(key, b);
  }
  b.count++;
  return b.count <= limit;
}

function normalizeIp(value) {
  let ip = String(value || '').trim();
  if (!ip) return '';
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  // Node 在双栈 socket 上常以 ::ffff:192.0.2.1 表示 IPv4。
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped && net.isIP(mapped[1]) === 4) ip = mapped[1];
  return net.isIP(ip) ? ip.toLowerCase() : '';
}

function addTrustedProxyRule(rule) {
  const slash = rule.lastIndexOf('/');
  const rawIp = slash === -1 ? rule : rule.slice(0, slash);
  const ip = normalizeIp(rawIp);
  if (!ip) return false;
  const family = net.isIP(ip);
  const type = family === 6 ? 'ipv6' : 'ipv4';
  try {
    if (slash === -1) {
      trustedProxyBlockList.addAddress(ip, type);
      return true;
    }
    const prefixText = rule.slice(slash + 1);
    if (!/^\d+$/.test(prefixText)) return false;
    const prefix = Number(prefixText);
    if (prefix < 0 || prefix > (family === 6 ? 128 : 32)) return false;
    trustedProxyBlockList.addSubnet(ip, prefix, type);
    return true;
  } catch (_) {
    return false;
  }
}

for (const rawRule of TRUST_PROXY.split(',')) {
  const rule = rawRule.trim();
  if (rule && !addTrustedProxyRule(rule)) {
    console.warn(`[警告] 已忽略非法 JMW_TRUST_PROXY 规则: ${rule}`);
  }
}

function isLoopbackIp(ip) {
  if (net.isIP(ip) === 4) return ip.split('.')[0] === '127';
  return ip === '::1';
}

function isTrustedProxyIp(ip) {
  const family = net.isIP(ip);
  if (!family) return false;
  return isLoopbackIp(ip) || trustedProxyBlockList.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

function clientIp(req) {
  let current = normalizeIp(req.socket.remoteAddress) || 'unknown';
  if (!isTrustedProxyIp(current)) return current;

  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded !== 'string' || !forwarded.trim()) return current;
  const parts = forwarded.split(',');
  // 限制链长，且任一 token 不是纯 IP 时整个头都不采信。
  if (parts.length > 32) return current;
  const chain = parts.map(normalizeIp);
  if (chain.some((ip) => !ip)) return current;

  // 从最靠近应用的一跳开始剥离可信代理，第一个非可信 IP 即客户。
  for (let i = chain.length - 1; i >= 0 && isTrustedProxyIp(current); i--) {
    current = chain[i];
  }
  return current;
}

function requestIsSecure(req) {
  if (req.socket && req.socket.encrypted) return true;
  const peer = normalizeIp(req.socket && req.socket.remoteAddress);
  if (!peer || !isTrustedProxyIp(peer)) return false;
  const forwarded = req.headers && req.headers['x-forwarded-proto'];
  if (typeof forwarded !== 'string') return false;
  // 反代必须覆盖而不是追加该头；拒绝含逗号的歧义链，避免客户端伪造首项。
  return forwarded.trim().toLowerCase() === 'https';
}

function cookieSecurity(req) {
  return requestIsSecure(req) ? '; Secure' : '';
}

/* ----------------------------- 会话/鉴权 ----------------------------- */

function ensureJar(req, res) {
  const sid = getCookie(req, 'jmw_sid');
  let jar = sid ? sessions.loadJar(sid) : null;
  if (!jar) {
    jar = sessions.createJar();
    res.setHeader(
      'Set-Cookie',
      `jmw_sid=${jar.sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7776000${cookieSecurity(req)}`
    );
  }
  // 旧版可能在会话文件中留下任意 Host；升级后一律清除非受信值。
  if (jar.apiHost && !settings.isTrustedApiHost(jar.apiHost)) {
    jar.apiHost = '';
    sessions.scheduleSave(jar);
  }
  sessions.retainJar(jar);
  req.jmwJar = jar;
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
  if (!ACCESS_PASSWORD) return false;
  // 比较双方口令的 sha256（长度恒定），可用 timingSafeEqual 防时序侧信道
  const given = crypto.createHash('sha256').update(String(password)).digest();
  const expected = crypto.createHash('sha256').update(ACCESS_PASSWORD).digest();
  return crypto.timingSafeEqual(given, expected);
}

function requestTargetsLoopbackHost(req) {
  const raw = req.headers && req.headers.host;
  if (typeof raw !== 'string' || !raw || raw.includes(',')) return false;
  try {
    const parsed = new URL(`http://${raw}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return false;
    const hostname = parsed.hostname.toLowerCase();
    return hostname === 'localhost' || isLoopbackIp(normalizeIp(hostname));
  } catch (_) {
    return false;
  }
}

function requestHasSafeBrowserContext(req) {
  const fetchSite = req.headers && req.headers['sec-fetch-site'];
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;

  const origin = req.headers && req.headers.origin;
  if (origin === undefined) return true; // curl/脚本没有浏览器来源元数据。
  if (typeof origin !== 'string' || !origin || origin === 'null') return false;
  try {
    const scheme = requestIsSecure(req) ? 'https' : 'http';
    return new URL(origin).origin === new URL(`${scheme}://${req.headers.host}`).origin;
  } catch (_) {
    return false;
  }
}

/**
 * 日志和全局 DoH 设置属于实例级运维能力，而不是普通访客设置。
 * - 配置访问口令后，沿用站点口令鉴权；
 * - 未配置口令时只允许直接 TCP 回环、回环 Host、同源 JSON 请求。
 *   该模式刻意不信任反代/NAT；容器或反向代理部署必须配置口令。
 */
function checkOperationalAccess(req) {
  if (ACCESS_PASSWORD) return checkAccess(req);
  const peer = normalizeIp(req.socket && req.socket.remoteAddress);
  if (!isLoopbackIp(peer)) return false;
  // 无口令模式不支持任何反代链，避免本机反代错误保留 Host 时把远端当本机。
  const forwardingHeaders = new Set(['forwarded', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip', 'via']);
  if (req.headers && Object.keys(req.headers).some((name) =>
    forwardingHeaders.has(name) || name.startsWith('x-forwarded-'))) return false;
  return requestTargetsLoopbackHost(req) && requestHasSafeBrowserContext(req);
}

/* ----------------------------- 图片代理 ----------------------------- */

function imageTrace(res) {
  return res && res.jmwImageTrace && typeof res.jmwImageTrace === 'object'
    ? res.jmwImageTrace : null;
}

function addImageTraceDuration(trace, key, started) {
  if (!trace) return;
  trace[key] = Math.max(0, Number(trace[key]) || 0) + Math.max(0, Date.now() - started);
}

function hostnameOnly(value) {
  try { return new URL(String(value || '')).hostname.toLowerCase().slice(0, 253); } catch (_) { return ''; }
}

function setImageTraceHost(trace, value) {
  if (trace) trace.upstream_host = hostnameOnly(value);
}

function taggedImageError(message, code, type, options) {
  const error = new ApiError(message, code, options);
  error.imageFailureType = type;
  return error;
}

function clientDisconnectError() {
  const error = new Error('客户端已断开');
  error.code = 'JMW_CLIENT_DISCONNECTED';
  return error;
}

function isClientDisconnectError(error) {
  return !!error && error.code === 'JMW_CLIENT_DISCONNECTED';
}

function throwIfAborted(signal) {
  if (!signal || !signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : clientDisconnectError();
}

/**
 * 申请图片代理槽位。返回释放函数，失败时返回 null。
 * 计数按请求生命周期维护，客户端断开也会在路由 finally 中释放，
 * 因而不会把短暂的 IP 列表留在内存里。
 */
function acquireImageRequestSlot(clientKey) {
  if (activeImageRequests >= MAX_IMAGE_CONCURRENCY) return null;
  const key = String(clientKey || 'unknown');
  const current = imageRequestsByClient.get(key) || 0;
  if (current >= MAX_IMAGE_CONCURRENCY_PER_IP) return null;
  activeImageRequests++;
  imageRequestsByClient.set(key, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeImageRequests = Math.max(0, activeImageRequests - 1);
    const remaining = (imageRequestsByClient.get(key) || 1) - 1;
    if (remaining > 0) imageRequestsByClient.set(key, remaining);
    else imageRequestsByClient.delete(key);
    pumpImageWaitQueue();
  };
}

/**
 * 图片请求短队列：上游线路偶发慢时，先让少量请求排队，避免浏览器收到
 * 一次性 503 后把 <img> 永久判定为损坏。队列仍有硬上限和超时，不会把
 * 全部章节图片堆在内存或连接表里。
 */
function removeImageWaiter(waiter) {
  const index = imageWaitQueue.indexOf(waiter);
  if (index >= 0) imageWaitQueue.splice(index, 1);
}

function finishImageWaiter(waiter, release) {
  if (!waiter || waiter.done) return;
  waiter.done = true;
  if (waiter.timer) clearTimeout(waiter.timer);
  if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
  const count = (imageWaitersByClient.get(waiter.key) || 1) - 1;
  if (count > 0) imageWaitersByClient.set(waiter.key, count);
  else imageWaitersByClient.delete(waiter.key);
  waiter.resolve(release || null);
}

function pumpImageWaitQueue() {
  if (!imageWaitQueue.length || activeImageRequests >= MAX_IMAGE_CONCURRENCY) return;
  // 每轮最多扫描当前队列长度，避免单个达到单客户端上限的请求阻塞其他客户。
  let scans = imageWaitQueue.length;
  while (scans > 0 && imageWaitQueue.length && activeImageRequests < MAX_IMAGE_CONCURRENCY) {
    scans--;
    const waiter = imageWaitQueue.shift();
    if (!waiter || waiter.done) continue;
    if (waiter.signal && waiter.signal.aborted) {
      finishImageWaiter(waiter, null);
      continue;
    }
    const release = acquireImageRequestSlot(waiter.key);
    if (release) finishImageWaiter(waiter, release);
    else imageWaitQueue.push(waiter);
  }
}

/** 等待图片槽位，超时/队列已满时返回 null。 */
function waitForImageRequestSlot(clientKey, signal) {
  const key = String(clientKey || 'unknown');
  if (signal && signal.aborted) return Promise.resolve(null);
  const immediate = acquireImageRequestSlot(key);
  if (immediate || IMAGE_QUEUE_LIMIT <= 0) {
    return Promise.resolve(immediate);
  }
  const clientQueued = imageWaitersByClient.get(key) || 0;
  // 单个客户端最多占用总等待队列的四分之一，避免一个标签页饿死其他请求。
  const perClientLimit = Math.max(1, Math.ceil(IMAGE_QUEUE_LIMIT / 4));
  if (imageWaitQueue.length >= IMAGE_QUEUE_LIMIT || clientQueued >= perClientLimit) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const waiter = { key, signal, resolve, timer: null, onAbort: null, done: false };
    waiter.onAbort = () => {
      removeImageWaiter(waiter);
      finishImageWaiter(waiter, null);
    };
    imageWaitersByClient.set(key, clientQueued + 1);
    imageWaitQueue.push(waiter);
    if (signal) signal.addEventListener('abort', waiter.onAbort, { once: true });
    waiter.timer = setTimeout(() => {
      removeImageWaiter(waiter);
      finishImageWaiter(waiter, null);
    }, IMAGE_QUEUE_TIMEOUT);
    // 队列计时器不应阻止进程优雅退出。
    waiter.timer.unref?.();
    pumpImageWaitQueue();
  });
}

function pruneImageCache(now = Date.now()) {
  for (const [key, entry] of imageCache) {
    if (!entry || entry.expiresAt <= now || !entry.body?.length) {
      imageCache.delete(key);
      imageCacheBytes = Math.max(0, imageCacheBytes - Number(entry?.size || entry?.body?.length || 0));
    }
  }
  while (imageCacheBytes > MAX_IMAGE_CACHE_BYTES && imageCache.size) {
    const oldestKey = imageCache.keys().next().value;
    const oldest = imageCache.get(oldestKey);
    imageCache.delete(oldestKey);
    imageCacheBytes = Math.max(0, imageCacheBytes - Number(oldest?.size || oldest?.body?.length || 0));
  }
}

/** 获取成功图片缓存；Map 顺序同时充当轻量 LRU。 */
function getImageCache(key) {
  if (!key || MAX_IMAGE_CACHE_BYTES <= 0) return null;
  const entry = imageCache.get(String(key));
  if (!entry) return null;
  if (entry.expiresAt <= Date.now() || !entry.body?.length) {
    imageCache.delete(String(key));
    imageCacheBytes = Math.max(0, imageCacheBytes - Number(entry.size || entry.body?.length || 0));
    return null;
  }
  imageCache.delete(String(key));
  imageCache.set(String(key), entry);
  return entry;
}

/** 写入成功图片缓存；只接受有界 Buffer，避免缓存异常对象或超大正文。 */
function setImageCache(key, value) {
  if (!key || MAX_IMAGE_CACHE_BYTES <= 0 || MAX_IMAGE_CACHE_ENTRY_BYTES <= 0) return false;
  const body = Buffer.isBuffer(value?.body) ? value.body : null;
  const mime = typeof value?.mime === 'string' ? value.mime : '';
  if (!body || !body.length || body.length > MAX_IMAGE_CACHE_ENTRY_BYTES || !SAFE_RASTER_MIME.has(mime)) return false;
  const normalizedKey = String(key);
  const previous = imageCache.get(normalizedKey);
  if (previous) {
    imageCacheBytes = Math.max(0, imageCacheBytes - Number(previous.size || previous.body?.length || 0));
    imageCache.delete(normalizedKey);
  }
  const entry = {
    body,
    mime,
    size: body.length,
    expiresAt: Date.now() + IMAGE_CACHE_TTL_MS,
  };
  imageCache.set(normalizedKey, entry);
  imageCacheBytes += entry.size;
  pruneImageCache();
  return imageCache.has(normalizedKey);
}

function clearImageCache() {
  imageCache.clear();
  imageCacheBytes = 0;
}

function claimImageCacheFlight(key) {
  if (!key || MAX_IMAGE_CACHE_BYTES <= 0 || MAX_IMAGE_CACHE_ENTRY_BYTES <= 0) {
    return { owner: false, flight: null };
  }
  const normalizedKey = String(key);
  const existing = imageCacheFlights.get(normalizedKey);
  if (existing) return { owner: false, flight: existing };
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  const flight = { promise, resolve };
  imageCacheFlights.set(normalizedKey, flight);
  return { owner: true, flight };
}

function finishImageCacheFlight(key, flight, entry = null) {
  if (!flight) return;
  const normalizedKey = String(key || '');
  if (normalizedKey && imageCacheFlights.get(normalizedKey) === flight) {
    imageCacheFlights.delete(normalizedKey);
  }
  flight.resolve(entry || null);
}

function imageCacheStats() {
  pruneImageCache();
  return {
    entries: imageCache.size,
    bytes: imageCacheBytes,
    maxBytes: MAX_IMAGE_CACHE_BYTES,
    maxEntryBytes: MAX_IMAGE_CACHE_ENTRY_BYTES,
  };
}

/** 从请求入口开始监听客户端断开，便于取消 DNS、fetch 和响应体读取。 */
function bindClientAbort(res) {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded && !controller.signal.aborted) {
      controller.abort(clientDisconnectError());
    }
  };
  res.once('close', onClose);
  if (res.destroyed) onClose();
  return {
    signal: controller.signal,
    cleanup: () => res.off('close', onClose),
  };
}

/** 将客户端取消与单次上游 deadline 合并，信号保持到响应体消费完成。 */
function linkedTimeoutSignal(timeoutMs, parentSignal) {
  const controller = new AbortController();
  const ms = Math.max(1, Math.floor(Number(timeoutMs) || 0));
  const onParentAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort(parentSignal.reason instanceof Error ? parentSignal.reason : clientDisconnectError());
    }
  };
  if (parentSignal) {
    if (parentSignal.aborted) onParentAbort();
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(taggedImageError('图片获取超时', 504, 'timeout'));
    }
  }, ms);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
    },
  };
}

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

/**
 * 封面请求通常来自 albums/library/album/novels 路径；章节正文位于 photos，
 * 不纳入进程缓存，避免一章数百张原图把内存预算吃满。
 */
function isCoverImagePath(pathname) {
  const value = String(pathname || '');
  if (!value.startsWith('/') || value.includes('\\')) return false;
  // URL 规范化会折叠点段；缓存分类前先拒绝原始/编码后的点段，避免把
  // /media/albums/../photos 下的正文误放进封面缓存。
  for (const segment of value.split('?', 1)[0].split('/')) {
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch (_) { return false; }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) return false;
  }
  return /^\/media\/(?:albums|library\/album|novels)\//i.test(value);
}

function imageCacheKeyForPath(value) {
  const raw = String(value || '');
  const p = raw.startsWith('/') ? raw : `/${raw}`;
  const pathname = p.split('?', 1)[0];
  return isCoverImagePath(pathname) ? `path:${p}` : '';
}

function imageCacheKeyForUrl(value) {
  try {
    const url = validateImageUrl(value);
    return isCoverImagePath(url.pathname) ? `url:${url.href}` : '';
  } catch (_) {
    return '';
  }
}

function cacheKeyForFetchedImage(requestedKey, finalUrl) {
  if (!requestedKey || !finalUrl) return '';
  try {
    const url = validateImageUrl(finalUrl);
    return isCoverImagePath(url.pathname) ? requestedKey : '';
  } catch (_) {
    return '';
  }
}

function sendCachedImage(res, entry, cacheDays) {
  if (!entry || res.destroyed) return false;
  const trace = imageTrace(res);
  if (trace) {
    trace.cache_hit = true;
    trace.bytes = entry.body.length;
  }
  res.writeHead(200, baseHeaders({
    'Cache-Control': imageCacheControl(cacheDays),
    'Content-Type': entry.mime,
    'Content-Length': entry.body.length,
    'X-JMW-Image-Cache': 'HIT',
  }));
  res.end(entry.body);
  return true;
}

async function waitForImageCacheFlight(flight, signal) {
  if (!flight) return null;
  if (!signal) return flight.promise;
  if (signal.aborted) return null;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(value || null);
    };
    const onAbort = () => finish(null);
    signal.addEventListener('abort', onAbort, { once: true });
    flight.promise.then(finish, () => finish(null));
  });
}

async function serveImageCacheFlight(res, key, cacheDays, signal) {
  if (!key) return false;
  const flight = imageCacheFlights.get(String(key));
  if (!flight) return false;
  const entry = await waitForImageCacheFlight(flight, signal);
  if (!entry || (signal && signal.aborted) || res.destroyed) return false;
  return sendCachedImage(res, entry, cacheDays);
}

/** 手动跟随重定向，每一跳都重新验证 HTTPS 与精确 origin 白名单。 */
async function fetchImageResponse(urlStr, timeoutMs, dnsLookup, clientSignal, trace) {
  let current = validateImageUrl(urlStr);
  // 预检和实际 socket 使用同一个 resolver。outboundFetch 还会再次校验并把
  // 第二次得到的安全地址集固定给 TLS 连接，以消除校验后的 DNS TOCTOU。
  const effectiveLookup = dnsLookup || features.dohLookup;
  const deadline = Date.now() + timeoutMs;
  for (let hop = 0; hop <= MAX_IMAGE_REDIRECTS; hop++) {
    setImageTraceHost(trace, current);
    throwIfAborted(clientSignal);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ApiError('图片获取超时', 504);
    // 紧邻 fetch 对每一跳的当前 DNS A/AAAA 做非公网拒绝。
    const dnsStarted = Date.now();
    try {
      await assertPublicUrl(current, effectiveLookup, remaining, clientSignal);
    } catch (error) {
      if (error && !error.imageFailureType && /DNS|解析|地址族/.test(String(error.message || ''))) {
        error.imageFailureType = 'dns';
      }
      throw error;
    } finally {
      addImageTraceDuration(trace, 'dns_ms', dnsStarted);
    }
    throwIfAborted(clientSignal);
    const fetchRemaining = deadline - Date.now();
    if (fetchRemaining <= 0) throw new ApiError('图片获取超时', 504);
    const linked = linkedTimeoutSignal(fetchRemaining, clientSignal);
    let response;
    try {
      response = await features.outboundFetch(current.href, {
        headers: { 'User-Agent': 'okhttp/4.9.3', Referer: current.origin + '/' },
        signal: linked.signal,
        redirect: 'manual',
        jmwLookup: effectiveLookup,
        jmwTrace: trace,
      });
    } catch (e) {
      linked.cleanup();
      if (linked.signal.aborted && linked.signal.reason instanceof Error) throw linked.signal.reason;
      throw e;
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await cancelBody(response);
      linked.cleanup();
      if (!location) throw taggedImageError('图片重定向缺少 Location', 502, 'redirect');
      if (hop >= MAX_IMAGE_REDIRECTS) throw taggedImageError('图片重定向次数过多', 502, 'redirect');
      current = validateImageUrl(new URL(location, current));
      continue;
    }
    return { response, finalUrl: current, signal: linked.signal, cleanup: linked.cleanup };
  }
  throw taggedImageError('图片重定向次数过多', 502, 'redirect');
}

async function rasterResponseInfo(response) {
  const mime = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (!SAFE_RASTER_MIME.has(mime)) {
    await cancelBody(response);
    throw taggedImageError(`上游返回了非安全栅格图片类型：${mime || '未知'}`, 415, 'mime');
  }
  if (!response.body) throw taggedImageError('上游图片响应为空', 502, 'upstream_body');
  const lengthHeader = response.headers.get('content-length');
  const declared = lengthHeader === null ? NaN : Number(lengthHeader);
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    await cancelBody(response);
    throw taggedImageError(`图片超过 ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)} MiB 上限`, 413, 'too_large');
  }
  return { mime };
}

/** 只接收安全栅格图片 MIME，并对解压后实际读取字节数设硬上限。 */
async function readRasterImage(response) {
  const { mime } = await rasterResponseInfo(response);

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
        throw taggedImageError(`图片超过 ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)} MiB 上限`, 413, 'too_large');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (e) {
    try { await reader.cancel(); } catch (_) {}
    if (e instanceof ApiError) throw e;
    throw taggedImageError('读取上游图片失败', 502, 'body', { cause: e });
  }
  return { mime, body: Buffer.concat(chunks, total) };
}

function waitForDrain(res, signal, timeoutMs = IMAGE_DRAIN_TIMEOUT) {
  if (res.destroyed) return Promise.reject(new Error('客户端已断开'));
  if (signal && signal.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('请求已取消'));
  }
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onError);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('客户端已断开')); };
    const onError = (error) => { cleanup(); reject(error); };
    const onAbort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error('请求已取消'));
    };
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      reject(new Error('客户端读取图片超时'));
    }, Math.max(1, Math.floor(Number(timeoutMs) || IMAGE_DRAIN_TIMEOUT)));
  });
}

/** 带实际字节上限和 Node 写入背压的流式图片转发。 */
function imageCacheControl(cacheDays, accessProtected = !!ACCESS_PASSWORD) {
  // /api/img 在开启访问口令时依赖 Cookie 鉴权。标成 public 会允许 Nginx/CDN
  // 等共享缓存把认证用户的响应直接返回给未认证访客，绕过回源鉴权。
  return `${accessProtected ? 'private' : 'public'}, max-age=${cacheDays * 86400}, immutable`;
}

async function sendUpstreamImage(
  res,
  response,
  cacheDays,
  requestSignal,
  drainTimeoutMs = IMAGE_DRAIN_TIMEOUT,
  cacheKey = '',
) {
  const { mime } = await rasterResponseInfo(response);
  const reader = response.body.getReader();
  let total = 0;
  let cacheable = !!(cacheKey && MAX_IMAGE_CACHE_BYTES > 0 && MAX_IMAGE_CACHE_ENTRY_BYTES > 0);
  const cacheChunks = [];
  let cacheTotal = 0;
  let clientClosed = res.destroyed || isClientDisconnectError(requestSignal && requestSignal.reason);
  const onClose = () => {
    if (res.writableEnded) return;
    clientClosed = true;
    const trace = imageTrace(res);
    if (trace) trace.client_aborted = true;
    reader.cancel().catch(() => {});
  };
  const onAbort = () => {
    if (isClientDisconnectError(requestSignal.reason)) {
      clientClosed = true;
      const trace = imageTrace(res);
      if (trace) trace.client_aborted = true;
    }
    reader.cancel().catch(() => {});
  };
  res.once('close', onClose);
  if (requestSignal) requestSignal.addEventListener('abort', onAbort, { once: true });

  try {
    if (clientClosed) {
      await reader.cancel();
      return;
    }
    throwIfAborted(requestSignal);
    // 先读一块：如果上游在任何字节前就失败，仍能返回结构化 502。
    let part = await reader.read();
    throwIfAborted(requestSignal);
    if (clientClosed) return;
    if (!part.done) {
      total += part.value.byteLength;
      const trace = imageTrace(res);
      if (trace) trace.bytes = total;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw taggedImageError(`图片超过 ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)} MiB 上限`, 413, 'too_large');
      }
    }

    res.writeHead(200, baseHeaders({
      'Cache-Control': imageCacheControl(cacheDays),
      'Content-Type': mime,
      'X-JMW-Image-Cache': cacheKey ? 'MISS' : 'BYPASS',
      // fetch 可能已解压响应体，不能直接转发上游 Content-Length。
    }));

    while (!part.done) {
      const chunk = Buffer.from(part.value);
      const trace = imageTrace(res);
      if (trace) trace.bytes = total;
      if (cacheable) {
        cacheTotal += chunk.length;
        if (cacheTotal <= MAX_IMAGE_CACHE_ENTRY_BYTES) cacheChunks.push(chunk);
        else {
          // 超过单项缓存预算后立即释放已收集的块；正文仍按流式方式转发。
          cacheable = false;
          cacheChunks.length = 0;
          cacheTotal = 0;
        }
      }
      if (!res.write(chunk)) await waitForDrain(res, requestSignal, drainTimeoutMs);
      part = await reader.read();
      throwIfAborted(requestSignal);
      if (clientClosed) return;
      if (!part.done) {
        total += part.value.byteLength;
        const trace = imageTrace(res);
        if (trace) trace.bytes = total;
        if (total > MAX_IMAGE_BYTES) {
          await reader.cancel();
          throw taggedImageError(`图片超过 ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)} MiB 上限`, 413, 'too_large');
        }
      }
    }
    if (!res.destroyed) {
      res.end();
      if (cacheable && cacheChunks.length && cacheTotal > 0) {
        setImageCache(cacheKey, { mime, body: Buffer.concat(cacheChunks, cacheTotal) });
      }
    }
  } catch (e) {
    try { await reader.cancel(); } catch (_) {}
    if (clientClosed) return;
    if (e instanceof ApiError) throw e;
    // 保留底层错误类型供调用方区分（HTTP 层会统一脱敏）；不直接把该
    // message 写入图片完成日志或返回浏览器。
    throw taggedImageError(`读取上游图片失败：${e.message || '响应流异常'}`, 502, 'body', { cause: e });
  } finally {
    res.off('close', onClose);
    if (requestSignal) requestSignal.removeEventListener('abort', onAbort);
  }
}

function imageErrorStatus(e) {
  const candidate = e instanceof ApiError ? Number(e.code) : NaN;
  return Number.isInteger(candidate) && candidate >= 400 && candidate < 600 ? candidate : 502;
}

function publicErrorMessage(error, fallback) {
  return error instanceof ApiError && error.expose === true
    ? (error.publicMessage || error.message || fallback)
    : fallback;
}

const IMAGE_HOST_FAILURE_BASE_MS = 5000;
const IMAGE_HOST_FAILURE_MAX_MS = 2 * 60 * 1000;
const IMAGE_HOST_HEALTH_LIMIT = 200;
const imageHostHealth = new Map();
const TRANSIENT_IMAGE_FAILURES = new Set([
  'dns', 'connect', 'tls', 'timeout', 'network', 'http_retryable', 'http_429', 'http_5xx',
]);

function underlyingErrorCode(error) {
  let current = error;
  for (let depth = 0; current && depth < 4; depth++, current = current.cause) {
    const code = String(current.code || '').toUpperCase();
    if (/^[A-Z0-9_]{1,64}$/.test(code)) return code;
  }
  return '';
}

function classifyImageFailure(errorOrStatus) {
  if (typeof errorOrStatus === 'number') {
    if (errorOrStatus === 408 || errorOrStatus === 425) return 'http_retryable';
    if (errorOrStatus === 429) return 'http_429';
    if (errorOrStatus >= 500) return 'http_5xx';
    return errorOrStatus >= 400 ? 'upstream_http' : '';
  }
  const error = errorOrStatus || {};
  if (error.imageFailureType && error.imageFailureType !== 'body') return error.imageFailureType;
  const code = underlyingErrorCode(error);
  if (['EAI_AGAIN', 'ENOTFOUND', 'ENODATA', 'EAI_FAIL'].includes(code)) return 'dns';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'timeout';
  if (/^(?:ERR_TLS_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/.test(code)) return 'tls';
  if ([
    'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
    'ERR_SOCKET_CLOSED', 'UND_ERR_SOCKET',
  ].includes(code)) return 'connect';
  if (error.imageFailureType) return error.imageFailureType;
  const status = imageErrorStatus(error);
  if (status === 408 || status === 425 || status === 504) return 'timeout';
  if (status === 429) return 'http_429';
  if (status >= 500) return 'http_5xx';
  if (status === 413) return 'too_large';
  if (status === 415) return 'mime';
  if (status === 400 || status === 403) return 'security';
  return 'internal';
}

function isTransientImageFailure(errorOrStatus) {
  return TRANSIENT_IMAGE_FAILURES.has(classifyImageFailure(errorOrStatus));
}

function normalizedImageHost(host) {
  return settings.normalizeHost(String(host || ''));
}

function pruneImageHostHealth() {
  while (imageHostHealth.size > IMAGE_HOST_HEALTH_LIMIT) {
    imageHostHealth.delete(imageHostHealth.keys().next().value);
  }
}

/** 指数退避开启熔断；到期后只允许一个半开探测请求。 */
function markImageHostFailed(host, errorOrStatus, ttlMs) {
  const normalized = normalizedImageHost(host);
  if (!normalized || !isTransientImageFailure(errorOrStatus)) return false;
  const previous = imageHostHealth.get(normalized);
  const failures = Math.min(8, Math.max(0, Number(previous?.failures) || 0) + 1);
  const exponential = Math.min(IMAGE_HOST_FAILURE_MAX_MS, IMAGE_HOST_FAILURE_BASE_MS * (2 ** (failures - 1)));
  const delay = ttlMs === undefined ? exponential : Math.max(1000, Math.min(IMAGE_HOST_FAILURE_MAX_MS, Number(ttlMs) || 0));
  imageHostHealth.delete(normalized);
  imageHostHealth.set(normalized, {
    failures,
    openUntil: Date.now() + delay,
    probeInFlight: false,
  });
  pruneImageHostHealth();
  return true;
}

function markImageHostHealthy(host) {
  const normalized = normalizedImageHost(host);
  if (normalized) imageHostHealth.delete(normalized);
}

function releaseImageHostProbe(host) {
  const normalized = normalizedImageHost(host);
  const health = normalized && imageHostHealth.get(normalized);
  if (health && health.probeInFlight) health.probeInFlight = false;
}

function clearImageHostHealth() {
  imageHostHealth.clear();
}

function reserveImageHost(host, now = Date.now()) {
  const normalized = normalizedImageHost(host);
  if (!normalized) return false;
  const health = imageHostHealth.get(normalized);
  if (!health) return true;
  if (now < health.openUntil || health.probeInFlight) return false;
  health.probeInFlight = true;
  return true;
}

function noteImageAttempt(trace, attempts) {
  if (trace) trace.retry_count = Math.max(0, attempts - 1);
}

function noteImageFailure(res, errorOrStatus) {
  const trace = imageTrace(res);
  const type = classifyImageFailure(errorOrStatus);
  if (trace) trace.error_type = type;
  if (typeof errorOrStatus === 'number') return type;
  if (errorOrStatus instanceof ApiError && errorOrStatus.expose === true) return type;
  const code = underlyingErrorCode(errorOrStatus);
  const fields = [
    `request_id=${trace?.request_id || 'unknown'}`,
    `error_type=${type}`,
    `upstream_host=${trace?.upstream_host || ''}`,
  ];
  if (code) fields.push(`error_code=${code}`);
  // 不输出 Error 对象或 message；其中可能包含签名 URL、查询参数或内部地址。
  console.error(`[image] ${fields.join(' ')}`);
  return type;
}

function imageUrlCandidates(value) {
  const original = validateImageUrl(value);
  const candidates = [original];
  for (const host of settings.imageHosts()) {
    if (host === original.origin) continue;
    const candidate = new URL(`${original.pathname}${original.search}`, host);
    candidates.push(validateImageUrl(candidate));
  }
  return candidates;
}

async function proxyImage(res, urlStr, cacheDays = 7, clientSignal) {
  const cacheKey = imageCacheKeyForUrl(urlStr);
  const cached = getImageCache(cacheKey);
  if (cached) {
    sendCachedImage(res, cached, cacheDays);
    return;
  }
  if (await serveImageCacheFlight(res, cacheKey, cacheDays, clientSignal)) return;
  let cacheFlight = null;
  if (cacheKey) {
    const claim = claimImageCacheFlight(cacheKey);
    if (!claim.owner) {
      if (await serveImageCacheFlight(res, cacheKey, cacheDays, clientSignal)) return;
      // 前一个请求未能缓存（例如图片超过单项预算），当前请求接管回源。
      const retryClaim = claimImageCacheFlight(cacheKey);
      if (retryClaim.owner) cacheFlight = retryClaim.flight;
    } else {
      cacheFlight = claim.flight;
    }
  }
  const trace = imageTrace(res);
  const deadline = Date.now() + IMAGE_PATH_TOTAL_TIMEOUT;
  let attempts = 0;
  let lastError = null;
  let lastStatus = 502;
  try {
    for (const target of imageUrlCandidates(urlStr)) {
      if ((clientSignal && clientSignal.aborted) || res.destroyed) return;
      const host = target.origin;
      if (!reserveImageHost(host)) continue;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        releaseImageHostProbe(host);
        lastError = taggedImageError('图片获取总时间已超限', 504, 'timeout');
        lastStatus = 504;
        break;
      }
      attempts++;
      noteImageAttempt(trace, attempts);
      setImageTraceHost(trace, target);
      let fetched;
      let hostHealthy = false;
      try {
        fetched = await fetchImageResponse(
          target, Math.min(8000, remaining), undefined, clientSignal, trace,
        );
        const { response } = fetched;
        if (!response.ok || !response.body) {
          await cancelBody(response);
          lastError = response.status;
          noteImageFailure(res, response.status);
          if (isTransientImageFailure(response.status)) {
            markImageHostFailed(host, response.status);
            continue;
          }
          markImageHostHealthy(host);
          return sendJson(res, 502, { error: `图片获取失败（HTTP ${response.status}）` });
        }
        if (trace) trace.error_type = '';
        await sendUpstreamImage(
          res, response, cacheDays, fetched.signal, IMAGE_DRAIN_TIMEOUT,
          cacheKeyForFetchedImage(cacheKey, fetched.finalUrl),
        );
        markImageHostHealthy(host);
        hostHealthy = true;
        settings.setPreferredImageHost(host);
        return;
      } catch (error) {
        if ((clientSignal && clientSignal.aborted) || isClientDisconnectError(error) || res.destroyed) return;
        lastError = error;
        lastStatus = imageErrorStatus(error);
        noteImageFailure(res, error);
        if (res.headersSent) {
          if (isTransientImageFailure(error)) markImageHostFailed(host, error);
          if (!res.destroyed) res.destroy();
          return;
        }
        if (isTransientImageFailure(error)) {
          markImageHostFailed(host, error);
          continue;
        }
        markImageHostHealthy(host);
        return sendJson(res, lastStatus, { error: publicErrorMessage(error, '图片获取失败') });
      } finally {
        if (fetched) fetched.cleanup();
        if (!hostHealthy) releaseImageHostProbe(host);
      }
    }
    if ((clientSignal && clientSignal.aborted) || res.destroyed) return;
    if (!attempts && trace) trace.error_type = 'circuit_open';
    if (!res.headersSent) sendJson(res, lastStatus, {
      error: publicErrorMessage(lastError, '图片获取失败'),
    });
  } catch (error) {
    if ((clientSignal && clientSignal.aborted) || isClientDisconnectError(error) || res.destroyed) return;
    noteImageFailure(res, error);
    if (!res.headersSent) sendJson(res, imageErrorStatus(error), {
      error: publicErrorMessage(error, '图片获取失败'),
    });
    else res.destroy();
  } finally {
    if (cacheFlight) finishImageCacheFlight(cacheKey, cacheFlight, getImageCache(cacheKey));
  }
}

/** path 形式：在图片域名列表中依次尝试（记住成功的域名） */
async function proxyImagePath(res, p, clientSignal) {
  if (!/^\/media\//.test(p)) return sendJson(res, 400, { error: '非法路径' });
  const cacheKey = imageCacheKeyForPath(p);
  const cached = getImageCache(cacheKey);
  if (cached) {
    sendCachedImage(res, cached, 1);
    return;
  }
  if (await serveImageCacheFlight(res, cacheKey, 1, clientSignal)) return;
  let cacheFlight = null;
  if (cacheKey) {
    const claim = claimImageCacheFlight(cacheKey);
    if (!claim.owner) {
      if (await serveImageCacheFlight(res, cacheKey, 1, clientSignal)) return;
      const retryClaim = claimImageCacheFlight(cacheKey);
      if (retryClaim.owner) cacheFlight = retryClaim.flight;
    } else {
      cacheFlight = claim.flight;
    }
  }
  try {
    const hosts = settings.imageHosts();
    const trace = imageTrace(res);
    const now = Date.now();
    const deadline = now + IMAGE_PATH_TOTAL_TIMEOUT;
    let lastError = '所有图片域名均无法获取该资源';
    let lastStatus = 502;
    let attempts = 0;
    for (const host of hosts) {
      if (clientSignal && clientSignal.aborted) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        lastError = '图片获取总时间已超限';
        lastStatus = 504;
        break;
      }
      if (!reserveImageHost(host)) continue;
      attempts++;
      noteImageAttempt(trace, attempts);
      setImageTraceHost(trace, host);
      let fetched;
      let hostHealthy = false;
      try {
        const target = host.replace(/\/+$/, '') + p;
        fetched = await fetchImageResponse(target, Math.min(8000, remaining), undefined, clientSignal, trace);
        const { response } = fetched;
        if (!response.ok || !response.body) {
          lastError = `HTTP ${response.status}`;
          await cancelBody(response);
          noteImageFailure(res, response.status);
          if (isTransientImageFailure(response.status)) markImageHostFailed(host, response.status);
          else markImageHostHealthy(host);
          continue;
        }
        if (trace) trace.error_type = '';
        await sendUpstreamImage(
          res, response, 1, fetched.signal, IMAGE_DRAIN_TIMEOUT,
          cacheKeyForFetchedImage(cacheKey, fetched.finalUrl),
        );
        markImageHostHealthy(host);
        hostHealthy = true;
        settings.setPreferredImageHost(host);
        return;
      } catch (e) {
        if ((clientSignal && clientSignal.aborted) || isClientDisconnectError(e) || res.destroyed) return;
        // 流式转发已发出 200 后无法再切换域名或改写 JSON 错误。
        if (res.headersSent) {
          noteImageFailure(res, e);
          if (isTransientImageFailure(e)) markImageHostFailed(host, e);
          if (!res.destroyed) res.destroy();
          return;
        }
        if (!(e instanceof ApiError) || e.expose !== true) {
          noteImageFailure(res, e);
          lastError = '图片获取失败';
        } else {
          noteImageFailure(res, e);
          lastError = publicErrorMessage(e, lastError);
        }
        lastStatus = imageErrorStatus(e);
        // 网络、超时、上游 5xx/429 才进入短负缓存；MIME/重定向安全拒绝
        // 不污染域名健康状态，避免误伤其他正常资源。
        if (isTransientImageFailure(e)) markImageHostFailed(host, e);
        else markImageHostHealthy(host);
        /* 尝试下一个域名 */
      } finally {
        if (fetched) fetched.cleanup();
        if (!hostHealthy) releaseImageHostProbe(host);
      }
    }
    if ((clientSignal && clientSignal.aborted) || res.destroyed) return;
    if (!attempts && trace) trace.error_type = 'circuit_open';
    // 网络线路耗尽或熔断时只返回稳定文案；不把上游状态、内部错误或 URL
    // 细节暴露给浏览器。资源明确存在但被上游拒绝的 4xx 仍保留简短状态。
    const publicLastError = lastStatus >= 500
      ? '图片获取失败'
      : (typeof lastError === 'string' ? lastError : '图片获取失败');
    sendJson(res, lastStatus, { error: publicLastError });
  } finally {
    if (cacheFlight) finishImageCacheFlight(cacheKey, cacheFlight, getImageCache(cacheKey));
  }
}

/* ----------------------------- API 路由 ----------------------------- */

async function proxyEventStream(res, response, signal) {
  let reader = null;
  let onClose = null;
  let closed = false;
  let total = 0;
  try {
    reader = response.body.getReader();
    onClose = () => {
      if (!res.writableEnded) {
        closed = true;
        reader.cancel().catch(() => {});
      }
    };
    res.once('close', onClose);
    res.writeHead(200, baseHeaders({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    }));
    while (!closed) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_AI_STREAM_BYTES) throw new ApiError('AI 流式响应过大', 502);
      if (!res.write(Buffer.from(value))) await waitForDrain(res, signal, 30000);
    }
    if (!closed && !res.destroyed) res.end();
  } finally {
    if (onClose) res.off('close', onClose);
    try { if (reader) await reader.cancel(); } catch (_) {}
    // requestAiStream 把 timeout/父 signal 清理器绑定在 response 上；无论
    // getReader、writeHead、转发还是背压在哪一步失败，都必须在这里释放。
    features.cleanupResponse(response);
  }
}

function translationServiceHeaders(contentType) {
  const headers = { 'Content-Type': contentType };
  if (TRANSLATION_SERVICE_TOKEN) headers.Authorization = `Bearer ${TRANSLATION_SERVICE_TOKEN}`;
  return headers;
}

function translationQuery(u) {
  const allowed = ['aid', 'photoId', 'pageIndex', 'targetLang', 'pipeline', 'waitMs'];
  const query = new URLSearchParams();
  for (const key of allowed) {
    const value = String(u.searchParams.get(key) || '').trim();
    if (value) query.set(key, value);
  }
  return query;
}

async function proxyTranslationPage(req, res, u, requestSignal) {
  if (!TRANSLATION_SERVICE_URL) {
    if (typeof req.resume === 'function') req.resume();
    throw new ApiError('翻译服务未配置', 503, { expose: true, publicMessage: '翻译服务暂不可用' });
  }
  const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (!TRANSLATION_IMAGE_MIMES.has(contentType)) {
    if (typeof req.resume === 'function') req.resume();
    throw new ApiError('请以 image/* 二进制上传图片', 415);
  }
  const source = await readBody(req, TRANSLATION_MAX_PAGE_BYTES);
  if (!source.length) throw new ApiError('图片请求体为空', 400);

  let endpoint;
  try {
    endpoint = new URL('/v1/translate/page', `${TRANSLATION_SERVICE_URL}/`);
    endpoint.search = translationQuery(u).toString();
  } catch (_) {
    throw new ApiError('翻译服务地址配置无效', 503, { expose: true, publicMessage: '翻译服务暂不可用' });
  }

  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: 'POST',
      headers: translationServiceHeaders(contentType),
      body: source,
      signal: requestSignal,
    });
  } catch (error) {
    if (requestSignal?.aborted || error?.name === 'AbortError') throw error;
    throw new ApiError('翻译服务连接失败', 502, { cause: error });
  }

  const responseBody = await readResponseBuffer(upstream, 2 * 1024 * 1024, '翻译服务响应', requestSignal);
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
  try { resultUrl = new URL(String(payload.imageUrl), `${TRANSLATION_SERVICE_URL}/`); } catch (_) {
    throw new ApiError('翻译结果地址无效', 502);
  }
  const serviceOrigin = new URL(`${TRANSLATION_SERVICE_URL}/`).origin;
  if (resultUrl.origin !== serviceOrigin || !/^\/v1\/results\/[0-9a-f]{64}\.webp$/.test(resultUrl.pathname)) {
    throw new ApiError('翻译结果地址不受信任', 502);
  }
  let translated;
  try {
    translated = await fetch(resultUrl, {
      headers: translationServiceHeaders('application/json'),
      signal: requestSignal,
    });
  } catch (error) {
    if (requestSignal?.aborted || error?.name === 'AbortError') throw error;
    throw new ApiError('翻译结果获取失败', 502, { cause: error });
  }
  if (!translated.ok) throw new ApiError('翻译结果获取失败', 502);
  const resultType = String(translated.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (resultType !== 'image/webp') throw new ApiError('翻译结果不是 WebP 图片', 502);
  const output = await readResponseBuffer(translated, TRANSLATION_MAX_PAGE_BYTES, '翻译结果', requestSignal);
  if (!output.length) throw new ApiError('翻译结果为空', 502);
  res.writeHead(200, baseHeaders({
    'Content-Type': 'image/webp',
    'Content-Length': output.length,
    'Cache-Control': 'private, max-age=86400',
    'X-Translation-Status': 'ready',
    'X-Translation-Cache-Hit': payload.cacheHit === true ? '1' : '0',
  }));
  return res.end(output);
}

async function api(req, res, u, requestSignal) {
  const route = u.pathname.replace(/^\/api/, '');
  const q = u.searchParams;
  // /api/auth 在口令验证前调用；/api/img 只依赖站点门禁和服务端图片白名单。
  // 两者都不创建 JM Session，避免首屏并发图片生成大量空 jmw_sid 文件。
  const stateless = route === '/auth' || route === '/img' || route === '/translation/page';
  const jar = stateless ? { cookiesByOrigin: {}, user: null, apiHost: '' } : ensureJar(req, res);

  // 数据源由浏览器设置选择，但只能是固定枚举；实际 origin 始终来自服务端白名单。
  const dataSource = settings.normalizeDataSource(String(req.headers['x-jmw-data-source'] || 'mixed'));
  if (route !== '/img' && route !== '/auth') {
    req.jmwApiTrace = {
      request_id: crypto.randomBytes(8).toString('hex'),
      upstream_host: '', retry_count: 0, attempts: 0, upstream_ms: 0, error_type: '',
    };
  }
  // 透传到上游的快捷封装（会话内 API 域名覆盖优先）。成功响应会记住
  // 实际成功的精确 origin；登录可能走备用域名，后续请求必须继续使用同一
  // origin，避免 Cookie 按域隔离后再次落到没有 AVS 的线路。
  const call = (opts = {}) => {
    const { onSuccess, ...rest } = opts;
    return upstreamRequest({
      hosts: settings.apiHostsForSource(dataSource, jar.apiHost),
      cookieHosts: settings.allDataSourceHosts(),
      jar,
      dnsLookup: features.dohLookup,
      fetchImpl: features.outboundFetch,
      signal: requestSignal,
      ...rest,
      trace: req.jmwApiTrace,
      onSuccess: async (meta) => {
        let changed = false;
        const origin = settings.normalizeHost(meta && meta.origin);
        req.jmwApiTrace = req.jmwApiTrace || {};
        Object.assign(req.jmwApiTrace, {
          upstream_host: hostnameOnly(origin),
          retry_count: Math.max(0, Number(meta && meta.index) || 0),
          upstream_ms: Math.max(0, Number(meta && meta.durationMs) || Number(req.jmwApiTrace.upstream_ms) || 0),
          error_type: '',
        });
        if (origin && settings.isTrustedApiHost(origin) && jar.apiHost !== origin) {
          jar.apiHost = origin;
          changed = true;
        }
        if (typeof onSuccess === 'function') await onSuccess(meta);
        if (changed) sessions.scheduleSave(jar);
      },
    });
  };

  // 401 说明当前 JM 会话已失效，而不是站点访问口令错误。认证 GET 可以
  // 先在其它已有 AVS 的受信 origin 重试；全部失败后清除本地用户状态，
  // 防止 /api/me 继续把已不能使用收藏的旧用户显示成“已登录”。
  const callWithAuthRecovery = async (opts = {}) => {
    const expectedUser = jar.user;
    try {
      return await call({
        retryUnauthorized: opts.retryUnauthorized === undefined ? !!expectedUser : opts.retryUnauthorized,
        ...opts,
      });
    } catch (error) {
      if (error && error.authFailure && expectedUser && jar.user === expectedUser) {
        sessions.clearUpstreamAuth(jar);
        error.code = 401;
        error.expose = true;
        error.publicMessage = '登录会话已失效，请重新登录';
      }
      throw error;
    }
  };

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
        dataSource,
        dataSources: {
          builtin: { available: settings.apiHostsForSource('builtin', jar.apiHost).length > 0, hosts: settings.apiHostsForSource('builtin', jar.apiHost).length },
          network: { available: settings.apiHostsForSource('network', jar.apiHost).length > 0, configured: settings.isApiHostLocked() },
          mixed: { available: settings.apiHostsForSource('mixed', jar.apiHost).length > 0, hosts: settings.apiHostsForSource('mixed', jar.apiHost).length },
        },
        imageHosts: settings.imageHosts(),
        hasAccessPassword: !!ACCESS_PASSWORD,
        advanced: {
          ai: features.aiConfig(),
          // DoH 自定义地址和运行策略只经受保护的 /api/doh 返回。
          doh: { available: true },
          localFolders: true,
          offline: true,
        },
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
          `jmw_auth=${authToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${cookieSecurity(req)}`
        );
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 401, { error: '口令错误' });
    }

    /* ---- 用户 ---- */
    case '/me':
      // 旧版本可能只保存了用户资料却没有按 origin 保存 AVS；这类状态
      // 不能继续显示为“已登录”，否则收藏页会稳定收到上游 401。
      return sendJson(res, 200, { user: sessions.hasUpstreamAuth(jar) ? jar.user : null });

    case '/login': {
      if (!rateLimit(`login:${clientIp(req)}`, 10, 5 * 60 * 1000)) {
        return sendJson(res, 429, { error: '尝试次数过多，请 5 分钟后再试' });
      }
      const body = await readJsonBody(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!username || !password) return sendJson(res, 400, { error: '请输入用户名和密码' });
      let loginOrigin = '';
      const out = await call({ method: 'POST', path: '/login', form: [
        { name: 'username', value: username },
        { name: 'password', value: password },
      ], onSuccess: ({ origin }) => { loginOrigin = origin; } });
      const rawUser = out && out.data;
      if (!rawUser || typeof rawUser !== 'object' || Array.isArray(rawUser)) {
        sessions.clearUpstreamAuth(jar);
        throw new ApiError('上游返回的用户资料格式异常', 502);
      }
      // JM API 将登录态放在响应 data.s；它不一定通过 Set-Cookie 返回，
      // 因此必须在“实际成功 origin”上显式写入 AVS，而不能复制到其它域名。
      const avs = typeof rawUser.s === 'string' ? rawUser.s.trim() : '';
      if (!loginOrigin || !avs || !setOriginCookie(jar, loginOrigin, 'AVS', avs)) {
        sessions.clearUpstreamAuth(jar);
        throw new ApiError('上游登录成功但未返回有效会话凭证', 502);
      }
      const safeUser = sessions.sanitizeUser(rawUser);
      if (!safeUser) {
        sessions.clearUpstreamAuth(jar);
        throw new ApiError('上游返回的用户资料格式异常或过大', 502);
      }
      jar.user = safeUser;
      jar.apiHost = settings.normalizeHost(loginOrigin) || jar.apiHost;
      sessions.scheduleSave(jar);
      // 不把 s/jwttoken 等认证字段回传给浏览器；前端只需要展示资料。
      return sendJson(res, 200, { ...out, data: safeUser });
    }

    case '/logout':
      sessions.destroyJar(jar.sid);
      res.setHeader('Set-Cookie', `jmw_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecurity(req)}`);
      return sendJson(res, 200, { ok: true });

    case '/daily':
      return sendJson(res, 200, await callWithAuthRecovery({ path: '/daily', query: { user_id: q.get('user_id') } }));

    case '/daily_chk': {
      const body = await readJsonBody(req);
      return sendJson(res, 200, await callWithAuthRecovery({ method: 'POST', path: '/daily_chk', form: [
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

    case '/album': {
      const out = await call({ path: '/album', query: { id: q.get('id') } });
      const value = out?.data || out; const aid = String(q.get('id') || '');
      const hotPriority = chapterAi.touchPopularity(aid, { weight: 1 });
      const rows = Array.isArray(value?.series) ? value.series : [];
      rows.forEach((row, index) => { const photoId = String(row?.id || ''); if (/^\d+$/.test(photoId)) { try { chapterAi.enqueue(aid, photoId, hotPriority + Math.max(10, 100 - index)); } catch (_) {} } });
      if (Array.isArray(value?.series)) {
        value.series = value.series.map((row) => {
          const rec = chapterAi.get(aid, String(row?.id || ''));
          // 上游章节名是默认/优先标题；只有确实缺少上游标题时，才把已完成
          // 的 AI 标题作为列表名称。描述和总结只留在 chapter-ai 记录中，
          // 暂不注入漫画详情响应，待确定展示位置后再单独接入。
          const sourceTitle = chapterSourceTitle(row);
          if (rec?.status === 'completed' && !sourceTitle) {
            // 这里 sourceTitle 已确认为空，因此只取本次分析生成的标题；
            // 不能用记录里旧的 sourceName 覆盖当前章节的无标题状态。
            const title = effectiveChapterTitle(sourceTitle, rec.generatedTitle);
            if (title) return { ...row, name: title };
          }
          // 某些上游线路把章节标题放在 title 而不是 name；统一补到前端使用
          // 的 name 字段，但不改变原标题内容或把 AI 结果覆盖上去。
          if (sourceTitle && !String(row?.name || '').trim()) return { ...row, name: sourceTitle };
          return row;
        });
      }
      return sendJson(res, 200, out);
    }

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

    case '/comment_vote': {
      const body = await readJsonBody(req);
      const commentId = String(body.comment_id || '');
      if (!/^\d+$/.test(commentId)) return sendJson(res, 400, { error: '评论 ID 不合法' });
      return sendJson(res, 200, await call({ method: 'POST', path: '/comment_vote', form: [
        { name: 'comment_id', value: commentId },
        { name: 'vote_type', value: body.vote_type === 'down' ? 'down' : 'up' },
      ] }));
    }

    case '/like':
      return sendJson(res, 200, await call({ method: 'POST', path: '/like', form: [
        { name: 'id', value: String(q.get('id') || '') },
      ] }));

    case '/favorite':
      return sendJson(res, 200, await callWithAuthRecovery({ method: 'POST', path: '/favorite', form: [
        { name: 'aid', value: String(q.get('aid') || '') },
      ] }));

    case '/favorite_folder': {
      const body = await readJsonBody(req);
      const type = String(body.type || '');
      const folderId = String(body.folder_id ?? (type === 'add' ? '0' : ''));
      const folderName = String(body.folder_name || '').trim().slice(0, 60);
      const aid = String(body.aid || '');
      if (!['add', 'edit', 'del', 'move'].includes(type)) {
        return sendJson(res, 400, { error: '未知收藏夹操作' });
      }
      if ((type === 'add' || type === 'edit') && !folderName) {
        return sendJson(res, 400, { error: '收藏夹名称不能为空' });
      }
      if (type !== 'add' && !/^\d{1,20}$/.test(folderId)) {
        return sendJson(res, 400, { error: '收藏夹 ID 不合法' });
      }
      if (type === 'move' && !/^\d{1,12}$/.test(aid)) {
        return sendJson(res, 400, { error: '漫画 ID 不合法' });
      }
      jar.favoriteFolders = Array.isArray(jar.favoriteFolders) ? jar.favoriteFolders : [];
      jar.favoriteFolderMap = jar.favoriteFolderMap && typeof jar.favoriteFolderMap === 'object' ? jar.favoriteFolderMap : {};
      const localFolder = jar.favoriteFolders.find((folder) => folder.id === folderId);
      const localMove = type === 'move' && (
        !!localFolder || Object.prototype.hasOwnProperty.call(jar.favoriteFolderMap, aid)
      );
      const isSessionOperation = (type === 'edit' || type === 'del') ? !!localFolder : localMove;
      let cloudError = null;

      // 已登录且操作对象不是先前降级创建的本会话收藏夹时，优先写入 JM 账号。
      // call() 继续使用同一个按 origin 隔离的 cookiesByOrigin jar，绝不跨域复制凭证。
      if (jar.user && !isSessionOperation) {
        try {
          const out = await callWithAuthRecovery({ method: 'POST', path: '/favorite_folder', form: [
            { name: 'type', value: type },
            { name: 'folder_id', value: type === 'add' ? '0' : folderId },
            { name: 'folder_name', value: folderName },
            { name: 'aid', value: aid },
          ] });
          const status = String(out?.data?.status || '').trim().toLowerCase();
          if (status && !['ok', 'success', 'true', '1'].includes(status)) {
            throw new ApiError(String(out?.data?.msg || '上游未完成收藏夹操作'), 502);
          }
          return sendJson(res, 200, { ...out, ok: true, scope: 'cloud' });
        } catch (error) {
          if (requestSignal?.aborted || error?.name === 'AbortError') throw error;
          cloudError = error;
        }
      }

      // 未登录、上游不支持或请求失败时，保留原有会话级实现作为明确降级。
      if (type === 'add') {
        if (jar.favoriteFolders.length >= 100) return sendJson(res, 409, { error: '收藏夹数量已达上限（100）' });
        let id;
        do {
          id = `${Date.now()}${String(crypto.randomInt(1_000_000)).padStart(6, '0')}`;
        } while (jar.favoriteFolders.some((folder) => folder.id === id));
        jar.favoriteFolders.push({ id, name: folderName });
      } else if (type === 'edit') {
        if (!localFolder && !cloudError) return sendJson(res, 404, { error: '收藏夹不存在' });
        if (!localFolder) {
          if (jar.favoriteFolders.length >= 100) return sendJson(res, 409, { error: '收藏夹数量已达上限（100）' });
          jar.favoriteFolders.push({ id: folderId, name: folderName });
        } else localFolder.name = folderName;
      } else if (type === 'del') {
        jar.favoriteFolders = jar.favoriteFolders.filter((x) => x.id !== folderId);
        for (const [aid, value] of Object.entries(jar.favoriteFolderMap)) if (value === folderId) delete jar.favoriteFolderMap[aid];
      } else if (type === 'move') {
        if (folderId !== '0' && !localFolder && !cloudError) return sendJson(res, 404, { error: '收藏夹不存在' });
        if (folderId !== '0' && !localFolder) {
          if (jar.favoriteFolders.length >= 100) return sendJson(res, 409, { error: '收藏夹数量已达上限（100）' });
          jar.favoriteFolders.push({ id: folderId, name: `收藏夹 ${folderId}` });
        }
        if (folderId !== '0' && !Object.prototype.hasOwnProperty.call(jar.favoriteFolderMap, aid) &&
            Object.keys(jar.favoriteFolderMap).length >= 10000) {
          return sendJson(res, 409, { error: '收藏夹映射数量已达上限' });
        }
        if (folderId === '0') delete jar.favoriteFolderMap[aid];
        else jar.favoriteFolderMap[aid] = folderId;
      }
      sessions.scheduleSave(jar);
      return sendJson(res, 200, {
        ok: true,
        scope: 'session',
        warning: cloudError
          ? '云端收藏夹操作失败，已仅在本会话应用'
          : '当前未使用账号云端收藏夹，操作仅在本会话应用',
        data: { folder_list: [{ id: '0', name: '全部收藏' }, ...jar.favoriteFolders] },
      });
    }

    case '/favorites': {
      const folderId = q.get('folder_id') || '0';
      const sessionFolders = Array.isArray(jar.favoriteFolders) ? jar.favoriteFolders : [];
      const isSessionFolder = folderId !== '0' && sessionFolders.some((folder) => folder.id === folderId);
      const out = await callWithAuthRecovery({ path: '/favorite', retryUnauthorized: true, query: {
        page: q.get('page') || '1',
        o: q.get('o') || 'mr',
        // 云端收藏夹直接由上游筛选；仅本会话收藏夹仍取总收藏后在本地分组。
        folder_id: isSessionFolder ? '0' : folderId,
      } });
      if (out && out.data) {
        const list = Array.isArray(out.data.list) ? out.data.list : [];
        out.data.source_count = list.length;
        out.data.source_page_key = sourcePageKey(list);
        if (isSessionFolder) out.data.list = list.filter((item) => jar.favoriteFolderMap[String(item.id || item.aid || item.AID || '')] === folderId);
        // 保留上游真实 folder_list，并附加曾经降级创建的会话收藏夹。
        const upstreamFolders = out.data.folder_list;
        if (Array.isArray(upstreamFolders)) {
          out.data.folder_list = [...upstreamFolders, ...sessionFolders];
        } else if (upstreamFolders && typeof upstreamFolders === 'object') {
          out.data.folder_list = { ...upstreamFolders };
          for (const folder of sessionFolders) out.data.folder_list[folder.id] ??= folder.name;
        } else {
          out.data.folder_list = [{ id: '0', name: '全部收藏' }, ...sessionFolders];
        }
        out.data.local_folder_map = jar.favoriteFolderMap || {};
        out.data.session_folder_ids = sessionFolders.map((folder) => folder.id);
      }
      out.scope = jar.user ? 'cloud' : 'session';
      return sendJson(res, 200, out);
    }

    case '/history': {
      const out = await callWithAuthRecovery({ path: '/watch_list', query: { page: q.get('page') || '1' } });
      if (out && out.data && Array.isArray(out.data.list)) {
        out.data.source_count = out.data.list.length;
        out.data.source_page_key = sourcePageKey(out.data.list);
        const hidden = new Set(jar.hiddenHistory || []);
        out.data.list = out.data.list.filter((item) => !hidden.has(String(item.id || item.aid || item.AID || '')));
      }
      out.scope = jar.user ? 'cloud' : 'session';
      return sendJson(res, 200, out);
    }

    case '/history/delete': {
      const body = await readJsonBody(req);
      const id = String(body.id || '');
      if (!/^\d{1,12}$/.test(id)) return sendJson(res, 400, { error: '历史记录 ID 不合法' });
      let cloudError = null;
      if (jar.user) {
        try {
          const out = await callWithAuthRecovery({ method: 'POST', path: '/watch_list', form: [
            { name: 'id', value: id },
          ] });
          if (Array.isArray(jar.hiddenHistory) && jar.hiddenHistory.includes(id)) {
            jar.hiddenHistory = jar.hiddenHistory.filter((value) => value !== id);
            sessions.scheduleSave(jar);
          }
          return sendJson(res, 200, { ...out, ok: true, scope: 'cloud' });
        } catch (error) {
          if (requestSignal?.aborted || error?.name === 'AbortError') throw error;
          cloudError = error;
        }
      }
      jar.hiddenHistory = [...new Set([...(jar.hiddenHistory || []), id])].slice(-5000);
      sessions.scheduleSave(jar);
      return sendJson(res, 200, {
        ok: true,
        scope: 'session',
        warning: cloudError
          ? '云端历史删除失败，已仅在本会话隐藏'
          : '当前未登录 JM 账号，已仅在本会话隐藏',
      });
    }

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
      // 用户访问章节即记录为后台候选；不绑定用户身份，按访问自然提升优先级。
      try { const aid = parsed.aid || id; const hotPriority = chapterAi.touchPopularity(aid, { photoId: id, weight: 2 }); chapterAi.enqueue(aid, id, hotPriority + 100); } catch (_) {}
      return sendJson(res, 200, { code: 200, data: parsed });
    }

    /* ---- 图片代理 ---- */
    case '/img': {
      const upath = q.get('path');
      const abs = q.get('u');
      if (!abs && !upath) return sendJson(res, 400, { error: '缺少 path 或 u 参数' });
      // 缓存命中不占用上游槽位；这对首页刷新、返回列表和多标签页尤其重要。
      const cacheKey = abs ? imageCacheKeyForUrl(abs) : imageCacheKeyForPath(upath);
      const cached = getImageCache(cacheKey);
      if (cached) {
        sendCachedImage(res, cached, abs ? 30 : 1);
        return;
      }
      const trace = imageTrace(res);
      const queueStarted = Date.now();
      const releaseImageSlot = await waitForImageRequestSlot(clientIp(req), requestSignal);
      addImageTraceDuration(trace, 'queue_ms', queueStarted);
      if (!releaseImageSlot) {
        if (requestSignal.aborted || res.destroyed) return;
        if (trace) trace.error_type = 'queue';
        return sendJson(res, 503, { error: '图片代理并发请求过多，请稍后重试' }, { 'Retry-After': '1' });
      }
      try {
        if (abs) return await proxyImage(res, abs, 30, requestSignal);
        return await proxyImagePath(res, upath.startsWith('/') ? upath : '/' + upath, requestSignal);
      } finally {
        releaseImageSlot();
      }
    }

    case '/translation/page':
      return await proxyTranslationPage(req, res, u, requestSignal);

    /* ---- 高级功能 ---- */
    case '/ai/config':
      return sendJson(res, 200, { ...features.aiConfig(), chapterAnalysis: chapterAi.config() });

    case '/chapter-ai': {
      const aid = q.get('aid'); const photoId = q.get('photoId');
      if (!/^\d{1,16}$/.test(String(aid || ''))) return sendJson(res, 400, { error: '缺少合法的 aid' });
      if (photoId == null || photoId === '') {
        return sendJson(res, 200, { data: Object.values(chapterAi.state.records).filter((x) => String(x.aid) === String(aid)) });
      }
      if (!/^\d{1,16}$/.test(String(photoId))) return sendJson(res, 400, { error: '章节 ID 不合法' });
      return sendJson(res, 200, { data: chapterAi.get(aid, photoId) });
    }

    case '/chapter-ai/enqueue': {
      const body = await readJsonBody(req);
      const aid = String(body.aid || ''); const photoId = String(body.photoId || '');
      if (!/^\d{1,16}$/.test(aid) || !/^\d{1,16}$/.test(photoId)) return sendJson(res, 400, { error: '漫画或章节 ID 不合法' });
      return sendJson(res, 202, { data: chapterAi.enqueue(aid, photoId, Number(body.priority) || 0) });
    }

    case '/ai/chat': {
      if (!rateLimit(`ai:${clientIp(req)}`, 30, 5 * 60 * 1000) ||
          !rateLimit('ai:global', 60, 5 * 60 * 1000)) return sendJson(res, 429, { error: 'AI 请求过于频繁，请稍后重试' });
      if (activeAiRequests >= MAX_AI_CONCURRENCY) return sendJson(res, 503, { error: 'AI 服务繁忙，请稍后重试' }, { 'Retry-After': '2' });
      const body = await readJsonBody(req);
      activeAiRequests++;
      try {
        const upstream = await features.requestAiStream(body, requestSignal);
        features.addLog('info', `AI chat model=${features.aiConfig().model}`);
        return await proxyEventStream(res, upstream, requestSignal);
      } finally {
        activeAiRequests--;
      }
    }

    case '/ai/search': {
      if (!rateLimit(`ai-search:${clientIp(req)}`, 20, 5 * 60 * 1000) ||
          !rateLimit('ai-search:global', 120, 5 * 60 * 1000)) return sendJson(res, 429, { error: '搜索请求过于频繁，请稍后重试' });
      if (activeSearchRequests >= MAX_SEARCH_CONCURRENCY) return sendJson(res, 503, { error: '搜索服务繁忙，请稍后重试' }, { 'Retry-After': '2' });
      const body = await readJsonBody(req);
      activeSearchRequests++;
      try {
        return sendJson(res, 200, await features.searchWeb(body.query, body, requestSignal));
      } finally {
        activeSearchRequests--;
      }
    }

    case '/doh': {
      if (req.method === 'GET') {
        const doh = features.getDohState();
        if (checkOperationalAccess(req)) return sendJson(res, 200, doh);
        // 普通访客仍需加载“数据源”页面，但不得读取自定义解析地址/名称。
        return sendJson(res, 200, {
          enabled: !!doh.enabled,
          configuredEnabled: !!doh.configuredEnabled,
          autoStart: !!doh.autoStart,
          preferIpv6: !!doh.preferIpv6,
          current: String(doh.current || ''),
          customName: '',
          customUrl: '',
          certificatePolicy: String(doh.certificatePolicy || ''),
          providers: (doh.providers || []).map((provider) => provider.id === 'custom'
            ? { id: 'custom', name: '自定义 DoH', url: '' }
            : { id: String(provider.id || ''), name: String(provider.name || ''), url: String(provider.url || '') }),
          restricted: true,
        });
      }
      const body = await readJsonBody(req);
      return sendJson(res, 200, features.setDohState(body));
    }

    case '/doh/test':
      if (!rateLimit(`doh-test:${clientIp(req)}`, 10, 5 * 60 * 1000)) return sendJson(res, 429, { error: 'DoH 测试过于频繁，请稍后重试' });
      return sendJson(res, 200, await features.testDoh(
        q.get('provider') || features.getDohState().current,
        q.get('host') || 'github.com',
        requestSignal
      ));

    case '/logs':
      if (req.method === 'DELETE') {
        features.clearLogs();
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 200, { logs: features.getLogs(q.get('limit')) });

    case '/update':
      return sendJson(res, 200, await features.checkUpdate(requestSignal));

    case '/setting': {
      // 远端设置（img_host 等），同时并入图片域名白名单
      const out = await call({ path: '/setting' });
      try {
        if (out && out.data && out.data.img_host) {
          const host = settings.normalizeHost(String(out.data.img_host));
          if (host && settings.isKnownImageHost(host)) settings.set({ imgHost: host });
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
  // 静态错误不能被浏览器或 CDN 负缓存。否则一次发布时序或拼写错误
  // 可能让随后已经存在的同名资源继续返回缓存的 404。
  const staticErrorHeaders = () => baseHeaders({
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  let p;
  try {
    p = decodeURIComponent(u.pathname);
  } catch (_) {
    res.writeHead(400, staticErrorHeaders());
    return res.end('Bad Request');
  }
  // Node 的 fs API 会对含 NUL 的路径同步抛错；在进入异步文件操作前拒绝，
  // 避免 async request listener 产生未处理 rejection 并终止进程。
  if (p.includes('\0')) {
    res.writeHead(400, staticErrorHeaders());
    return res.end('Bad Request');
  }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  // 防目录穿越：必须在 public 内（附加分隔符，避免 public* 兄弟目录被前缀匹配放行）
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, staticErrorHeaders());
    return res.end('Forbidden');
  }

  const sendKnownFile = (target, st, isSpaFallback = false) => {
    if (!st || !st.isFile()) {
      if (isSpaFallback) {
        res.writeHead(500, staticErrorHeaders());
        return res.end('index.html missing');
      }
      return fallbackOrNotFound();
    }
    const ext = path.extname(target).toLowerCase();
    const etag = `W/"${st.size}-${st.mtimeMs}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, baseHeaders({ ETag: etag }));
      return res.end();
    }
    const headers = baseHeaders({
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Content-Length': st.size,
      ETag: etag,
    });
    if (ext === '.html') headers['Content-Security-Policy'] = CSP;

    // HEAD 必须返回与 GET 相同的元数据，但不应为此把整个静态资源读入内存。
    if (req.method === 'HEAD') {
      res.writeHead(200, headers);
      return res.end();
    }
    fs.readFile(target, (error, buf) => {
      if (error) {
        if (isSpaFallback) {
          res.writeHead(500, staticErrorHeaders());
          return res.end('index.html missing');
        }
        return fallbackOrNotFound();
      }
      // stat/read 间文件若被原子替换，以实际发送长度为准，避免响应被截断。
      headers['Content-Length'] = buf.length;
      res.writeHead(200, headers);
      res.end(buf);
    });
  };

  const fallbackOrNotFound = () => {
    // SPA 回退：非资源请求一律回 index.html；回退页也具备完整 HEAD/ETag 语义。
    if (!path.extname(p)) {
      const index = path.join(PUBLIC_DIR, 'index.html');
      return fs.stat(index, (error, st) => {
        if (error) {
          res.writeHead(500, staticErrorHeaders());
          return res.end('index.html missing');
        }
        sendKnownFile(index, st, true);
      });
    }
    res.writeHead(404, staticErrorHeaders());
    return res.end('Not Found');
  };

  fs.stat(file, (error, st) => {
    if (error) return fallbackOrNotFound();
    sendKnownFile(file, st);
  });
}

/* ----------------------------- 服务器 ----------------------------- */

function imageCompletionMeta(trace, res, started, clientClosed = false) {
  if (clientClosed) {
    trace.client_aborted = true;
    if (!trace.error_type) trace.error_type = 'client_aborted';
  }
  const status = clientClosed && !res.headersSent ? 499 : Number(res.statusCode || 0);
  if (!trace.error_type && status >= 400) {
    trace.error_type = status === 401 ? 'access_auth' : status >= 500 ? 'upstream_error' : 'client_error';
  }
  const metric = (key) => Math.max(0, Math.round(Number(trace[key]) || 0));
  return {
    request_id: trace.request_id,
    status,
    duration_ms: Math.max(0, Date.now() - started),
    upstream_host: trace.upstream_host || '',
    error_type: trace.error_type || '',
    dns_ms: metric('dns_ms'),
    connect_ms: metric('connect_ms'),
    tls_ms: metric('tls_ms'),
    ttfb_ms: metric('ttfb_ms'),
    retry_count: metric('retry_count'),
    queue_ms: metric('queue_ms'),
    cache_hit: trace.cache_hit === true,
    bytes: metric('bytes'),
    client_aborted: trace.client_aborted === true,
  };
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let u;
  try {
    u = new URL(req.url, 'http://localhost');
  } catch (_) {
    res.writeHead(400, baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
    return res.end('Bad Request');
  }
  if (u.pathname === '/api/img') {
    res.jmwImageTrace = {
      request_id: crypto.randomBytes(8).toString('hex'),
      upstream_host: '', error_type: '', dns_ms: 0, connect_ms: 0, tls_ms: 0,
      ttfb_ms: 0, retry_count: 0, queue_ms: 0, cache_hit: false, bytes: 0,
      client_aborted: false,
    };
    let imageLogged = false;
    const writeImageLog = (clientClosed) => {
      if (imageLogged) return;
      imageLogged = true;
      const meta = imageCompletionMeta(res.jmwImageTrace, res, started, clientClosed);
      const message = `${req.method} /api/img -> ${meta.status} (${meta.duration_ms}ms)`;
      const level = meta.status >= 500 || meta.status === 499 ? 'error' : meta.status >= 400 ? 'warn' : 'info';
      console.log(`[image] ${JSON.stringify(meta)}`);
      features.addLog(level, message, meta);
    };
    res.once('finish', () => writeImageLog(false));
    res.once('close', () => writeImageLog(!res.writableEnded));
  } else {
    res.on('finish', () => {
      if (u.pathname.startsWith('/api/')) {
      // 查询参数可能包含搜索词、用户标识或临时凭据；访问日志只记录路由。
      const trace = req.jmwApiTrace;
      const suffix = trace && trace.upstream_host
        ? ` upstream_host=${trace.upstream_host} retry_count=${trace.retry_count}` : '';
      const message = `${req.method} ${u.pathname} -> ${res.statusCode} (${Date.now() - started}ms)${suffix}`;
      console.log(`[api] ${message}`);
      features.addLog(
        res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
        message,
        trace && trace.upstream_host ? {
          request_id: trace.request_id,
          upstream_host: trace.upstream_host,
          retry_count: trace.retry_count,
          attempts: trace.attempts,
          upstream_ms: trace.upstream_ms,
          error_type: trace.error_type || '',
        } : undefined,
      );
      }
    });
  }

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
    const clientAbort = bindClientAbort(res);
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
      const operationalRoute = route === '/logs' || (route === '/doh' && req.method !== 'GET') || route === '/doh/test';
      if (operationalRoute && !checkOperationalAccess(req)) {
        return sendJson(res, 403, { error: '该运维操作仅限站点管理员' });
      }
      await api(req, res, u, clientAbort.signal);
    } catch (e) {
      if (clientAbort.signal.aborted || res.destroyed || isClientDisconnectError(e)) return;
      const status = e instanceof ApiError ? imageErrorStatus(e) : 500;
      const exposed = e instanceof ApiError && e.expose === true;
      if (!exposed) console.error(`[api] 内部错误 ${req.method} ${u.pathname}:`, e);
      // 只有显式标为可公开的 ApiError 才能回显；5xx 默认只保留在服务端诊断日志。
      const publicMessage = exposed ? (e.publicMessage || e.message || '请求处理失败') : '服务器内部错误';
      if (!res.headersSent) sendJson(res, status, { error: publicMessage });
      else res.end();
    } finally {
      clientAbort.cleanup();
      if (req.jmwJar) {
        sessions.releaseJar(req.jmwJar);
        req.jmwJar = null;
      }
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
  clientIp,
  requestIsSecure,
  rateLimit,
  bindClientAbort,
  validateImageUrl,
  fetchImageResponse,
  readRasterImage,
  imageCacheControl,
  sendCachedImage,
  sendUpstreamImage,
  proxyEventStream,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_CONCURRENCY,
  MAX_IMAGE_CONCURRENCY_PER_IP,
  MAX_IMAGE_CACHE_BYTES,
  MAX_IMAGE_CACHE_ENTRY_BYTES,
  IMAGE_CACHE_TTL_MS,
  IMAGE_QUEUE_LIMIT,
  IMAGE_QUEUE_TIMEOUT,
  acquireImageRequestSlot,
  waitForImageRequestSlot,
  imageCacheKeyForPath,
  imageCacheKeyForUrl,
  cacheKeyForFetchedImage,
  getImageCache,
  setImageCache,
  clearImageCache,
  imageCacheStats,
  isTransientImageFailure,
  markImageHostFailed,
  markImageHostHealthy,
  releaseImageHostProbe,
  reserveImageHost,
  clearImageHostHealth,
  classifyImageFailure,
  imageUrlCandidates,
  SAFE_RASTER_MIME,
};
