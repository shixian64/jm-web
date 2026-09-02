'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const publicJs = path.join(root, 'public', 'js');

(async () => {
  const coreUrl = pathToFileURL(path.join(publicJs, 'descramble-core.js')).href;
  const { calcSeed, validateDecodeDimensions, drawDescrambled } = await import(coreUrl);

  // 共享核心输出必须保持与旧入口公开导出一致，防止 Worker 与主线程算法漂移。
  const descrambleUrl = pathToFileURL(path.join(publicJs, 'descramble.js')).href;
  const publicApi = await import(descrambleUrl);
  assert.strictEqual(publicApi.calcSeed(500000, '00001'), calcSeed(500000, '00001'));
  assert.deepStrictEqual(
    publicApi.validateDecodeDimensions(1200, 2000),
    validateDecodeDimensions(1200, 2000),
  );

  const draws = [];
  drawDescrambled({ drawImage: (...args) => draws.push(args) }, {}, 500000, '00001', 100, 103);
  assert(draws.length >= 2 && draws.length <= 20, '解扰必须按有限纵向分片绘制');
  assert.strictEqual(draws.reduce((sum, args) => sum + args[4], 0), 103,
    '目标分片高度总和必须完整覆盖原图');
  assert.strictEqual(draws.reduce((sum, args) => sum + args[8], 0), 103,
    '来源分片高度总和必须完整覆盖原图');

  const workerSource = fs.readFileSync(path.join(publicJs, 'descramble-worker.js'), 'utf8');
  const shellSource = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
  assert.match(workerSource, /new OffscreenCanvas\(width, height\)/,
    'Worker 必须在后台执行 Canvas 重排');
  assert.match(workerSource, /validateDecodeDimensions\(bitmap\.width, bitmap\.height/,
    'Worker 创建全尺寸 Canvas 前必须执行统一尺寸上限');
  assert.match(workerSource, /let decodeTail = Promise\.resolve\(\)/,
    'Worker 必须串行持有全尺寸 Canvas，避免多张 RGBA 工作集叠加');
  const descrambleSource = fs.readFileSync(path.join(publicJs, 'descramble.js'), 'utf8');
  assert.match(descrambleSource, /let mainDecodeTail = Promise\.resolve\(\)/,
    '兼容回退也必须串行持有全尺寸 Canvas');
  assert.match(shellSource, /['"]\/js\/descramble-worker\.js['"]/,
    'Service Worker 外壳必须缓存模块 Worker');
  assert.match(shellSource, /['"]\/js\/descramble-core\.js['"]/,
    'Service Worker 外壳必须缓存 Worker 的模块依赖');

  // 用最小 Worker 替身验证：浏览器支持模块 Worker 时优先走后台路径，
  // 原 Blob 不通过 transfer list 转移，仍可留在阅读器的字节预算 LRU 中。
  const resultBlob = new Blob(['decoded'], { type: 'image/webp' });
  let createdOptions;
  let posted;
  class FakeWorker {
    constructor(_url, options) { createdOptions = options; }
    postMessage(data, transfer) {
      posted = { data, transfer };
      queueMicrotask(() => this.onmessage({ data: {
        type: 'result', id: data.id, blob: resultBlob, width: 720, height: 1080,
      } }));
    }
    terminate() {}
  }
  global.Worker = FakeWorker;
  global.location = { origin: 'https://jm-web.test' };
  const workerModuleUrl = `${descrambleUrl}?worker-test=${Date.now()}`;
  const workerApi = await import(workerModuleUrl);
  const raw = new Blob(['raw'], { type: 'image/webp' });
  const decoded = await workerApi.decodeFromBlob(raw, 500000, '00001');
  assert.deepStrictEqual(createdOptions, { type: 'module', name: 'jmw-descramble' });
  assert.strictEqual(posted.data.blob, raw);
  assert.strictEqual(posted.transfer, undefined, 'Blob 不得被错误地放入 transferable 列表');
  assert.strictEqual(decoded.blob, resultBlob);
  assert.strictEqual(decoded.width, 720);
  assert.strictEqual(decoded.height, 1080);

  // 模块 Worker 构造失败（旧 Safari/WebView、CSP）时必须回退现有 Canvas
  // 路径，不能让所有需要解扰的页面一起失效。
  let bitmapCloseCount = 0;
  let mainThreadDraws = 0;
  let activeMainCanvases = 0;
  let maxActiveMainCanvases = 0;
  class ThrowingWorker {
    constructor() { throw new Error('module worker unsupported'); }
  }
  class FakeOffscreenCanvas {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() {
      return { imageSmoothingEnabled: true, drawImage() { mainThreadDraws++; } };
    }
    async convertToBlob() {
      activeMainCanvases++;
      maxActiveMainCanvases = Math.max(maxActiveMainCanvases, activeMainCanvases);
      await new Promise((resolve) => setTimeout(resolve, 0));
      activeMainCanvases--;
      return new Blob(['main-fallback'], { type: 'image/webp' });
    }
  }
  global.Worker = ThrowingWorker;
  global.OffscreenCanvas = FakeOffscreenCanvas;
  global.createImageBitmap = async () => ({
    width: 100,
    height: 103,
    close() { bitmapCloseCount++; },
  });
  const fallbackApi = await import(`${descrambleUrl}?fallback-test=${Date.now()}`);
  const [fallback, fallbackSecond] = await Promise.all([
    fallbackApi.decodeFromBlob(raw, 500000, '00001'),
    fallbackApi.decodeFromBlob(raw, 500000, '00002'),
  ]);
  assert.strictEqual(fallback.width, 100);
  assert.strictEqual(fallback.height, 103);
  assert(fallback.blob instanceof Blob && fallback.blob.size > 0);
  assert(fallbackSecond.blob instanceof Blob && fallbackSecond.blob.size > 0);
  assert(mainThreadDraws >= 2, '主线程回退必须执行实际分片重排');
  assert.strictEqual(bitmapCloseCount, 2, '主线程回退完成后必须主动关闭 ImageBitmap');
  assert.strictEqual(maxActiveMainCanvases, 1, '主线程回退不得并发持有全尺寸 Canvas');

  // AbortSignal 必须取消等待，并在当前无其他任务时终止 Worker；离开阅读器
  // 后不允许后台解码继续占用 CPU/内存。
  class HangingWorker {
    constructor() { HangingWorker.instance = this; this.terminated = false; }
    postMessage() {}
    terminate() { this.terminated = true; }
  }
  global.Worker = HangingWorker;
  const abortApi = await import(`${descrambleUrl}?abort-test=${Date.now()}`);
  const controller = new AbortController();
  const pending = abortApi.decodeFromBlob(raw, 500000, '00001', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error && error.name === 'AbortError');
  assert.strictEqual(HangingWorker.instance.terminated, true);

  const readerSource = fs.readFileSync(path.join(publicJs, 'reader.js'), 'utf8');
  const downloadsSource = fs.readFileSync(path.join(publicJs, 'downloads.js'), 'utf8');
  assert.match(readerSource, /memoryOptimized:[\s\S]{0,160}signal: imageSignal/,
    '切换章节/线路时必须把阅读器取消信号传入 Worker');
  assert.match(downloadsSource, /decodeFromBlob\([^\n]+\{ signal \}\)/,
    '暂停下载时必须把任务取消信号传入 Worker');

  delete global.Worker;
  delete global.location;
  delete global.OffscreenCanvas;
  delete global.createImageBitmap;
  console.log('descramble worker all pass');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
