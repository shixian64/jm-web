'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// sharp 是唯一的原生运行依赖。本机未安装时用最小桩替换（只覆盖本测试用到的
// 元数据/重编码链），调度器逻辑测试照常运行；图像编解码行为由安装了 sharp 的
// CI 覆盖。输出会显式标注桩模式，不得把桩模式当作编解码验证通过。
let sharp;
let sharpStubbed = false;
try {
  sharp = require('sharp');
} catch (_) {
  sharpStubbed = true;
  const FAKE_JPEG = Buffer.alloc(70000, 1);
  const makeChain = () => {
    const chain = {
      metadata: async () => ({ width: 2, height: 2, channels: 3 }),
      clone: () => makeChain(),
      extract: () => chain,
      png: () => chain,
      jpeg: () => chain,
      composite: () => chain,
      toBuffer: async () => Buffer.from(FAKE_JPEG),
    };
    return chain;
  };
  sharp = () => makeChain();
  const Module = require('module');
  const originalLoad = Module._load;
  Module._load = function hookedLoad(request, parent, isMain) {
    if (request === 'sharp') return sharp;
    return originalLoad.apply(this, arguments);
  };
}

const {
  ChapterAiScheduler,
  ChapterAiBudgetError,
  chapterSourceTitle,
  isMeaningfulChapterTitle,
  effectiveChapterTitle,
  CHAPTER_AI_PROMPT_VERSION,
} = require('../lib/chapter-ai');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-chapter-ai-'));
const extraDirs = [];

// 统计 state.json 的同步写（tmp 原子写：每次落盘恰好一次 writeFileSync）。
// 记录目标路径再按目录分桶，避免其他调度器延迟窗口内的合并写互相干扰。
const originalWriteFileSync = fs.writeFileSync;
const stateWritePaths = [];
const writesFor = (dataDir) => stateWritePaths.filter((p) => p.startsWith(path.resolve(dataDir))).length;
fs.writeFileSync = function countedWriteFileSync(file, data, options) {
  if (typeof file === 'string' && file.endsWith('state.json.tmp')) stateWritePaths.push(path.resolve(file));
  return originalWriteFileSync.call(fs, file, data, options);
};

