'use strict';

// 后台章节视觉分析：持久化优先级队列；默认单章节运行，章节内按页顺序处理。
// 图片只在任务期间驻留内存，分析结果以 JSON 持久化。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

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
    this.log = logger; this.timer = null; this.active = 0; this.lastDiscovery = 0; this.state = { queue: [], records: {}, stats: {} };
    this.load();
  }
  load() { try { this.state = { ...this.state, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch (_) {} this.state.queue = Array.isArray(this.state.queue) ? this.state.queue : []; this.state.queue.forEach((job) => { job.running = false; }); this.state.records = this.state.records && typeof this.state.records === 'object' ? this.state.records : {}; this.state.stats = this.state.stats && typeof this.state.stats === 'object' ? this.state.stats : {}; }
  save() { fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 }); const tmp = `${this.file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 }); fs.renameSync(tmp, this.file); }
  key(aid, photoId) { return `${aid}:${photoId}`; }
  config() { return { enabled: !!this.apiKey, model: this.model, intervalMs: this.intervalMs, maxConcurrency: this.maxConcurrency, maxRetries: this.maxRetries, modelTimeoutMs: this.modelTimeoutMs, active: this.active, queued: this.state.queue.length }; }
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
  enqueue(aid, photoId, priority = 0) {
    aid = safeId(aid); photoId = safeId(photoId); if (!aid || !photoId) throw new Error('漫画或章节 ID 不合法');
    const key = this.key(aid, photoId); const old = this.state.records[key];
    if (old?.status === 'completed') return old;
    const pending = this.state.queue.find((x) => x.key === key);
    if (pending) pending.priority = Math.max(Number(pending.priority) || 0, Number(priority) || 0);
    else this.state.queue.push({ key, aid, photoId, priority: Number(priority) || 0, attempts: 0, nextAt: 0 });
    this.state.queue.sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key)); this.save(); return this.state.records[key] || { key, status: 'queued' };
  }
  get(aid, photoId) { return this.state.records[this.key(aid, photoId)] || null; }
  start() { if (!this.timer) { this.timer = setInterval(() => this.tick().catch((e) => this.log('error', e.message)), this.intervalMs); this.timer.unref?.(); } }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  async tick() {
    if (this.active >= this.maxConcurrency || !this.apiKey || !this.fetchChapter || !this.fetchImage || !this.modelFetch) return;
    if (this.discover && Date.now() - this.lastDiscovery >= 10 * 60 * 1000) {
      this.lastDiscovery = Date.now();
      try { await this.discover(this); } catch (error) { this.log('warn', `chapter-ai discovery: ${error.message}`); }
    }
    const now = Date.now(); const jobs = this.state.queue.filter((x) => !x.running && Number(x.nextAt || 0) <= now).slice(0, this.maxConcurrency - this.active);
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
    const content = [{ type: 'text', text: '请阅读下面完整漫画章节，严格只返回 JSON：{ "chapterTitle": string, "detailedDescription": string, "briefSummary": string }。chapterTitle 仅在原章节名为空或无意义时生成；briefSummary 是剧情总结，不是标题。不要编造无法从图片确认的内容。原章节名：' + String(chapter.name || '') }];
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
    const parsed = extractJson(text); return { sourceName: String(chapter.name || ''), generatedTitle: String(parsed.chapterTitle || ''), detailedDescription: String(parsed.detailedDescription || ''), briefSummary: String(parsed.briefSummary || ''), model: this.model, promptVersion: 'v1' };
  }
}

module.exports = { ChapterAiScheduler, descramble };
