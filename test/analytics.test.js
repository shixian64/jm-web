'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Analytics, dayKey, MAX_BYTES } = require('../lib/analytics');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-analytics-'));
  const instances = [];
  let now = Date.parse('2026-11-11T12:00:00Z');
  const create = (name, extra = {}) => {
    const a = new Analytics({ dataDir: path.join(root, name), secret: 'synthetic-test-secret', now: () => now, ...extra });
    instances.push(a); return a;
  };
  try {
    assert.strictEqual(dayKey(Date.parse('2026-11-10T15:59:59Z')), '2026-11-10');
    assert.strictEqual(dayKey(Date.parse('2026-11-10T16:00:00Z')), '2026-11-11');
    const a = create('normal');
    const visitor = a.visitor('');
    assert(visitor.fresh);
    assert.strictEqual(a.visitor(visitor.cookie).id, visitor.id);
    assert(!a.visitor(visitor.cookie).fresh);
    assert(a.visitor(visitor.cookie + 'x').fresh);
    const proof = a.proof(visitor.id, '123', '<unsafe title>');
    assert.deepStrictEqual(a.verifyProof(proof, visitor.id), { aid: '123', title: '<unsafe title>' });
    assert.strictEqual(a.verifyProof(proof, 'another-browser'), null);
    assert.strictEqual(a.verifyProof(proof + 'x', visitor.id), null);
    assert.strictEqual(a.verifyProof('😀', visitor.id), null);
    assert.strictEqual(a.verifyProof(proof.split('.')[0] + '.😀', visitor.id), null);
    assert.strictEqual(a.proof(visitor.id, '../invalid'), '');
    const add = (visitorId, kind = 'comic', aid = '123', uid = '') => a.record({ visitorId, kind, uid, comic: { aid, title: '<unsafe title>' } });
    add(visitor.id, 'page'); add(visitor.id); add(visitor.id);
    let result = a.summary(7);
    assert.deepStrictEqual(result.totals, { users: 1, accounts: 0, anonymous: 1, pageViews: 1, comicUsers: 1, comics: 1, comicViews: 1 });
    now += 31000; add(visitor.id);
    assert.strictEqual(a.summary(7).ranking[0].users, 1);
    assert.strictEqual(a.summary(7).ranking[0].views, 2);
    add('browser-2', 'comic', '456'); add('browser-3', 'comic', '456');
    assert.strictEqual(a.summary(7).ranking[0].aid, '456', '榜单按 UV 而非访问次数排序');
    add(visitor.id, 'active', '', 'account-42');
    result = a.summary(7);
    assert.strictEqual(result.totals.users, 3, '匿名转账号不可多算一人');
    assert.strictEqual(result.totals.accounts, 1);
    assert.strictEqual(result.ranking.find((r) => r.aid === '123').users, 1);
    add('another-device', 'comic', '123', 'account-42');
    assert.strictEqual(a.summary(7).totals.users, 3, '同账号跨设备去重');
    now += 86400000;
    add('another-device', 'page', '', 'account-42');
    add('another-device', 'comic', '123', 'account-42');
    result = a.summary(7);
    assert.strictEqual(result.totals.users, 3, '范围 UV 不可累加每日 UV');
    assert.strictEqual(result.trend.reduce((sum, r) => sum + r.users, 0), 4);
    assert.strictEqual(a.summary(1).totals.users, 1);
    assert.strictEqual(a.verifyProof(proof, visitor.id), null, '过期凭据必须拒绝');
    // 元数据获取本身不算漫画访问；只补齐已有标题。
    const views = a.summary(7).totals.comicViews;
    a.proof(visitor.id, '123', 'Updated title');
    assert.strictEqual(a.summary(7).totals.comicViews, views);
    assert.strictEqual(a.summary(7).ranking.find((r) => r.aid === '123').title, 'Updated title');
    await a.flush();
    const saved = fs.readFileSync(a.file, 'utf8');
    for (const secret of ['account-42', visitor.id, 'browser-2', 'another-device']) assert(!saved.includes(secret), '磁盘不得出现原始身份');
    const publicData = JSON.stringify(a.summary(7));
    for (const id of Object.keys(a.state.days[dayKey(now)].users)) assert(!publicData.includes(id), '响应不得包含个人哈希');
    const restored = create('normal');
    assert.deepStrictEqual(restored.summary(7).totals, a.summary(7).totals);
    now += 30 * 86400000;
    assert.strictEqual(a.summary(30).totals.users, 0);
    assert.strictEqual(Object.keys(a.state.days).length, 0, '过期数据从持久化状态删除');
    await a.flush();

    // 容量不够时不淘汰近期 UV，保留准确的已收集子集并显式提示不完整。
    const tiny = create('tiny', { maxBytes: 10000 });
    for (let i = 0; i < 100; i++) tiny.record({ visitorId: `anon-${i}`, kind: 'comic', comic: { aid: '1', title: '"'.repeat(160) } });
    assert(tiny.summary(1).limited);
    assert(tiny.budget <= tiny.maxBytes);
    for (let i = 1; i < 30; i++) {
      now += 86400000;
      for (let j = 0; j < 20; j++) tiny.record({ visitorId: `day-${i}-${j}`, kind: 'comic', comic: { aid: String(i + 1), title: '"'.repeat(160) } });
      assert(tiny.budget <= tiny.maxBytes, '跨日告警容器必须在预算内');
      assert(Buffer.byteLength(tiny.serialize()) <= tiny.maxBytes);
    }
    await tiny.flush();
    assert(fs.statSync(tiny.file).size <= tiny.maxBytes);
    assert(MAX_BYTES === 8388608);
    const merge = create('merge');
    merge.record({ visitorId: 'a', kind: 'comic', comic: { aid: '1', title: '' } });
    merge.record({ visitorId: 'b', uid: 'same', kind: 'comic', comic: { aid: '1', title: '' } });
    merge.record({ visitorId: 'a', uid: 'same', kind: 'active' });
    assert.strictEqual(merge.summary(1).totals.users, 1);
    assert.strictEqual(merge.summary(1).ranking[0].users, 1);
    assert.strictEqual(merge.summary(1).ranking[0].views, 2);
    // 合并写盘过程中新增事件不能丢失，关闭等待最终版本。
    merge.record({ visitorId: 'c', kind: 'page' });
    const flushing = merge.flush();
    merge.record({ visitorId: 'd', kind: 'page' });
    await flushing; await merge.close();
    const mergedRestored = create('merge');
    assert.strictEqual(mergedRestored.summary(1).totals.users, 3);

    const corruptDir = path.join(root, 'corrupt', 'analytics');
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.writeFileSync(path.join(corruptDir, 'state.json'), '{invalid');
    const corrupt = create('corrupt');
    assert(!corrupt.summary().available);
    assert.strictEqual(corrupt.record({ visitorId: 'x', kind: 'page' }), false);
    await corrupt.close();
    assert.strictEqual(fs.readFileSync(corrupt.file, 'utf8'), '{invalid', '损坏状态不得被空数据覆盖');
    const fail = create('unwritable');
    fs.mkdirSync(path.dirname(fail.file), { recursive: true });
    fs.mkdirSync(fail.file);
    fail.record({ visitorId: 'x', kind: 'page' });
    await fail.flush();
    assert(!fail.summary().persistenceOk);
    fs.rmdirSync(fail.file);
    await fail.flush();
    assert(fail.summary().persistenceOk);
    console.log('analytics all pass (dedup, promotion, windows, privacy, proof, bounds, recovery, atomic flush)');
  } finally {
    await Promise.all(instances.map((a) => a.close()));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
