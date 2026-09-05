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

function extractJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(raw); } catch (_) {}
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('模型未返回有效 JSON');
  return JSON.parse(match[0]);
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
  constructor({ dataDir, fetchChapter, fetchImage, modelFetch, discover, model, apiKey, baseUrl, intervalMs = 30000, maxRetries = 3, maxConcurrency = 1, modelTimeoutMs = 120000, logger = () => {} }) {
    this.dir = path.join(dataDir, 'chapter-ai');
    this.file = path.join(this.dir, 'state.json');
    this.fetchChapter = fetchChapter; this.fetchImage = fetchImage; this.modelFetch = modelFetch; this.discover = discover;
    this.model = model; this.apiKey = apiKey; this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.intervalMs = Math.max(1000, Number(intervalMs) || 30000); this.maxRetries = Math.max(0, Number(maxRetries) || 3);
    this.maxConcurrency = Math.min(20, Math.max(1, Number(maxConcurrency) || 1));
    this.modelTimeoutMs = Math.min(10 * 60 * 1000, Math.max(1000, Number(modelTimeoutMs) || 120000));
    this.log = logger; this.timer = null; this.active = 0; this.lastDiscovery = 0;
    this.state = { queue: [], records: {}, stats: {}, scheduler: { currentAid: '' } };
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
    try { this.state = { ...this.state, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch (_) {}
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

    // v1 只在缺少原标题时要求模型生成标题。旧记录即使已经“完成”，也必须
    // 按新契约重新分析，以保证每个章节都会同时得到标题、详细描述和简洁总结。
    const queuedKeys = new Set(this.state.queue.map((job) => String(job?.key || '')));
    for (const record of Object.values(this.state.records)) {
      if (!record || !['completed', 'running'].includes(record.status) || this.hasCurrentResult(record)) continue;
      const aid = safeId(record.aid); const photoId = safeId(record.photoId);
      if (!aid || !photoId) continue;
      const key = this.key(aid, photoId);
      if (!queuedKeys.has(key)) {
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
  save() { fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 }); const tmp = `${this.file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 }); fs.renameSync(tmp, this.file); }
  key(aid, photoId) { return `${aid}:${photoId}`; }
  config() {
    const currentAid = safeId(this.state.scheduler.currentAid);
    const current = currentAid && this.state.queue.find((job) => String(job.aid) === currentAid);
    return { enabled: !!this.apiKey, model: this.model, promptVersion: CHAPTER_AI_PROMPT_VERSION, intervalMs: this.intervalMs, maxConcurrency: this.maxConcurrency, maxRetries: this.maxRetries, modelTimeoutMs: this.modelTimeoutMs, active: this.active, queued: this.state.queue.length, currentAid, currentPhotoId: current ? String(current.photoId) : '' };
  }
  touchPopularity(aid, { photoId = '', weight = 1 } = {}) {
    aid = safeId(aid); if (!aid) return 0;
    const now = Date.now(); const current = this.state.stats[aid] || {};
    const elapsed = Math.max(0, now - Number(current.lastAt || now));
    const decay = Math.exp(-elapsed / (6 * 60 * 60 * 1000));
    const recent = Number(current.recentViews || 0) * decay + Math.max(0, Number(weight) || 0);
    const views = Math.max(0, Number(current.views) || 0) + Math.max(0, Number(weight) || 0);
    this.state.stats[aid] = { ...current, aid, views, recentViews: recent, lastAt: now, lastPhotoId: safeId(photoId) || current.lastPhotoId || '' };
    this.save();
    return this.priorityFor(aid);
  }
  setRankWeight(aid, rankWeight = 0) {
    aid = safeId(aid); if (!aid) return 0;
    const current = this.state.stats[aid] || {};
    this.state.stats[aid] = { ...current, aid, rankWeight: Math.max(0, Number(rankWeight) || 0), rankAt: Date.now() };
    this.save();
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
    this.save();
  }
  priorityFor(aid) {
    const stat = this.state.stats[safeId(aid)] || {};
    return Math.max(0, Number(stat.rankWeight) || 0) + Math.log1p(Math.max(0, Number(stat.views) || 0)) * 5 + Math.max(0, Number(stat.recentViews) || 0) * 10;
  }
  enqueue(aid, photoId, priority = 0, order = null) {
    aid = safeId(aid); photoId = safeId(photoId); if (!aid || !photoId) throw new Error('漫画或章节 ID 不合法');
    const key = this.key(aid, photoId); const old = this.state.records[key];
    if (this.hasCurrentResult(old)) return old;
    const pending = this.state.queue.find((x) => x.key === key);
    if (pending) {
      pending.priority = Math.max(Number(pending.priority) || 0, Number(priority) || 0);
      pending.aid = aid; pending.photoId = photoId;
      if (Number.isFinite(Number(order))) pending.order = Number(order);
    } else {
      this.state.queue.push({ key, aid, photoId, priority: Number(priority) || 0, order: Number.isFinite(Number(order)) ? Number(order) : null, attempts: 0, nextAt: 0 });
    }
    if (old && old.status !== 'running') {
      old.status = 'queued';
      old.updatedAt = Date.now();
      delete old.error;
    }
    this.state.queue.sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key)); this.save(); return this.state.records[key] || { key, status: 'queued' };
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
      this.save();
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
    this.save();
    try {
      const result = await this.analyze(job.aid, job.photoId);
      Object.assign(record, result, { status: 'completed', updatedAt: Date.now() });
      this.state.queue = this.state.queue.filter((x) => x !== job); this.save(); this.log('info', `chapter-ai completed ${job.key}`);
    } catch (error) {
      record.status = 'failed'; record.error = String(error.message || '分析失败').slice(0, 500); record.updatedAt = Date.now();
      if (job.attempts <= this.maxRetries) {
        job.nextAt = Date.now() + Math.min(30 * 60 * 1000, 1000 * (2 ** (job.attempts - 1)));
        record.status = 'queued';
      } else {
        this.state.queue = this.state.queue.filter((x) => x !== job);
      }
      this.save(); this.log('warn', `chapter-ai ${job.key}: ${record.error}`);
    } finally { job.running = false; this.active--; }
  }
  async analyze(aid, photoId) {
    const chapter = await this.fetchChapter(aid, photoId); const images = Array.isArray(chapter.images) ? chapter.images : [];
    if (!images.length) throw new Error('章节没有图片');
    const sourceName = chapterSourceTitle(chapter);
    const content = [{ type: 'text', text: '请阅读下面完整漫画章节，并严格按照要求返回结果。所有字段值必须使用简体中文，不得使用繁体中文、英文或拼音；不得输出 Markdown、解释、代码块或 JSON 以外的内容。必须只返回一个 JSON 对象，格式固定为：{ "chapterTitle": "简短章节标题", "detailedDescription": "2 至 4 句的剧情描述", "briefSummary": "1 至 2 句的剧情总结" }。三个字段必须同时存在且都为字符串。chapterTitle 控制在 30 个汉字以内；detailedDescription 只描述图片明确表现的主要人物、场景和事件；briefSummary 简洁概括本章主线，不要重复标题。不要编造图片无法确认的内容。无论原章节名是否为空，都必须根据图片生成新的 chapterTitle；原章节名仅作为参考。原章节名：' + sourceName }];
    for (const image of images) {
      const raw = await this.fetchImage(image.url);
      const decoded = needsScramble({ photoId, scrambleId: chapter.scrambleId, speed: chapter.speed, name: image.name })
        ? await descramble(raw, Number(photoId), image.page)
        : await sharp(raw).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
      content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${decoded.toString('base64')}` } });
      await sleep(0);
    }
    const endpoint = `${this.baseUrl}/chat/completions`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('视觉模型请求超时')), this.modelTimeoutMs);
    let response;
    try {
      response = await this.modelFetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` }, body: JSON.stringify({ model: this.model, messages: [{ role: 'system', content: '你是漫画章节分析器。' }, { role: 'user', content }], stream: false }), signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new Error('视觉模型请求超时');
      throw error;
    } finally { clearTimeout(timeout); }
    if (!response.ok) throw new Error(`视觉模型 HTTP ${response.status}`);
    const json = await response.json(); const text = json?.choices?.[0]?.message?.content;
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
  }
}

module.exports = {
  ChapterAiScheduler,
  descramble,
  chapterSourceTitle,
  isMeaningfulChapterTitle,
  effectiveChapterTitle,
  CHAPTER_AI_PROMPT_VERSION,
};
