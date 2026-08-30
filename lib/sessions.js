'use strict';
/**
 * 会话（Cookie Jar）管理：每个浏览器一个 jar，登录后的 AVS 等 cookie
 * 与用户信息持久化在 data/sessions/ 下，服务重启不丢登录态。
 *
 * 内存缓存有上限（LRU 按最近使用驱逐，驱逐前落盘）；
 * 空会话（未登录且无 cookie）7 天过期，登录会话 90 天过期；
 * 空会话文件总量超限时优先删除最旧的空会话，防止磁盘无限膨胀。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.JMW_DATA_DIR || path.join(__dirname, '..', 'data');
const SESSION_DIR = path.join(DATA_DIR, 'sessions');

if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

const CACHE_LIMIT = 800;      // 内存中最多缓存的 jar 数
const FILE_LIMIT = 2000;      // 磁盘上最多保留的会话文件数
const EMPTY_LIMIT = 7 * 24 * 3600 * 1000;   // 空会话过期时间
const USER_LIMIT = 90 * 24 * 3600 * 1000;   // 登录会话过期时间

const cache = new Map(); // sid -> { jar, lastSeen }
const pendingSave = new Map(); // sid -> timer
let fileCount = 0;
let writesSincePrune = 0;

function sanitizeCookies(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [name, raw] of Object.entries(value).slice(0, 64)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name)) continue;
    const val = String(raw);
    if (val.length <= 4096 && !/[\r\n]/.test(val)) out[name] = val;
  }
  return out;
}

function sanitizeJar(sid, raw) {
  return {
    sid,
    cookies: sanitizeCookies(raw && raw.cookies),
    user: raw && raw.user && typeof raw.user === 'object' && !Array.isArray(raw.user) ? raw.user : null,
    apiHost: raw && typeof raw.apiHost === 'string' ? raw.apiHost.slice(0, 2048) : '',
    destroyed: false,
  };
}

function newSid() {
  return crypto.randomBytes(16).toString('hex');
}

function touch(sid) {
  const hit = cache.get(sid);
  if (hit) hit.lastSeen = Date.now();
  return hit;
}

function evictOldest() {
  let oldestSid = null, oldestTime = Infinity;
  for (const [sid, hit] of cache) {
    if (hit.lastSeen < oldestTime) { oldestTime = hit.lastSeen; oldestSid = sid; }
  }
  if (oldestSid) {
    const hit = cache.get(oldestSid);
    try { saveJar(hit.jar); } catch (_) {}
    const timer = pendingSave.get(oldestSid);
    if (timer) { clearTimeout(timer); pendingSave.delete(oldestSid); }
    cache.delete(oldestSid);
  }
}

function loadJar(sid) {
  if (!/^[a-f0-9]{32}$/.test(sid)) return null;
  const hit = touch(sid);
  if (hit) return hit.jar;
  const file = path.join(SESSION_DIR, `${sid}.json`);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const jar = sanitizeJar(sid, raw);
    if (cache.size >= CACHE_LIMIT) evictOldest();
    cache.set(sid, { jar, lastSeen: Date.now() });
    return jar;
  } catch (_) {
    // 损坏的会话文件不应永久占用容量。
    try {
      if (fs.existsSync(file)) {
        fs.rmSync(file, { force: true });
        fileCount = Math.max(0, fileCount - 1);
      }
    } catch (_) {}
    return null;
  }
}

function createJar() {
  const jar = { sid: newSid(), cookies: {}, user: null, apiHost: '', destroyed: false };
  if (cache.size >= CACHE_LIMIT) evictOldest();
  cache.set(jar.sid, { jar, lastSeen: Date.now() });
  scheduleSave(jar);
  return jar;
}

function scheduleSave(jar) {
  if (!jar || jar.destroyed) return;
  if (pendingSave.has(jar.sid)) clearTimeout(pendingSave.get(jar.sid));
  pendingSave.set(
    jar.sid,
    setTimeout(() => {
      pendingSave.delete(jar.sid);
      saveJar(jar);
    }, 300)
  );
}

function saveJar(jar) {
  if (!jar || jar.destroyed || !/^[a-f0-9]{32}$/.test(jar.sid)) return;
  const file = path.join(SESSION_DIR, `${jar.sid}.json`);
  const tmp = `${file}.tmp`;
  try {
    const existed = fs.existsSync(file);
    fs.writeFileSync(tmp, JSON.stringify({ cookies: jar.cookies, user: jar.user, apiHost: jar.apiHost || '' }));
    fs.renameSync(tmp, file);
    if (!existed) fileCount++;
    writesSincePrune++;
    // 批量修剪，避免攻击流量下每新建一个文件就扫描整个目录。
    if (fileCount > FILE_LIMIT && writesSincePrune >= 25) pruneSessionFiles();
  } catch (e) {
    console.error('[session] 保存失败:', e.message);
  }
}

/** 进程退出前同步落盘所有缓存中的会话 */
function flushAll() {
  for (const timer of pendingSave.values()) clearTimeout(timer);
  pendingSave.clear();
  for (const hit of cache.values()) saveJar(hit.jar);
  pruneSessionFiles();
}

