'use strict';
/**
 * 会话（Cookie Jar）管理：每个浏览器一个 jar，登录后的 AVS 等 cookie
 * 与用户信息持久化在 data/sessions/ 下，服务重启不丢登录态。
 *
 * 内存缓存有上限（LRU 按最近使用驱逐，驱逐前落盘）；
 * 空会话（未登录且无 cookie）7 天过期，登录会话默认 365 天过期；
 * 空会话文件总量超限时优先删除最旧的空会话，防止磁盘无限膨胀。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.JMW_DATA_DIR || path.join(__dirname, '..', 'data');
const SESSION_DIR = path.join(DATA_DIR, 'sessions');

if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
// 登录 Cookie 属敏感数据；在支持 POSIX 权限的平台收紧已有目录，新建文件
// 也显式使用 0600。Windows/部分挂载不支持时保持可用并由目录 ACL 管理。
try { fs.chmodSync(SESSION_DIR, 0o700); } catch (_) {}

const CACHE_LIMIT = 800;      // 内存中最多缓存的 jar 数
const FILE_LIMIT = 2000;      // 磁盘上最多保留的会话文件数
const EMPTY_LIMIT = 7 * 24 * 3600 * 1000;   // 空会话过期时间
function sessionTtlMs() {
  const fallback = 365 * 24 * 3600;
  const raw = Number(process.env.JMW_SESSION_TTL_SECONDS);
  const seconds = Number.isFinite(raw) ? Math.max(7 * 24 * 3600, Math.min(2 * 365 * 24 * 3600, Math.floor(raw))) : fallback;
  return seconds * 1000;
}
const USER_LIMIT = sessionTtlMs();   // 登录会话过期时间
const MAX_USER_STATE_BYTES = 256 * 1024;
const MAX_SESSION_FILE_BYTES = 2 * 1024 * 1024;
const MIGRATION_LOCK_STALE_MS = 30 * 60 * 1000;
const MIGRATION_LOCK_FILE = '.sanitize.lock';
// JM 登录响应中的 s/jwttoken 是认证凭据，不是展示资料。任何层级出现这些
// 字段都不得写入会话文件或通过 /api/me 返回给浏览器。
const PRIVATE_USER_FIELDS = new Set([
  's', 'jwttoken', 'token', 'access_token', 'refresh_token',
  'accesstoken', 'refreshtoken', 'password', 'passwd', 'cookie', 'cookies',
]);

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

function sanitizeCookieStores(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [rawOrigin, cookies] of Object.entries(value).slice(0, 32)) {
    try {
      const url = new URL(rawOrigin);
      if (url.protocol !== 'https:' || url.username || url.password || url.origin !== rawOrigin) continue;
      const safe = sanitizeCookies(cookies);
      if (Object.keys(safe).length) out[url.origin] = safe;
    } catch (_) {}
  }
  return out;
}

/**
 * 上游登录对象会常驻内存并写入磁盘。响应体虽然已有总上限，但仍不能允许
 * 单个会话用数 MiB 的异常对象长期占据 LRU；同时借 JSON 往返去掉原型和
 * 非 JSON 值。正常用户资料远小于该上限。
 */
function sanitizeUser(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const text = JSON.stringify(value);
    if (!text || Buffer.byteLength(text) > MAX_USER_STATE_BYTES) return null;
    const parsed = JSON.parse(text);
    const scrub = (item) => {
      if (Array.isArray(item)) return item.map(scrub);
      if (!item || typeof item !== 'object') return item;
      const out = {};
      for (const [key, child] of Object.entries(item)) {
        if (PRIVATE_USER_FIELDS.has(String(key).toLowerCase())) continue;
        out[key] = scrub(child);
      }
      return out;
    };
    const clean = scrub(parsed);
    if (!clean || typeof clean !== 'object' || Array.isArray(clean)) return null;
    if (Buffer.byteLength(JSON.stringify(clean)) > MAX_USER_STATE_BYTES) return null;
    return clean;
  } catch (_) {
    return null;
  }
}

