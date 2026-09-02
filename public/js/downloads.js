// 漫画下载队列：任务状态、暂停/恢复、断点续传和解扰后持久化。
// 数据最终写入 offline.js 的 IndexedDB，刷新页面后仍可继续。

import { imgSrc, selectedDataSource } from './api.js';
import { needsScramble, decodeFromBlob } from './descramble.js';
import {
  putOfflineAlbum,
  getOfflineAlbum,
  putOfflineChapter,
  getOfflineChapter,
  listOfflineChapters,
  putOfflineImage,
  getOfflineImage,
  listOfflineImages,
  deleteOfflineImage,
  putDownloadTask,
  getDownloadTask,
  listDownloadTasks,
  deleteDownloadTask,
  deleteOfflineAlbum,
  deleteOfflineChapter,
  clearOfflineLibrary,
  withOfflineLibraryLock,
  withOfflineAidLock,
  withOfflineAidLockOnly,
  withOfflineTaskAidLock,
  withOfflineTaskAidLockOnly,
  supportsOfflineWebLocks,
} from './offline.js';

const ACTIVE = new Set(['queued', 'fetching', 'downloading']);
const TERMINAL = new Set(['completed', 'failed']);
const DEFAULT_CONCURRENCY = 3;
const COORD_CHANNEL = 'jmw-download-coordination-v1';
const COORD_STORAGE_KEY = '__jmw_download_coord_v1';
const RUNNING = new Set(['fetching', 'downloading']);

function makeId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function cleanId(value, name = 'id') {
  const id = String(value == null ? '' : value).trim();
  if (!id) throw new TypeError(`${name} 不能为空`);
  return id;
}

function clampConcurrency(value) {
  return Math.max(1, Math.min(6, Number(value) || DEFAULT_CONCURRENCY));
}

function abortError(message = '下载已暂停') {
  try { return new DOMException(message, 'AbortError'); } catch (_) {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
  }
}

function isAbort(error) {
  return error && error.name === 'AbortError';
}

