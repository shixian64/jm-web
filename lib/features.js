'use strict';

/** 可选高级能力：DoH、AI、联网搜索、更新检查和内存日志。 */
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const net = require('net');
const os = require('os');
const { URL } = require('url');
const {
  ApiError, assertPublicUrl, positiveTimeout, linkedAbortSignal, readResponseText,
} = require('./jm-api');
const { httpsFetch } = require('./https-fetch');
const sessions = require('./sessions');
const pkg = require('../package.json');

const FILE = path.join(sessions.DATA_DIR, 'features.json');
const DOH_PROVIDERS = Object.freeze([
  { id: 'tencent', name: 'DNSPod / 腾讯', url: 'https://doh.pub/dns-query' },
  { id: 'aliyun', name: 'AliDNS / 阿里', url: 'https://dns.alidns.com/resolve' },
  { id: 'cloudflare', name: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
  { id: 'google', name: 'Google Public DNS', url: 'https://dns.google/resolve' },
]);

let state = loadState();
let dohRuntimeEnabled = !!(state.dohEnabled && state.dohAutoStart);
const dohCache = new Map();
const logs = [];
const LOG_LIMIT = 1000;
const DOH_CACHE_LIMIT = 512;
const DOH_RESPONSE_LIMIT = 128 * 1024;
const SEARCH_RESPONSE_LIMIT = 4 * 1024 * 1024;
const UPDATE_RESPONSE_LIMIT = 1024 * 1024;
const SEARCH_TOTAL_TIMEOUT = Math.min(60_000, positiveTimeout(process.env.SEARCH_TIMEOUT, 35_000));
const responseCleanups = new WeakMap();

function abortError(signal) {
  if (signal && signal.reason instanceof Error) return signal.reason;
  const error = new Error('请求已取消');
  error.name = 'AbortError';
  return error;
}

function hasUsableIpv6(interfaces = os.networkInterfaces()) {
  try {
    return Object.values(interfaces || {}).flat().some((row) => {
      if (!row || row.internal || net.isIP(String(row.address || '')) !== 6) return false;
      const address = String(row.address).toLowerCase().split('%', 1)[0];
      // 回环、未指定、ULA、链路本地、多播和文档地址都不能证明存在公网 IPv6 出口。
      return address !== '::' && address !== '::1'
        && !/^f[cd]/.test(address) && !/^fe[89ab]/.test(address)
        && !/^ff/.test(address) && !/^2001:db8(?::|$)/.test(address);
    });
  } catch (_) {
    return false;
  }
}

function addTraceDuration(trace, key, started) {
  if (!trace || typeof trace !== 'object') return;
  trace[key] = Math.max(0, Number(trace[key]) || 0) + Math.max(0, Date.now() - started);
}

function outboundError(error, requestSignal, parentSignal, label) {
  if (parentSignal && parentSignal.aborted) return abortError(parentSignal);
  if (requestSignal && requestSignal.aborted && requestSignal.reason instanceof Error) {
    return requestSignal.reason;
  }
  if (error instanceof ApiError) return error;
  return new ApiError(`${label}请求失败：${error?.message || error}`, 502);
}

function boundedTimeout(value, fallback, max) {
  return Math.min(max, positiveTimeout(value, fallback));
}

function parseJsonText(text, label) {
  try { return JSON.parse(text); } catch (_) { throw new ApiError(`${label}返回了无效 JSON`, 502); }
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return sanitizeState(raw);
  } catch (_) {
    return sanitizeState({});
  }
}

function sanitizeState(value) {
  const customUrl = sanitizeDohUrl(value?.dohCustomUrl);
  const provider = value?.dohProvider === 'custom' && customUrl
    ? 'custom'
    : (DOH_PROVIDERS.some((x) => x.id === value?.dohProvider) ? value.dohProvider : 'tencent');
  return {
    dohEnabled: !!value?.dohEnabled,
    dohAutoStart: !!value?.dohAutoStart,
    dohProvider: provider,
    dohCustomName: String(value?.dohCustomName || '').trim().slice(0, 80),
    dohCustomUrl: customUrl,
    dohPreferIpv6: !!value?.dohPreferIpv6,
  };
}

function sanitizeDohUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || String(url).length > 2048) return '';
    return url.href;
  } catch (_) { return ''; }
}

function saveState() {
  try {
    fs.mkdirSync(sessions.DATA_DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (error) {
    addLog('error', `保存高级设置失败：${error.message}`);
  }
}

function addLog(level, message, meta) {
  const item = { time: new Date().toISOString(), level: String(level || 'info'), message: String(message || '') };
  if (meta && typeof meta === 'object') item.meta = meta;
  logs.push(item);
  if (logs.length > LOG_LIMIT) logs.splice(0, logs.length - LOG_LIMIT);
  return item;
}

function getLogs(limit = 200) {
  const n = Math.max(1, Math.min(500, Number(limit) || 200));
  return logs.slice(-n);
}

function clearLogs() { logs.length = 0; }

function selectedDohProvider(providerId = state.dohProvider) {
  if (providerId === 'custom' && state.dohCustomUrl) {
    return { id: 'custom', name: state.dohCustomName || '自定义 DoH', url: state.dohCustomUrl };
  }
  return DOH_PROVIDERS.find((x) => x.id === providerId);
}

function getDohState() {
  const providers = DOH_PROVIDERS.map(({ id, name, url }) => ({ id, name, url }));
  providers.push({ id: 'custom', name: state.dohCustomName || '自定义 DoH', url: state.dohCustomUrl });
  return {
    enabled: dohRuntimeEnabled,
    configuredEnabled: state.dohEnabled,
    autoStart: state.dohAutoStart,
    preferIpv6: state.dohPreferIpv6,
    ipv6Available: hasUsableIpv6(),
    current: state.dohProvider,
    customName: state.dohCustomName,
    customUrl: state.dohCustomUrl,
    certificatePolicy: '使用 Node.js 系统信任库；可由部署者通过 NODE_EXTRA_CA_CERTS 添加 CA',
    providers,
  };
}

function setDohState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError('DoH 设置必须是 JSON 对象', 400);
  }
  const optionalBoolean = (key, current) => {
    if (value[key] === undefined) return current;
    if (typeof value[key] !== 'boolean') throw new ApiError(`${key} 必须为布尔值`, 400);
    return value[key];
  };
  if (value.provider !== undefined && typeof value.provider !== 'string') {
    throw new ApiError('provider 必须为字符串', 400);
  }
  if (value.customName !== undefined && typeof value.customName !== 'string') {
    throw new ApiError('customName 必须为字符串', 400);
  }
  if (value.customUrl !== undefined && typeof value.customUrl !== 'string') {
    throw new ApiError('customUrl 必须为字符串', 400);
  }
  const requestedCustom = value?.customUrl === undefined ? state.dohCustomUrl : sanitizeDohUrl(value.customUrl);
  if (value?.customUrl && !requestedCustom) throw new ApiError('请输入有效的 HTTPS DoH 地址', 400);
  const requestedProvider = value?.provider || state.dohProvider;
  if (requestedProvider === 'custom' && !requestedCustom) throw new ApiError('请先填写自定义 DoH 地址', 400);
  if (requestedProvider !== 'custom' && !DOH_PROVIDERS.some((x) => x.id === requestedProvider)) throw new ApiError('未知 DoH 服务', 400);
  state = sanitizeState({
    ...state,
    dohEnabled: optionalBoolean('enabled', state.dohEnabled),
    dohAutoStart: optionalBoolean('autoStart', state.dohAutoStart),
    dohProvider: requestedProvider,
    dohCustomName: value?.customName === undefined ? state.dohCustomName : value.customName,
    dohCustomUrl: requestedCustom,
    dohPreferIpv6: optionalBoolean('preferIpv6', state.dohPreferIpv6),
  });
  if (value?.enabled !== undefined) dohRuntimeEnabled = value.enabled;
  if (!state.dohEnabled) dohRuntimeEnabled = false;
  dohCache.clear();
  saveState();
  addLog('info', `DoH ${dohRuntimeEnabled ? `启用：${state.dohProvider}` : '关闭'}${state.dohPreferIpv6 ? '（IPv6 优先）' : ''}`);
  return getDohState();
}

