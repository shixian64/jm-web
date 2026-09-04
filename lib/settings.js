'use strict';
/**
 * 服务器全局设置（data/settings.json）：自定义 API 域名、
 * 运行中发现的新图片域名（chapter HTML 的 imghost）等。
 *
 * 环境变量 JM_API_BASE 指定的域名仅保存在内存（锁定、不可通过接口修改）；
 * /api/config/api-host 的切换保存在各浏览器会话（jar.apiHost）中，互不影响。
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const { BUILTIN_API_HOSTS, BUILTIN_IMAGE_HOSTS } = require('./jm-api');

const DATA_DIR = process.env.JMW_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'settings.json');

const EXTRA_IMAGE_HOST_LIMIT = 12;

const defaults = {
  apiHost: '', // '' = 自动（管理员级全局默认，一般留空）
  customApiHosts: [], // 用户在设置页添加的自定义 API 域名
  extraImageHosts: [], // 从章节 HTML/远端设置中学习到的图片域名
  imgHost: '', // 远端 setting 接口返回的 img_host
};

function unsafeIPv4(ip) {
  const p = ip.split('.').map(Number);
  const [a, b, c] = p;
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
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

function unsafeIPv6(ip) {
  const b = ipv6Bytes(ip);
  if (!b) return true;
  const allZero = b.every((x) => x === 0);
  const loopback = b.slice(0, 15).every((x) => x === 0) && b[15] === 1;
  const mappedV4 = b.slice(0, 10).every((x) => x === 0) && b[10] === 255 && b[11] === 255;
  return (
    allZero || loopback || mappedV4 ||
    (b[0] & 0xfe) === 0xfc ||                 // fc00::/7
    (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) || // fe80::/10
    b[0] === 0xff ||                           // multicast
    (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) // documentation
  );
}

function unsafeHostname(hostname) {
  let host = String(hostname || '').toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host || host.endsWith('.')) return true;
  if (host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal') ||
      host.endsWith('.lan') || host.endsWith('.home') || host.endsWith('.home.arpa')) return true;
  const kind = net.isIP(host);
  if (kind === 4) return unsafeIPv4(host);
  if (kind === 6) return unsafeIPv6(host);
  // 拒绝单标签主机名（可能通过 DNS search suffix 指向内网）及非标准 label。
  const labels = host.split('.');
  return labels.length < 2 || labels.some((x) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x));
}

/**
 * 规范化远程服务 origin。仅允许 HTTPS、无路径/查询/用户信息、非本地/私网字面量。
 * 浏览器提交的 API Host 还必须在 trustedApiHosts() 精确白名单中，
 * 不允许攻击者提交可控 DNS 名称，从根源上避免 DNS rebinding。
 */
function normalizeHost(host) {
  if (!host || typeof host !== 'string') return '';
  host = host.trim();
  if (!host) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) host = 'https://' + host;
  try {
    const u = new URL(host);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return '';
    if (u.pathname !== '/' && u.pathname !== '') return '';
    if (unsafeHostname(u.hostname)) return '';
    return u.origin;
  } catch (_) {
    return '';
  }
}

function sanitizeList(value, limit) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((x) => normalizeHost(x)).filter(Boolean))].slice(-limit);
}

// 章节 HTML 的 imghost 属于上游可变输入，不能借一次响应把任意公网域名
// 永久加入出站白名单。只接受当前 JM 图片线路使用的、可审计的主机命名模式；
// 新线路需先更新此处并经过发布审核。内置列表始终直接受信。
function isKnownImageHost(host) {
  const normalized = normalizeHost(host);
  if (!normalized) return false;
  if (BUILTIN_IMAGE_HOSTS.map((x) => normalizeHost(x)).includes(normalized)) return true;
  let hostname;
  try { hostname = new URL(normalized).hostname.toLowerCase(); } catch (_) { return false; }
  return /^(?:cdn-msp\d*|tencent)\.jmapiproxy\d+\.cc$/.test(hostname)
    || /^cdn-msp\d*\.jmapinodeudzn\.net$/.test(hostname)
    || /^(?:cdn-msp\d*|tencent)\.jmdanjonproxy\.(?:vip|xyz)$/.test(hostname);
}

function sanitizeImageList(value, limit) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((x) => normalizeHost(x)).filter((host) => host && isKnownImageHost(host)))].slice(-limit);
}

function sanitizeData(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  return {
    apiHost: normalizeHost(raw.apiHost),
    // 仅为兼容旧文件保留；不再将其当作可请求的 API 信任来源。
    customApiHosts: sanitizeList(raw.customApiHosts, 20),
    extraImageHosts: sanitizeImageList(raw.extraImageHosts, EXTRA_IMAGE_HOST_LIMIT),
    imgHost: isKnownImageHost(raw.imgHost) ? normalizeHost(raw.imgHost) : '',
  };
}

let data = load();

function load() {
  try {
    return sanitizeData(Object.assign({}, defaults, JSON.parse(fs.readFileSync(FILE, 'utf8'))));
  } catch (_) {
    return sanitizeData(defaults);
  }
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeNow();
  }, 200);
}

function writeNow() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error('[settings] 保存失败:', e.message);
  }
}

/** 进程退出前同步落盘 */
function flushNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  writeNow();
}

