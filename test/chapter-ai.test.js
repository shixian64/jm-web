'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const {
  ChapterAiScheduler,
  chapterSourceTitle,
  isMeaningfulChapterTitle,
  effectiveChapterTitle,
  CHAPTER_AI_PROMPT_VERSION,
} = require('../lib/chapter-ai');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-chapter-ai-'));
const extraDirs = [];
async function main() {
try {
  // 新契约要求无论上游是否已有标题，都必须让模型同时生成三项结果；
  // 但最终用于列表的标题仍由上游原标题优先决定。
  const image = await sharp({
    create: { width: 2, height: 2, channels: 3, background: { r: 240, g: 240, b: 240 } },
  }).jpeg().toBuffer();
  const modelBodies = [];
  const analysis = new ChapterAiScheduler({
    dataDir: dir,
    apiKey: 'test',
    model: 'test',
    fetchChapter: async (_aid, photoId) => ({
      name: String(photoId) === '201' ? '上游原标题' : '',
      scrambleId: 999999,
      speed: '',
      images: [{ url: 'https://image.example/1.jpg', name: '1.jpg', page: '1' }],
    }),
    fetchImage: async () => image,
    modelFetch: async (_endpoint, options) => {
      modelBodies.push(JSON.parse(options.body));
      const photoId = modelBodies.length === 1 ? '201' : modelBodies.length === 2 ? '202' : '203';
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        chapterTitle: `AI 标题 ${photoId}`,
        detailedDescription: `详细剧情 ${photoId}`,
        briefSummary: `简洁总结 ${photoId}`,
      }) } }] }), { status: 200 });
    },
  });
  const withSourceTitle = await analysis.analyze('100', '201');
  assert.strictEqual(withSourceTitle.sourceName, '上游原标题');
  assert.strictEqual(withSourceTitle.generatedTitle, 'AI 标题 201');
  assert.strictEqual(withSourceTitle.effectiveTitle, '上游原标题');
  assert.strictEqual(withSourceTitle.detailedDescription, '详细剧情 201');
  assert.strictEqual(withSourceTitle.briefSummary, '简洁总结 201');
  assert.strictEqual(withSourceTitle.promptVersion, CHAPTER_AI_PROMPT_VERSION);
  const withoutSourceTitle = await analysis.analyze('100', '202');
  assert.strictEqual(withoutSourceTitle.sourceName, '');
  assert.strictEqual(withoutSourceTitle.effectiveTitle, 'AI 标题 202');
  const prompt = modelBodies[0].messages[1].content[0].text;
  assert.match(prompt, /无论原章节名是否为空/);
  assert.match(prompt, /三个字段必须同时存在/);
  assert.match(prompt, /所有字段值必须使用简体中文/);
  assert.match(prompt, /格式固定为/);
  assert.doesNotMatch(prompt, /仅在原章节名为空或无意义时生成/);

  // runJob 必须把标题、详细剧情和简洁总结作为同一条完成记录原子保存。
  analysis.enqueue('100', '203');
  await analysis.runJob(analysis.state.queue.find((job) => job.key === '100:203'));
  const persisted = analysis.get('100', '203');
  assert.strictEqual(persisted.status, 'completed');
  assert.strictEqual(persisted.generatedTitle, 'AI 标题 203');
  assert.strictEqual(persisted.effectiveTitle, 'AI 标题 203');
  assert.strictEqual(persisted.detailedDescription, '详细剧情 203');
  assert.strictEqual(persisted.briefSummary, '简洁总结 203');

  // 旧 v1 完成记录不能阻止新规则重新排队；当前版本的完整记录则不重复分析。
  const migrationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-chapter-ai-migration-'));
  extraDirs.push(migrationDir);
  const stateDir = path.join(migrationDir, 'chapter-ai');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({
    queue: [],
    records: {
      '100:301': {
        key: '100:301', aid: '100', photoId: '301', status: 'completed', promptVersion: 'v1',
        sourceName: '旧原标题', generatedTitle: '', detailedDescription: '旧描述', briefSummary: '旧总结',
      },
      '100:302': {
        key: '100:302', aid: '100', photoId: '302', status: 'completed', promptVersion: CHAPTER_AI_PROMPT_VERSION,
        sourceName: '当前原标题', generatedTitle: '当前 AI 标题', effectiveTitle: '当前原标题',
        detailedDescription: '当前描述', briefSummary: '当前总结',
      },
    },
    stats: {},
  }));
  const migrated = new ChapterAiScheduler({
    dataDir: migrationDir, apiKey: 'test', model: 'test',
    fetchChapter: async () => ({ images: [] }), fetchImage: async () => image, modelFetch: async () => null,
  });
  assert.strictEqual(migrated.get('100', '301').status, 'queued');
  assert.strictEqual(migrated.state.queue.filter((job) => job.key === '100:301').length, 1);
  assert.strictEqual(migrated.get('100', '302').status, 'completed');
  assert.strictEqual(migrated.state.queue.some((job) => job.key === '100:302'), false);
  assert.strictEqual(effectiveChapterTitle('已有标题', 'AI 标题'), '已有标题');
  assert.strictEqual(effectiveChapterTitle('', 'AI 标题'), 'AI 标题');
  assert.strictEqual(chapterSourceTitle({ name: '  名称  ', title: '备用标题' }), '名称');
  assert.strictEqual(chapterSourceTitle({ name: '  ', title: '备用标题' }), '备用标题');
  assert.strictEqual(isMeaningfulChapterTitle('277'), false);
  assert.strictEqual(isMeaningfulChapterTitle('休刊公告'), false);
  assert.strictEqual(isMeaningfulChapterTitle('停更通知'), false);
  assert.strictEqual(chapterSourceTitle({ name: '277', title: '实际标题' }), '实际标题');
  assert.strictEqual(chapterSourceTitle({ name: '休刊公告', title: '休刊公告' }), '');
  assert.strictEqual(effectiveChapterTitle('277', 'AI 标题'), 'AI 标题');

  const scheduler = new ChapterAiScheduler({
    dataDir: dir,
    apiKey: 'test',
    model: 'test',
    maxRetries: 3,
    maxConcurrency: 1,
    fetchChapter: async () => ({ images: [] }),
    fetchImage: async () => Buffer.alloc(0),
    modelFetch: async () => null,
  });
  const first = scheduler.touchPopularity('100', { weight: 1 });
  const second = scheduler.touchPopularity('100', { weight: 2 });
  assert.ok(second > first, '最近访问应提升章节分析优先级');
  scheduler.setRankWeight('100', 50);
  scheduler.setRankWeight('100', 10);
  assert.strictEqual(scheduler.state.stats['100'].rankWeight, 10, '榜单权重应使用当前榜单快照');

  // 调度必须先锁定热门漫画，再按章节顺序处理；当前漫画还有任务时不能跳到下一本。
  const lane = new ChapterAiScheduler({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-chapter-ai-lane-')), apiKey: 'test', model: 'test', maxConcurrency: 1 });
  lane.enqueue('200', '203', 100, 3);
  lane.enqueue('200', '201', 100, 1);
  lane.enqueue('200', '202', 100, 2);
  lane.enqueue('201', '301', 200, 1);
  assert.deepStrictEqual(lane.nextJobs(Date.now()).map((job) => job.key), ['201:301']);
  lane.state.queue = lane.state.queue.filter((job) => job.key !== '201:301');
  assert.deepStrictEqual(lane.nextJobs(Date.now()).map((job) => job.key), ['200:201']);
  lane.state.queue = lane.state.queue.filter((job) => job.key !== '200:201');
  assert.deepStrictEqual(lane.nextJobs(Date.now()).map((job) => job.key), ['200:202']);

  scheduler.enqueue('100', '200', 1);
  scheduler.analyze = async () => { throw new Error('expected failure'); };
  const run = async () => scheduler.runJob(scheduler.state.queue[0]);
  await run(); await run(); await run(); await run();
    assert.strictEqual(scheduler.state.queue.length, 0, '超过最大重试次数后任务必须终止');
    assert.strictEqual(scheduler.get('100', '200').status, 'failed');
    console.log('chapter-ai scheduler checks pass');
} finally {
  // Promise 链完成后测试进程会退出；目录清理由 finally 的同步路径负责。
  // eslint 不在本项目启用，保留此处以便异常时尽量清理。
  for (const target of [dir, ...extraDirs]) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch (_) {}
  }
}
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