/**
 * 先解析并验证全部地址，再把同一地址集固定给真实 TLS socket，避免
 * “系统 DNS 预检、DoH 实际连接”或二次解析造成的校验/连接不一致。
 */
async function publicHttpsFetch(input, init = {}, lookup = dns.promises.lookup, dnsTimeoutMs = 8000) {
  const url = input instanceof URL ? new URL(input.href) : new URL(input);
  const signal = init.signal;
  const trace = init.jmwTrace && typeof init.jmwTrace === 'object' ? init.jmwTrace : null;
  const dnsStarted = Date.now();
  let addresses;
  try {
    addresses = await assertPublicUrl(url, lookup, dnsTimeoutMs, signal);
  } finally {
    addTraceDuration(trace, 'dns_ms', dnsStarted);
  }
  const expectedHost = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const ipv6Available = hasUsableIpv6();
  const rows = addresses.map((address) => ({ address, family: net.isIP(address) }))
    .filter((row) => row.family === 4 || (row.family === 6 && ipv6Available))
    .sort((a, b) => {
      if (a.family === b.family) return 0;
      const preferIpv6 = state.dohPreferIpv6 && ipv6Available;
      return preferIpv6 ? b.family - a.family : a.family - b.family;
    });
  if (!rows.length) {
    throw new ApiError('当前运行环境没有可用的公网出站地址族', 502);
  }
  const pinnedLookup = async (hostname, options = {}) => {
    const actualHost = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
    if (actualHost !== expectedHost) throw new Error('TLS 连接主机与已验证主机不一致');
    const family = Number(options.family || 0);
    const filtered = family ? rows.filter((row) => row.family === family) : rows;
    if (!filtered.length) throw new Error(`DNS 未返回 IPv${family || 4} 地址（${hostname}）`);
    return options.all ? filtered.map((row) => ({ ...row })) : { ...filtered[0] };
  };
  return httpsFetch(url, init, pinnedLookup);
}

function pruneDohCache(now = Date.now()) {
  for (const [key, value] of dohCache) {
    if (!value || value.expiresAt <= now) dohCache.delete(key);
  }
  while (dohCache.size >= DOH_CACHE_LIMIT) dohCache.delete(dohCache.keys().next().value);
}

function getCachedDoh(key) {
  const cached = dohCache.get(key);
  if (!cached || cached.expiresAt <= Date.now()) {
    if (cached) dohCache.delete(key);
    return null;
  }
  // Map 插入顺序作为轻量 LRU。
  dohCache.delete(key);
  dohCache.set(key, cached);
  return cached.addresses.slice();
}

async function dohResolve(hostname, providerId = state.dohProvider, timeoutMs = 8000, preferIpv6 = state.dohPreferIpv6, signal) {
  const provider = selectedDohProvider(providerId);
  if (!provider) throw new ApiError('未知 DoH 服务', 400);
  const host = String(hostname || '').trim().toLowerCase();
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) {
    throw new ApiError('待解析域名不合法', 400);
  }
  const effectiveIpv6 = !!preferIpv6 && hasUsableIpv6();
  const cacheKey = `${provider.id}:${provider.url}:${effectiveIpv6 ? 1 : 0}:${host}`;
  const cached = getCachedDoh(cacheKey);
  if (cached) return cached;
  const resolveType = async (type, answerType) => {
    const query = new URL(provider.url);
    query.searchParams.set('name', host);
    query.searchParams.set('type', type);
    const request = linkedAbortSignal(Math.max(500, Math.min(15_000, timeoutMs)), signal, 'DoH 请求超时');
    let response;
    try {
      response = await publicHttpsFetch(query, {
        headers: { Accept: 'application/dns-json', 'User-Agent': 'JM-Web-DoH' },
        redirect: 'error', signal: request.signal,
      }, dns.promises.lookup, Math.max(500, Math.min(8000, timeoutMs)));
      if (!response.ok) throw new ApiError(`DoH 返回 HTTP ${response.status}`, 502);
      const json = parseJsonText(
        await readResponseText(response, DOH_RESPONSE_LIMIT, 'DoH 响应', request.signal),
        'DoH'
      );
      const answers = Array.isArray(json && json.Answer) ? json.Answer : [];
      return answers.slice(0, 256).filter((x) => Number(x && x.type) === answerType)
        .map((x) => String(x.data || '').trim()).filter((x) => net.isIP(x) === (answerType === 28 ? 6 : 4));
    } catch (error) {
      throw outboundError(error, request.signal, signal, 'DoH');
    } finally {
      request.cleanup();
      if (response && !response.bodyUsed) {
        try { await response.body?.cancel(); } catch (_) {}
      }
    }
  };
  const [v4, v6] = await Promise.all([
    resolveType('A', 1),
    effectiveIpv6 ? resolveType('AAAA', 28).catch(() => []) : Promise.resolve([]),
  ]);
  const addresses = [...new Set([...v6, ...v4])];
  if (!addresses.length) throw new ApiError(`DoH 未返回${effectiveIpv6 ? ' IPv6/IPv4' : ' IPv4'}地址`, 502);
  pruneDohCache();
  dohCache.set(cacheKey, { addresses, expiresAt: Date.now() + 60_000 });
  return addresses;
}