/** 清除失效的 JM 登录状态，但保留非认证 Cookie 和本地收藏夹。 */
function clearUpstreamAuth(jar) {
  if (!jar || typeof jar !== 'object') return false;
  let changed = !!jar.user || !!jar.apiHost;
  jar.user = null;
  jar.apiHost = '';
  if (jar.cookiesByOrigin && typeof jar.cookiesByOrigin === 'object' && !Array.isArray(jar.cookiesByOrigin)) {
    for (const [origin, cookies] of Object.entries(jar.cookiesByOrigin)) {
      if (!cookies || typeof cookies !== 'object' || Array.isArray(cookies)) continue;
      if (Object.prototype.hasOwnProperty.call(cookies, 'AVS')) {
        delete cookies.AVS;
        changed = true;
      }
      if (!Object.keys(cookies).length) delete jar.cookiesByOrigin[origin];
    }
  }
  if (changed) scheduleSave(jar);
  return changed;
}

function hasUpstreamAuth(jar) {
  if (!jar || !jar.cookiesByOrigin || typeof jar.cookiesByOrigin !== 'object' || Array.isArray(jar.cookiesByOrigin)) return false;
  return Object.values(jar.cookiesByOrigin).some((cookies) =>
    cookies && typeof cookies === 'object' && typeof cookies.AVS === 'string' && cookies.AVS.length > 0
  );
}

function sanitizeJar(sid, raw) {
  // 本地收藏夹 ID 由毫秒时间戳与随机后缀组成，当前通常为 13~16 位。
  // 这里不能沿用漫画 ID 的 12 位上限，否则重启后刚创建的收藏夹及映射会被清空。
  const folders = Array.isArray(raw && raw.favoriteFolders) ? raw.favoriteFolders
    .filter((x) => x && /^\d{1,20}$/.test(String(x.id)) && typeof x.name === 'string')
    .map((x) => ({ id: String(x.id), name: x.name.slice(0, 60) })).slice(0, 100) : [];
  const folderMap = {};
  if (raw && raw.favoriteFolderMap && typeof raw.favoriteFolderMap === 'object') {
    for (const [aid, folderId] of Object.entries(raw.favoriteFolderMap).slice(0, 10000)) {
      if (/^\d{1,12}$/.test(aid) && /^\d{1,20}$/.test(String(folderId))) folderMap[aid] = String(folderId);
    }
  }
  return {
    sid,
    // Cookie 必须按 origin 隔离。旧版扁平 cookies 无法可靠判断来源，升级时
    // 有意不迁移，避免把自定义 API 的凭证发送给内置线路（反向同理）。
    cookiesByOrigin: sanitizeCookieStores(raw && raw.cookiesByOrigin),
    user: sanitizeUser(raw && raw.user),
    apiHost: raw && typeof raw.apiHost === 'string' ? raw.apiHost.slice(0, 2048) : '',
    favoriteFolders: folders,
    favoriteFolderMap: folderMap,
    hiddenHistory: Array.isArray(raw && raw.hiddenHistory) ? raw.hiddenHistory.map(String).filter((x) => /^\d{1,12}$/.test(x)).slice(-5000) : [],
    destroyed: false,
    retired: false,
    activeUses: 0,
  };
}

function persistedJar(jar) {
  // 保存路径也必须经过同一套边界校验；不能因为对象来自内存而绕过收藏夹、
  // 历史记录和用户资料的大小/字段限制（例如异常上游响应或恶意请求反复追加）。
  const clean = sanitizeJar(jar && jar.sid, jar || {});
  return {
    cookiesByOrigin: clean.cookiesByOrigin,
    user: clean.user,
    apiHost: clean.apiHost,
    favoriteFolders: clean.favoriteFolders,
    favoriteFolderMap: clean.favoriteFolderMap,
    hiddenHistory: clean.hiddenHistory,
  };
}

function fsyncDirectory(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch (_) {
    // Windows、部分网络卷和特殊文件系统不允许 fsync 目录；文件本身仍已同步。
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }
}

function sameFileVersion(file, expected) {
  if (!expected) return true;
  try {
    const current = fs.lstatSync(file);
    return current.isFile() && !current.isSymbolicLink()
      && current.dev === expected.dev && current.ino === expected.ino
      && current.size === expected.size && current.mtimeMs === expected.mtimeMs;
  } catch (_) {
    return false;
  }
}

