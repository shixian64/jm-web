// 离线资料库（IndexedDB）与零网络阅读器。
//
// 这个模块刻意不依赖 app.js/views.js：路由层只需调用 mountOfflineReader，
// 下载模块和导出模块则复用下面的持久化 API。

export const OFFLINE_DB_NAME = 'jm-web-offline';
export const OFFLINE_DB_VERSION = 1;

const STORE_ALBUMS = 'albums';
const STORE_CHAPTERS = 'chapters';
const STORE_IMAGES = 'images';
const STORE_TASKS = 'tasks';
const ALL_STORES = [STORE_ALBUMS, STORE_CHAPTERS, STORE_IMAGES, STORE_TASKS];
const OFFLINE_LIBRARY_LOCK = 'jmw:offline-library:v1';
const OFFLINE_AID_LOCK_PREFIX = 'jmw:offline-aid:v1:';
const OFFLINE_TASK_AID_LOCK_PREFIX = 'jmw:offline-task-aid:v1:';

let dbPromise = null;

function idbAvailable() {
  return typeof indexedDB !== 'undefined';
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB 请求失败'));
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务已中止'));
    tx.onerror = () => reject(tx.error || new Error('IndexedDB 事务失败'));
  });
}

function normalizeId(value, name) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw new TypeError(`${name || 'id'} 不能为空`);
  return text;
}

function lockManager() {
  const locks = globalThis.navigator && globalThis.navigator.locks;
  return locks && typeof locks.request === 'function' ? locks : null;
}

function lockOptions(mode, options = {}) {
  const out = { mode };
  if (options.signal) out.signal = options.signal;
  if (options.ifAvailable) out.ifAvailable = true;
  return out;
}

/** 当前浏览器是否能用 Web Locks 在多个标签页之间串行化离线库写入。 */
export function supportsOfflineWebLocks() {
  return !!lockManager();
}

/**
 * 获取离线库全局锁。下载/按书操作使用 shared，清空整个库使用 exclusive。
 * 不支持 Web Locks 时仍执行回调，由 downloads.js 的跨标签消息协议负责尽力协调。
 */
export async function withOfflineLibraryLock(mode, callback, options = {}) {
  const normalizedMode = mode === 'exclusive' ? 'exclusive' : 'shared';
  const locks = lockManager();
  if (!locks) return callback(null);
  return locks.request(OFFLINE_LIBRARY_LOCK, lockOptions(normalizedMode, options), callback);
}

/** 已持有 library shared 锁时使用；不要在回调里再次获取 library 锁。 */
export async function withOfflineAidLockOnly(aid, callback, options = {}) {
  aid = normalizeId(aid, 'aid');
  const locks = lockManager();
  if (!locks) return callback(null);
  return locks.request(`${OFFLINE_AID_LOCK_PREFIX}${encodeURIComponent(aid)}`,
    lockOptions('exclusive', options), callback);
}

/** 同一本漫画的下载、删除与完整性修复互斥，不同漫画仍可并行。 */
export function withOfflineAidLock(aid, callback, options = {}) {
  return withOfflineLibraryLock('shared',
    () => withOfflineAidLockOnly(aid, callback, options), options);
}

/** 只串行化某本漫画的任务元数据；已持有 library shared 时使用。 */
export async function withOfflineTaskAidLockOnly(aid, callback, options = {}) {
  aid = normalizeId(aid, 'aid');
  const locks = lockManager();
  if (!locks) return callback(null);
  return locks.request(`${OFFLINE_TASK_AID_LOCK_PREFIX}${encodeURIComponent(aid)}`,
    lockOptions('exclusive', options), callback);
}

/** enqueue/resume 等短任务写入不会被长时间正文下载锁阻塞。 */
export function withOfflineTaskAidLock(aid, callback, options = {}) {
  return withOfflineLibraryLock('shared',
    () => withOfflineTaskAidLockOnly(aid, callback, options), options);
}

/**
 * 探测某本漫画是否无人持锁。true=空闲，false=其他标签页正在操作，null=不支持 Web Locks。
 * 仅用于恢复遗留任务状态，不能代替真正持锁执行。
 */
export async function probeOfflineAidIdle(aid) {
  if (!lockManager()) return null;
  return withOfflineLibraryLock('shared',
    () => withOfflineAidLockOnly(aid, (lock) => !!lock, { ifAvailable: true }));
}

