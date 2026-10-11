'use strict';

// 后台章节视觉分析：持久化优先级队列；默认单章节运行，章节内按页顺序处理。
// 图片只在任务期间驻留内存，分析结果以 JSON 持久化。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// 修改章节分析提示词或结果契约时必须递增版本。加载旧状态时会自动重新排队，
// 避免已经按旧规则生成的记录被误当成新结果。
const CHAPTER_AI_PROMPT_VERSION = 'v3';

function textValue(value) {
  return (typeof value === 'string' || typeof value === 'number') ? String(value).trim() : '';
}

// 上游偶尔把章节序号或休刊通知当作章节名；这些内容不足以描述章节，
// 应交给视觉模型生成实际标题。保留更具体的其它原标题作为回退。
function isMeaningfulChapterTitle(value) {
  const title = textValue(value);
  if (!title) return false;
  if (/^[\d０-９]+(?:[.．、]|\s*)$/u.test(title)) return false;
  if (/^(?:休刊|休載|停更|停載)(?:公告|通知|中)?$/iu.test(title)) return false;
  if (/^(?:公告|通知)(?:[：:：\-—].*)?$/iu.test(title)) return false;
  return true;
}

function chapterSourceTitle(chapter) {
  const name = textValue(chapter?.name);
  if (isMeaningfulChapterTitle(name)) return name;
  const title = textValue(chapter?.title);
  return isMeaningfulChapterTitle(title) ? title : '';
}

/**
 * 章节最终用于列表/阅读入口的标题：上游已有标题永远优先，只有缺少上游
 * 标题时才使用模型生成的标题。模型标题仍单独保存，便于以后选择展示位置。
 */
function effectiveChapterTitle(sourceName, generatedTitle) {
  const source = isMeaningfulChapterTitle(sourceName) ? textValue(sourceName) : '';
  return source || textValue(generatedTitle);
}

function safeId(value) {
  const text = String(value || '').trim();
  return /^\d{1,16}$/.test(text) ? text : '';
}

// 预算类失败：输入本身超出分析预算，重试不可能成功，必须永久终止任务。
class ChapterAiBudgetError extends Error {}

// 每个已接受任务预留队列字段和一条运行/重试记录的空间。500 字符错误即使
// 全部需要 JSON 的 \uXXXX 转义，也能与 ID、计数、时间戳一起放入 4 KiB。
const PENDING_SLOT_BYTES = 4096;
const STATE_HEADROOM_BYTES = 4096;
function capacityLimit(value, fallback, minimum = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.floor(number)) : fallback;
}

function extractJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(raw); } catch (_) {}
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('模型未返回有效 JSON');
  return JSON.parse(match[0]);
}

function cancelModelStream(stream) {
  // 释放上游资源，但不能让异常 fetch/stream 实现的 cancel Promise 延长
  // 已经到期的整任务预算；同步异常和异步拒绝均不得成为未处理错误。
  try { Promise.resolve(stream?.cancel?.()).catch(() => {}); } catch (_) {}
}

// 读取模型响应体：字节上限与截止时间必须覆盖“读完响应体”这一段，
// 超时经 abort 信号中断读取，超字节时主动取消流。
async function readModelJson(response, maxBytes, deadlineMs, controller) {
  const remainingMs = Math.max(1, deadlineMs - Date.now());
  let timer = null;
  let reader = null;
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new Error('视觉模型响应超时'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
  });
  try {
    reader = response.body?.getReader?.();
    if (!reader) {
      const text = await Promise.race([response.text(), aborted]);
      if (Buffer.byteLength(text) > maxBytes) throw new Error('视觉模型响应超过字节上限');
      return JSON.parse(text);
    }
    timer = setTimeout(() => controller.abort(new Error('视觉模型响应超时')), remainingMs);
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error('视觉模型响应超过字节上限');
      }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    cancelModelStream(reader || response.body);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
    try { reader?.releaseLock?.(); } catch (_) {}
  }
}

