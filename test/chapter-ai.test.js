'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ChapterAiScheduler } = require('../lib/chapter-ai');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-chapter-ai-'));
async function main() {
try {
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
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