async function dohLookup(hostname, options = {}) {
  if (!dohRuntimeEnabled) return dns.promises.lookup(hostname, options);
  const requestedFamily = Number(options?.family || 0);
  const preferIpv6 = requestedFamily === 6 || (state.dohPreferIpv6 && requestedFamily !== 4);
  const addresses = await dohResolve(hostname, state.dohProvider, 8000, preferIpv6, options.signal);
  const list = addresses.map((address) => ({ address, family: net.isIP(address) }))
    .filter((row) => !requestedFamily || row.family === requestedFamily);
  if (!list.length) throw new ApiError(`DoH 未返回 IPv${requestedFamily || 4} 地址`, 502);
  return options?.all ? list : list[0];
}

function outboundFetch(input, init = {}) {
  const lookup = init.jmwLookup || (dohRuntimeEnabled
    ? ((hostname, options) => dohLookup(hostname, { ...options, signal: init.signal }))
    : dns.promises.lookup);
  const safeInit = { ...init };
  delete safeInit.jmwLookup;
  return publicHttpsFetch(input, safeInit, lookup, 8000);
}

async function testDoh(providerId, hostname = 'github.com', signal) {
  const started = Date.now();
  const addresses = await dohResolve(hostname, providerId, 8000, state.dohPreferIpv6, signal);
  return { addresses, ms: Date.now() - started, provider: providerId, hostname };
}

function aiConfig() {
  return {
    enabled: !!process.env.AI_API_KEY,
    model: process.env.AI_MODEL || 'grok-4.6',
    searchEnabled: true,
    tavilyAvailable: !!process.env.TAVILY_API_KEY,
    searxngConfigured: !!String(process.env.SEARXNG_BASE_URL || '').trim(),
    searchProviders: ['auto', 'tavily', 'duckduckgo', 'bing', 'sogou', 'baidu', 'searxng'],
  };
}

function aiEndpoint() {
  const base = process.env.AI_BASE_URL || 'https://newapi.shixian.me/v1';
  let url;
  try { url = new URL(base.replace(/\/+$/, '') + '/chat/completions'); } catch (_) { throw new ApiError('AI_BASE_URL 配置无效', 500); }
  if (url.protocol !== 'https:') throw new ApiError('AI_BASE_URL 必须使用 HTTPS', 500);
  return url;
}

function sanitizeMessages(value) {
  if (!Array.isArray(value)) throw new ApiError('messages 必须为数组', 400);
  const messages = value.slice(-60).map((item) => ({
    role: ['system', 'user', 'assistant'].includes(item?.role) ? item.role : 'user',
    content: String(item?.content || '').slice(0, 30000),
  })).filter((x) => x.content.trim());
  const total = messages.reduce((n, x) => n + x.content.length, 0);
  if (!messages.length || total > 120000) throw new ApiError('AI 对话内容为空或过长', 400);
  return messages;
}