const readState = (scheduler) => JSON.parse(originalWriteFileSync && fs.readFileSync(scheduler.file, 'utf8'));

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

  // 模型响应生命周期：非 2xx、读取超时和迟到响应都必须释放流；
  // 完整读取成功也要释放 reader 锁，不能仅依赖 fetch 实现响应 AbortSignal。
  {
    const makeModelScheduler = (modelFetch) => new ChapterAiScheduler({
      dataDir: dir, apiKey: 'test', model: 'test',
      fetchChapter: async () => ({ scrambleId: 999999, images: [{ url: 'https://image.example/1.jpg', name: '1.jpg', page: '1' }] }),
      fetchImage: async () => image,
      modelFetch,
    });
    let rejectedBodyCancelled = false;
    const rejectedResponse = new Response(new ReadableStream({
      cancel() { rejectedBodyCancelled = true; },
    }), { status: 503 });
    await assert.rejects(() => makeModelScheduler(async () => rejectedResponse).analyze('100', '210'), /HTTP 503/);
    assert.strictEqual(rejectedBodyCancelled, true, '非 2xx 模型响应必须主动取消，不能遗留无截止期限的连接');

    let timedBodyCancelled = false;
    const timedResponse = new Response(new ReadableStream({
      cancel() { timedBodyCancelled = true; },
    }));
    const timed = makeModelScheduler(async () => timedResponse);
    timed.modelTimeoutMs = 30;
    await assert.rejects(() => timed.analyze('100', '211'), /超时/);
    await wait(0);
    assert.strictEqual(timedBodyCancelled, true, '读取超时必须取消已经取得的 reader');
    assert.strictEqual(timedResponse.body.locked, false, '读取超时必须释放 reader 锁');

    let resolveLate;
    const late = makeModelScheduler(() => new Promise((resolve) => { resolveLate = resolve; }));
    late.modelTimeoutMs = 30;
    await assert.rejects(() => late.analyze('100', '212'), /超时/);
    let lateBodyCancelled = false;
    resolveLate(new Response(new ReadableStream({ cancel() { lateBodyCancelled = true; } })));
    await wait(0);
    assert.strictEqual(lateBodyCancelled, true, '超时后迟到的 fetch 响应必须取消');

    const completeResponse = new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      chapterTitle: '标题', detailedDescription: '描述', briefSummary: '总结',
    }) } }] }));
    await makeModelScheduler(async () => completeResponse).analyze('100', '213');
    assert.strictEqual(completeResponse.body.locked, false, '成功读取模型响应后也必须释放 reader 锁');
  }

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

  // 部署者用 CHAPTER_AI_MAX_RETRIES=0 关闭自动重试时，数字 0 与环境
  // 字符串 "0" 都必须保留，不能经 || 3 恢复默认而重复付费调用模型。
  for (const maxRetries of [0, '0']) {
    const noRetryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-chapter-ai-no-retry-'));
    extraDirs.push(noRetryDir);
    const noRetry = new ChapterAiScheduler({ dataDir: noRetryDir, apiKey: 'test', maxRetries });
    assert.strictEqual(noRetry.maxRetries, 0);
    noRetry.analyze = async () => { throw new Error('expected no-retry failure'); };
    noRetry.enqueue('100', '204');
    await noRetry.runJob(noRetry.state.queue[0]);
    assert.strictEqual(noRetry.get('100', '204').status, 'failed');
    assert.strictEqual(noRetry.get('100', '204').attempts, 1);
    assert.strictEqual(noRetry.state.queue.length, 0, '关闭重试后首次失败即终止任务');
    noRetry.flushSync();
  }

  /* ---------------- 第 2 批新增：资源控制行为验证 ---------------- */

  // 1) 写放大复现与修复：500 章节批量入队 + 500 次热度更新在一次 HTTP 请求
  //    的模拟中只允许一次合并落盘，且最终状态正确持久化。
  {
    const bulkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-chapter-ai-bulk-'));
    extraDirs.push(bulkDir);
    const bulk = new ChapterAiScheduler({
      dataDir: bulkDir, apiKey: 'test', model: 'test', saveDelayMs: 50,
      fetchChapter: async () => ({ images: [] }), fetchImage: async () => Buffer.alloc(0), modelFetch: async () => null,
    });
    const before = writesFor(bulkDir);
    for (let i = 0; i < 500; i++) {
      bulk.touchPopularity(`90${i}`, { weight: 1 });
      bulk.enqueue(`90${i}`, `80${i}`, 1);
    }
    assert.strictEqual(writesFor(bulkDir), before, '请求热路径不得触发同步全量写盘');
    assert.strictEqual(bulk.state.queue.length, 500);
    await wait(120);
    assert.strictEqual(writesFor(bulkDir), before + 1, '批量更新只允许合并为一次落盘');
    const onDisk = readState(bulk);
    assert.strictEqual(onDisk.queue.length, 500, '最终状态必须完整落盘');
    assert.ok(onDisk.stats['900'], '热度统计必须随合并写落盘');
    // 重启恢复：新实例读到同样状态，不复活已完成任务、不丢队列。
    const reloaded = new ChapterAiScheduler({
      dataDir: bulkDir, apiKey: 'test', model: 'test',
      fetchChapter: async () => ({ images: [] }), fetchImage: async () => Buffer.alloc(0), modelFetch: async () => null,
    });
    assert.strictEqual(reloaded.state.queue.length, 500);
    assert.ok(reloaded.state.stats['900']);
  }

  // 2) 未配置 AI Key：自动入队返回 null、手工入队明确拒绝、热度不写盘；
  //    既有完成结果仍可读取展示。
  {
    const disabledDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-chapter-ai-disabled-'));
    extraDirs.push(disabledDir);
    const stateDir2 = path.join(disabledDir, 'chapter-ai');
    fs.mkdirSync(stateDir2, { recursive: true });
    fs.writeFileSync(path.join(stateDir2, 'state.json'), JSON.stringify({
      queue: [],
      records: {
        '500:501': {
          key: '500:501', aid: '500', photoId: '501', status: 'completed', promptVersion: CHAPTER_AI_PROMPT_VERSION,
          sourceName: '标题', generatedTitle: 'AI 标题', effectiveTitle: '标题',
          detailedDescription: '描述', briefSummary: '总结',
        },
      },
      stats: {},
    }));
    const disabled = new ChapterAiScheduler({
      dataDir: disabledDir, apiKey: '', model: 'test', saveDelayMs: 50,
      fetchChapter: async () => ({ images: [] }), fetchImage: async () => Buffer.alloc(0), modelFetch: async () => null,
    });
    assert.strictEqual(disabled.get('500', '501').status, 'completed', '未配置 Key 时既有完成结果仍可读取');
    assert.strictEqual(disabled.enqueue('500', '502', 1), null, '未配置 Key 时自动入队不得创建任务');
    assert.strictEqual(disabled.state.queue.length, 0);
    assert.throws(() => disabled.enqueue('500', '503', 1, null, { manual: true }), (error) => error.code === 'ai_disabled');
    const before = writesFor(disabledDir);
    for (let i = 0; i < 500; i++) disabled.touchPopularity(`70${i}`, { weight: 1 });
    await wait(120);
    assert.strictEqual(writesFor(disabledDir), before, '未配置 Key 时普通浏览不得产生热度写盘');
  }

  // 3) 队列容量：手工超限明确拒绝、自动超限跳过、状态不增长；同 key 幂等。
  {
    const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-chapter-ai-cap-'));
    extraDirs.push(capDir);
    const capped = new ChapterAiScheduler({
      dataDir: capDir, apiKey: 'test', model: 'test', maxQueueEntries: 5,
      fetchChapter: async () => ({ images: [] }), fetchImage: async () => Buffer.alloc(0), modelFetch: async () => null,
    });
    for (let i = 0; i < 5; i++) capped.enqueue('600', `60${i}`, 10);
    assert.strictEqual(capped.state.queue.length, 5);
    assert.throws(() => capped.enqueue('600', '605', 1, null, { manual: true }), (error) => error.code === 'queue_full');
    assert.strictEqual(capped.enqueue('600', '606', 1), null, '自动入队超限必须跳过');
    assert.strictEqual(capped.state.queue.length, 5, '容量满后状态不得继续增长');
    capped.enqueue('600', '600', 99);
    assert.strictEqual(capped.state.queue.length, 5, '同 key 重复入队必须幂等');
    assert.ok(capped.state.queue.some((job) => job.key === '600:600'));
    // 已有当前版本完成结果：即便队列满也直接返回，不占用容量。
    capped.state.records['600:610'] = {
      key: '600:610', aid: '600', photoId: '610', status: 'completed', promptVersion: CHAPTER_AI_PROMPT_VERSION,
      sourceName: '标题', generatedTitle: 'AI 标题', effectiveTitle: '标题',
      detailedDescription: '描述', briefSummary: '总结',
    };
    const existing = capped.enqueue('600', '610', 1, null, { manual: true });
    assert.strictEqual(existing && existing.status, 'completed');
    assert.strictEqual(capped.state.queue.length, 5);
  }

  // 4) 记录与热度淘汰：失败 → 旧版本完成 → 最旧当前版本完成；统计淘汰低价值条目。
  {
    const evictDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-chapter-ai-evict-'));
    extraDirs.push(evictDir);
    const evictor = new ChapterAiScheduler({
      dataDir: evictDir, apiKey: 'test', model: 'test', maxRecordEntries: 3, maxStatEntries: 2,
      fetchChapter: async () => ({ images: [] }), fetchImage: async () => Buffer.alloc(0), modelFetch: async () => null,
    });
    evictor.state.records = {
      '700:1': { key: '700:1', aid: '700', photoId: '1', status: 'failed', updatedAt: 100 },
      '700:2': { key: '700:2', aid: '700', photoId: '2', status: 'completed', promptVersion: 'v1', updatedAt: 200 },
      '700:3': { key: '700:3', aid: '700', photoId: '3', status: 'completed', promptVersion: CHAPTER_AI_PROMPT_VERSION, updatedAt: 300 },
      '700:4': { key: '700:4', aid: '700', photoId: '4', status: 'completed', promptVersion: CHAPTER_AI_PROMPT_VERSION, updatedAt: 400 },
    };
    evictor.enforceRecordCap();
    assert.strictEqual(Object.keys(evictor.state.records).length, 3);
    assert.strictEqual(evictor.state.records['700:1'], undefined, '失败记录必须最先淘汰');
    evictor.state.records['700:1'] = { key: '700:1', aid: '700', photoId: '1', status: 'failed', updatedAt: 100 };
    evictor.state.records['700:2'].status = 'completed';
    evictor.state.records['700:2'].promptVersion = 'v1';
    evictor.state.records['700:5'] = { key: '700:5', aid: '700', photoId: '5', status: 'completed', promptVersion: CHAPTER_AI_PROMPT_VERSION, updatedAt: 500 };
    // 5 条超上限（1 失败 + 1 旧版本完成 + 3 当前版本完成，上限 3）：
    // 先淘汰失败，再淘汰旧提示词版本，三条当前版本完成结果保留。
    evictor.enforceRecordCap();
    assert.strictEqual(Object.keys(evictor.state.records).length, 3);
    assert.strictEqual(evictor.state.records['700:1'], undefined, '失败记录必须最先淘汰');
    assert.strictEqual(evictor.state.records['700:2'], undefined, '旧提示词版本的完成记录先于当前版本淘汰');
    assert.ok(evictor.state.records['700:3'] && evictor.state.records['700:4'] && evictor.state.records['700:5'], '当前版本完成结果保留');
    evictor.touchPopularity('710', { weight: 100 });
    evictor.touchPopularity('711', { weight: 1 });
    evictor.touchPopularity('712', { weight: 50 });
    assert.strictEqual(Object.keys(evictor.state.stats).length, 2, '热度统计必须受条数上限约束');
    assert.ok(evictor.state.stats['710'] && evictor.state.stats['712'], '低价值热度条目先淘汰');
  }

  // 5) 启动恢复服从容量边界：超大的历史队列在加载时收敛。
  {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-chapter-ai-legacy-'));
    extraDirs.push(legacyDir);
    const legacyStateDir = path.join(legacyDir, 'chapter-ai');
    fs.mkdirSync(legacyStateDir, { recursive: true });
    const legacyQueue = [];
    for (let i = 0; i < 10; i++) legacyQueue.push({ key: `800:80${i}`, aid: '800', photoId: `80${i}`, priority: i, attempts: 0, nextAt: 0 });
    fs.writeFileSync(path.join(legacyStateDir, 'state.json'), JSON.stringify({ queue: legacyQueue, records: {}, stats: {} }));
    const legacy = new ChapterAiScheduler({
      dataDir: legacyDir, apiKey: 'test', model: 'test', maxQueueEntries: 5,
      fetchChapter: async () => ({ images: [] }), fetchImage: async () => Buffer.alloc(0), modelFetch: async () => null,
    });
    assert.strictEqual(legacy.state.queue.length, 5, '启动加载必须把超大历史队列裁剪到上限');
    assert.ok(legacy.state.queue.some((job) => job.priority === 9), '裁剪保留高优先级任务');
    const recovery = fs.readFileSync(legacy.recoveryFile, 'utf8');
    assert.strictEqual(JSON.parse(recovery).queue.length, 10, '收敛前必须保存全部旧任务');
    fs.writeFileSync(legacy.file, JSON.stringify({ queue: legacyQueue, records: {}, stats: {} }));
    assert.throws(() => new ChapterAiScheduler({
      dataDir: legacyDir, apiKey: 'test', model: 'test', maxQueueEntries: 5,
    }), (error) => error.code === 'capacity_recovery_failed', '恢复副本已存在时不能覆盖或再次静默裁剪');
    assert.strictEqual(fs.readFileSync(legacy.recoveryFile, 'utf8'), recovery);
    assert.strictEqual(readState(legacy).queue.length, 10, '保存恢复副本失败不得改写原状态');
  }

  // 6) 单任务预算：页数/像素/累计字节/时长超限都明确失败且不重试；预算检查
  //    先于重编码与模型发送；响应体读取受字节与截止时间保护。
  {
    const budgetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-chapter-ai-budget-'));
    extraDirs.push(budgetDir);
    const chapterWith = (count) => ({
      name: '', scrambleId: 999999, speed: '',
      images: Array.from({ length: count }, (_, i) => ({ url: `https://image.example/${i}.jpg`, name: `${i}.jpg`, page: String(i + 1) })),
    });
    const budgetModel = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      chapterTitle: 'AI 标题', detailedDescription: '描述', briefSummary: '总结',
    }) } }] }), { status: 200 });

    const paged = new ChapterAiScheduler({
      dataDir: budgetDir, apiKey: 'test', model: 'test', maxTaskPages: 2,
      fetchChapter: async () => chapterWith(3), fetchImage: async () => image, modelFetch: budgetModel,
    });
    await assert.rejects(() => paged.analyze('900', '901'), (error) => error instanceof ChapterAiBudgetError && /页数.*超过/.test(error.message));
    paged.enqueue('900', '901', 1);
    await paged.runJob(paged.state.queue[0]);
    assert.strictEqual(paged.state.queue.length, 0, '预算失败必须永久终止，不进入重试');
    assert.strictEqual(paged.get('900', '901').status, 'failed');
    assert.match(paged.get('900', '901').error, /页数/);

    const pixeled = new ChapterAiScheduler({
      dataDir: budgetDir, apiKey: 'test', model: 'test', maxTaskImagePixels: 1,
      fetchChapter: async () => chapterWith(1), fetchImage: async () => image, modelFetch: budgetModel,
    });
    await assert.rejects(() => pixeled.analyze('900', '902'), (error) => error instanceof ChapterAiBudgetError && /像素.*超过/.test(error.message));

    // 使用与 analyze 相同的真实编码输出计算页数；生产的 1 KiB 下限不可为
    // 迁就测试而降低。2×2 图片在真实 sharp 下三页仅 963B，并没有超限。
    const encodedImage = await sharp(image).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
    const byteBudget = Math.max(1024, Math.floor(encodedImage.length * 1.5));
    const overBudgetPages = Math.floor(byteBudget / encodedImage.length) + 1;
    assert.ok(encodedImage.length * overBudgetPages > byteBudget, '测试数据必须确实超过编码字节预算');
    const byted = new ChapterAiScheduler({
      dataDir: budgetDir, apiKey: 'test', model: 'test', maxTaskImageBytes: byteBudget,
      fetchChapter: async () => chapterWith(overBudgetPages), fetchImage: async () => image, modelFetch: budgetModel,
    });
    await assert.rejects(() => byted.analyze('900', '903'), (error) => error instanceof ChapterAiBudgetError && /累计字节.*超过/.test(error.message));

    const timed = new ChapterAiScheduler({
      dataDir: budgetDir, apiKey: 'test', model: 'test', maxTaskDurationMs: 1000,
      fetchChapter: async () => chapterWith(3),
      fetchImage: async () => { await wait(700); return image; },
      modelFetch: budgetModel,
    });
    await assert.rejects(() => timed.analyze('900', '904'), (error) => error instanceof ChapterAiBudgetError && /总时长/.test(error.message));

    const oversized = new ChapterAiScheduler({
      dataDir: budgetDir, apiKey: 'test', model: 'test', maxModelResponseBytes: 1024,
      fetchChapter: async () => chapterWith(1), fetchImage: async () => image,
      modelFetch: async () => new Response('X'.repeat(4096), { status: 200 }),
    });
    await assert.rejects(() => oversized.analyze('900', '905'), /字节上限/);

    // 响应体读取挂起：模型阶段超时（1s）先于任务总预算（10s）触发，
    // 共享控制器必须立即中断读取，而不是永久等待。
    const hanging = new ChapterAiScheduler({
      dataDir: budgetDir, apiKey: 'test', model: 'test', maxTaskDurationMs: 10000, modelTimeoutMs: 1000,
      fetchChapter: async () => chapterWith(1), fetchImage: async () => image,
      modelFetch: async () => ({ ok: true, body: { getReader: () => ({ read: () => new Promise(() => {}) }) } }),
    });
    await assert.rejects(() => hanging.analyze('900', '906'), /视觉模型(?:请求|响应)超时/);

    // 总时长是完整截止期限：章节获取阶段挂起（忽略取消信号）也必须在任务
    // 预算处结束，不允许长期停留在 running 占用调度槽位。
    const stuckChapter = new ChapterAiScheduler({
      dataDir: budgetDir, apiKey: 'test', model: 'test', maxTaskDurationMs: 1000,
      fetchChapter: () => new Promise(() => {}), fetchImage: async () => image, modelFetch: budgetModel,
    });
    await assert.rejects(() => stuckChapter.analyze('900', '907'), (error) => error instanceof ChapterAiBudgetError && /总时长/.test(error.message));
    stuckChapter.enqueue('900', '907', 1);
    await stuckChapter.runJob(stuckChapter.state.queue[0]);
    assert.strictEqual(stuckChapter.state.queue.length, 0, '总时长超限必须终止任务');
    assert.strictEqual(stuckChapter.get('900', '907').status, 'failed');

    // 图片获取阶段挂起但尊重取消信号：到期即中止并归类为预算失败。
    const stuckImage = new ChapterAiScheduler({
      dataDir: budgetDir, apiKey: 'test', model: 'test', maxTaskDurationMs: 1000,
      fetchChapter: async () => chapterWith(1),
      fetchImage: (url, signal) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
      modelFetch: budgetModel,
    });
    await assert.rejects(() => stuckImage.analyze('900', '908'), (error) => error instanceof ChapterAiBudgetError && /总时长/.test(error.message));

    // 元数据读取也属于任务期限。独立 watchdog 防止挂起 Promise 在 Node 中
    // 静默退出造成假绿；注入实现完全不响应取消，也不能永久占用运行槽位。
    const stuckMetadata = new ChapterAiScheduler({
      dataDir: budgetDir, apiKey: 'test', model: 'test', maxTaskDurationMs: 1000,
      fetchChapter: async () => chapterWith(1), fetchImage: async () => image,
      readImageMetadata: () => new Promise(() => {}), modelFetch: budgetModel,
    });
    stuckMetadata.enqueue('900', '909');
    let watchdogTimer;
    const watchdog = new Promise((_, reject) => {
      watchdogTimer = setTimeout(() => reject(new Error('metadata timeout did not release the job')), 3000);
    });
    try {
      await Promise.race([stuckMetadata.runJob(stuckMetadata.state.queue[0]), watchdog]);
    } finally { clearTimeout(watchdogTimer); }
    assert.strictEqual(stuckMetadata.active, 0, '元数据读取挂起不得占用运行槽位');
    assert.strictEqual(stuckMetadata.state.queue.length, 0);
    assert.strictEqual(stuckMetadata.get('900', '909').status, 'failed');
    assert.match(stuckMetadata.get('900', '909').error, /总时长/);
  }

  // 7) 写失败保留可重试状态：失败的合并写不丢数据，恢复后下一次写补齐。
  {
    const failingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-chapter-ai-writefail-'));
    extraDirs.push(failingDir);
    const failing = new ChapterAiScheduler({
      dataDir: failingDir, apiKey: 'test', model: 'test', saveDelayMs: 20,
      fetchChapter: async () => ({ images: [] }), fetchImage: async () => Buffer.alloc(0), modelFetch: async () => null,
    });
    const realWrite = fs.writeFileSync;
    fs.writeFileSync = function brokenWrite(file, data, options) {
      if (typeof file === 'string' && file.endsWith('state.json.tmp')) throw new Error('disk full');
      return realWrite.call(fs, file, data, options);
    };
    failing.touchPopularity('950', { weight: 3 });
    await wait(60);
    assert.strictEqual(failing.dirty, true, '写失败必须保留脏标记等待重试');
    assert.ok(failing.lastSaveError.includes('disk full'), '写失败必须记录可观测错误');
    fs.writeFileSync = realWrite;
    failing.notifyChanged();
    await wait(60);
    assert.strictEqual(failing.dirty, false, '恢复后重试写必须成功');
    assert.ok(readState(failing).stats['950'], '写失败期间的数据不能静默丢失');
  }

  // 8) 退出 flush：尚在合并窗口内的更新由 flushSync 立即落盘。
  {
    const exitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-chapter-ai-exit-'));
    extraDirs.push(exitDir);
    const exiting = new ChapterAiScheduler({
      dataDir: exitDir, apiKey: 'test', model: 'test', saveDelayMs: 5000,
      fetchChapter: async () => ({ images: [] }), fetchImage: async () => Buffer.alloc(0), modelFetch: async () => null,
    });
    exiting.enqueue('960', '961', 1);
    assert.strictEqual(exiting.dirty, true);
    assert.strictEqual(exiting.flushSync(), true);
    assert.strictEqual(exiting.dirty, false);
    assert.strictEqual(exiting.saveTimer, null);
    assert.strictEqual(readState(exiting).queue.length, 1, '退出 flush 必须落盘合并窗口内的更新');
  }

  // 9) 上限不得被运行/完成路径绕过：完成 3 个任务后记录收敛到 maxRecordEntries；
  //    字节预算按落盘的实际（格式化）序列化度量，超限必须真实收敛到预算内。
  {
    const okModel = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      chapterTitle: 'AI 标题', detailedDescription: '描述', briefSummary: '总结',
    }) } }] }), { status: 200 });
    const oneImageChapter = () => ({
      name: '', scrambleId: 999999, speed: '',
      images: [{ url: 'https://image.example/1.jpg', name: '1.jpg', page: '1' }],
    });
    const capDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-chapter-ai-runcap-'));
    extraDirs.push(capDir2);
    const runner = new ChapterAiScheduler({
      dataDir: capDir2, apiKey: 'test', model: 'test', maxRecordEntries: 2, saveDelayMs: 10,
      fetchChapter: async () => oneImageChapter(), fetchImage: async () => image, modelFetch: okModel,
    });
    for (let i = 1; i <= 3; i++) {
      runner.enqueue('910', String(i), 1);
      await runner.runJob(runner.state.queue[0]);
    }
    assert.strictEqual(Object.keys(runner.state.records).length, 2, '完成任务不得绕过记录条数上限');
    runner.flushSync();
    assert.strictEqual(Object.keys(readState(runner).records).length, 2, '落盘状态同样不得超过记录条数上限');

    const byteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-chapter-ai-bytecap-'));
    extraDirs.push(byteDir);
    const byter = new ChapterAiScheduler({
      dataDir: byteDir, apiKey: 'test', model: 'test', maxStateBytes: 65536, maxRecordEntries: 50,
      fetchChapter: async () => ({ images: [] }), fetchImage: async () => Buffer.alloc(0), modelFetch: okModel,
    });
    const filler = '描'.repeat(6000); // 每条约 18KB（UTF-8），8 条远超 64KiB 预算
    for (let i = 0; i < 8; i++) {
      byter.state.records[`920:${i}`] = {
        key: `920:${i}`, aid: '920', photoId: String(i), status: 'completed',
        promptVersion: CHAPTER_AI_PROMPT_VERSION, sourceName: '标题', generatedTitle: 'AI 标题',
        effectiveTitle: '标题', detailedDescription: filler, briefSummary: '总结', updatedAt: i + 1,
      };
    }
    assert.ok(byter.save());
    const persistedBytes = fs.statSync(byter.file).size;
    assert.ok(persistedBytes > 0 && persistedBytes <= 65536,
      `落盘文件必须收敛到字节预算内，实际 ${persistedBytes}B`);
  }

  // 10) 不可淘汰任务先预留记录/字节容量：拒绝新任务，但不得丢失已接受任务。
  {
    const retryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-chapter-ai-retrycap-'));
    extraDirs.push(retryDir);
    const retrier = new ChapterAiScheduler({
      dataDir: retryDir, apiKey: 'test', model: 'test', maxQueueEntries: 5, maxRecordEntries: 2,
      maxConcurrency: 2, saveDelayMs: 60000,
    });
    retrier.analyze = async () => { throw new Error('temporary fixture failure'); };
    assert.ok(retrier.enqueue('930', '1'));
    assert.ok(retrier.enqueue('930', '2'));
    assert.strictEqual(retrier.enqueue('930', '3'), null, '自动任务不得挤占未来的重试记录容量');
    assert.throws(() => retrier.enqueue('930', '3', 0, null, { manual: true }), (error) => error.code === 'queue_full');
    await Promise.all(retrier.state.queue.map((job) => retrier.runJob(job)));
    assert.strictEqual(Object.keys(retrier.state.records).length, 2);
    assert.ok(Object.values(retrier.state.records).every((record) => record.status === 'queued'));
    assert.strictEqual(retrier.flushSync(), true);
    assert.strictEqual(Object.keys(readState(retrier).records).length, 2);

    const pendingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-chapter-ai-pendingbytes-'));
    extraDirs.push(pendingDir);
    const options = { dataDir: pendingDir, apiKey: 'test', model: 'test', maxQueueEntries: 1000,
      maxRecordEntries: 1000, maxStateBytes: 65536, saveDelayMs: 60000 };
    const pending = new ChapterAiScheduler(options);
    assert.strictEqual(pending.config().maxQueueEntries, 15, '配置接口必须报告有效容量而非原始队列配置');
    const accepted = [];
    for (let i = 1; i <= 600; i++) {
      const photoId = String(1000000000000000n + BigInt(i));
      if (pending.enqueue('9999999999999999', photoId)) accepted.push(`9999999999999999:${photoId}`);
    }
    assert.ok(accepted.length > 0 && accepted.length < 600, '队列独占文件空间时也必须在准入处受限');
    assert.strictEqual(pending.flushSync(), true);
    assert.ok(fs.statSync(pending.file).size <= 65536);
    pending.analyze = async () => { throw new Error('\u0000'.repeat(500)); };
    for (const job of pending.state.queue) await pending.runJob(job);
    for (let i = 0; i < 500; i++) pending.touchPopularity(String(10000 + i));
    assert.strictEqual(pending.flushSync(), true, '最坏 JSON 转义错误与热度压力下仍可写入');
    assert.ok(fs.statSync(pending.file).size <= 65536, '失败重试记录不得突破字节硬上限');
    assert.deepStrictEqual(readState(pending).queue.map((job) => job.key).sort(), accepted.slice().sort());
    const restarted = new ChapterAiScheduler(options);
    assert.deepStrictEqual(restarted.state.queue.map((job) => job.key).sort(), accepted.slice().sort());
    assert.strictEqual(Object.keys(restarted.state.records).length, accepted.length);
    assert.ok(restarted.state.queue.every((job) => job.attempts === 1), '重启必须保留所有重试任务及其次数');

    const overflowDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-chapter-ai-oldbytes-'));
    extraDirs.push(overflowDir);
    const oldQueue = Array.from({ length: 600 }, (_, i) => ({
      key: `950:${i + 1}`, aid: '950', photoId: String(i + 1), priority: i, attempts: 0, nextAt: 0,
    }));
    fs.mkdirSync(path.join(overflowDir, 'chapter-ai'));
    fs.writeFileSync(path.join(overflowDir, 'chapter-ai', 'state.json'), JSON.stringify({ queue: oldQueue, records: {}, stats: {} }));
    const recovered = new ChapterAiScheduler({ ...options, dataDir: overflowDir });
    assert.strictEqual(JSON.parse(fs.readFileSync(recovered.recoveryFile, 'utf8')).queue.length, 600);
    assert.ok(recovered.state.queue.length < 600);
    assert.ok(fs.statSync(recovered.file).size <= 65536);
    assert.ok(recovered.state.queue.some((job) => job.priority === 599), '恢复时保留最高优先级任务');

    // 旧记录误带完整分析缓存：只移除旧缓存，重试次数、错误和任务仍保留。
    const cachedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-chapter-ai-pendingcache-'));
    extraDirs.push(cachedDir);
    const cached = new ChapterAiScheduler({ ...options, dataDir: cachedDir });
    cached.enqueue('951', '1');
    cached.state.queue[0].attempts = 2;
    cached.state.records['951:1'] = { key: '951:1', aid: '951', photoId: '1', status: 'queued',
      attempts: 2, updatedAt: 1, error: 'temporary failure', detailedDescription: '旧'.repeat(65536) };
    assert.strictEqual(cached.flushSync(), true);
    const compacted = readState(cached);
    assert.strictEqual(compacted.queue.length, 1);
    assert.strictEqual(compacted.queue[0].attempts, 2);
    assert.strictEqual(compacted.records['951:1'].error, 'temporary failure');
    assert.strictEqual(compacted.records['951:1'].detailedDescription, undefined);
    assert.ok(fs.statSync(cached.file).size <= 65536);

    // 淘汰必须使用字典真实键，不能被历史记录错误的 key 阻断。
    cached.state.records['wrong:key'] = { key: 'missing:key', status: 'failed', error: 'x'.repeat(65536) };
    assert.strictEqual(cached.save(), true);
    assert.strictEqual(cached.state.records['wrong:key'], undefined);
    assert.ok(cached.state.records['951:1'], '有队列对应的记录不可淘汰');
  }

  // 11) 无法收敛的异常状态拒写且保留 dirty：不把超大落盘伪装成成功。
  {
    const blockedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-chapter-ai-blocked-'));
    extraDirs.push(blockedDir);
    const blocked = new ChapterAiScheduler({
      dataDir: blockedDir, apiKey: 'test', model: 'test', maxStateBytes: 65536, saveDelayMs: 60000,
    });
    blocked.enqueue('960', '1');
    assert.strictEqual(blocked.flushSync(), true);
    const original = fs.readFileSync(blocked.file, 'utf8');
    blocked.state.scheduler.unsupported = 'x'.repeat(65536);
    assert.strictEqual(blocked.save(), false);
    assert.strictEqual(blocked.dirty, true);
    assert.strictEqual(blocked.capacityBlocked, true);
    assert.strictEqual(blocked.config().capacityBlocked, true);
    assert.match(blocked.lastSaveError, /字节上限/);
    assert.strictEqual(fs.readFileSync(blocked.file, 'utf8'), original, '失败写入不得覆盖上一次有效状态');
    assert.strictEqual(blocked.enqueue('960', '2'), null);
    assert.throws(() => blocked.enqueue('960', '2', 0, null, { manual: true }), (error) => error.code === 'queue_full');
    delete blocked.state.scheduler.unsupported;
    assert.strictEqual(blocked.flushSync(), true);
    assert.strictEqual(blocked.capacityBlocked, false);
    assert.ok(blocked.enqueue('960', '2'), '成功重试写入后恢复准入');
    blocked.flushSync();
  }

  console.log(`chapter-ai scheduler checks pass${sharpStubbed ? '（注意：本机未安装 sharp，图像编解码使用桩，编解码行为由 CI 覆盖）' : ''}`);
} finally {
  fs.writeFileSync = originalWriteFileSync;
  for (const target of [dir, ...extraDirs]) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch (_) {}
  }
}
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