async function descramble(buffer, photoId, page) {
  const image = sharp(buffer, { failOn: 'error' });
  const meta = await image.metadata();
  const width = Number(meta.width); const height = Number(meta.height);
  if (!width || !height) throw new Error('图片尺寸无效');
  const md5 = crypto.createHash('md5').update(`${photoId}${page}`).digest('hex');
  const code = md5.charCodeAt(md5.length - 1);
  let index = code;
  if (photoId >= 268850 && photoId <= 421925) index %= 10;
  else if (photoId >= 421926) index %= 8;
  const seed = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20][index] || 10;
  const remainder = height % seed;
  const pieces = [];
  for (let i = 0; i < seed; i++) {
    let sliceH = Math.floor(height / seed);
    let dy = sliceH * i;
    const sy = height - sliceH * (i + 1) - remainder;
    if (i === 0) sliceH += remainder; else dy += remainder;
    if (sliceH <= 0) continue;
    pieces.push({ input: await image.clone().extract({ left: 0, top: sy, width, height: sliceH }).png().toBuffer(), top: dy });
  }
  const out = sharp({ create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } });
  const compositing = pieces.map((piece) => ({ input: piece.input, left: 0, top: piece.top }));
  return out.composite(compositing).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
}

function needsScramble({ photoId, scrambleId, speed, name }) {
  if (/\.gif$/i.test(String(name || ''))) return false;
  if (Number(photoId) <= Number(scrambleId || 0)) return false;
  if (String(speed || '') === '1') return false;
  return true;
}