function sleep(ms, signal) {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    function done() {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchJson(path, signal) {
  const response = await fetch(path, {
    headers: { Accept: 'application/json', 'X-JMW-Data-Source': selectedDataSource() },
    credentials: 'same-origin',
    signal,
  });
  let json = null;
  try { json = await response.json(); } catch (_) {}
  if (!response.ok) {
    const error = new Error((json && json.error) || `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  if (!json) throw new Error('服务器返回了无法识别的数据');
  return json;
}

async function fetchBlob(url, signal, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        credentials: 'same-origin',
        headers: { 'X-JMW-Data-Source': selectedDataSource() },
        signal,
      });
      if (!response.ok) {
        const error = new Error(`图片请求失败（${response.status}）`);
        error.status = response.status;
        throw error;
      }
      const blob = await response.blob();
      if (!blob.size) throw new Error('服务器返回了空图片');
      if (blob.type && !/^image\//i.test(blob.type)) throw new Error(`服务器返回了非图片内容（${blob.type}）`);
      return blob;
    } catch (error) {
      if (isAbort(error) || signal.aborted) throw abortError();
      lastError = error;
      // 4xx（除 408/429）重试没有意义；5xx/网络错误则短暂退避。
      if (error.status && error.status < 500 && error.status !== 408 && error.status !== 429) break;
      if (attempt < attempts) await sleep(300 * (2 ** (attempt - 1)), signal);
    }
  }
  throw lastError || new Error('图片下载失败');
}

function normalizeSeries(album, requested, fallbackAid) {
  const source = Array.isArray(album.series) && album.series.length
    ? album.series
    : [{ id: album.id || album.aid || fallbackAid, name: album.name || '全一话', sort: 0 }];
  let chapters = source.map((chapter, index) => ({
    id: cleanId(chapter && chapter.id, '章节 id'),
    name: String((chapter && chapter.name) || '').trim() || `第 ${index + 1} 章`,
    sort: Number(chapter && chapter.sort) || index,
  })).sort((a, b) => a.sort - b.sort);
  if (Array.isArray(requested) && requested.length) {
    const wanted = new Set(requested.map((item) => String(item && typeof item === 'object' ? item.id : item)));
    chapters = chapters.filter((chapter) => wanted.has(chapter.id));
  }
  if (!chapters.length) throw new Error('没有找到要下载的章节');
  return chapters;
}

function normalizeRequestedChapterIds(value) {
  if (!Array.isArray(value) || !value.length) return null;
  return [...new Set(value.map((item) => cleanId(item && typeof item === 'object' ? item.id : item, '章节 id')))];
}

function taskCoversRequest(task, requestedChapterIds) {
  if (!task || !task.request || !Object.prototype.hasOwnProperty.call(task.request, 'chapterIds')) return false;
  let existing;
  try { existing = normalizeRequestedChapterIds(task?.request?.chapterIds); }
  catch (_) { return false; }
  if (existing === null) return true; // 已有整本任务覆盖任意章节请求。
  if (requestedChapterIds === null) return false;
  const covered = new Set(existing);
  return requestedChapterIds.every((id) => covered.has(id));
}

function offlineRowsAreComplete(rows, expected) {
  expected = Number(expected);
  if (!Number.isInteger(expected) || expected <= 0 || !Array.isArray(rows) || rows.length !== expected) return false;
  const indexes = new Set();
  for (const row of rows) {
    const index = Number(row?.index);
    if (!Number.isInteger(index) || index < 0 || index >= expected || indexes.has(index)
        || !(row.blob instanceof Blob) || row.blob.size <= 0) return false;
    indexes.add(index);
  }
  return indexes.size === expected;
}

async function cachedChapterIsUsable(aid, chapter) {
  const expected = Number(chapter?.imageCount);
  if (!chapter?.complete || !Number.isInteger(expected) || expected <= 0) return false;
  return offlineRowsAreComplete(await listOfflineImages(aid, chapter.photoId), expected);
}

function publicTask(task) {
  const out = copy(task);
  const progress = out.progress || {};
  progress.percent = progress.total
    ? Math.min(100, Math.round((Number(progress.completed || 0) / progress.total) * 1000) / 10)
    : 0;
  out.progress = progress;
  return out;
}

export class DownloadManager extends EventTarget {
  constructor({ maxActiveTasks = 1 } = {}) {
    super();
    this.maxActiveTasks = Math.max(1, Math.min(3, Number(maxActiveTasks) || 1));
    this.tasks = new Map();
    this.controllers = new Map();
    this.runs = new Map();
    this.runAids = new Map();
    this.ownedAids = new Set();
    this.suspendedAids = new Set();
    this.albumRemovalPromises = new Map();
    this.remoteSuspensions = new Map();
    this.peers = new Map();
    this.ackWaiters = new Map();
    this.pendingClaims = new Map();
    this.instanceId = makeId();
    this.channel = null;
    this.busAvailable = false;
    this.messageQueue = Promise.resolve();
    this.clearing = false;
    this.#installCoordination();
    this.ready = this.#restore();
    queueMicrotask(() => this.#broadcast({ type: 'HELLO' }));
  }

  #installCoordination() {
    if (typeof window === 'undefined') return;
    if (typeof globalThis.BroadcastChannel === 'function') {
      try {
        this.channel = new BroadcastChannel(COORD_CHANNEL);
        this.channel.addEventListener('message', (event) => {
          this.#queueCoordinationMessage(event.data);
        });
        this.busAvailable = true;
        return;
      } catch (_) {}
    }
    // BroadcastChannel 不可用时退化到 storage 事件；消息写后立即删除，不进入备份。
    try {
      if (!globalThis.localStorage) return;
      this.storageHandler = (event) => {
        if (event.key !== COORD_STORAGE_KEY || !event.newValue) return;
        try { this.#queueCoordinationMessage(JSON.parse(event.newValue)); } catch (_) {}
      };
      window.addEventListener('storage', this.storageHandler);
      this.busAvailable = true;
    } catch (_) {}
  }

  #queueCoordinationMessage(message) {
    this.messageQueue = this.messageQueue
      .then(() => this.#onCoordinationMessage(message))
      .catch(() => {});
  }

  #broadcast(payload) {
    if (!this.busAvailable) return false;
    const message = { ...payload, source: this.instanceId, sentAt: Date.now(), nonce: makeId() };
    try {
      if (this.channel) this.channel.postMessage(message);
      else {
        localStorage.setItem(COORD_STORAGE_KEY, JSON.stringify(message));
        localStorage.removeItem(COORD_STORAGE_KEY);
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  #scopeMatches(task, scope, value) {
    if (!task) return false;
    if (scope === 'all') return true;
    if (scope === 'aid') return String(task.aid) === String(value);
    if (scope === 'task') return String(task.id) === String(value);
    return false;
  }

  #isRemotelySuspended(task) {
    for (const item of this.remoteSuspensions.values()) {
      if (this.#scopeMatches(task, item.scope, item.value)) return true;
    }
    return false;
  }

  async #pauseMatching(scope, value, message = '已由另一标签页暂停') {
    const matched = [...this.tasks.values()]
      .filter((task) => this.#scopeMatches(task, scope, value) && ACTIVE.has(task.status));
    for (const task of matched) {
      task.status = 'paused';
      task.message = message;
      task.updatedAt = Date.now();
      this.controllers.get(task.id)?.abort();
    }
    await Promise.all(matched.map((task) => this.runs.get(task.id)).filter(Boolean).map((run) => run.catch(() => {})));
    // 运行中的 owner 会在仍持 aid 锁时由 #runOwned catch 持久化；排队/远端镜像
    // 不能在这里用旧快照 put，否则可能排在清理删除之后把任务复活。
    for (const task of matched) if (this.tasks.get(task.id) === task) this.#emit(task, 'pause', false);
    return matched;
  }

  async #suspendAcrossTabs(scope, value, message) {
    if (!supportsOfflineWebLocks() && !this.busAvailable) {
      throw new Error('当前浏览器无法安全协调多个标签页，请关闭其他 JM Web 页面后重试');
    }
    const opId = makeId();
    const recentPeers = new Set([...this.peers.entries()]
      .filter(([, seenAt]) => Date.now() - seenAt < 60000).map(([id]) => id));
    // 心跳只能帮助发现仍在调度的页面，不能把“超过 60 秒没发消息”等同于
    // 已经退出：后台冻结的标签页解冻后仍可能继续旧 run 并重新写回数据。
    // 因此把作用域内持久化任务记录的 owner 也纳入最终 ACK 集合，不受 peer
    // TTL 影响。无 Web Locks 时 owner 无法确认停止便安全失败，绝不先行删除。
    for (const task of this.tasks.values()) {
      const ownerId = String(task?.ownerId || '');
      if (ownerId && ownerId !== this.instanceId && RUNNING.has(task.status)
          && this.#scopeMatches(task, scope, value)) recentPeers.add(ownerId);
    }
    const waiter = { acks: new Set(), peers: recentPeers };
    this.ackWaiters.set(opId, waiter);
    this.#broadcast({ type: 'SUSPEND', opId, scope, value, message });
    try {
      await this.#pauseMatching(scope, value, message);
      if (this.busAvailable) {
        const hasLocks = supportsOfflineWebLocks();
        const startedAt = Date.now();
        const minimumWaitUntil = startedAt + (hasLocks ? 120 : 800);
        const deadline = startedAt + (hasLocks ? 1200 : 5000);
        // 至少留出一个消息往返；无 Web Locks 时必须等所有已发现页面确认其 run 已结束。
        do { await new Promise((resolve) => setTimeout(resolve, 60)); }
        while (Date.now() < minimumWaitUntil
          || (Date.now() < deadline && [...waiter.peers].some((id) => !waiter.acks.has(id))));
        const missing = [...waiter.peers].filter((id) => !waiter.acks.has(id));
        if (!hasLocks && missing.length) {
          throw new Error('其他标签页未能及时停止下载，请关闭其他 JM Web 页面后重试');
        }
      }
      return {
        opId,
        release: () => {
          this.#broadcast({ type: 'RELEASE', opId });
          this.ackWaiters.delete(opId);
        },
      };
    } catch (error) {
      this.#broadcast({ type: 'RELEASE', opId });
      this.ackWaiters.delete(opId);
      throw error;
    }
  }

  async #claimAidWithoutLocks(aid) {
    if (supportsOfflineWebLocks() || !this.busAvailable) return true;
    const opId = makeId();
    const claim = { opId, blocked: false };
    this.pendingClaims.set(aid, claim);
    this.#broadcast({ type: 'CLAIM_AID', aid, opId });
    await new Promise((resolve) => setTimeout(resolve, 180));
    if (this.pendingClaims.get(aid) === claim) this.pendingClaims.delete(aid);
    return !claim.blocked;
  }

  async #onCoordinationMessage(message) {
    if (!message || typeof message !== 'object' || !message.type || !message.source
        || message.source === this.instanceId) return;
    this.peers.set(String(message.source), Date.now());
    if (message.type === 'HELLO') {
      this.#broadcast({ type: 'HELLO_ACK', target: message.source });
      return;
    }
    if (message.target && message.target !== this.instanceId) return;
    if (message.type === 'HELLO_ACK') return;
    if (message.type === 'ACK') {
      const waiter = this.ackWaiters.get(String(message.opId));
      if (waiter) {
        waiter.peers.add(String(message.source));
        waiter.acks.add(String(message.source));
      }
      return;
    }
    if (message.type === 'SUSPEND_SEEN') {
      // “已看到”只用于把此前未知/过期的活跃页面加入等待集合，不能当作已停止。
      this.ackWaiters.get(String(message.opId))?.peers.add(String(message.source));
      return;
    }
    if (message.type === 'CLAIM_AID') {
      const aid = String(message.aid || '');
      const pending = this.pendingClaims.get(aid);
      if (this.ownedAids.has(aid) || (pending && this.instanceId < String(message.source))) {
        this.#broadcast({ type: 'CLAIM_BUSY', target: message.source, opId: message.opId, aid });
      } else if (pending && String(message.source) < this.instanceId) pending.blocked = true;
      return;
    }
    if (message.type === 'CLAIM_BUSY') {
      const pending = this.pendingClaims.get(String(message.aid || ''));
      if (pending && pending.opId === message.opId) pending.blocked = true;
      return;
    }
    if (message.type === 'TASK_UPDATE') {
      if (this.ready) await this.ready;
      const task = message.task;
      if (!task || !task.id || this.runs.has(String(task.id))) return;
      // 清理消息和 owner 的旧进度消息来自不同发送者，没有全局 FIFO。以锁内 IDB
      // 记录为准：已被 clear/remove 删除的 task 绝不能被迟到消息重新放回内存。
      const persisted = await withOfflineLibraryLock('shared', () => getDownloadTask(task.id));
      if (!persisted) {
        this.tasks.delete(String(task.id));
        return;
      }
      this.tasks.set(String(task.id), persisted);
      this.#emit(persisted, 'remote-update', false);
      return;
    }
    if (message.type === 'RELEASE') {
      const item = this.remoteSuspensions.get(String(message.opId));
      if (item?.timer) clearTimeout(item.timer);
      this.remoteSuspensions.delete(String(message.opId));
      this.#pump();
      return;
    }
    if (message.type === 'DATA_CLEARED') {
      if (this.ready) await this.ready;
      this.tasks.clear();
      this.#emit(null, 'data-remove', false);
      return;
    }
    if (message.type === 'AID_REMOVED') {
      if (this.ready) await this.ready;
      const aid = String(message.aid || '');
      for (const task of [...this.tasks.values()]) if (String(task.aid) === aid) this.tasks.delete(task.id);
      this.#emit(null, 'data-remove', false);
      return;
    }
    if (message.type === 'TASK_REMOVED') {
      if (this.ready) await this.ready;
      this.tasks.delete(String(message.taskId || ''));
      this.#emit(null, 'remove', false);
      return;
    }
    if (message.type === 'CHAPTER_REMOVED') {
      if (this.ready) await this.ready;
      this.#emit(null, 'data-remove', false);
      return;
    }
    if (message.type !== 'SUSPEND') return;
    // 必须在等待本页不可取消的解码/IDB 步骤之前应答 seen；无 Web Locks 的清理方
    // 会等最终 ACK，若超时则安全失败而不是继续删除。
    this.#broadcast({ type: 'SUSPEND_SEEN', target: message.source, opId: message.opId });
    if (this.ready) await this.ready;
    const opId = String(message.opId || '');
    if (!opId) return;
    const item = {
      scope: message.scope,
      value: message.value,
      timer: setTimeout(() => {
        this.remoteSuspensions.delete(opId);
        this.#pump();
      }, 30000),
    };
    this.remoteSuspensions.set(opId, item);
    await this.#pauseMatching(message.scope, message.value, message.message || '已由另一标签页暂停');
    this.#broadcast({ type: 'ACK', target: message.source, opId });
  }

  async #restore() {
    return withOfflineLibraryLock('shared', async () => {
      // restore 的读取和遗留状态回写必须和 clearAll 的 library exclusive 同序；否则
      // “锁外旧快照 -> clear -> put”会在清空后把任务复活。
      const rows = await listDownloadTasks();
      for (const snapshot of rows) {
        await withOfflineTaskAidLockOnly(snapshot.aid, async () => {
          // removeAlbum 可能已在 list 之后删除该行；锁内重读是唯一可信版本。
          const row = await getDownloadTask(snapshot.id);
          if (!row) return;
          // fetching/downloading 可能正由另一个标签页持有。只有 aid ifAvailable 明确
          // 空闲时才降为 paused；绝不能由新标签页盲写覆盖所有者状态。
          const aidIdle = RUNNING.has(row.status) && supportsOfflineWebLocks()
            ? await withOfflineAidLockOnly(row.aid, (lock) => !!lock, { ifAvailable: true })
            : null;
          if (RUNNING.has(row.status) && aidIdle === true) {
            row.status = 'paused';
            row.message = '页面曾被关闭，点击继续即可断点续传';
            delete row.ownerId;
            row.updatedAt = Date.now();
            await putDownloadTask(row);
          }
          this.tasks.set(row.id, row);
        });
      }
      this.#emitList();
      return this.listSync();
    });
  }

  listSync() {
    return [...this.tasks.values()]
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
      .map(publicTask);
  }

  async list() {
    await this.ready;
    return this.listSync();
  }

  async get(id) {
    await this.ready;
    const task = this.tasks.get(String(id));
    return task ? publicTask(task) : null;
  }

  subscribe(listener) {
    const handler = (event) => listener(event.detail.tasks, event.detail.task, event.detail.type);
    this.addEventListener('change', handler);
    return () => this.removeEventListener('change', handler);
  }

  /** 下载整本或所选章节。options.chapterIds 省略时下载全部章节。 */
  async enqueueAlbum(aid, options = {}) {
    await this.ready;
    aid = cleanId(aid, 'aid');
    const requestedChapterIds = normalizeRequestedChapterIds(options.chapterIds);
    const probeTask = { aid, id: '', status: 'queued' };
    if (this.clearing || this.suspendedAids.has(aid) || this.#isRemotelySuspended(probeTask)) {
      throw new Error('缓存正在其他页面清理，请稍后再创建下载任务');
    }
    // 只去重真正覆盖本次请求的任务。A 章正在下载时请求 B 章必须另建排队任务，
    // 再由本地调度与跨标签 aid 锁保证同一本不会并发写入。
    const duplicate = [...this.tasks.values()].find((task) => String(task.aid) === aid
      && ACTIVE.has(task.status) && taskCoversRequest(task, requestedChapterIds));
    if (duplicate) return publicTask(duplicate);
    const now = Date.now();
    const task = {
      id: makeId(),
      kind: requestedChapterIds && requestedChapterIds.length === 1 ? 'chapter' : 'album',
      aid,
      albumName: String((options.album && options.album.name) || options.name || '').trim(),
      status: 'queued',
      message: '等待下载',
      request: {
        chapterIds: requestedChapterIds,
        shunt: String(options.shunt || '1'),
        decode: options.decode !== false,
        cacheCover: options.cacheCover !== false,
        concurrency: clampConcurrency(options.concurrency),
        album: options.album ? copy(options.album) : null,
      },
      chapters: [],
      progress: { total: 0, completed: 0, skipped: 0, failed: 0, bytes: 0 },
      errors: [],
      ownerId: this.instanceId,
      createdAt: now,
      updatedAt: now,
    };
    await withOfflineTaskAidLock(aid, async () => {
      if (this.clearing || this.suspendedAids.has(aid) || this.#isRemotelySuspended(task)) {
        throw new Error('缓存正在其他页面清理，请稍后再创建下载任务');
      }
      this.tasks.set(task.id, task);
      try { await putDownloadTask(task); }
      catch (error) { this.tasks.delete(task.id); throw error; }
    });
    this.#emit(task, 'enqueue');
    this.#pump();
    return publicTask(task);
  }

  async enqueueChapter(aid, photoId, options = {}) {
    return this.enqueueAlbum(aid, { ...options, chapterIds: [cleanId(photoId, 'photoId')] });
  }

  async pause(id) {
    await this.ready;
    const task = this.tasks.get(String(id));
    if (!task || TERMINAL.has(task.status) || task.status === 'paused') return task ? publicTask(task) : null;
    const coordination = await this.#suspendAcrossTabs('task', task.id, '已暂停');
    try {
      await withOfflineAidLock(task.aid, () => withOfflineTaskAidLockOnly(task.aid, async () => {
        const current = await getDownloadTask(task.id);
        if (!current) {
          this.tasks.delete(task.id);
          return;
        }
        current.status = 'paused';
        current.message = '已暂停';
        current.updatedAt = Date.now();
        delete current.ownerId;
        await putDownloadTask(current);
        this.tasks.set(task.id, current);
        this.#emit(current, 'pause');
      }));
      return publicTask(this.tasks.get(task.id) || task);
    }
    finally { coordination.release(); }
  }

  async resume(id) {
    await this.ready;
    let task = this.tasks.get(String(id));
    if (!task) throw new Error('下载任务不存在');
    if (this.runs.has(task.id)) await this.runs.get(task.id).catch(() => {});
    let shouldPump = false;
    await withOfflineTaskAidLock(task.aid, async () => {
      if (this.clearing || this.suspendedAids.has(String(task.aid)) || this.#isRemotelySuspended(task)) {
        throw new Error('缓存正在其他页面清理，请稍后再继续任务');
      }
      const current = await getDownloadTask(task.id);
      if (!current) throw new Error('下载任务不存在');
      task = current;
      if (task.status === 'completed' || (RUNNING.has(task.status)
          && task.ownerId && task.ownerId !== this.instanceId)) {
        this.tasks.set(task.id, task);
        return;
      }
      task.status = 'queued';
      task.message = '等待继续下载';
      task.error = null;
      task.errors = [];
      task.progress = task.progress || {};
      task.progress.failed = 0;
      task.ownerId = this.instanceId;
      task.updatedAt = Date.now();
      await putDownloadTask(task);
      this.tasks.set(task.id, task);
      shouldPump = true;
    });
    if (!shouldPump) return publicTask(task);
    this.#emit(task, 'resume');
    this.#pump();
    return publicTask(task);
  }

  async retry(id) {
    return this.resume(id);
  }

  /** removeData=true 时同时删除该任务对应漫画的全部离线正文。 */
  async remove(id, { removeData = false } = {}) {
    await this.ready;
    const task = this.tasks.get(String(id));
    if (!task) return false;
    if (removeData) return this.removeAlbum(task.aid);
    const coordination = await this.#suspendAcrossTabs('task', task.id, '任务正在删除');
    try {
      await withOfflineAidLock(task.aid, () => withOfflineTaskAidLockOnly(task.aid, async () => {
        this.tasks.delete(task.id);
        await deleteDownloadTask(task.id);
      }));
      this.#broadcast({ type: 'TASK_REMOVED', taskId: task.id });
      this.#emit(task, 'remove', false);
      this.#pump();
      return true;
    } finally {
      coordination.release();
    }
  }

  /** 中止并移除同一本漫画的全部任务，再原子删除其离线数据。 */
  async removeAlbum(aid) {
    await this.ready;
    aid = String(aid);
    const existing = this.albumRemovalPromises.get(aid);
    if (existing) return existing;
    const operation = (async () => {
      this.suspendedAids.add(aid);
      let coordination;
      try {
        coordination = await this.#suspendAcrossTabs('aid', aid, '漫画缓存正在删除');
        await withOfflineAidLock(aid,
          () => withOfflineTaskAidLockOnly(aid, () => deleteOfflineAlbum(aid)));
        const tasks = [...this.tasks.values()].filter((task) => String(task.aid) === aid);
        for (const task of tasks) this.tasks.delete(task.id);
        this.#broadcast({ type: 'AID_REMOVED', aid });
        this.#emit(tasks[0] || null, 'remove', false);
        return true;
      } finally {
        coordination?.release();
        this.suspendedAids.delete(aid);
        this.#pump();
      }
    })();
    this.albumRemovalPromises.set(aid, operation);
    try {
      return await operation;
    } finally {
      if (this.albumRemovalPromises.get(aid) === operation) this.albumRemovalPromises.delete(aid);
    }
  }

  /** 中止所有运行任务、清空运行态与 IndexedDB，避免清理后后台任务把正文重新写回。 */
  async clearAll() {
    await this.ready;
    if (this.clearing) return false;
    this.clearing = true;
    let coordination;
    try {
      coordination = await this.#suspendAcrossTabs('all', '', '离线资料库正在清空');
      await withOfflineLibraryLock('exclusive', () => clearOfflineLibrary());
      this.tasks.clear();
      this.#broadcast({ type: 'DATA_CLEARED' });
      this.#emit(null, 'data-remove');
      return true;
    } finally {
      coordination?.release();
      this.clearing = false;
      this.#pump();
    }
  }

  /** 删除一章已缓存正文，但保留任务与其他章节。 */
  async removeChapter(aid, photoId) {
    await this.ready;
    aid = cleanId(aid, 'aid');
    photoId = cleanId(photoId, 'photoId');
    this.suspendedAids.add(aid);
    let coordination;
    try {
      coordination = await this.#suspendAcrossTabs('aid', aid, '章节缓存正在删除');
      await withOfflineAidLock(aid, () => withOfflineTaskAidLockOnly(aid, async () => {
        await deleteOfflineChapter(aid, photoId);
        for (const mirror of [...this.tasks.values()].filter((item) => String(item.aid) === aid)) {
          const current = await getDownloadTask(mirror.id);
          if (!current) {
            this.tasks.delete(mirror.id);
            continue;
          }
          if (ACTIVE.has(current.status) || mirror.status === 'paused') {
            current.status = 'paused';
            current.message = '章节缓存已删除，可继续任务重新下载';
            current.updatedAt = Date.now();
            delete current.ownerId;
            await putDownloadTask(current);
          }
          this.tasks.set(current.id, current);
        }
      }));
      this.#broadcast({ type: 'CHAPTER_REMOVED', aid, photoId });
      this.#emit(null, 'data-remove');
    } finally {
      coordination?.release();
      this.suspendedAids.delete(aid);
      this.#pump();
    }
  }

  #emit(task, type, broadcast = true) {
    const detail = { tasks: this.listSync(), task: task ? publicTask(task) : null, type };
    this.dispatchEvent(new CustomEvent('change', { detail }));
    if (task) this.dispatchEvent(new CustomEvent(type, { detail: publicTask(task) }));
    // 每张图片都会触发 progress；跨标签只同步状态边界，避免消息洪水阻塞清理指令。
    if (broadcast && task && type !== 'progress') {
      this.#broadcast({ type: 'TASK_UPDATE', eventType: type, task: publicTask(task) });
    }
  }

  #emitList() {
    this.#emit(null, 'restore');
  }

  #pump() {
    queueMicrotask(() => {
      if (this.clearing) return;
      const capacity = this.maxActiveTasks - this.runs.size;
      if (capacity <= 0) return;
      const waiting = [...this.tasks.values()].filter((task) => task.status === 'queued' && !this.runs.has(task.id)
        && !this.suspendedAids.has(String(task.aid)) && !this.#isRemotelySuspended(task));
      const reservedAids = new Set(this.runAids.values());
      const selected = [];
      for (const task of waiting) {
        const aid = String(task.aid);
        if (reservedAids.has(aid)) continue;
        reservedAids.add(aid);
        selected.push(task);
        if (selected.length >= capacity) break;
      }
      for (const task of selected) {
        this.runAids.set(task.id, String(task.aid));
        const run = this.#run(task).finally(() => {
          this.runs.delete(task.id);
          this.controllers.delete(task.id);
          this.runAids.delete(task.id);
          this.#pump();
        });
        this.runs.set(task.id, run);
      }
    });
  }

  async #persistProgress(task, type = 'progress') {
    // remove/clear 的跨标签消息可能已把任务从本页集合删除；运行协程即使稍后才
    // 收到 AbortError 也不得再把该记录写回 IndexedDB。
    if (this.tasks.get(task.id) !== task) return false;
    task.updatedAt = Date.now();
    if (task.status === 'downloading' && task.progress?.startedAt) {
      const seconds = Math.max(0.25, (Date.now() - Number(task.progress.startedAt)) / 1000);
      task.progress.bytesPerSecond = Math.round(Number(task.progress.networkBytes || 0) / seconds);
    }
    await putDownloadTask(task);
    this.#emit(task, type);
    return true;
  }

  async #run(task) {
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    const execute = async () => {
      if (controller.signal.aborted || task.status !== 'queued' || this.clearing
          || this.suspendedAids.has(String(task.aid)) || this.#isRemotelySuspended(task)) return;
      this.ownedAids.add(String(task.aid));
      task.ownerId = this.instanceId;
      this.#broadcast({ type: 'RUN_STARTED', aid: task.aid, taskId: task.id });
      const heartbeat = setInterval(() => {
        this.#broadcast({ type: 'RUN_HEARTBEAT', aid: task.aid, taskId: task.id });
      }, 15000);
      try { await this.#runOwned(task, controller); }
      finally {
        clearInterval(heartbeat);
        this.ownedAids.delete(String(task.aid));
        this.#broadcast({ type: 'RUN_RELEASED', aid: task.aid, taskId: task.id });
      }
    };
    try {
      if (supportsOfflineWebLocks()) {
        // 从获取详情到最后一次聚合字段写入都持有 library shared + aid exclusive。
        // 等锁期间也登记 controller，pause/clear 可取消尚未开始的锁请求。
        await withOfflineAidLock(task.aid, execute, { signal: controller.signal });
      } else {
        const claimed = await this.#claimAidWithoutLocks(String(task.aid));
        if (controller.signal.aborted || task.status !== 'queued') return;
        if (claimed) await execute();
        else {
          task.status = 'queued';
          task.message = '等待另一标签页完成同一本漫画';
          await this.#persistProgress(task);
          // 保持排队并低频重试，而不是把新请求静默变成需手动恢复的 paused。
          await sleep(400, controller.signal);
        }
      }
    } catch (error) {
      // #runOwned 会自行收口执行期错误；这里只处理等待 Web Lock 时的取消/失败。
      if (isAbort(error) || controller.signal.aborted || task.status === 'paused') {
        task.status = 'paused';
        task.message = '已暂停，可断点续传';
        delete task.ownerId;
        if (this.tasks.get(task.id) === task) this.#emit(task, 'pause', false);
      } else {
        task.status = 'failed';
        task.error = error.message || '无法协调下载任务';
        task.message = task.error;
        delete task.ownerId;
        if (this.tasks.get(task.id) === task) await this.#persistProgress(task, 'error');
      }
    }
  }

  async #runOwned(task, controller) {
    const { signal } = controller;
    try {
      task.status = 'fetching';
      task.message = '正在获取漫画信息';
      task.error = null;
      task.ownerId = this.instanceId;
      await this.#persistProgress(task, 'start');

      const albumJson = task.request.album
        ? { data: task.request.album }
        : await fetchJson(`/api/album?id=${encodeURIComponent(task.aid)}`, signal);
      const album = albumJson.data || albumJson;
      if (!album || typeof album !== 'object') throw new Error('漫画详情为空');
      const allChapters = normalizeSeries(album, null, task.aid);
      const chapters = normalizeSeries(album, task.request.chapterIds, task.aid);
      task.albumName = String(album.name || task.albumName || `漫画 ${task.aid}`);
      task.chapters = chapters.map((chapter) => ({ photoId: chapter.id, name: chapter.name, sort: chapter.sort, status: 'queued' }));

      let coverBlob;
      if (task.request.cacheCover) {
        try { coverBlob = await fetchBlob(imgSrc({ ...album, id: task.aid }), signal, 1); } catch (_) {}
      }
      const oldAlbum = await getOfflineAlbum(task.aid);
      await putOfflineAlbum({
        ...(oldAlbum || {}),
        aid: task.aid,
        name: task.albumName,
        author: album.author || album.author_list || [],
        description: album.description || '',
        cover: album.image || (oldAlbum && oldAlbum.cover) || '',
        coverBlob: coverBlob || (oldAlbum && oldAlbum.coverBlob),
        chapters: allChapters.map((chapter) => ({ photoId: chapter.id, name: chapter.name, sort: chapter.sort })),
        selectedChapterIds: chapters.map((chapter) => chapter.id),
        complete: false,
      });

      task.progress = { total: 0, completed: 0, skipped: 0, failed: 0, bytes: 0, networkBytes: 0, bytesPerSecond: 0, startedAt: Date.now() };
      task.status = 'downloading';
      task.message = '开始下载正文';
      await this.#persistProgress(task);

      for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex++) {
        if (signal.aborted || task.status === 'paused') throw abortError();
        const chapter = chapters[chapterIndex];
        const taskChapter = task.chapters[chapterIndex];
        taskChapter.status = 'fetching';
        task.message = `获取章节：${chapter.name}`;
        await this.#persistProgress(task);

        const cachedChapter = await getOfflineChapter(task.aid, chapter.id);
        if (cachedChapter && await cachedChapterIsUsable(task.aid, cachedChapter)) {
          task.progress.total += Number(cachedChapter.imageCount);
          task.progress.completed += Number(cachedChapter.imageCount);
          task.progress.skipped += Number(cachedChapter.imageCount);
          task.progress.bytes += Number(cachedChapter.totalBytes || 0);
          taskChapter.status = 'completed';
          taskChapter.completed = Number(cachedChapter.imageCount);
          await this.#persistProgress(task);
          continue;
        }

        const chapterJson = await fetchJson(`/api/chapter?id=${encodeURIComponent(chapter.id)}&shunt=${encodeURIComponent(task.request.shunt)}`, signal);
        const payload = chapterJson.data || chapterJson;
        const images = Array.isArray(payload.images) ? payload.images : [];
        if (!images.length) throw new Error(`章节“${chapter.name}”没有图片`);

        // 上游章节缩短后，旧版本留下的高序号页会令 count 永远大于期望值，
        // 造成“重试成功但仍不完整”。在断点续传前先移除这些不可达旧页。
        const storedImages = await listOfflineImages(task.aid, chapter.id, { includeBlob: false });
        const malformedIndex = storedImages.some((stored) => {
          const storedIndex = Number(stored.index);
          return !Number.isInteger(storedIndex) || storedIndex < 0;
        });
        if (malformedIndex) {
          // 无法用规范键精确定位的损坏记录只能按章清理，随后在本轮重新下载。
          await deleteOfflineChapter(task.aid, chapter.id);
        } else {
          for (const stored of storedImages) {
            const storedIndex = Number(stored.index);
            if (storedIndex >= images.length) await deleteOfflineImage(task.aid, chapter.id, storedIndex);
          }
        }
        task.progress.total += images.length;
        taskChapter.total = images.length;
        taskChapter.completed = 0;
        taskChapter.status = 'downloading';

        await putOfflineChapter({
          aid: task.aid,
          photoId: chapter.id,
          name: chapter.name,
          sort: chapter.sort,
          imageCount: images.length,
          scrambleId: Number(payload.scrambleId || 0),
          speed: String(payload.speed || ''),
          // 不持久化远端 URL，只保留导出/校验需要的页码和原始文件名。
          imageMeta: images.map((image, index) => ({ index, page: image.page, name: image.name || '' })),
          complete: false,
          totalBytes: Number(cachedChapter && cachedChapter.totalBytes || 0),
        });

        const jobs = [];
        let chapterBytes = 0;
        for (let index = 0; index < images.length; index++) {
          const old = await getOfflineImage(task.aid, chapter.id, index);
          const expected = images[index];
          const samePage = old?.page == null || expected?.page == null || String(old.page) === String(expected.page);
          const sameName = !old?.name || !expected?.name || String(old.name) === String(expected.name);
          if (old && old.blob instanceof Blob && old.blob.size && samePage && sameName) {
            task.progress.completed++;
            task.progress.skipped++;
            task.progress.bytes += old.blob.size;
            taskChapter.completed++;
            chapterBytes += old.blob.size;
          } else {
            if (old) await deleteOfflineImage(task.aid, chapter.id, index);
            jobs.push({ image: images[index], index });
          }
        }
        await this.#persistProgress(task);

        let cursor = 0;
        const worker = async () => {
          while (cursor < jobs.length) {
            if (signal.aborted || task.status === 'paused') throw abortError();
            const job = jobs[cursor++];
            try {
              const source = `/api/img?u=${encodeURIComponent(job.image.url)}`;
              const raw = await fetchBlob(source, signal);
              task.progress.networkBytes += raw.size;
              let blob = raw;
              let width = 0;
              let height = 0;
              let decoded = true;
              const scrambled = needsScramble({
                photoId: Number(chapter.id),
                scrambleId: Number(payload.scrambleId || 0),
                speed: String(payload.speed || ''),
                name: job.image.name || '',
              });
              if (scrambled && task.request.decode) {
                const result = await decodeFromBlob(raw, Number(chapter.id), job.image.page, { signal });
                blob = result.blob;
                width = Number(result.width || 0);
                height = Number(result.height || 0);
              } else if (scrambled) {
                decoded = false;
              }
              await putOfflineImage({
                aid: task.aid,
                photoId: chapter.id,
                index: job.index,
                page: job.image.page,
                name: job.image.name || `${job.index + 1}`,
                blob,
                width,
                height,
                decoded,
              });
              task.progress.completed++;
              task.progress.bytes += blob.size;
              taskChapter.completed++;
              chapterBytes += blob.size;
              task.message = `${chapter.name}：${taskChapter.completed}/${images.length}`;
              await this.#persistProgress(task);
            } catch (error) {
              if (isAbort(error) || signal.aborted) throw abortError();
              const quota = error && (error.name === 'QuotaExceededError' || /quota|空间/i.test(error.message || ''));
              if (quota) throw new Error('浏览器存储空间不足，请删除部分离线漫画后重试');
              task.progress.failed++;
              const detail = { photoId: chapter.id, index: job.index, message: error.message || '下载失败' };
              task.errors.push(detail);
              task.message = `${chapter.name}：第 ${job.index + 1} 页失败`;
              await this.#persistProgress(task);
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(task.request.concurrency, jobs.length || 1) }, worker));

        const finalRows = await listOfflineImages(task.aid, chapter.id);
        const chapterComplete = offlineRowsAreComplete(finalRows, images.length);
        chapterBytes = finalRows
          .filter((row) => row.blob instanceof Blob && row.blob.size > 0)
          .reduce((sum, row) => sum + row.blob.size, 0);
        await putOfflineChapter({
          aid: task.aid,
          photoId: chapter.id,
          name: chapter.name,
          sort: chapter.sort,
          imageCount: images.length,
          scrambleId: Number(payload.scrambleId || 0),
          speed: String(payload.speed || ''),
          imageMeta: images.map((image, index) => ({ index, page: image.page, name: image.name || '' })),
          complete: chapterComplete,
          totalBytes: chapterBytes,
        });
        taskChapter.status = chapterComplete ? 'completed' : 'failed';
        await this.#persistProgress(task);
      }

      const storedChapters = await listOfflineChapters(task.aid);
      const selected = new Set(chapters.map((chapter) => chapter.id));
      const selectedStored = storedChapters.filter((chapter) => selected.has(chapter.photoId));
      const albumComplete = chapters.length === allChapters.length && selectedStored.length === allChapters.length && selectedStored.every((chapter) => chapter.complete);
      const totalBytes = storedChapters.reduce((sum, chapter) => sum + Number(chapter.totalBytes || 0), 0);
      const totalImages = storedChapters.reduce((sum, chapter) => sum + Number(chapter.imageCount || 0), 0);
      await putOfflineAlbum({
        ...(await getOfflineAlbum(task.aid)),
        aid: task.aid,
        complete: albumComplete,
        totalBytes,
        totalImages,
        downloadedChapters: storedChapters.filter((chapter) => chapter.complete).map((chapter) => chapter.photoId),
      });

      if (task.progress.failed) {
        task.status = 'failed';
        task.error = `${task.progress.failed} 张图片下载失败，可点击重试`;
        task.message = task.error;
        delete task.ownerId;
        await this.#persistProgress(task, 'error');
      } else {
        task.status = 'completed';
        task.message = '下载完成';
        task.completedAt = Date.now();
        delete task.ownerId;
        await this.#persistProgress(task, 'complete');
      }
    } catch (error) {
      if (isAbort(error) || signal.aborted || task.status === 'paused') {
        task.status = 'paused';
        task.message = '已暂停，可断点续传';
        delete task.ownerId;
        await this.#persistProgress(task, 'pause');
      } else {
        task.status = 'failed';
        task.error = error.message || '下载失败';
        task.message = task.error;
        delete task.ownerId;
        await this.#persistProgress(task, 'error');
      }
    }
  }
}

/** 全站共享队列。路由/UI 直接 import { downloads } 即可。 */
export const downloads = new DownloadManager();

export const queueAlbumDownload = (aid, options) => downloads.enqueueAlbum(aid, options);
export const queueChapterDownload = (aid, photoId, options) => downloads.enqueueChapter(aid, photoId, options);
