'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-api-cache-test-'));
process.env.JMW_DATA_DIR = dataDir;
delete process.env.ACCESS_PASSWORD;
delete process.env.JM_API_BASE;

const { createApiCache, albumCacheKey, warmPublicFeeds } = require('../server');

const realNow = Date.now;
let now = 1_000_000;
Date.now = () => now;
const tick = () => new Promise((resolve) => setImmediate(resolve));

(async () => {
  // 1. 新鲜期内命中，不再调用 loader；并发请求单飞。
  {
    const cache = createApiCache(8);
    let calls = 0;
    const loader = async () => { calls++; await tick(); return { v: calls }; };
    const [a, b] = await Promise.all([cache.get('k', 1000, loader), cache.get('k', 1000, loader)]);
    assert.equal(calls, 1);
    assert.equal(a, b);
    now += 500;
    assert.deepEqual(await cache.get('k', 1000, loader), { v: 1 });
    assert.equal(calls, 1);
  }

  // 2. stale-while-revalidate：过期但在 stale 窗口内立即返回旧值，后台刷新一次。
  {
    const cache = createApiCache(8);
    let calls = 0;
    const loader = async () => { calls++; await tick(); return { v: calls }; };
    await cache.get('k', 1000, loader, { staleMs: 10_000 });
    now += 2000;
    const stale = await cache.get('k', 1000, loader, { staleMs: 10_000 });
    assert.deepEqual(stale, { v: 1 }, 'stale value returned without waiting');
    assert.equal(calls, 2, 'background refresh started');
    // 刷新进行中再次请求：仍返回旧值，不重复发起上游请求。
    assert.deepEqual(await cache.get('k', 1000, loader, { staleMs: 10_000 }), { v: 1 });
    assert.equal(calls, 2);
    await tick(); await tick();
    assert.deepEqual(await cache.get('k', 1000, loader, { staleMs: 10_000 }), { v: 2 });
    assert.equal(calls, 2);
  }

  // 3. 后台刷新失败保留旧值；超出 stale 窗口后阻塞加载，错误不缓存。
  {
    const cache = createApiCache(8);
    let fail = false;
    let calls = 0;
    const loader = async () => { calls++; await tick(); if (fail) throw new Error('upstream down'); return { v: calls }; };
    await cache.get('k', 1000, loader, { staleMs: 5000 });
    fail = true;
    now += 2000;
    assert.deepEqual(await cache.get('k', 1000, loader, { staleMs: 5000 }), { v: 1 });
    await tick(); await tick();
    assert.deepEqual(await cache.get('k', 1000, loader, { staleMs: 5000 }), { v: 1 }, 'failed refresh keeps stale value');
    now += 10_000;
    await assert.rejects(cache.get('k', 1000, loader, { staleMs: 5000 }), /upstream down/);
    fail = false;
    const fresh = await cache.get('k', 1000, loader, { staleMs: 5000 });
    assert.ok(fresh.v > 1, 'errors are never cached');
  }

  // 4. 无 staleMs 时保持原语义：过期即阻塞重新加载。
  {
    const cache = createApiCache(8);
    let calls = 0;
    const loader = async () => ({ v: ++calls });
    await cache.get('k', 1000, loader);
    now += 1500;
    assert.deepEqual(await cache.get('k', 1000, loader), { v: 2 });
  }

  // 5. deleteWhere 清除条目，并作废进行中的加载：结果交给等待者但不写回缓存。
  {
    const cache = createApiCache(8);
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const loader = async () => { calls++; if (calls === 1) await gate; return { v: calls }; };
    const pending = cache.get('album:s1:x', 1000, loader);
    await tick();
    cache.deleteWhere((key) => key.startsWith('album:s1:'));
    release();
    assert.deepEqual(await pending, { v: 1 });
    assert.deepEqual(await cache.get('album:s1:x', 1000, loader), { v: 2 }, 'invalidated flight must not be cached');
  }

  // 6. LRU 上限。
  {
    const cache = createApiCache(2);
    for (const key of ['a', 'b', 'c']) await cache.get(key, 1000, async () => key);
    assert.equal(cache.entries.size, 2);
    assert.ok(!cache.entries.has('a'));
  }

  // 7. 详情缓存键区分会话、用户、数据源与漫画 ID。
  {
    const anon = { sid: 's1', user: null };
    const user = { sid: 's1', user: { uid: '42' } };
    const other = { sid: 's2', user: null };
    const keys = new Set([
      albumCacheKey(anon, 'mixed', '1'), albumCacheKey(user, 'mixed', '1'),
      albumCacheKey(other, 'mixed', '1'), albumCacheKey(anon, 'builtin', '1'), albumCacheKey(anon, 'mixed', '2'),
    ]);
    assert.equal(keys.size, 5);
    assert.ok(albumCacheKey(anon, 'mixed', '1').startsWith('album:s1:'));
    assert.ok(albumCacheKey(anon, 'mixed', '12').endsWith(',"12"]'));
  }

  // 8. 闲置（无 API 活动）时预热不产生上游请求。
  assert.deepEqual(warmPublicFeeds(), []);

  Date.now = realNow;
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('api cache all pass');
  process.exit(0);
})().catch((error) => {
  Date.now = realNow;
  console.error(error);
  process.exit(1);
});