/* ---- 环境变量锁定的 API 域名（仅内存，不持久化） ---- */
let envApiHosts = null;
function setEnvApiHosts(hosts) {
  const safe = sanitizeList(hosts, 20);
  envApiHosts = safe.length ? safe : null;
}
function isApiHostLocked() {
  return !!envApiHosts;
}

/** 受信 API origin：管理员环境变量（锁定）或内置候选。 */
function trustedApiHosts() {
  if (envApiHosts) return [...envApiHosts];
  return BUILTIN_API_HOSTS.map((x) => normalizeHost(x)).filter(Boolean);
}

function builtinApiHosts() {
  return BUILTIN_API_HOSTS.map((x) => normalizeHost(x)).filter(Boolean);
}

function isTrustedApiHost(host) {
  const normalized = normalizeHost(host);
  return !!normalized && trustedApiHosts().includes(normalized);
}

/** API 域名候选列表：环境变量锁定 > 会话在受信列表内的排序 > 内置 */
function apiHosts(jarApiHost) {
  const all = trustedApiHosts();
  const requested = normalizeHost(jarApiHost) || normalizeHost(data.apiHost);
  const cur = isTrustedApiHost(requested) ? requested : '';
  if (cur && !envApiHosts) {
    const idx = all.indexOf(cur);
    if (idx === -1) return [cur, ...all];
    all.splice(idx, 1);
    return [cur, ...all];
  }
  return all;
}

/**
 * 对齐移动端的三种数据源，但使用 Web 服务端可执行的等价路由：
 * - builtin：项目内置、随版本维护的直连域名池；
 * - network：管理员 JM_API_BASE（或当前会话选中的单一线路）；
 * - mixed：网络线路优先，失败后回退内置域名池。
 *
 * 浏览器只能提交枚举值，不能借此注入任意出站地址。
 */
function normalizeDataSource(value) {
  return ['builtin', 'network', 'mixed'].includes(value) ? value : 'mixed';
}

function apiHostsForSource(value, jarApiHost) {
  // JM_API_BASE 是部署者的强制出站边界，而不只是“首选线路”。锁定后
  // builtin/mixed 也不得绕过它回退到内置 origin；若会话已记录某条锁定
  // 线路，则把它排在首位，确保登录成功后按精确 origin 继续发送 AVS。
  if (envApiHosts) {
    const requested = normalizeHost(jarApiHost) || normalizeHost(data.apiHost);
    const idx = requested ? envApiHosts.indexOf(requested) : -1;
    if (idx > 0) return [requested, ...envApiHosts.slice(0, idx), ...envApiHosts.slice(idx + 1)];
    return [...envApiHosts];
  }
  const source = normalizeDataSource(value);
  const builtins = builtinApiHosts();
  const requested = normalizeHost(jarApiHost) || normalizeHost(data.apiHost);
  const requestedBuiltin = requested && builtins.includes(requested) ? requested : '';
  const orderedBuiltins = requestedBuiltin
    ? [requestedBuiltin, ...builtins.filter((host) => host !== requestedBuiltin)]
    : builtins;
  const network = [requestedBuiltin || builtins[0]].filter(Boolean);
  if (source === 'builtin') return orderedBuiltins;
  if (source === 'network') return network;
  return [...new Set([...network, ...orderedBuiltins])];
}

function allDataSourceHosts() {
  return envApiHosts ? [...envApiHosts] : builtinApiHosts();
}

/** 图片域名列表（内置 + 学习到的），当前可用的排前面 */
let preferredImageHost = '';
function imageHosts() {
  const extras = [...new Set([...data.extraImageHosts, ...(data.imgHost ? [data.imgHost] : [])])];
  const builtins = BUILTIN_IMAGE_HOSTS.map((x) => normalizeHost(x)).filter(Boolean);
  const all = [...new Set([...extras, ...builtins])];
  if (preferredImageHost) {
    const idx = all.indexOf(preferredImageHost);
    if (idx > 0) {
      all.splice(idx, 1);
      all.unshift(preferredImageHost);
    }
  }
  return all;
}

function addImageHost(host) {
  host = normalizeHost(host);
  if (!host || !isKnownImageHost(host)) return false;
  data.extraImageHosts = Array.isArray(data.extraImageHosts) ? data.extraImageHosts : [];
  if (!data.extraImageHosts.includes(host) && !BUILTIN_IMAGE_HOSTS.includes(host)) {
    data.extraImageHosts.push(host);
    // 上限保护：白名单不会被上游无限扩张
    while (data.extraImageHosts.length > EXTRA_IMAGE_HOST_LIMIT) data.extraImageHosts.shift();
    save();
    return true;
  }
  return false;
}

module.exports = {
  get: () => data,
  set(patch) {
    data = sanitizeData(Object.assign({}, data, patch));
    save();
  },
  setPreferredImageHost(host) {
    const normalized = normalizeHost(String(host || ''));
    // 线路偏好只接受当前白名单中的 origin；不要让一个调用方错误地把
    // 任意域名写入内存排序状态并在后续请求中优先使用。
    if (normalized && imageHosts().includes(normalized)) preferredImageHost = normalized;
  },
  getPreferredImageHost: () => preferredImageHost,
  apiHosts,
  apiHostsForSource,
  allDataSourceHosts,
  normalizeDataSource,
  trustedApiHosts,
  isTrustedApiHost,
  imageHosts,
  addImageHost,
  normalizeHost,
  isKnownImageHost,
  setEnvApiHosts,
  isApiHostLocked,
  flushNow,
  DATA_DIR,
};