/**
 * 在目标文件所在目录写入唯一临时文件，完成 fsync 后原子替换。expected 用于
 * 启动迁移：若旧进程在扫描期间更新了 Session，则放弃本次替换，避免覆盖新状态。
 */
function atomicWriteSession(file, text, { expected = null, atime = null, mtime = null } = {}) {
  const dir = path.dirname(file);
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  let fd;
  let renamed = false;
  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    fd = fs.openSync(
      tmp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    fs.writeFileSync(fd, text, 'utf8');
    try { fs.fchmodSync(fd, 0o600); } catch (_) {}
    fs.fsyncSync(fd);
    if (atime instanceof Date && mtime instanceof Date) {
      try {
        fs.futimesSync(fd, atime, mtime);
        fs.fsyncSync(fd);
      } catch (_) {}
    }
    fs.closeSync(fd);
    fd = undefined;
    if (!sameFileVersion(file, expected)) return { written: false, conflict: true };
    fs.renameSync(tmp, file);
    renamed = true;
    try { fs.chmodSync(file, 0o600); } catch (_) {}
    fsyncDirectory(dir);
    return { written: true, conflict: false };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
    if (!renamed) try { fs.rmSync(tmp, { force: true }); } catch (_) {}
  }
}

function acquireMigrationLock(sessionDir) {
  const lock = path.join(sessionDir, MIGRATION_LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      const noFollow = fs.constants.O_NOFOLLOW || 0;
      fd = fs.openSync(
        lock,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
        0o600,
      );
      fs.writeFileSync(fd, `${process.pid} ${Date.now()}\n`, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      return () => {
        try { fs.rmSync(lock, { force: true }); } catch (_) {}
        fsyncDirectory(sessionDir);
      };
    } catch (error) {
      if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
      if (!error || error.code !== 'EEXIST') return null;
      // 崩溃可能遗留锁。只回收足够老且仍为普通文件的锁；活跃锁或可疑
      // symlink 一律跳过，避免两个进程同时迁移。
      try {
        const stat = fs.lstatSync(lock);
        if (attempt === 0 && stat.isFile() && !stat.isSymbolicLink()
            && Date.now() - stat.mtimeMs > MIGRATION_LOCK_STALE_MS) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch (_) {}
      return null;
    }
  }
  return null;
}

/** 启动时全量脱敏旧 Session。损坏、过大或扫描期间变化的文件保持原样。 */
function migrateSessionFiles(sessionDir = SESSION_DIR) {
  const result = {
    scanned: 0, migrated: 0, unchanged: 0, invalid: 0, conflicts: 0, errors: 0, locked: false,
  };
  let releaseLock;
  try {
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    releaseLock = acquireMigrationLock(sessionDir);
    if (!releaseLock) {
      result.locked = true;
      return result;
    }
    const files = fs.readdirSync(sessionDir);
    for (const name of files) {
      const sid = sidFromFile(name);
      if (!sid) continue;
      result.scanned++;
      const file = path.join(sessionDir, name);
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SESSION_FILE_BYTES) {
          result.invalid++;
          continue;
        }
        let raw;
        try {
          raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (_) {
          result.invalid++;
          continue;
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          result.invalid++;
          continue;
        }
        const clean = persistedJar(sanitizeJar(sid, raw));
        const serialized = JSON.stringify(clean);
        if (JSON.stringify(raw) === serialized) {
          try { fs.chmodSync(file, 0o600); } catch (_) {}
          result.unchanged++;
          continue;
        }
        const write = atomicWriteSession(file, serialized, {
          expected: stat,
          atime: stat.atime,
          mtime: stat.mtime,
        });
        if (write.conflict) result.conflicts++;
        else if (write.written) result.migrated++;
      } catch (_) {
        result.errors++;
      }
    }
    return result;
  } catch (_) {
    result.errors++;
    return result;
  } finally {
    if (releaseLock) releaseLock();
  }
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
    // 异步请求返回后还会写入 jar，正在使用的对象不得被驱逐。
    if ((hit.jar.activeUses || 0) > 0) continue;
    if (hit.lastSeen < oldestTime) { oldestTime = hit.lastSeen; oldestSid = sid; }
  }
  if (oldestSid) {
    const hit = cache.get(oldestSid);
    try { saveJar(hit.jar); } catch (_) {}
    const timer = pendingSave.get(oldestSid);
    if (timer) { clearTimeout(timer); pendingSave.delete(oldestSid); }
    // 即使调用方忘了 retain，被驱逐的旧引用也不能在 logout 后复活文件。
    hit.jar.retired = true;
    cache.delete(oldestSid);
    return true;
  }
  return false;
}

