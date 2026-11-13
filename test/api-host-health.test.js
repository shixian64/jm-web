'use strict';
// 缩短单次/总超时，使截短预算用例毫秒级完成（须在加载 jm-api 前设置）。
process.env.JM_TIMEOUT = '60';
process.env.JM_TOTAL_TIMEOUT = '100';
const assert = require('node:assert/strict');
const {
  upstreamRequest, resetApiHostHealth, orderHostsByHealth, noteApiHostFailure, noteApiHostSuccess,
} = require('../lib/jm-api');

const PRIMARY = 'https://primary.example';
const BACKUP = 'https://backup.example';
const THIRD = 'https://third.example';
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const ok = () => new Response(JSON.stringify({ code: 200, data: { ok: true } }));

(async () => {
  // 1. 首选线路 5xx 后进入冷却：下一次请求直接从备用线路开始。
  resetApiHostHealth();
  {
    const calls = [];
    const fetchImpl = async (url) => {
      const origin = new URL(url).origin;
      calls.push(origin);
      return origin === PRIMARY ? new Response('boom', { status: 500 }) : ok();
    };
    await upstreamRequest({ path: '/week', hosts: [PRIMARY, BACKUP], cookieHosts: [], dnsLookup: publicDns, fetchImpl });
    assert.deepEqual(calls, [PRIMARY, BACKUP]);
    calls.length = 0;
    const trace = {};
    await upstreamRequest({ path: '/week', hosts: [PRIMARY, BACKUP], cookieHosts: [], dnsLookup: publicDns, fetchImpl, trace });
    assert.deepEqual(calls, [BACKUP], 'cooling host must be tried after healthy hosts');
    assert.equal(trace.upstream_host, 'backup.example');
  }

  // 2. 非 JSON 风控页、网络错误同样计入；所有线路都冷却时仍按原顺序全部尝试。
  resetApiHostHealth();
  {
    const calls = [];
    const fetchImpl = async (url) => {
      const origin = new URL(url).origin;
      calls.push(origin);
      if (origin === PRIMARY) return new Response('<html>blocked</html>');
      if (origin === BACKUP) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      return ok();
    };
    await upstreamRequest({ path: '/week', hosts: [PRIMARY, BACKUP, THIRD], cookieHosts: [], dnsLookup: publicDns, fetchImpl });
    assert.deepEqual(calls, [PRIMARY, BACKUP, THIRD]);
    calls.length = 0;
    await upstreamRequest({ path: '/week', hosts: [PRIMARY, BACKUP, THIRD], cookieHosts: [], dnsLookup: publicDns, fetchImpl });
    assert.deepEqual(calls, [THIRD]);

    noteApiHostFailure(THIRD);
    const all = orderHostsByHealth([PRIMARY, BACKUP, THIRD], null, new Set());
    assert.deepEqual(all, [PRIMARY, BACKUP, THIRD], 'all cooling keeps original order, never drops hosts');
  }

  // 3. 成功清除冷却；冷却到期后恢复原顺序。
  resetApiHostHealth();
  {
    const now = 1_000_000;
    noteApiHostFailure(PRIMARY, now);
    assert.deepEqual(orderHostsByHealth([PRIMARY, BACKUP], null, new Set(), now + 1000), [BACKUP, PRIMARY]);
    assert.deepEqual(orderHostsByHealth([PRIMARY, BACKUP], null, new Set(), now + 30_001), [PRIMARY, BACKUP]);
    // 连续失败指数退避：第二次失败冷却 60 秒。
    noteApiHostFailure(PRIMARY, now);
    assert.deepEqual(orderHostsByHealth([PRIMARY, BACKUP], null, new Set(), now + 45_000), [BACKUP, PRIMARY]);
    noteApiHostSuccess(PRIMARY);
    assert.deepEqual(orderHostsByHealth([PRIMARY, BACKUP], null, new Set(), now + 1000), [PRIMARY, BACKUP]);
  }

  // 4. 首选线路持有该会话的 AVS 登录 Cookie 时保持首位，避免登录态换线。
  resetApiHostHealth();
  {
    noteApiHostFailure(PRIMARY);
    const jar = { cookiesByOrigin: { [PRIMARY]: { AVS: 'fixture' } } };
    const cookieOrigins = new Set([PRIMARY, BACKUP]);
    assert.deepEqual(orderHostsByHealth([PRIMARY, BACKUP], jar, cookieOrigins), [PRIMARY, BACKUP]);
    assert.deepEqual(orderHostsByHealth([PRIMARY, BACKUP], { cookiesByOrigin: {} }, cookieOrigins), [BACKUP, PRIMARY]);
    // 固定首位之外的线路仍按健康度排序。
    noteApiHostFailure(BACKUP);
    assert.deepEqual(orderHostsByHealth([PRIMARY, BACKUP, THIRD], jar, cookieOrigins), [PRIMARY, THIRD, BACKUP]);
  }

  // 4b. 会话选定/记住的线路（jar.apiHost）保持首位，不被其他请求造成的冷却改写。
  resetApiHostHealth();
  {
    noteApiHostFailure(PRIMARY);
    const jar = { cookiesByOrigin: {}, apiHost: PRIMARY };
    assert.deepEqual(orderHostsByHealth([PRIMARY, BACKUP], jar, new Set()), [PRIMARY, BACKUP]);
    const calls = [];
    await upstreamRequest({
      path: '/week', hosts: [PRIMARY, BACKUP], cookieHosts: [], jar, dnsLookup: publicDns,
      fetchImpl: async (url) => { calls.push(new URL(url).origin); return ok(); },
    });
    assert.deepEqual(calls, [PRIMARY], 'session-selected host must be tried first');
    // 未选定线路的会话仍按健康度排序。
    noteApiHostFailure(PRIMARY);
    assert.deepEqual(orderHostsByHealth([PRIMARY, BACKUP], { cookiesByOrigin: {}, apiHost: '' }, new Set()), [BACKUP, PRIMARY]);
  }

  // 4c. 总预算剩余不足造成的截短超时不计入线路故障。
  resetApiHostHealth();
  {
    const { TIMEOUT, TOTAL_TIMEOUT } = require('../lib/jm-api');
    assert.ok(TOTAL_TIMEOUT < TIMEOUT * 2, 'test premise: second attempt budget is truncated');
    const calls = [];
    await assert.rejects(upstreamRequest({
      path: '/week', hosts: [PRIMARY, BACKUP], cookieHosts: [], dnsLookup: publicDns,
      fetchImpl: (url, opts) => new Promise((_, reject) => {
        calls.push(new URL(url).origin);
        opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
      }),
    }));
    assert.deepEqual(calls, [PRIMARY, BACKUP]);
    // PRIMARY 用满整段单次预算超时 → 冷却；BACKUP 只拿到截短的剩余预算 → 不冷却。
    assert.deepEqual(orderHostsByHealth([PRIMARY, BACKUP], null, new Set()), [BACKUP, PRIMARY]);
    assert.deepEqual(orderHostsByHealth([BACKUP, THIRD], null, new Set()), [BACKUP, THIRD]);
  }

  // 5. 客户端取消不是线路故障，不能让线路进入冷却。
  resetApiHostHealth();
  {
    const controller = new AbortController();
    await assert.rejects(upstreamRequest({
      path: '/week', hosts: [PRIMARY, BACKUP], cookieHosts: [], dnsLookup: publicDns, signal: controller.signal,
      fetchImpl: async () => { controller.abort(); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); },
    }));
    assert.deepEqual(orderHostsByHealth([PRIMARY, BACKUP], null, new Set()), [PRIMARY, BACKUP]);
  }

  // 6. 资源级 404/401 不是线路故障。
  resetApiHostHealth();
  {
    await assert.rejects(upstreamRequest({
      path: '/album', hosts: [PRIMARY, BACKUP], cookieHosts: [], dnsLookup: publicDns,
      fetchImpl: async () => new Response('missing', { status: 404 }),
    }), (error) => error.code === 404);
    assert.deepEqual(orderHostsByHealth([PRIMARY, BACKUP], null, new Set()), [PRIMARY, BACKUP]);
  }

  // 7. 失效保活连接判定：仅对端重置/断开类错误触发一次新连接重试；空闲连接可被安全丢弃。
  {
    const { isStaleSocketError, dropIdleUpstreamSockets, upstreamAgent, freshConnectionAgent } = require('../lib/https-fetch');
    assert.ok(isStaleSocketError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })));
    assert.ok(isStaleSocketError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
    assert.ok(isStaleSocketError(new Error('socket hang up')));
    assert.ok(!isStaleSocketError(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    assert.ok(!isStaleSocketError(new Error('certificate has expired')));
    assert.equal(upstreamAgent.keepAlive, true);
    assert.equal(freshConnectionAgent.keepAlive, false);
    let destroyed = 0;
    upstreamAgent.freeSockets['test:443:'] = [{ destroy() { destroyed++; } }, { destroy() { destroyed++; } }];
    dropIdleUpstreamSockets();
    assert.equal(destroyed, 2);
    delete upstreamAgent.freeSockets['test:443:'];
  }

  resetApiHostHealth();
  console.log('api host health all pass');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
