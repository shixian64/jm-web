'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

(async () => {
  const readerPath = path.resolve(__dirname, '..', 'public', 'js', 'reader.js');
  const readerUrl = pathToFileURL(readerPath).href;
  const {
    readerPrefetchOrder,
    filterReaderPrefetchWindow,
    scheduleReaderPrefetch,
    backfillReaderImageDimensions,
    readerDecodedRecord,
    readerRawCacheBytes,
    blobByteSize,
    recommendedDecodeConcurrency,
  } = await import(readerUrl);
  const descrambleUrl = pathToFileURL(path.resolve(__dirname, '..', 'public', 'js', 'descramble.js')).href;
  const { validateDecodeDimensions } = await import(descrambleUrl);

  assert.strictEqual(blobByteSize({ size: 1024 }), 1024);
  assert.strictEqual(blobByteSize({ size: 0 }), 0);
  assert.strictEqual(readerRawCacheBytes({ memoryOptimized: true }), 32 * 1024 * 1024);
  assert.strictEqual(readerRawCacheBytes({ deviceMemory: 1 }), 48 * 1024 * 1024);
  assert.strictEqual(readerRawCacheBytes({ deviceMemory: 8 }), 128 * 1024 * 1024);
  assert.strictEqual(recommendedDecodeConcurrency({ deviceMemory: 0.5 }), 1);
  assert.strictEqual(recommendedDecodeConcurrency({ deviceMemory: 2 }), 2);
  assert.strictEqual(recommendedDecodeConcurrency({ deviceMemory: 8 }), 3);
  assert.strictEqual(recommendedDecodeConcurrency({ memoryOptimized: true, configured: 4 }), 4);
  assert.throws(
    () => validateDecodeDimensions(4000, 10000),
    /图片过大/,
    '超大长条图必须在创建 Canvas 前被拒绝',
  );
  assert.throws(
    () => validateDecodeDimensions(500, 40000),
    /图片过大/,
    '单轴超过浏览器 Canvas 上限的长条图必须被拒绝',
  );
  assert.throws(
    () => validateDecodeDimensions(5000, 5000, { memoryOptimized: true }),
    /图片过大/,
    '内存优化模式应使用更低的解码预算',
  );
  assert.deepStrictEqual(validateDecodeDimensions(1200, 2000), {
    width: 1200,
    height: 2000,
    pixels: 2400000,
    estimatedBytes: 19200000,
  });

  // 半径 2 的窗口只能覆盖 current ± 2，不能再隐式扩大为 n + 2。
  // 顺序对齐客户端：当前页完成后先后续页，再前序页，而不是交替调度。
  assert.deepStrictEqual(readerPrefetchOrder(5, 12, 2), [5, 6, 7, 4, 3]);
  assert.deepStrictEqual(readerPrefetchOrder(0, 12, 2), [0, 1, 2]);
  assert.deepStrictEqual(readerPrefetchOrder(11, 12, 2), [11, 10, 9]);
  assert.deepStrictEqual(readerPrefetchOrder(-1, 12, 2), []);
  // 恢复到中间页时，即使 IntersectionObserver 报告了视口顶部槽位，n=1
  // 也只能调度 [current-1, current, current+1]。
  assert.deepStrictEqual(filterReaderPrefetchWindow([0, 1, 4, 5, 6, 9], 5, 12, 1), [4, 5, 6]);

  // 当前页 Promise 未完成时，任何邻页都不得进入下载/解码队列。
  const current = deferred();
  const calls = [];
  const delivered = [];
  const order = readerPrefetchOrder(5, 12, 2);
  const scheduled = scheduleReaderPrefetch(order, (index) => {
    calls.push(index);
    return index === 5 ? current.promise : Promise.resolve({ index });
  }, (index) => delivered.push(index));
  assert.deepStrictEqual(calls, [5]);
  await Promise.resolve();
  assert.deepStrictEqual(calls, [5]);
  current.resolve({ index: 5 });
  await scheduled;
  assert.deepStrictEqual(calls, [5, 6, 7, 4, 3]);
  await Promise.resolve();
  assert.deepStrictEqual(delivered, [5, 6, 7, 4, 3]);

  // 当前调度失效后，即使迟到的当前页完成，也不能再启动旧窗口的邻页。
  const staleCurrent = deferred();
  const staleCalls = [];
  const discarded = [];
  let active = true;
  const staleTask = scheduleReaderPrefetch([4, 5, 3], (index) => {
    staleCalls.push(index);
    return staleCurrent.promise;
  }, null, () => active, (index) => discarded.push(index));
  active = false;
  staleCurrent.resolve({ index: 4 });
  await staleTask;
  assert.deepStrictEqual(staleCalls, [4]);
  assert.deepStrictEqual(discarded, [4]);

  // 原图路径不得为了读取尺寸调用 createImageBitmap 做一次完整预解码。
  const source = fs.readFileSync(readerPath, 'utf8');
  const decodeStart = source.indexOf('async function doDecode');
  const decodeEnd = source.indexOf('\n  function waitForDecodeSlot', decodeStart);
  assert.ok(decodeStart >= 0 && decodeEnd > decodeStart);
  assert.ok(!source.slice(decodeStart, decodeEnd).includes('createImageBitmap'));
  const rawStart = source.indexOf('const url = URL.createObjectURL(blob);', decodeStart);
  const rawEnd = source.indexOf('return rec;', rawStart);
  assert.ok(rawStart >= 0 && rawEnd > rawStart);
  // 原图路径只允许“读取”已验证尺寸用于保留（行为由下方 readerDecodedRecord
  // 用例锁定）；出现写入、删除或清空 dims 即回归。
  const rawSource = source.slice(rawStart, rawEnd);
  assert.ok(
    rawSource.includes('state.dims.get(idx)'),
    '原图路径必须读取已验证尺寸并传给 readerDecodedRecord（丢失该读取即回归）',
  );
  assert.ok(
    !/state\.dims\.(?:set|delete|clear)\s*\(/.test(rawSource),
    '原图路径不得写入或清除已验证尺寸',
  );

  // 行为验证：重建解码记录必须保留缓存的已验证尺寸（LRU 重用不丢宽高）。
  assert.deepStrictEqual(
    readerDecodedRecord({ url: 'blob:raw-1', generation: 7, sourceVersion: 2, dims: { width: 1440, height: 2160 } }),
    { url: 'blob:raw-1', generation: 7, sourceVersion: 2, width: 1440, height: 2160 },
    'raws LRU 重用时必须保留早先回填的尺寸',
  );
  // 没有已验证尺寸时不伪造——undefined 等待挂载后的 onload 回填。
  assert.deepStrictEqual(
    readerDecodedRecord({ url: 'blob:raw-2', generation: 7, sourceVersion: 2, dims: undefined }),
    { url: 'blob:raw-2', generation: 7, sourceVersion: 2, width: undefined, height: undefined },
    '缺少已验证尺寸时不得伪造宽高',
  );
  assert.deepStrictEqual(
    readerDecodedRecord({ url: 'blob:raw-3', generation: 1, sourceVersion: 1, dims: null }),
    { url: 'blob:raw-3', generation: 1, sourceVersion: 1, width: undefined, height: undefined },
    'dims 缺失（null）与 undefined 同样不得伪造宽高',
  );
  // 端到端口径：onload 回填写入 state.dims 后，重建记录能读到同一尺寸。
  {
    const dims = new Map();
    const record = { url: 'blob:page-9', generation: 3, sourceVersion: 1 };
    const state = { destroyed: false, decoded: new Map([[9, record]]), dims };
    const slot = { isConnected: true, dataset: { idx: '9', objectUrl: record.url } };
    const image = { naturalWidth: 800, naturalHeight: 600 };
    assert.strictEqual(backfillReaderImageDimensions({
      image, slot, index: 9, record, state, generation: 3, sourceVersion: 1,
    }), true);
    const rebuilt = readerDecodedRecord({
      url: 'blob:page-9', generation: 3, sourceVersion: 1, dims: dims.get(9),
    });
    assert.deepStrictEqual(rebuilt, { url: 'blob:page-9', generation: 3, sourceVersion: 1, width: 800, height: 600 });
  }

  const prefetchStart = source.indexOf('function prefetchAround(idx)');
  const prefetchEnd = source.indexOf('\n  function placeholderFor', prefetchStart);
  const prefetchSource = source.slice(prefetchStart, prefetchEnd);
  assert.ok(prefetchStart >= 0 && prefetchEnd > prefetchStart);
  assert.match(prefetchSource, /if \(k < start \|\| k > end\) evictDecoded\(k, v\)/);
  assert.ok(!prefetchSource.includes('start - 4'));
  assert.ok(!prefetchSource.includes('end + 4'));

  // 尺寸只由仍属于当前槽位、当前代次的最终 <img> onload 安全回填。
  const record = { url: 'blob:page-3', generation: 7, sourceVersion: 2 };
  const state = {
    destroyed: false,
    decoded: new Map([[3, record]]),
    dims: new Map(),
  };
  const slot = {
    isConnected: true,
    dataset: { idx: '3', objectUrl: record.url },
  };
  const image = { naturalWidth: 1440, naturalHeight: 2160 };
  assert.strictEqual(backfillReaderImageDimensions({
    image, slot, index: 3, record, state, generation: 7, sourceVersion: 2,
  }), true);
  assert.deepStrictEqual(state.dims.get(3), { width: 1440, height: 2160 });
  assert.strictEqual(record.width, 1440);
  assert.strictEqual(record.height, 2160);

  const staleRecord = { url: 'blob:stale', generation: 6, sourceVersion: 2 };
  assert.strictEqual(backfillReaderImageDimensions({
    image,
    slot: { isConnected: true, dataset: { idx: '3', objectUrl: staleRecord.url } },
    index: 3,
    record: staleRecord,
    state,
    generation: 7,
    sourceVersion: 2,
  }), false);
  assert.strictEqual(staleRecord.width, undefined);

  const replacedSlot = { isConnected: true, dataset: { idx: '4', objectUrl: record.url } };
  assert.strictEqual(backfillReaderImageDimensions({
    image, slot: replacedSlot, index: 3, record, state, generation: 7, sourceVersion: 2,
  }), false);

  const invalidImage = { naturalWidth: 0, naturalHeight: 0 };
  assert.strictEqual(backfillReaderImageDimensions({
    image: invalidImage, slot, index: 3, record, state, generation: 7, sourceVersion: 2,
  }), false);

  console.log('reader performance all pass');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