function destroyJar(sid) {
  const hit = cache.get(sid);
  if (hit) {
    hit.jar.destroyed = true;
    hit.jar.cookies = {};
    hit.jar.user = null;
    hit.jar.apiHost = '';
    cache.delete(sid);
  }
  const timer = pendingSave.get(sid);
  if (timer) { clearTimeout(timer); pendingSave.delete(sid); }
  try {
    const file = path.join(SESSION_DIR, `${sid}.json`);
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      fileCount = Math.max(0, fileCount - 1);
    }
  } catch (_) {}
}

function sidFromFile(file) {
  const m = /^([a-f0-9]{32})\.json$/.exec(file);
  return m ? m[1] : '';
}

function removeEntry(entry) {
  // 正在内存中使用的会话不在后台清理中删除，避免 flushAll 将其复活。
  if (entry.sid && cache.has(entry.sid)) return false;
  const timer = entry.sid && pendingSave.get(entry.sid);
  if (timer) {
    clearTimeout(timer);
    pendingSave.delete(entry.sid);
  }
  try {
    fs.rmSync(entry.full, { force: true });
    return true;
  } catch (_) {
    return false;
  }
}

function pruneSessionFiles() {
  let files;
  try {
    files = fs.readdirSync(SESSION_DIR);
  } catch (_) {
    return;
  }
  const entries = [];
  for (const f of files) {
    const sid = sidFromFile(f);
    if (!sid) continue;
    const full = path.join(SESSION_DIR, f);
    try {
      const st = fs.statSync(full);
      let empty = false;
      try {
        const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
        empty = (!raw.user && (!raw.cookies || !Object.keys(raw.cookies).length));
      } catch (_) {
        empty = true; // 无法解析的文件视作空会话
      }
      entries.push({ sid, full, mtime: st.mtimeMs, empty });
    } catch (_) {}
  }
  const now = Date.now();
  for (const it of entries) {
    const limit = it.empty ? EMPTY_LIMIT : USER_LIMIT;
    if (now - it.mtime > limit) {
      if (removeEntry(it)) it.removed = true;
    }
  }
  // 文件总量超限：先删最旧空会话，仍不足时删最旧非活跃会话。
  const alive = entries.filter((it) => !it.removed);
  if (alive.length > FILE_LIMIT) {
    const candidates = alive
      .filter((it) => !cache.has(it.sid))
      .sort((a, b) => Number(a.empty) === Number(b.empty) ? a.mtime - b.mtime : Number(b.empty) - Number(a.empty));
    let excess = alive.length - FILE_LIMIT;
    for (const it of candidates) {
      if (excess <= 0) break;
      if (removeEntry(it)) {
        it.removed = true;
        excess--;
      }
    }
  }
  fileCount = entries.reduce((n, it) => n + (it.removed ? 0 : 1), 0);
  writesSincePrune = 0;
}

pruneSessionFiles();
setInterval(pruneSessionFiles, 24 * 3600 * 1000).unref();

module.exports = { loadJar, createJar, scheduleSave, saveJar, flushAll, destroyJar, DATA_DIR };
