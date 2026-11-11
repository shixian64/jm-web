'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-analytics-api-'));
process.env.JMW_DATA_DIR = dataDir;
process.env.ACCESS_PASSWORD = 'synthetic-analytics-access-password';
delete process.env.AI_API_KEY;
delete process.env.JM_API_BASE;
const { server, analytics } = require('../server');
const features = require('../lib/features');
const settings = require('../lib/settings');
const sessions = require('../lib/sessions');
const nativeFetch = global.fetch;
const encrypted = (token, value) => {
  const cipher = crypto.createCipheriv('aes-256-ecb', Buffer.from(token, 'utf8'), null);
  return new Response(JSON.stringify({ code: 200, data: Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]).toString('base64') }));
};
(async () => {
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const cookies = new Map();
    const call = async (url, options = {}, jar = cookies) => {
      const res = await nativeFetch(base + url, { ...options, headers: { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...options.headers } });
      for (const cookie of res.headers.getSetCookie()) {
        const part = cookie.split(';')[0]; const eq = part.indexOf('=');
        jar.set(part.slice(0, eq), part.slice(eq + 1));
      }
      return res;
    };
    const post = (url, body, options = {}, jar = cookies) => call(url, { method: 'POST', body: JSON.stringify(body), ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers } }, jar);
    assert.strictEqual((await call('/api/analytics')).status, 401);
    assert.strictEqual((await post('/api/analytics/event', { kind: 'page' })).status, 401);
    assert.strictEqual((await post('/api/auth', { password: process.env.ACCESS_PASSWORD })).status, 200);
    let res = await call('/api/me', { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.strictEqual(res.status, 200);
    const setCookies = res.headers.getSetCookie();
    assert(setCookies.some((v) => /^jmw_sid=/.test(v)));
    assert(setCookies.some((v) => /^jmw_visitor=/.test(v) && /HttpOnly/.test(v) && /SameSite=Lax/.test(v) && /; Secure/.test(v)), '匿名 cookie 不得覆盖 session cookie');
    assert(!JSON.stringify(await res.json()).includes(cookies.get('jmw_visitor')));
    assert.strictEqual((await call('/api/analytics', { method: 'DELETE' })).status, 405);
    assert.strictEqual((await call('/api/analytics?days=2')).status, 400);
    assert.strictEqual((await call('/api/analytics?page=-1')).status, 400);
    assert.strictEqual((await post('/api/analytics/event', { kind: 'page' }, { headers: { Origin: 'https://cross-origin.invalid' } })).status, 403);
    assert.strictEqual((await call('/api/analytics/event', { method: 'POST', body: 'x', headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.strictEqual((await post('/api/analytics/event', { kind: 'arbitrary' })).status, 400);
    assert.strictEqual((await post('/api/analytics/event', { kind: 'comic', aid: '123', title: 'forged' })).status, 400);
    let data = await (await call('/api/analytics')).json();
    assert.strictEqual(data.totals.users, 0, 'GET 查询统计不得产生用户或访问记录');
    features.dohLookup = async () => [{ address: '93.184.216.34', family: 4 }];
    features.outboundFetch = async (url, options) => {
      const target = new URL(url);
      if (target.pathname === '/album') return encrypted(options.headers.token, { id: '123', name: '<img src=x onerror=alert(1)>', series: [] });
      if (target.pathname === '/chapter_view_template') return new Response(`<script>const result = { images: ['00001.webp'] }; const config = { jmid: '124', imghost: '${settings.imageHosts()[0]}', cache: '' }; var aid = 123; var scramble_id = 220980;</script>`, { headers: { 'Content-Type': 'text/html' } });
      throw new Error('unexpected mock endpoint');
    };
    const album = await (await call('/api/album?id=123')).json();
    assert(album.analyticsProof);
    const chapter = await (await call('/api/chapter?id=124')).json();
    assert(chapter.analyticsProof);
    data = await (await call('/api/analytics')).json();
    assert.strictEqual(data.totals.comicUsers, 0, '后台获取元数据和章节不得记漫画访问');
    assert.strictEqual((await post('/api/analytics/event', { kind: 'page' })).status, 200);
    assert.strictEqual((await post('/api/analytics/event', { kind: 'comic', proof: album.analyticsProof })).status, 200);
    assert.strictEqual((await post('/api/analytics/event', { kind: 'comic', proof: chapter.analyticsProof })).status, 200);
    data = await (await call('/api/analytics')).json();
    assert.strictEqual(data.totals.users, 1);
    assert.strictEqual(data.ranking[0].users, 1);
    assert.strictEqual(data.ranking[0].views, 1, '详情到章节短时间重复访问合并');
    assert.strictEqual(data.ranking[0].aid, '123', '章节必须归属于专辑 ID 而不是章节 ID');
    assert.strictEqual(data.ranking[0].title, '<img src=x onerror=alert(1)>');
    assert.strictEqual((await call('/api/analytics')).headers.get('Cache-Control'), 'no-store');
    const other = new Map([['jmw_auth', cookies.get('jmw_auth')]]);
    await call('/api/me', {}, other);
    assert.strictEqual((await post('/api/analytics/event', { kind: 'comic', proof: album.analyticsProof }, {}, other)).status, 400, '浏览凭据不得跨浏览器使用');
    // 有用户资料但没有 AVS，不能当作有效登录用户。
    const jar = sessions.loadJar(cookies.get('jmw_sid'));
    jar.user = { uid: 'synthetic-account-77', username: 'not-public' };
    await post('/api/analytics/event', { kind: 'active' });
    assert.strictEqual((await (await call('/api/analytics')).json()).totals.accounts, 0);
    jar.cookiesByOrigin[settings.allDataSourceHosts()[0]] = { AVS: 'synthetic-upstream-session' };
    await post('/api/analytics/event', { kind: 'active' });
    data = await (await call('/api/analytics')).json();
    assert.strictEqual(data.totals.accounts, 1);
    assert.strictEqual(data.totals.users, 1, '匿名转账号应归并');
    const publicJson = JSON.stringify(data);
    for (const secret of ['synthetic-account-77', 'not-public', 'synthetic-upstream-session', cookies.get('jmw_visitor')]) assert(!publicJson.includes(secret));
    for (let i = 0; i < 25; i++) analytics.record({ visitorId: 'synthetic-pagination', kind: 'comic', comic: { aid: String(2000 + i), title: `Synthetic comic ${i}` } });
    const paged = await (await call('/api/analytics?page=2')).json();
    assert.strictEqual(paged.ranking.length, 6);
    assert.strictEqual(paged.total, 26);
    assert.strictEqual((await (await call('/api/analytics?page=100000')).json()).page, 2, '范围外页码收敛到最后一页');
    await analytics.flush();
    assert(fs.existsSync(analytics.file));
    for (const secret of ['synthetic-account-77', 'not-public', 'synthetic-upstream-session']) assert(!fs.readFileSync(analytics.file, 'utf8').includes(secret));
    console.log('analytics API all pass (gate, CSRF, methods, cookie, proof, frontend-only events, auth, privacy, persistence)');
  } finally {
    sessions.flushAll();
    await analytics.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