class ChapterAiScheduler {
  constructor({
    dataDir, fetchChapter, fetchImage, modelFetch, discover, model, apiKey, baseUrl,
    readImageMetadata = (raw) => sharp(raw, { failOn: 'error' }).metadata(),
    intervalMs = 30000, maxRetries = 3, maxConcurrency = 1, modelTimeoutMs = 120000, logger = () => {},
    // 状态与任务预算上限。默认值依据：JM 章节多为 10–40 页（任务页数预算 60 覆盖
    // 绝大多数且保留整章语义）；单图 40M 像素高于主流长条漫；累计 24MiB 编码字节
    // 对应约 32MiB base64 请求体，低于常见视觉模型网关的请求上限；状态文件 8MiB
    // 在 5000 条记录上限内留有充分余量。调整时须同步 .env.example / compose / 测试。
    maxQueueEntries = 1000, maxRecordEntries = 5000, maxStatEntries = 2000,
    maxStateBytes = 8 * 1024 * 1024,
    maxTaskPages = 60, maxTaskImageBytes = 24 * 1024 * 1024, maxTaskImagePixels = 40_000_000,
    maxTaskDurationMs = 10 * 60 * 1000, maxModelResponseBytes = 4 * 1024 * 1024,
    saveDelayMs = 250,
  }) {
    this.dir = path.join(dataDir, 'chapter-ai');
    this.file = path.join(this.dir, 'state.json');
    this.fetchChapter = fetchChapter; this.fetchImage = fetchImage; this.modelFetch = modelFetch; this.discover = discover;
    this.readImageMetadata = readImageMetadata;
    this.recoveryFile = path.join(this.dir, 'state.capacity-recovery.json');
    this.model = model; this.apiKey = apiKey; this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.intervalMs = Math.max(1000, Number(intervalMs) || 30000); this.maxRetries = capacityLimit(maxRetries, 3, 0);
    this.maxConcurrency = Math.min(20, Math.max(1, Number(maxConcurrency) || 1));
    this.modelTimeoutMs = Math.min(10 * 60 * 1000, Math.max(1000, Number(modelTimeoutMs) || 120000));
    this.maxRecordEntries = capacityLimit(maxRecordEntries, 5000);
    this.maxStatEntries = capacityLimit(maxStatEntries, 2000);
    this.maxStateBytes = capacityLimit(maxStateBytes, 8 * 1024 * 1024, 64 * 1024);
    // 队列里的任务将来都可能产生不可淘汰的重试记录；不能只在完成后收敛。
    this.maxQueueEntries = Math.min(capacityLimit(maxQueueEntries, 1000), this.maxRecordEntries,
      Math.floor((this.maxStateBytes - STATE_HEADROOM_BYTES) / PENDING_SLOT_BYTES));
    this.maxTaskPages = Math.max(1, Number(maxTaskPages) || 60);
    this.maxTaskImageBytes = Math.max(1024, Number(maxTaskImageBytes) || 24 * 1024 * 1024);
    this.maxTaskImagePixels = Math.max(1, Number(maxTaskImagePixels) || 40_000_000);
    this.maxTaskDurationMs = Math.max(1000, Number(maxTaskDurationMs) || 10 * 60 * 1000);
    this.maxModelResponseBytes = Math.max(1024, Number(maxModelResponseBytes) || 4 * 1024 * 1024);
    this.saveDelayMs = Math.max(0, Number(saveDelayMs) || 0);
    this.log = logger; this.timer = null; this.active = 0; this.lastDiscovery = 0;
    this.state = { queue: [], records: {}, stats: {}, scheduler: { currentAid: '' } };
    // 脏标记 + 单一延迟写者：请求热路径只置脏并调度一次合并写，不逐次全量落盘。
    this.dirty = false; this.saveTimer = null; this.lastSaveError = ''; this.capacityBlocked = false;
    this.load();
  }
  hasCurrentResult(record) {
    return !!record && record.status === 'completed' && record.promptVersion === CHAPTER_AI_PROMPT_VERSION &&
      textValue(record.sourceName) === String(record.sourceName || '').trim() &&
      !!textValue(record.generatedTitle) && !!textValue(record.detailedDescription) &&
      !!textValue(record.briefSummary) &&
      textValue(record.effectiveTitle) === effectiveChapterTitle(record.sourceName, record.generatedTitle);
  }
  load() {
    let original = '';
    try { original = fs.readFileSync(this.file, 'utf8'); this.state = { ...this.state, ...JSON.parse(original) }; } catch (_) {}
    this.state.queue = Array.isArray(this.state.queue) ? this.state.queue : [];
    let changed = false;
    this.state.queue.forEach((job) => {
      if (job.running) changed = true;
      job.running = false;
    });
    this.state.records = this.state.records && typeof this.state.records === 'object' ? this.state.records : {};
    this.state.stats = this.state.stats && typeof this.state.stats === 'object' ? this.state.stats : {};
    this.state.scheduler = this.state.scheduler && typeof this.state.scheduler === 'object' ? this.state.scheduler : { currentAid: '' };
    this.state.scheduler.currentAid = safeId(this.state.scheduler.currentAid);

    // 启动恢复同样服从容量边界：过大的历史状态在加载时收敛到上限内。
    if (this.state.queue.length > this.maxQueueEntries) {
      // 降低配置或升级后超限的旧任务必须先保留原始恢复副本，不能静默丢弃。
      // 固定文件只创建一次，不覆盖已有副本，也不生成无界历史备份。
      try {
        fs.writeFileSync(this.recoveryFile, original, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        throw Object.assign(new Error('chapter-ai 旧队列超限，无法安全保存恢复副本；请先归档 state.capacity-recovery.json 再重启', { cause: error }),
          { code: 'capacity_recovery_failed' });
      }
      this.log('warn', `chapter-ai 旧队列超限，原始状态已保存在 state.capacity-recovery.json；活动队列收敛至 ${this.maxQueueEntries}`);
    }
    if (this.enforceQueueCap()) changed = true;
    if (this.enforceStatCap()) changed = true;
    if (this.enforceRecordCap()) changed = true;

    // v1 只在缺少原标题时要求模型生成标题。旧记录即使已经“完成”，也必须
    // 按新契约重新分析，以保证每个章节都会同时得到标题、详细描述和简洁总结。
    const queuedKeys = new Set(this.state.queue.map((job) => String(job?.key || '')));
    for (const record of Object.values(this.state.records)) {
      if (!record || !['completed', 'running'].includes(record.status) || this.hasCurrentResult(record)) continue;
      const aid = safeId(record.aid); const photoId = safeId(record.photoId);
      if (!aid || !photoId) continue;
      const key = this.key(aid, photoId);
      if (!queuedKeys.has(key)) {
        if (this.state.queue.length >= this.maxQueueEntries) continue;
        this.state.queue.push({ key, aid, photoId, priority: this.priorityFor(aid), attempts: 0, nextAt: 0 });
        queuedKeys.add(key);
        changed = true;
      }
      if (record.status !== 'queued') {
        record.status = 'queued';
        record.updatedAt = Date.now();
        delete record.error;
        changed = true;
      }
    }
    if (changed) {
      this.state.queue.sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key));
      this.save();
    }
  }
  // 状态写盘：脏标记 + 合并延迟写。save() 立即落盘当前状态；内部热路径只调用
  // notifyChanged()。写失败保留脏标记以便下次重试，不静默丢失更新。
  notifyChanged() {
    this.dirty = true;
    if (!this.saveTimer && this.saveDelayMs > 0) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.flush();
      }, this.saveDelayMs);
      this.saveTimer.unref?.();
    } else if (!this.saveTimer) {
      this.flush();
    }
  }
  flush() {
    if (!this.dirty) return true;
    this.dirty = false;
    try {
      this.writeState();
      this.lastSaveError = '';
      this.capacityBlocked = false;
      return true;
    } catch (error) {
      this.dirty = true;
      this.lastSaveError = String(error.message || error);
      this.capacityBlocked = error.code === 'state_full';
      this.log('error', `chapter-ai 状态写盘失败（保留待重试）: ${this.lastSaveError}`);
      return false;
    }
  }
  flushSync() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    return this.flush();
  }
  save() {
    this.dirty = true;
    return this.flush();
  }
  // 落盘序列化必须与字节预算的度量完全一致（同为格式化 JSON），
  // 否则按紧凑 JSON 淘汰后写出的文件仍会超出预算。
  serializeState() {
    return JSON.stringify(this.state, null, 2);
  }
  writeState() {
    this.enforceRecordCap();
    if (this.state.queue.length > this.maxQueueEntries || Object.keys(this.state.records).length > this.maxRecordEntries) {
      throw Object.assign(new Error('chapter-ai 不可淘汰状态超过条数上限，保留旧文件与待写更新'), { code: 'state_full' });
    }
    let json = this.serializeState();
    if (Buffer.byteLength(json) > this.maxStateBytes) {
      if (this.evictRecordsForSize()) json = this.serializeState();
      // 旧版本可能把完整的旧分析结果留在重试记录中。仅在超限时淘汰这些
      // 缓存字段，保留任务、尝试次数与有界错误信息，不淘汰任何已接受任务。
      let compacted = 0;
      for (const job of this.state.queue) {
        const record = this.state.records[job.key];
        if (!record || Buffer.byteLength(JSON.stringify(record, null, 2)) <= PENDING_SLOT_BYTES - 512) continue;
        const pending = {
          key: job.key, aid: job.aid, photoId: job.photoId,
          status: job.running ? 'running' : 'queued', attempts: Number(job.attempts) || 0,
          updatedAt: Number(record.updatedAt) || Date.now(),
        };
        if (record.error) pending.error = String(record.error).slice(0, 500);
        for (const key of Object.keys(record)) delete record[key];
        Object.assign(record, pending);
        compacted++;
      }
      if (compacted) {
        this.log('warn', `chapter-ai 淘汰 ${compacted} 条待重试记录的旧结果缓存，任务与重试信息保留`);
        json = this.serializeState();
      }
      const stats = Object.keys(this.state.stats).sort((a, b) => this.priorityFor(a) - this.priorityFor(b)
        || Number(this.state.stats[a]?.lastAt || 0) - Number(this.state.stats[b]?.lastAt || 0));
      for (const aid of stats) {
        if (Buffer.byteLength(json) <= this.maxStateBytes) break;
        delete this.state.stats[aid];
        json = this.serializeState();
      }
      if (Buffer.byteLength(json) > this.maxStateBytes) {
        // 最后一层 fail-closed：不能通过“告警后写超大文件”假装成功。
        throw Object.assign(new Error(`chapter-ai 状态超过字节上限（${Buffer.byteLength(json)} > ${this.maxStateBytes}），保留旧文件与待写更新`),
          { code: 'state_full' });
      }
    }
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, json, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  // 队列容量：超限时从最低优先级端裁剪；返回是否发生了裁剪。
  enforceQueueCap() {
    let trimmed = false;
    while (this.state.queue.length > this.maxQueueEntries) {
      let victimIndex = 0;
      for (let i = 1; i < this.state.queue.length; i++) {
        const a = this.state.queue[i]; const b = this.state.queue[victimIndex];
        if (Number(a.priority || 0) < Number(b.priority || 0)
            || (Number(a.priority || 0) === Number(b.priority || 0) && String(a.key) > String(b.key))) victimIndex = i;
      }
      const [dropped] = this.state.queue.splice(victimIndex, 1);
      const record = this.state.records[String(dropped?.key || '')];
      if (record && record.status === 'queued' && !this.state.queue.some((job) => job.key === dropped.key)) {
        delete this.state.records[dropped.key];
      }
      trimmed = true;
    }
    return trimmed;
  }
  // 记录淘汰顺序：失败 → 孤儿 queued（队列中已无对应任务）→ 旧提示词版本的
  // completed → 最旧的当前版本 completed。正在排队/运行的任务记录不淘汰，
  // 当前版本的既有完成结果最后淘汰且只按最旧顺序，避免“意外”丢失。
  evictableRecordEntries() {
    const queuedKeys = new Set(this.state.queue.map((job) => String(job.key || '')));
    // 使用字典实际键删除，防止旧记录缺失/错写 record.key 导致无法淘汰的死循环。
    const entries = Object.entries(this.state.records).filter(([key, record]) => record && !queuedKeys.has(key))
      .map(([key, record]) => ({ ...record, key }));
    const rank = (record) => (record.status === 'failed' ? 0
      : record.status === 'queued' ? 1
        : record.promptVersion !== CHAPTER_AI_PROMPT_VERSION ? 2 : 3);
    return entries.sort((a, b) => rank(a) - rank(b) || Number(a.updatedAt || 0) - Number(b.updatedAt || 0));
  }
  enforceRecordCap() {
    let evicted = false;
    while (Object.keys(this.state.records).length > this.maxRecordEntries) {
      const victim = this.evictableRecordEntries()[0];
      if (!victim) break;
      delete this.state.records[String(victim.key)];
      evicted = true;
    }
    return evicted;
  }
  evictRecordsForSize() {
    let evicted = false;
    while (Buffer.byteLength(this.serializeState()) > this.maxStateBytes) {
      const victim = this.evictableRecordEntries()[0];
      if (!victim) break;
      delete this.state.records[String(victim.key)];
      evicted = true;
    }
    return evicted;
  }
  // 热度统计容量：优先淘汰对调度价值最小（优先级最低、最久未访问）的条目。
  enforceStatCap() {
    const keys = Object.keys(this.state.stats);
    if (keys.length <= this.maxStatEntries) return false;
    keys.sort((a, b) => (this.priorityFor(a) - this.priorityFor(b))
      || Number(this.state.stats[a]?.lastAt || 0) - Number(this.state.stats[b]?.lastAt || 0));
    while (Object.keys(this.state.stats).length > this.maxStatEntries) {
      delete this.state.stats[keys.shift()];
    }
    return true;
  }
  key(aid, photoId) { return `${aid}:${photoId}`; }
  config() {
    const currentAid = safeId(this.state.scheduler.currentAid);
    const current = currentAid && this.state.queue.find((job) => String(job.aid) === currentAid);
    return { enabled: !!this.apiKey, model: this.model, promptVersion: CHAPTER_AI_PROMPT_VERSION, intervalMs: this.intervalMs, maxConcurrency: this.maxConcurrency, maxRetries: this.maxRetries, modelTimeoutMs: this.modelTimeoutMs, active: this.active, queued: this.state.queue.length, maxQueueEntries: this.maxQueueEntries, capacityBlocked: this.capacityBlocked, currentAid, currentPhotoId: current ? String(current.photoId) : '' };
  }
  // 热度/榜单只影响调度优先级。未配置 AI Key 时章节分析整体禁用，
  // 普通浏览不得因此产生热度写盘：更新仅保留在内存中，不调度落盘。
  touchPopularity(aid, { photoId = '', weight = 1 } = {}) {
    aid = safeId(aid); if (!aid) return 0;
    const now = Date.now(); const current = this.state.stats[aid] || {};
    const elapsed = Math.max(0, now - Number(current.lastAt || now));
    const decay = Math.exp(-elapsed / (6 * 60 * 60 * 1000));
    const recent = Number(current.recentViews || 0) * decay + Math.max(0, Number(weight) || 0);
    const views = Math.max(0, Number(current.views) || 0) + Math.max(0, Number(weight) || 0);
    this.state.stats[aid] = { ...current, aid, views, recentViews: recent, lastAt: now, lastPhotoId: safeId(photoId) || current.lastPhotoId || '' };
    this.enforceStatCap();
    if (this.apiKey) this.notifyChanged();
    return this.priorityFor(aid);
  }
  setRankWeight(aid, rankWeight = 0) {
    aid = safeId(aid); if (!aid) return 0;
    const current = this.state.stats[aid] || {};
    this.state.stats[aid] = { ...current, aid, rankWeight: Math.max(0, Number(rankWeight) || 0), rankAt: Date.now() };
    this.enforceStatCap();
    if (this.apiKey) this.notifyChanged();
    return this.priorityFor(aid);
  }
  applyRankWeights(weights) {
    const map = weights instanceof Map ? weights : new Map(Object.entries(weights || {}));
    const now = Date.now();
    for (const [aid, current] of Object.entries(this.state.stats)) {
      this.state.stats[aid] = { ...current, rankWeight: Math.max(0, Number(map.get(aid)) || 0), rankAt: now };
    }
    for (const [aid, value] of map) {
      if (!this.state.stats[aid]) this.state.stats[aid] = { aid, rankWeight: Math.max(0, Number(value) || 0), rankAt: now };
    }
    this.enforceStatCap();
    if (this.apiKey) this.notifyChanged();
  }
  priorityFor(aid) {
    const stat = this.state.stats[safeId(aid)] || {};
    return Math.max(0, Number(stat.rankWeight) || 0) + Math.log1p(Math.max(0, Number(stat.views) || 0)) * 5 + Math.max(0, Number(stat.recentViews) || 0) * 10;
  }
  /**
   * 入队统一入口（手工 / 自动发现 / 详情批量 / 启动恢复共用同一容量边界）。
   * 显式契约：
   * - 未配置 AI Key：manual 抛出 code='ai_disabled'；自动入队返回 null（不建任务）。
   * - 队列已满：manual 抛出 code='queue_full'；自动入队返回 null（状态不增长）。
   * - 已有当前版本完成结果或已在队列：幂等返回，不重复入队。
   */
  enqueue(aid, photoId, priority = 0, order = null, { manual = false } = {}) {
    aid = safeId(aid); photoId = safeId(photoId); if (!aid || !photoId) throw new Error('漫画或章节 ID 不合法');
    if (!this.apiKey) {
      if (manual) {
        throw Object.assign(new Error('未配置 AI 服务（AI_API_KEY），无法排队章节分析'), { code: 'ai_disabled' });
      }
      return null;
    }
    const key = this.key(aid, photoId); const old = this.state.records[key];
    if (this.hasCurrentResult(old)) return old;
    const pending = this.state.queue.find((x) => x.key === key);
    if (pending) {
      pending.priority = Math.max(Number(pending.priority) || 0, Number(priority) || 0);
      pending.aid = aid; pending.photoId = photoId;
      if (Number.isFinite(Number(order))) pending.order = Number(order);
      if (old && old.status !== 'running') {
        old.status = 'queued';
        old.updatedAt = Date.now();
        delete old.error;
      }
      this.notifyChanged();
      return this.state.records[key] || { key, status: 'queued' };
    }
    if (this.capacityBlocked || this.state.queue.length >= this.maxQueueEntries) {
      if (manual) {
        throw Object.assign(new Error(`分析队列已满（${this.maxQueueEntries}），请稍后重试`), { code: 'queue_full' });
      }
      return null;
    }
    this.state.queue.push({ key, aid, photoId, priority: Number(priority) || 0, order: Number.isFinite(Number(order)) ? Number(order) : null, attempts: 0, nextAt: 0 });
    if (old && old.status !== 'running') {
      old.status = 'queued';
      old.updatedAt = Date.now();
      delete old.error;
    }
    this.state.queue.sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key));
    this.enforceRecordCap();
    this.notifyChanged();
    return this.state.records[key] || { key, status: 'queued' };
  }
  get(aid, photoId) { return this.state.records[this.key(aid, photoId)] || null; }
  start() { if (!this.timer) { this.timer = setInterval(() => this.tick().catch((e) => this.log('error', e.message)), this.intervalMs); this.timer.unref?.(); } }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  chapterOrder(job) {
    const explicit = Number(job?.order);
    if (Number.isFinite(explicit)) return explicit;
    const photoId = Number(job?.photoId);
    return Number.isFinite(photoId) ? photoId : Number.MAX_SAFE_INTEGER;
  }
  nextJobs(now) {
    const pending = this.state.queue.filter((job) => !job.running);
    let currentAid = safeId(this.state.scheduler.currentAid);
    if (currentAid && !pending.some((job) => String(job.aid) === currentAid)) currentAid = '';
    if (!currentAid) {
      const first = pending.slice().sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0)
        || String(a.aid).localeCompare(String(b.aid)))[0];
      currentAid = safeId(first?.aid);
    }
    if (currentAid !== this.state.scheduler.currentAid) {
      this.state.scheduler.currentAid = currentAid;
      this.notifyChanged();
    }
    if (!currentAid) return [];
    return pending.filter((job) => String(job.aid) === currentAid && Number(job.nextAt || 0) <= now)
      .sort((a, b) => this.chapterOrder(a) - this.chapterOrder(b) || String(a.key).localeCompare(String(b.key)))
      .slice(0, Math.max(0, this.maxConcurrency - this.active));
  }
  async tick() {
    if (this.active >= this.maxConcurrency || !this.apiKey || !this.fetchChapter || !this.fetchImage || !this.modelFetch) return;
    if (this.discover && Date.now() - this.lastDiscovery >= 10 * 60 * 1000) {
      this.lastDiscovery = Date.now();
      try { await this.discover(this); } catch (error) { this.log('warn', `chapter-ai discovery: ${error.message}`); }
    }
    const now = Date.now(); const jobs = this.nextJobs(now);
    for (const job of jobs) this.runJob(job).catch((error) => this.log('error', error.message));
  }
  async runJob(job) {
    this.active++;
    job.running = true;
    const now = Date.now();
    job.attempts = Number(job.attempts || 0) + 1;
    const record = this.state.records[job.key] = { key: job.key, aid: job.aid, photoId: job.photoId, status: 'running', attempts: job.attempts, updatedAt: now };
    // 创建运行记录后立即收敛容量：运行中的任务在队列内不可淘汰，
    // 被挤出的是最旧的可淘汰记录，上限不得被运行/完成路径绕过。
    this.enforceRecordCap();
    this.notifyChanged();
    try {
      const result = await this.analyze(job.aid, job.photoId);
      Object.assign(record, result, { status: 'completed', updatedAt: Date.now() });
      this.state.queue = this.state.queue.filter((x) => x !== job);
      this.enforceRecordCap();
      this.notifyChanged(); this.log('info', `chapter-ai completed ${job.key}`);
    } catch (error) {
      record.status = 'failed'; record.error = String(error.message || '分析失败').slice(0, 500); record.updatedAt = Date.now();
      // 预算类失败（页数/字节/像素/时长超限）重试不可能成功，直接永久终止；
      // 其余失败保留原有界重试与指数退避。
      if (!(error instanceof ChapterAiBudgetError) && job.attempts <= this.maxRetries) {
        job.nextAt = Date.now() + Math.min(30 * 60 * 1000, 1000 * (2 ** (job.attempts - 1)));
        record.status = 'queued';
      } else {
        this.state.queue = this.state.queue.filter((x) => x !== job);
      }
      this.notifyChanged(); this.log('warn', `chapter-ai ${job.key}: ${record.error}`);
    } finally { job.running = false; this.active--; }
  }
  async analyze(aid, photoId) {
    // 整任务预算：页数检查先于任何下载/解码/积累；总时长是完整截止期限——
    // 共享 AbortController 到期即中止，且每个阶段都与截止 Promise race，
    // 即使注入的 fetchChapter/fetchImage 忽略取消信号，任务也必须在期限
    // 处结束并释放运行槽位（不允许长期停在 running）。
    const deadlineAt = Date.now() + this.maxTaskDurationMs;
    const controller = new AbortController();
    const deadlineError = new ChapterAiBudgetError('章节分析超过总时长预算，已终止');
    let deadlineTimer = setTimeout(() => controller.abort(deadlineError), this.maxTaskDurationMs);
    let modelTimer = null;
    let modelResponse = null;
    // race 兜底：截止到期时无论下游是否响应取消，整段 await 都必须结束。
    const deadlineRejection = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(controller.signal.reason instanceof Error ? controller.signal.reason : deadlineError);
      }, { once: true });
    });
    const withinDeadline = (work) => Promise.race([Promise.resolve(work), deadlineRejection]);
    try {
    const chapter = await withinDeadline(this.fetchChapter(aid, photoId, controller.signal)); const images = Array.isArray(chapter.images) ? chapter.images : [];
    if (!images.length) throw new Error('章节没有图片');
    if (images.length > this.maxTaskPages) {
      throw new ChapterAiBudgetError(`章节页数（${images.length}）超过分析预算（${this.maxTaskPages}），已跳过整章分析`);
    }
    const sourceName = chapterSourceTitle(chapter);
    const content = [{ type: 'text', text: '请阅读下面完整漫画章节，并严格按照要求返回结果。所有字段值必须使用简体中文，不得使用繁体中文、英文或拼音；不得输出 Markdown、解释、代码块或 JSON 以外的内容。必须只返回一个 JSON 对象，格式固定为：{ "chapterTitle": "简短章节标题", "detailedDescription": "2 至 4 句的剧情描述", "briefSummary": "1 至 2 句的剧情总结" }。三个字段必须同时存在且都为字符串。chapterTitle 控制在 30 个汉字以内；detailedDescription 只描述图片明确表现的主要人物、场景和事件；briefSummary 简洁概括本章主线，不要重复标题。不要编造图片无法确认的内容。无论原章节名是否为空，都必须根据图片生成新的 chapterTitle；原章节名仅作为参考。原章节名：' + sourceName }];
    let encodedBytes = 0;
    for (const image of images) {
      if (Date.now() > deadlineAt) throw deadlineError;
      const raw = await withinDeadline(this.fetchImage(image.url, controller.signal));
      // 单图像素预算：只读元数据（头部解码）即判定，先于重编码与内存积累。
      const meta = await withinDeadline(this.readImageMetadata(raw));
      const width = Number(meta.width); const height = Number(meta.height);
      if (!width || !height) throw new Error('图片尺寸无效');
      if (width * height > this.maxTaskImagePixels) {
        throw new ChapterAiBudgetError(`单张图片像素（${width}×${height}=${width * height}）超过预算（${this.maxTaskImagePixels}），已跳过整章分析`);
      }
      const decoded = needsScramble({ photoId, scrambleId: chapter.scrambleId, speed: chapter.speed, name: image.name })
        ? await withinDeadline(descramble(raw, Number(photoId), image.page))
        : await withinDeadline(sharp(raw).jpeg({ quality: 88, mozjpeg: true }).toBuffer());
      encodedBytes += decoded.length;
      if (encodedBytes > this.maxTaskImageBytes) {
        throw new ChapterAiBudgetError(`章节图片累计字节（${encodedBytes}）超过预算（${this.maxTaskImageBytes}），已跳过整章分析`);
      }
      content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${decoded.toString('base64')}` } });
      await sleep(0);
    }
    const endpoint = `${this.baseUrl}/chat/completions`;
    // 模型阶段（发送 + 响应体读取）用共享控制器：单次模型超时立即中止
    // 响应体读取；任务总预算由 withinDeadline race 兜底，两者不重合计时。
    modelTimer = setTimeout(() => controller.abort(new Error('视觉模型请求超时')), this.modelTimeoutMs);
    try {
      modelResponse = await withinDeadline(Promise.resolve(this.modelFetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` }, body: JSON.stringify({ model: this.model, messages: [{ role: 'system', content: '你是漫画章节分析器。' }, { role: 'user', content }], stream: false }), signal: controller.signal })).then((response) => {
        // Promise.race 到期后 fetch 仍可能迟到；此时 analyze 的 finally 已经
        // 执行，必须在接收响应的这一层取消，不能留下无人消费的响应体。
        if (controller.signal.aborted) cancelModelStream(response?.body);
        return response;
      }));
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason === deadlineError) throw deadlineError;
      if (controller.signal.aborted) throw new Error('视觉模型请求超时');
      throw error;
    }
    if (!modelResponse.ok) throw new Error(`视觉模型 HTTP ${modelResponse.status}`);
    // 响应体读取同样受任务截止时间与字节上限约束，不能在 fetch 返回后失去保护。
    const json = await withinDeadline(readModelJson(modelResponse, this.maxModelResponseBytes, deadlineAt, controller));
    const text = json?.choices?.[0]?.message?.content;
    const parsed = extractJson(text);
    const generatedTitle = textValue(parsed.chapterTitle);
    const detailedDescription = textValue(parsed.detailedDescription);
    const briefSummary = textValue(parsed.briefSummary);
    if (!generatedTitle || !detailedDescription || !briefSummary) throw new Error('视觉模型返回字段不完整');
    return {
      sourceName,
      generatedTitle,
      effectiveTitle: effectiveChapterTitle(sourceName, generatedTitle),
      detailedDescription,
      briefSummary,
      model: this.model,
      promptVersion: CHAPTER_AI_PROMPT_VERSION,
    };
    } catch (error) {
      // 到期由共享控制器统一判定：任务级期限抛预算错误（永久失败），
      // 模型级超时保持原有可重试语义。
      if (controller.signal.aborted && controller.signal.reason === deadlineError) throw deadlineError;
      throw error;
    } finally {
      clearTimeout(deadlineTimer);
      if (modelTimer) clearTimeout(modelTimer);
      cancelModelStream(modelResponse?.body);
    }
  }
}

module.exports = {
  ChapterAiScheduler,
  ChapterAiBudgetError,
  descramble,
  chapterSourceTitle,
  isMeaningfulChapterTitle,
  effectiveChapterTitle,
  CHAPTER_AI_PROMPT_VERSION,
};