export function chapterKey(aid, photoId) {
  return `${normalizeId(aid, 'aid')}:${normalizeId(photoId, 'photoId')}`;
}

export function imageKey(aid, photoId, index) {
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0) throw new TypeError('图片序号不合法');
  return `${chapterKey(aid, photoId)}:${n}`;
}

/** 打开离线数据库。调用者可以在设置页据此判断浏览器是否支持离线功能。 */
export function openOfflineDB() {
  if (!idbAvailable()) return Promise.reject(new Error('当前浏览器不支持 IndexedDB，无法离线保存'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_ALBUMS)) {
        db.createObjectStore(STORE_ALBUMS, { keyPath: 'aid' });
      }
      if (!db.objectStoreNames.contains(STORE_CHAPTERS)) {
        const store = db.createObjectStore(STORE_CHAPTERS, { keyPath: 'key' });
        store.createIndex('aid', 'aid', { unique: false });
        store.createIndex('photoId', 'photoId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_IMAGES)) {
        const store = db.createObjectStore(STORE_IMAGES, { keyPath: 'key' });
        store.createIndex('chapterKey', 'chapterKey', { unique: false });
        store.createIndex('aid', 'aid', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_TASKS)) {
        const store = db.createObjectStore(STORE_TASKS, { keyPath: 'id' });
        store.createIndex('aid', 'aid', { unique: false });
        store.createIndex('status', 'status', { unique: false });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error || new Error('无法打开离线数据库'));
    };
    req.onblocked = () => console.warn('[offline] 数据库升级被其他页面阻塞');
  });
  return dbPromise;
}

async function getOne(storeName, key) {
  const db = await openOfflineDB();
  const tx = db.transaction(storeName, 'readonly');
  return requestPromise(tx.objectStore(storeName).get(key));
}

async function putOne(storeName, value) {
  const db = await openOfflineDB();
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).put(value);
  await transactionDone(tx);
  return value;
}

async function deleteOne(storeName, key) {
  const db = await openOfflineDB();
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).delete(key);
  await transactionDone(tx);
}

async function getAll(storeName) {
  const db = await openOfflineDB();
  const tx = db.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);
  if (typeof store.getAll === 'function') return requestPromise(store.getAll());
  return new Promise((resolve, reject) => {
    const rows = [];
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve(rows);
      rows.push(cursor.value);
      cursor.continue();
    };
    req.onerror = () => reject(req.error || new Error('读取离线数据失败'));
  });
}

async function getAllByIndex(storeName, indexName, key) {
  const db = await openOfflineDB();
  const tx = db.transaction(storeName, 'readonly');
  const index = tx.objectStore(storeName).index(indexName);
  if (typeof index.getAll === 'function') return requestPromise(index.getAll(key));
  return new Promise((resolve, reject) => {
    const rows = [];
    const req = index.openCursor(IDBKeyRange.only(key));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve(rows);
      rows.push(cursor.value);
      cursor.continue();
    };
    req.onerror = () => reject(req.error || new Error('读取离线索引失败'));
  });
}

async function deleteByIndex(store, indexName, key) {
  return new Promise((resolve, reject) => {
    const req = store.index(indexName).openKeyCursor(IDBKeyRange.only(key));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
    req.onerror = () => reject(req.error || new Error('删除离线索引失败'));
  });
}

export async function putOfflineAlbum(album) {
  const aid = normalizeId(album && album.aid, 'aid');
  const old = await getOfflineAlbum(aid);
  const now = Date.now();
  return putOne(STORE_ALBUMS, {
    ...(old || {}),
    ...album,
    aid,
    createdAt: (old && old.createdAt) || album.createdAt || now,
    updatedAt: now,
  });
}

export function getOfflineAlbum(aid) {
  return getOne(STORE_ALBUMS, normalizeId(aid, 'aid'));
}