function trimCache(maxSize = CACHE_LIMIT) {
  while (cache.size > maxSize) {
    // 全部在用时允许暂时超额，release 时再回收。
    if (!evictOldest()) break;
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
    // 兼容旧版本已经落盘的 s/jwttoken：首次加载时立即安排脱敏写回，
    // 不需要迁移脚本，也不会把生产 data 目录覆盖成测试数据。
    try {
      const rawUser = raw && raw.user;
      const cleanUser = jar.user;
      if (rawUser && JSON.stringify(rawUser) !== JSON.stringify(cleanUser)) scheduleSave(jar);
    } catch (_) {}
    trimCache(CACHE_LIMIT - 1);
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
  const jar = {
    sid: newSid(), cookiesByOrigin: {}, user: null, apiHost: '', favoriteFolders: [], favoriteFolderMap: {}, hiddenHistory: [],
    destroyed: false, retired: false, activeUses: 0,
  };
  trimCache(CACHE_LIMIT - 1);
  cache.set(jar.sid, { jar, lastSeen: Date.now() });
  scheduleSave(jar);
  return jar;
}

function scheduleSave(jar) {
  if (!jar || jar.destroyed || jar.retired) return;
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
  if (!jar || jar.destroyed || jar.retired || !/^[a-f0-9]{32}$/.test(jar.sid)) return;
  const file = path.join(SESSION_DIR, `${jar.sid}.json`);
  try {
    const existed = fs.existsSync(file);
    atomicWriteSession(file, JSON.stringify(persistedJar(jar)));
    if (!existed) fileCount++;
    writesSincePrune++;
    // 批量修剪，避免攻击流量下每新建一个文件就扫描整个目录。
    if (fileCount > FILE_LIMIT && writesSincePrune >= 25) pruneSessionFiles();
  } catch (e) {
    console.error('[session] 保存失败:', e.message);
  }
}

/** 请求处理期间保护 jar 不被 LRU 驱逐。 */
function retainJar(jar) {
  if (!jar || jar.destroyed || jar.retired) return false;
  jar.activeUses = Math.max(0, Number(jar.activeUses) || 0) + 1;
  return true;
}

function releaseJar(jar) {
  if (!jar) return;
  jar.activeUses = Math.max(0, (Number(jar.activeUses) || 0) - 1);
  trimCache(CACHE_LIMIT);
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
    hit.jar.retired = true;
    hit.jar.cookiesByOrigin = {};
    hit.jar.user = null;
    hit.jar.apiHost = '';
    hit.jar.favoriteFolders = [];
    hit.jar.favoriteFolderMap = {};
    hit.jar.hiddenHistory = [];
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
        const stores = raw.cookiesByOrigin && typeof raw.cookiesByOrigin === 'object'
          ? Object.values(raw.cookiesByOrigin) : [];
        empty = (!raw.user && !stores.some((cookies) => cookies && Object.keys(cookies).length));
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

const startupMigration = migrateSessionFiles();
if (startupMigration.migrated || startupMigration.invalid || startupMigration.conflicts || startupMigration.errors) {
  console.log(
    `[session] 启动脱敏扫描: scanned=${startupMigration.scanned} migrated=${startupMigration.migrated}`
    + ` unchanged=${startupMigration.unchanged} invalid=${startupMigration.invalid}`
    + ` conflicts=${startupMigration.conflicts} errors=${startupMigration.errors}`,
  );
}
pruneSessionFiles();
setInterval(pruneSessionFiles, 24 * 3600 * 1000).unref();

module.exports = {
  loadJar, createJar, retainJar, releaseJar, scheduleSave, saveJar,
  flushAll, destroyJar, sanitizeUser, clearUpstreamAuth, hasUpstreamAuth,
  migrateSessionFiles, DATA_DIR,
};