async function requestAiStream(body, signal) {
  if (!process.env.AI_API_KEY) throw new ApiError('服务器未配置 AI_API_KEY', 503, { expose: true });
  const endpoint = aiEndpoint();
  const messages = sanitizeMessages(body?.messages);
  const searchContext = String(body?.searchContext || '').slice(0, 30000);
  if (searchContext) messages.splice(Math.max(1, messages.length - 1), 0, { role: 'system', content: `以下是联网搜索结果，仅作为可能不完整的参考；引用时说明来源：\n${searchContext}` });
  let response;
  const request = linkedAbortSignal(
    boundedTimeout(process.env.AI_TIMEOUT, 120_000, 10 * 60_000),
    signal,
    'AI 服务请求超时'
  );
  try {
    response = await outboundFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.AI_API_KEY}` },
      body: JSON.stringify({ model: process.env.AI_MODEL || 'grok-4.6', messages, stream: true }),
      redirect: 'error', signal: request.signal,
    });
  } catch (error) {
    request.cleanup();
    throw outboundError(error, request.signal, signal, 'AI 服务连接');
  }
  if (!response.ok) {
    let text;
    try {
      text = await readResponseText(response, 64 * 1024, 'AI 错误响应', request.signal);
    } catch (error) {
      throw outboundError(error, request.signal, signal, 'AI 服务');
    } finally {
      request.cleanup();
    }
    throw new ApiError(`AI 服务错误（HTTP ${response.status}）：${text.slice(0, 1000)}`, 502);
  }
  if (!response.body) {
    request.cleanup();
    throw new ApiError('AI 服务未返回流', 502);
  }
  responseCleanups.set(response, request.cleanup);
  return response;
}

function cleanupResponse(response) {
  const cleanup = response && responseCleanups.get(response);
  if (cleanup) {
    responseCleanups.delete(response);
    cleanup();
  }
}

function decodeHtml(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, key) => {
    const lower = key.toLowerCase();
    if (lower[0] === '#') {
      const hex = lower[1] === 'x';
      const code = parseInt(lower.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return Object.prototype.hasOwnProperty.call(named, lower) ? named[lower] : all;
  });
}

function plainHtml(value) {
  return decodeHtml(String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function normalizeResultUrl(value, base) {
  try {
    let url = decodeHtml(value).trim();
    if (url.startsWith('//')) url = `https:${url}`;
    const parsed = new URL(url, base);
    if (parsed.hostname.endsWith('duckduckgo.com') && parsed.searchParams.get('uddg')) {
      return new URL(parsed.searchParams.get('uddg')).href;
    }
    return /^https?:$/.test(parsed.protocol) ? parsed.href : '';
  } catch (_) { return ''; }
}

function dedupeResults(rows, limit) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const url = String(row?.url || '').slice(0, 4000);
    const title = plainHtml(row?.title).slice(0, 500);
    const content = plainHtml(row?.content || row?.snippet).slice(0, 4000);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url); out.push({ title, url, content });
    if (out.length >= limit) break;
  }
  return out;
}

async function fetchBoundedText(url, init, signal, limit, label, timeoutMs = 10_000) {
  const request = linkedAbortSignal(timeoutMs, signal, `${label}请求超时`);
  let response;
  try {
    response = await outboundFetch(url, { ...init, signal: request.signal, redirect: 'error' });
    if (!response.ok) throw new ApiError(`${label}错误（HTTP ${response.status}）`, 502);
    return await readResponseText(response, limit, `${label}响应`, request.signal);
  } catch (error) {
    throw outboundError(error, request.signal, signal, label);
  } finally {
    request.cleanup();
    if (response && !response.bodyUsed) {
      try { await response.body?.cancel(); } catch (_) {}
    }
  }
}

async function fetchBoundedJson(url, init, signal, limit, label, timeoutMs = 10_000) {
  return parseJsonText(await fetchBoundedText(url, init, signal, limit, label, timeoutMs), label);
}

async function fetchSearchText(url, signal) {
  return fetchBoundedText(url, {
    headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'Mozilla/5.0 (compatible; JM-Web/1.0)' },
  }, signal, 3_000_000, '搜索服务');
}

function parseAnchoredResults(html, base, blockPattern, linkPattern, limit) {
  const rows = [];
  for (const match of html.matchAll(blockPattern)) {
    const block = match[0];
    const link = linkPattern.exec(block);
    if (!link) continue;
    const url = normalizeResultUrl(link[1], base);
    if (!url) continue;
    const title = plainHtml(link[2]);
    const content = plainHtml(block.replace(link[0], ' '));
    rows.push({ title, url, content });
    if (rows.length >= limit * 3) break;
  }
  return dedupeResults(rows, limit);
}

async function searchTavily(text, options, limit, signal) {
  if (!process.env.TAVILY_API_KEY) throw new ApiError('服务器未配置 TAVILY_API_KEY', 503, { expose: true });
  if (!text) throw new ApiError('搜索内容为空', 400);
  const endpoint = new URL('https://api.tavily.com/search');
  const json = await fetchBoundedJson(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query: text, search_depth: options.depth === 'advanced' ? 'advanced' : 'basic', max_results: limit, include_answer: false }),
  }, signal, SEARCH_RESPONSE_LIMIT, 'Tavily');
  return dedupeResults(json.results || [], limit);
}

async function searchDuckDuckGo(text, limit, signal) {
  const url = new URL('https://html.duckduckgo.com/html/'); url.searchParams.set('q', text);
  const html = await fetchSearchText(url, signal);
  return parseAnchoredResults(html, url, /<div\b[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>/gi,
    /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i, limit);
}

async function searchBing(text, limit, signal) {
  const url = new URL('https://cn.bing.com/search'); url.searchParams.set('q', text); url.searchParams.set('count', String(limit));
  const html = await fetchSearchText(url, signal);
  return parseAnchoredResults(html, url, /<li\b[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>[\s\S]*?<\/li>/gi,
    /<h2[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i, limit);
}

async function searchSogou(text, limit, signal) {
  const url = new URL('https://www.sogou.com/web'); url.searchParams.set('query', text);
  const html = await fetchSearchText(url, signal);
  return parseAnchoredResults(html, url, /<(?:div|li)\b[^>]*class="[^"]*(?:vrwrap|rb|results)[^"]*"[^>]*>[\s\S]*?<\/(?:div|li)>/gi,
    /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i, limit);
}

async function searchBaidu(text, limit, signal) {
  const url = new URL('https://www.baidu.com/s'); url.searchParams.set('wd', text); url.searchParams.set('rn', String(limit));
  const html = await fetchSearchText(url, signal);
  return parseAnchoredResults(html, url, /<div\b[^>]*(?:class="[^"]*result[^"]*"|data-tools=)[^>]*>[\s\S]*?<\/div>/gi,
    /<h3[^>]*>[\s\S]*?<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i, limit);
}

async function searchSearxng(text, options, limit, signal) {
  // 地址只能由部署者配置。浏览器请求体不得把服务器变成任意 HTTPS 代理。
  const raw = String(process.env.SEARXNG_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!raw) throw new ApiError('未配置 SearXNG 地址', 400);
  let url;
  try { url = new URL(`${raw}/search`); } catch (_) { throw new ApiError('SearXNG 地址无效', 400); }
  if (url.protocol !== 'https:') throw new ApiError('SearXNG 地址必须使用 HTTPS', 400);
  url.searchParams.set('q', text); url.searchParams.set('format', 'json');
  url.searchParams.set('language', String(options.searxngLanguage || 'zh-CN').slice(0, 32));
  url.searchParams.set('categories', String(options.searxngCategories || 'general').slice(0, 80));
  const json = await fetchBoundedJson(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'JM-Web/1.0' },
  }, signal, SEARCH_RESPONSE_LIMIT, 'SearXNG');
  return dedupeResults((json.results || []).map((x) => ({ title: x.title, url: x.url, content: x.content })), limit);
}

async function searchWeb(query, rawOptions = {}, signal) {
  const text = String(query || '').trim().slice(0, 1000);
  if (!text) throw new ApiError('搜索内容为空', 400);
  const options = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
  const provider = ['auto', 'tavily', 'duckduckgo', 'bing', 'sogou', 'baidu', 'searxng'].includes(options.provider)
    ? options.provider : 'auto';
  const limit = Math.max(1, Math.min(10, Number(options.resultCount) || 5));
  const total = linkedAbortSignal(SEARCH_TOTAL_TIMEOUT, signal, '联网搜索总时间已超限');
  const run = async (name) => ({ provider: name, results: await ({
    tavily: () => searchTavily(text, options, limit, total.signal), duckduckgo: () => searchDuckDuckGo(text, limit, total.signal),
    bing: () => searchBing(text, limit, total.signal), sogou: () => searchSogou(text, limit, total.signal), baidu: () => searchBaidu(text, limit, total.signal),
    searxng: () => searchSearxng(text, options, limit, total.signal),
  })[name]() });
  if (provider !== 'auto') {
    try { return await run(provider); } finally { total.cleanup(); }
  }
  const order = [
    ...(process.env.TAVILY_API_KEY ? ['tavily'] : []),
    ...(process.env.SEARXNG_BASE_URL ? ['searxng'] : []),
    'duckduckgo', 'bing', 'sogou', 'baidu',
  ];
  const errors = [];
  try {
    for (const name of order) {
      if (total.signal.aborted) throw abortError(total.signal);
      try {
        const result = await run(name);
        if (result.results.length) return result;
        errors.push(`${name}: 无结果`);
      } catch (error) {
        if (total.signal.aborted) throw abortError(total.signal);
        errors.push(`${name}: ${error.message}`);
      }
    }
    throw new ApiError(`所有搜索引擎均不可用：${errors.join('；').slice(0, 1000)}`, 502);
  } finally {
    total.cleanup();
  }
}

function normalizeGithubReleaseUrl(repo, value) {
  const expectedPath = `/${repo}/releases`;
  try {
    const parsedUrl = new URL(String(value || ''));
    if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname.toLowerCase() !== 'github.com'
        || parsedUrl.username || parsedUrl.password
        || (parsedUrl.pathname !== expectedPath && !parsedUrl.pathname.startsWith(`${expectedPath}/`))) return '';
    return parsedUrl.href;
  } catch (_) {
    return '';
  }
}

async function checkUpdate(signal) {
  const currentVersion = pkg.version || '1.0.0';
  const repo = String(process.env.JMW_UPDATE_REPO || '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    return { currentVersion, available: false, latestVersion: currentVersion, message: '未配置 JMW_UPDATE_REPO；容器部署请通过镜像或 Git 更新。', url: '' };
  }
  try {
    const endpoint = new URL(`https://api.github.com/repos/${repo}/releases/latest`);
    const json = await fetchBoundedJson(endpoint, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'jm-web-update-check' },
    }, signal, UPDATE_RESPONSE_LIMIT, '更新检查', 10_000);
    const latestVersion = String(json.tag_name || '').replace(/^v/i, '') || currentVersion;
    const parts = (x) => x.split(/[.-]/).map((v) => Number(v) || 0);
    const a = parts(latestVersion), b = parts(currentVersion);
    let available = false;
    for (let i = 0; i < Math.max(a.length, b.length); i++) { if ((a[i] || 0) !== (b[i] || 0)) { available = (a[i] || 0) > (b[i] || 0); break; } }
    const releaseUrl = normalizeGithubReleaseUrl(repo, json.html_url);
    return {
      currentVersion,
      latestVersion,
      available,
      message: String(json.name || json.body || '').slice(0, 500),
      url: releaseUrl || `https://github.com/${repo}/releases`,
    };
  } catch (error) {
    if (signal && signal.aborted) throw abortError(signal);
    // 更新检查是可选的后台能力。上游 DNS/TLS/响应内容可能包含内部主机名、
    // 代理细节或第三方原始文本，不能把 error.message 作为 200 响应的 message
    // 返回给浏览器；详细原因只保留在受控的服务端日志中。
    console.error('[update] 检查失败:', error);
    addLog('warn', '更新检查失败');
    return {
      currentVersion,
      latestVersion: currentVersion,
      available: false,
      message: '更新检查暂时不可用，请稍后重试。',
      url: `https://github.com/${repo}/releases`,
    };
  }
}

module.exports = {
  addLog, getLogs, clearLogs,
  getDohState, setDohState, dohLookup, outboundFetch, testDoh, hasUsableIpv6,
  aiConfig, requestAiStream, cleanupResponse, searchWeb, checkUpdate, normalizeGithubReleaseUrl,
};