export async function listOfflineAlbums() {
  const albums = await getAll(STORE_ALBUMS);
  return albums.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

export async function putOfflineChapter(chapter) {
  const aid = normalizeId(chapter && chapter.aid, 'aid');
  const photoId = normalizeId(chapter && chapter.photoId, 'photoId');
  const key = chapterKey(aid, photoId);
  const old = await getOne(STORE_CHAPTERS, key);
  return putOne(STORE_CHAPTERS, {
    ...(old || {}),
    ...chapter,
    key,
    aid,
    photoId,
    updatedAt: Date.now(),
  });
}

export function getOfflineChapter(aid, photoId) {
  return getOne(STORE_CHAPTERS, chapterKey(aid, photoId));
}

export async function listOfflineChapters(aid) {
  const rows = await getAllByIndex(STORE_CHAPTERS, 'aid', normalizeId(aid, 'aid'));
  return rows.sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0));
}

export async function putOfflineImage(image) {
  const aid = normalizeId(image && image.aid, 'aid');
  const photoId = normalizeId(image && image.photoId, 'photoId');
  const index = Number(image.index);
  if (!Number.isInteger(index) || index < 0) throw new TypeError('图片序号不合法');
  if (!(image.blob instanceof Blob)) throw new TypeError('离线图片必须是 Blob');
  const rec = {
    ...image,
    key: imageKey(aid, photoId, index),
    chapterKey: chapterKey(aid, photoId),
    aid,
    photoId,
    index,
    size: Number(image.blob.size || image.size || 0),
    mime: image.blob.type || image.mime || 'application/octet-stream',
    updatedAt: Date.now(),
  };
  return putOne(STORE_IMAGES, rec);
}

export function getOfflineImage(aid, photoId, index) {
  return getOne(STORE_IMAGES, imageKey(aid, photoId, index));
}

export function deleteOfflineImage(aid, photoId, index) {
  return deleteOne(STORE_IMAGES, imageKey(aid, photoId, index));
}

export async function listOfflineImages(aid, photoId, { includeBlob = true } = {}) {
  const rows = await getAllByIndex(STORE_IMAGES, 'chapterKey', chapterKey(aid, photoId));
  rows.sort((a, b) => Number(a.index) - Number(b.index));
  if (includeBlob) return rows;
  return rows.map(({ blob, ...metadata }) => metadata);
}

export async function countOfflineImages(aid, photoId) {
  const db = await openOfflineDB();
  const tx = db.transaction(STORE_IMAGES, 'readonly');
  return requestPromise(tx.objectStore(STORE_IMAGES).index('chapterKey').count(chapterKey(aid, photoId)));
}

export async function hasOfflineChapter(aid, photoId, { requireComplete = true } = {}) {
  const chapter = await getOfflineChapter(aid, photoId);
  if (!chapter) return false;
  if (!requireComplete) return true;
  const expected = Number(chapter.imageCount);
  if (!chapter.complete || !Number.isInteger(expected) || expected <= 0) return false;
  const rows = await listOfflineImages(aid, photoId);
  if (rows.length !== expected) return false;
  const indexes = new Set();
  for (const row of rows) {
    const index = Number(row?.index);
    if (!Number.isInteger(index) || index < 0 || index >= expected || indexes.has(index)
        || !(row.blob instanceof Blob) || row.blob.size <= 0) return false;
    indexes.add(index);
  }
  return indexes.size === expected;
}

export function putDownloadTask(task) {
  if (!task || !task.id) return Promise.reject(new TypeError('下载任务缺少 id'));
  // AbortController、Promise 等运行态对象不可写入 IndexedDB。
  const persisted = JSON.parse(JSON.stringify(task));
  return putOne(STORE_TASKS, persisted);
}

export function getDownloadTask(id) {
  return getOne(STORE_TASKS, normalizeId(id, 'task id'));
}

export async function listDownloadTasks() {
  const rows = await getAll(STORE_TASKS);
  return rows.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

export function deleteDownloadTask(id) {
  return deleteOne(STORE_TASKS, normalizeId(id, 'task id'));
}

/** 删除某本漫画的章节、图片和任务；同一事务保证不会留下半套孤儿数据。 */
export async function deleteOfflineAlbum(aid) {
  aid = normalizeId(aid, 'aid');
  const db = await openOfflineDB();
  const tx = db.transaction(ALL_STORES, 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore(STORE_ALBUMS).delete(aid);
  await Promise.all([
    deleteByIndex(tx.objectStore(STORE_CHAPTERS), 'aid', aid),
    deleteByIndex(tx.objectStore(STORE_IMAGES), 'aid', aid),
    deleteByIndex(tx.objectStore(STORE_TASKS), 'aid', aid),
  ]);
  await done;
}

export async function deleteOfflineChapter(aid, photoId) {
  aid = normalizeId(aid, 'aid');
  photoId = normalizeId(photoId, 'photoId');
  const db = await openOfflineDB();
  const tx = db.transaction([STORE_CHAPTERS, STORE_IMAGES], 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore(STORE_CHAPTERS).delete(chapterKey(aid, photoId));
  await deleteByIndex(tx.objectStore(STORE_IMAGES), 'chapterKey', chapterKey(aid, photoId));
  await done;
}

export async function clearOfflineLibrary({ keepTasks = false } = {}) {
  const db = await openOfflineDB();
  const names = keepTasks ? [STORE_ALBUMS, STORE_CHAPTERS, STORE_IMAGES] : ALL_STORES;
  const tx = db.transaction(names, 'readwrite');
  for (const name of names) tx.objectStore(name).clear();
  await transactionDone(tx);
}

export async function getOfflineStorageEstimate() {
  let usage = 0;
  const albums = await listOfflineAlbums();
  for (const album of albums) usage += Number(album.totalBytes || 0);
  let browser = null;
  if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
    try { browser = await navigator.storage.estimate(); } catch (_) {}
  }
  return {
    offlineBytes: usage,
    browserUsage: browser && Number(browser.usage || 0),
    browserQuota: browser && Number(browser.quota || 0),
    persistent: typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persisted
      ? await navigator.storage.persisted().catch(() => false)
      : false,
  };
}

/** 请求浏览器尽量不要在空间紧张时自动清除漫画缓存。 */
export async function requestPersistentStorage() {
  if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.persist) return false;
  return navigator.storage.persist().catch(() => false);
}

/**
 * 备份用轻量元数据（不包含可能达数 GiB 的图片/封面 Blob）。
 * 恢复后只作为下载目录参考，不会把没有正文的章节误标为“可离线”。
 */
export async function exportOfflineMetadata() {
  const [albums, chapters] = await Promise.all([getAll(STORE_ALBUMS), getAll(STORE_CHAPTERS)]);
  return {
    format: 'jmw-offline-metadata',
    version: 1,
    exportedAt: new Date().toISOString(),
    albums: albums.map(({ coverBlob, ...album }) => ({ ...album, complete: false })),
    chapters: chapters.map((chapter) => ({
      ...chapter,
      complete: false,
      totalBytes: 0,
    })),
  };
}

export async function importOfflineMetadata(payload) {
  if (!payload || payload.format !== 'jmw-offline-metadata' || Number(payload.version) !== 1) {
    throw new Error('离线缓存元数据格式不受支持');
  }
  const albums = Array.isArray(payload.albums) ? payload.albums.slice(0, 5000) : [];
  const chapters = Array.isArray(payload.chapters) ? payload.chapters.slice(0, 50_000) : [];
  for (const album of albums) {
    if (!album || !album.aid) continue;
    const existing = await getOfflineAlbum(album.aid);
    await putOfflineAlbum({
      ...album,
      coverBlob: existing && existing.coverBlob,
      complete: Boolean(existing && existing.complete),
      totalBytes: Number(existing && existing.totalBytes || 0),
      totalImages: Number(existing && existing.totalImages || 0),
      downloadedChapters: (existing && existing.downloadedChapters) || [],
    });
  }
  for (const chapter of chapters) {
    if (!chapter || !chapter.aid || !chapter.photoId) continue;
    const existing = await getOfflineChapter(chapter.aid, chapter.photoId);
    await putOfflineChapter({
      ...chapter,
      complete: Boolean(existing && existing.complete),
      totalBytes: Number(existing && existing.totalBytes || 0),
    });
  }
  return { albums: albums.length, chapters: chapters.length };
}

/**
 * 扫描并修复缓存聚合字段。
 * partial 只核对专辑/封面/章节配置，full 还会逐页读取 Blob；可用 aid 限定一本。
 */
export async function checkOfflineIntegrity(options = {}) {
  const mode = ['off', 'partial', 'full'].includes(options.mode) ? options.mode : 'full';
  if (mode === 'off') return {
    healthy: true, mode, albums: 0, chapters: 0, completeChapters: 0,
    missingImages: 0, invalidImages: 0, missingCovers: 0, missingConfigs: 0,
    brokenChapterIds: [], message: '缓存完整性自动检查已关闭',
  };
  const wantedAid = options.aid == null ? '' : normalizeId(options.aid, 'aid');
  return withOfflineLibraryLock('shared', async () => {
    // 没有 Web Locks 时仍可做只读核对，但不能安全地用扫描快照回写聚合字段：
    // 另一个标签页可能正在下载。宁可少做自动修复，也不能覆盖新结果。
    const canRepair = supportsOfflineWebLocks();
    // 先固定 aid 列表；每本书真正扫描前再在 aid 独占锁内重读，避免用下载前的
    // 旧 album/chapter 快照覆盖刚完成下载写入的 complete/bytes 聚合字段。
    const albumIds = (await listOfflineAlbums())
      .map((album) => String(album.aid))
      .filter((aid) => !wantedAid || aid === wantedAid);
    let checkedAlbums = 0;
    let checkedChapters = 0;
    let completeChapters = 0;
    let missingImages = 0;
    let invalidImages = 0;
    let missingCovers = 0;
    let missingConfigs = 0;
    const missingCoverAlbums = new Set();
    const brokenChapterIds = new Set();
    const brokenItems = [];
    const brokenItemKeys = new Set();
    const addBroken = (aid, photoId, reason) => {
      const key = `${aid}:${photoId}`;
      if (!brokenItemKeys.has(key)) {
        brokenItemKeys.add(key);
        brokenItems.push({ aid: String(aid), photoId: String(photoId), reason });
      }
      brokenChapterIds.add(String(photoId));
    };

    for (const aid of albumIds) {
      await withOfflineAidLockOnly(aid, async () => {
        const album = await getOfflineAlbum(aid);
        if (!album) return;
        checkedAlbums++;
        const chapters = await listOfflineChapters(aid);
        const byId = new Map(chapters.map((chapter) => [String(chapter.photoId), chapter]));
        const selectedIds = Array.isArray(album.selectedChapterIds) && album.selectedChapterIds.length
          ? album.selectedChapterIds.map(String)
          : chapters.map((chapter) => String(chapter.photoId));
        if ((album.cover || album.image) && !(album.coverBlob instanceof Blob && album.coverBlob.size > 0)) {
          missingCovers++;
          missingCoverAlbums.add(aid);
        }
        for (const chapterId of selectedIds) if (!byId.has(chapterId)) {
          missingConfigs++;
          addBroken(aid, chapterId, 'missing-config');
        }
        let albumBytes = 0;
        let albumImages = 0;
        const downloadedChapters = [];
        for (const chapter of chapters) {
          checkedChapters++;
          if (mode === 'partial') {
            if (!chapter.photoId || !Number.isInteger(Number(chapter.imageCount)) || Number(chapter.imageCount) <= 0) {
              missingConfigs++;
              addBroken(aid, String(chapter.photoId || 'unknown'), 'invalid-config');
            }
            if (chapter.complete) completeChapters++;
            albumBytes += Number(chapter.totalBytes || 0);
            albumImages += chapter.complete ? Number(chapter.imageCount || 0) : 0;
            if (chapter.complete) downloadedChapters.push(String(chapter.photoId));
            continue;
          }
          const images = await listOfflineImages(aid, chapter.photoId);
          const expected = Math.max(0, Number(chapter.imageCount) || 0);
          const valid = images.filter((image) => image.blob instanceof Blob && image.blob.size > 0
            && Number.isInteger(Number(image.index)) && Number(image.index) >= 0 && Number(image.index) < expected);
          const validIndexes = new Set(valid.map((image) => Number(image.index)));
          const missing = Math.max(0, expected - validIndexes.size);
          const invalid = images.length - valid.length;
          invalidImages += invalid;
          missingImages += missing;
          if (missing || invalid || expected <= 0) addBroken(aid, chapter.photoId, missing ? 'missing-image' : 'invalid-image');
          const totalBytes = valid.reduce((sum, image) => sum + image.blob.size, 0);
          const complete = expected > 0 && validIndexes.size === expected && invalid === 0;
          if (complete) {
            completeChapters++;
            downloadedChapters.push(chapter.photoId);
          }
          albumBytes += totalBytes;
          albumImages += valid.length;
          if (canRepair && (chapter.complete !== complete || Number(chapter.totalBytes || 0) !== totalBytes)) {
            await putOfflineChapter({ ...chapter, complete, totalBytes });
          }
        }
        if (mode === 'full' && canRepair) {
          const expectedChapterCount = Array.isArray(album.chapters) ? album.chapters.length : chapters.length;
          const complete = expectedChapterCount > 0 && downloadedChapters.length === expectedChapterCount;
          await putOfflineAlbum({
            ...album,
            complete,
            totalBytes: albumBytes,
            totalImages: albumImages,
            downloadedChapters,
          });
        }
      });
    }
    const healthy = missingImages === 0 && invalidImages === 0 && missingCovers === 0 && missingConfigs === 0;
    return {
      healthy,
      mode,
      albums: checkedAlbums,
      chapters: checkedChapters,
      completeChapters,
      missingImages,
      invalidImages,
      missingCovers,
      missingConfigs,
      brokenChapterIds: [...brokenChapterIds],
      brokenItems,
      repairApplied: mode === 'full' && canRepair,
      brokenAlbumIds: [...new Set([...brokenItems.map((item) => item.aid), ...missingCoverAlbums])],
      message: healthy
        ? `${mode === 'partial' ? '部分' : '完全'}检查完成：${checkedAlbums} 本、${completeChapters} 章正常${mode === 'full' && !canRepair ? '（当前浏览器仅只读检查）' : ''}`
        : `检查完成：缺配置 ${missingConfigs} 项、缺封面 ${missingCovers} 张、缺少 ${missingImages} 页、损坏 ${invalidImages} 页${mode === 'full' && !canRepair ? '（当前浏览器仅只读检查）' : ''}`,
    };
  });
}

/** 注册静态外壳 Service Worker；显式下载的漫画正文仍由 IndexedDB 管理。 */
export async function registerOfflineWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  if (typeof document !== 'undefined' && !document.querySelector('link[rel="manifest"]')) {
    const manifest = document.createElement('link');
    manifest.rel = 'manifest';
    manifest.href = '/manifest.webmanifest';
    document.head.append(manifest);
  }
  if (typeof document !== 'undefined' && !document.querySelector('link[rel="apple-touch-icon"]')) {
    const icon = document.createElement('link');
    icon.rel = 'apple-touch-icon';
    icon.href = '/icons/icon-192.png';
    document.head.append(icon);
  }
  return navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

export async function precacheOfflineShell() {
  const registration = await registerOfflineWorker();
  const worker = registration.active || registration.waiting || registration.installing;
  if (!worker) return false;
  worker.postMessage({ type: 'PRECACHE_SHELL' });
  return true;
}

function ensureReaderStyles() {
  if (document.querySelector('link[data-jmw-offline-style]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/css/offline.css';
  link.dataset.jmwOfflineStyle = '1';
  document.head.append(link);
}

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) if (child != null) node.append(child.nodeType ? child : document.createTextNode(String(child)));
  return node;
}

/**
 * 挂载完全不访问网络的阅读器。
 * @returns {{destroy: Function, ready: Promise, setPage: Function}}
 */
export function mountOfflineReader(root, aid, photoId, options = {}) {
  if (!root || !root.appendChild) throw new TypeError('mountOfflineReader 需要 DOM 根节点');
  aid = normalizeId(aid, 'aid');
  photoId = normalizeId(photoId, 'photoId');
  ensureReaderStyles();

  const state = {
    aid, photoId,
    mode: options.mode === 'page' ? 'page' : 'scroll',
    page: Math.max(0, Number(options.initialPage) || 0),
    chapter: null,
    album: null,
    imageCount: 0,
    urls: new Map(),
    destroyed: false,
  };
  let observer = null;
  let scrollRaf = 0;

  const title = el('div', { class: 'offline-reader-title', text: '正在打开离线章节…' });
  const counter = el('div', { class: 'offline-reader-counter', text: '…' });
  const pages = el('main', { class: 'offline-reader-pages', tabindex: '0' });
  const closeBtn = el('button', { type: 'button', class: 'offline-reader-btn', 'aria-label': '退出离线阅读', onclick: close }, '←');
  const modeBtn = el('button', { type: 'button', class: 'offline-reader-btn', onclick: switchMode }, '翻页');
  const prevBtn = el('button', { type: 'button', class: 'offline-page-nav offline-prev', onclick: () => setPage(state.page - 1) }, '‹');
  const nextBtn = el('button', { type: 'button', class: 'offline-page-nav offline-next', onclick: () => setPage(state.page + 1) }, '›');
  const container = el('section', { class: 'offline-reader', 'aria-label': '离线阅读器' },
    el('header', { class: 'offline-reader-bar' }, closeBtn, title, counter, modeBtn),
    pages, prevBtn, nextBtn,
  );
  root.append(container);
  document.body.classList.add('offline-reading');

  function close() {
    if (typeof options.onClose === 'function') options.onClose();
    else if (history.length > 1) history.back();
    else location.hash = '#/downloads';
  }

  function revoke(index) {
    const url = state.urls.get(index);
    if (url) URL.revokeObjectURL(url);
    state.urls.delete(index);
  }

  async function loadSlot(index, slot) {
    if (state.destroyed || !slot || slot.dataset.loaded === '1') return;
    slot.dataset.loaded = 'loading';
    try {
      const rec = await getOfflineImage(aid, photoId, index);
      if (state.destroyed || !slot.isConnected) return;
      if (!rec || !(rec.blob instanceof Blob)) throw new Error('缓存图片不存在');
      revoke(index);
      const url = URL.createObjectURL(rec.blob);
      state.urls.set(index, url);
      const img = el('img', { src: url, alt: `第 ${index + 1} 页`, draggable: 'false' });
      img.addEventListener('error', () => {
        revoke(index);
        slot.dataset.loaded = 'error';
        slot.replaceChildren(el('button', {
          class: 'offline-reader-error', type: 'button',
          onclick: () => { slot.dataset.loaded = '0'; loadSlot(index, slot); },
        }, `第 ${index + 1} 页损坏，点击重试`));
      }, { once: true });
      slot.dataset.loaded = '1';
      slot.replaceChildren(img);
    } catch (error) {
      if (!state.destroyed) {
        slot.dataset.loaded = 'error';
        slot.replaceChildren(el('button', {
          class: 'offline-reader-error', type: 'button',
          onclick: () => { slot.dataset.loaded = '0'; loadSlot(index, slot); },
        }, `第 ${index + 1} 页读取失败，点击重试`));
      }
    }
  }

  function updateCounter() {
    counter.textContent = state.imageCount ? `${state.page + 1} / ${state.imageCount}` : '0 / 0';
    prevBtn.disabled = state.page <= 0;
    nextBtn.disabled = state.page >= state.imageCount - 1;
  }

  function saveProgress() {
    try {
      const key = 'jmw_offline_history';
      const rows = JSON.parse(localStorage.getItem(key) || '[]').filter((row) => !(String(row.aid) === aid && String(row.photoId) === photoId));
      rows.unshift({ aid, photoId, page: state.page, ts: Date.now(), name: state.album && state.album.name });
      localStorage.setItem(key, JSON.stringify(rows.slice(0, 200)));
    } catch (_) {}
  }

  function setPage(index) {
    index = Number(index);
    if (!Number.isInteger(index) || index < 0 || index >= state.imageCount || state.destroyed) return;
    state.page = index;
    updateCounter();
    saveProgress();
    if (state.mode === 'page') {
      for (const old of state.urls.keys()) if (old !== index) revoke(old);
      const slot = el('div', { class: 'offline-reader-slot', 'data-index': index });
      slot.append(el('div', { class: 'offline-reader-loading', text: `读取第 ${index + 1} 页…` }));
      pages.replaceChildren(slot);
      loadSlot(index, slot);
    } else {
      pages.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: 'start' });
    }
  }

  function renderScroll() {
    observer?.disconnect();
    pages.classList.remove('paged');
    prevBtn.hidden = true;
    nextBtn.hidden = true;
    const slots = [];
    for (let i = 0; i < state.imageCount; i++) {
      const slot = el('div', { class: 'offline-reader-slot', 'data-index': i, 'data-loaded': '0' },
        el('div', { class: 'offline-reader-loading', text: `第 ${i + 1} 页` }));
      slots.push(slot);
    }
    pages.replaceChildren(...slots);
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) loadSlot(Number(entry.target.dataset.index), entry.target);
    }, { root: pages, rootMargin: '1000px 0px' });
    slots.forEach((slot) => observer.observe(slot));
    queueMicrotask(() => slots[state.page]?.scrollIntoView({ block: 'start' }));
  }

  function renderPage() {
    observer?.disconnect();
    pages.classList.add('paged');
    prevBtn.hidden = false;
    nextBtn.hidden = false;
    setPage(state.page);
  }

  function switchMode() {
    state.mode = state.mode === 'scroll' ? 'page' : 'scroll';
    modeBtn.textContent = state.mode === 'scroll' ? '翻页' : '滚动';
    state.mode === 'scroll' ? renderScroll() : renderPage();
  }

  function onScroll() {
    if (state.mode !== 'scroll' || state.destroyed || scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      const center = pages.scrollTop + pages.clientHeight / 2;
      let best = state.page;
      let distance = Infinity;
      pages.querySelectorAll('.offline-reader-slot').forEach((slot) => {
        const d = Math.abs(slot.offsetTop + slot.offsetHeight / 2 - center);
        if (d < distance) { distance = d; best = Number(slot.dataset.index); }
      });
      if (best !== state.page) {
        state.page = best;
        updateCounter();
        saveProgress();
      }
      // 主动回收远离视口的对象 URL，长章节不会常驻全部图片内存。
      for (const index of state.urls.keys()) if (Math.abs(index - state.page) > 8) {
        const slot = pages.querySelector(`[data-index="${index}"]`);
        revoke(index);
        if (slot) {
          slot.dataset.loaded = '0';
          slot.replaceChildren(el('div', { class: 'offline-reader-loading', text: `第 ${index + 1} 页` }));
        }
      }
    });
  }

  pages.addEventListener('scroll', onScroll, { passive: true });

  const keyHandler = (event) => {
    if (event.key === 'Escape') close();
    if (state.mode === 'page' && (event.key === 'ArrowRight' || event.key === 'PageDown')) setPage(state.page + 1);
    if (state.mode === 'page' && (event.key === 'ArrowLeft' || event.key === 'PageUp')) setPage(state.page - 1);
  };
  window.addEventListener('keydown', keyHandler);

  const ready = Promise.all([getOfflineAlbum(aid), getOfflineChapter(aid, photoId)]).then(async ([album, chapter]) => {
    if (state.destroyed) return;
    if (!chapter) throw new Error('离线章节不存在或已被删除');
    state.album = album || { aid, name: `漫画 ${aid}` };
    state.chapter = chapter;
    state.imageCount = Number(chapter.imageCount || await countOfflineImages(aid, photoId));
    if (!state.imageCount) throw new Error('这个离线章节没有图片');
    state.page = Math.min(state.page, state.imageCount - 1);
    title.textContent = chapter.name || state.album.name || `章节 ${photoId}`;
    updateCounter();
    state.mode === 'page' ? renderPage() : renderScroll();
    // 即使用户停留在第一页直接退出，也应留下可恢复的离线阅读位置。
    saveProgress();
  }).catch((error) => {
    if (!state.destroyed) pages.replaceChildren(el('div', { class: 'offline-reader-fatal', text: error.message || '无法打开离线章节' }));
    throw error;
  });

  function destroy() {
    if (state.destroyed) return;
    state.destroyed = true;
    observer?.disconnect();
    if (scrollRaf) cancelAnimationFrame(scrollRaf);
    pages.removeEventListener('scroll', onScroll);
    window.removeEventListener('keydown', keyHandler);
    for (const index of [...state.urls.keys()]) revoke(index);
    container.remove();
    document.body.classList.remove('offline-reading');
  }

  return { destroy, ready, setPage, state };
}

/** 与 app.js 的 view(root) -> cleanup 路由约定兼容。 */
export function offlineReaderView(root, aid, photoId, options = {}) {
  const mounted = mountOfflineReader(root, aid, photoId, options);
  mounted.ready.catch((error) => console.warn('[offline reader]', error.message));
  return () => mounted.destroy();
}
