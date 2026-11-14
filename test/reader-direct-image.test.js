'use strict';
// 阅读器章节图片直连 CDN：白名单、CSP 一致性、失败回退代理与冷却。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmw-direct-image-test-'));
process.env.JMW_DATA_DIR = dataDir;
delete process.env.ACCESS_PASSWORD;
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const imageResponse = (body = 'img', type = 'image/webp', status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': type } });

(async () => {
  const { chapterImgDirectSrc } = await import(pathToFileURL(path.join(__dirname, '../public/js/api.js')).href);
  const { fetchChapterImageBlob, resetDirectImageHealth, directImageAvailable } =
    await import(pathToFileURL(path.join(__dirname, '../public/js/reader.js')).href);
  const { IMAGE_DIRECT_CSP_SOURCES } = require('../server');
  const { BUILTIN_IMAGE_HOSTS } = require('../lib/jm-api');

  // 1. 白名单：只接受 https、已知 CDN 主机、/media/ 路径。
  const sample = 'https://cdn-msp3.jmdanjonproxy.vip/media/photos/1485993/00001.webp?v=1793783654';
  assert.equal(chapterImgDirectSrc(sample), sample);
  assert.equal(chapterImgDirectSrc(sample + '#x'), sample);
  for (const bad of [
    'http://cdn-msp3.jmdanjonproxy.vip/media/photos/1/1.webp',
    'https://evil.example/media/photos/1/1.webp',
    'https://cdn-msp.jmdanjonproxy.vip.evil.example/media/photos/1/1.webp',
    'https://cdn-msp.jmapiproxy9.cc/media/photos/1/1.webp',
    'https://cdn-msp.jmdanjonproxy.vip/api/secret',
    'https://user@cdn-msp.jmdanjonproxy.vip/media/photos/1/1.webp',
    'https://cdn-msp.jmdanjonproxy.vip:8443/media/photos/1/1.webp',
    '/media/photos/1/1.webp', '', null,
  ]) assert.equal(chapterImgDirectSrc(bad), '', `must reject ${bad}`);

  // 2. 客户端白名单内的每个主机都必须被 CSP connect-src 放行，否则直连必然失败。
  const cspAllows = (hostname) => IMAGE_DIRECT_CSP_SOURCES.some((source) => {
    const suffix = source.replace(/^https:\/\/\*/, '');
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  });
  const observed = ['cdn-msp.jmdanjonproxy.vip', 'cdn-msp3.jmapiproxy3.cc', 'tencent.jmdanjonproxy.xyz',
    'cdn-msp12.jmdanjonproxy.xyz', 'cdn-msp2.jmapiproxy1.cc'];
  for (const host of [...BUILTIN_IMAGE_HOSTS.map((h) => new URL(h).hostname), ...observed]) {
    const url = `https://${host}/media/photos/1/00001.webp`;
    assert.equal(chapterImgDirectSrc(url), url, `builtin/observed host must be direct-eligible: ${host}`);
    assert.ok(cspAllows(host), `CSP connect-src must allow ${host}`);
  }

  const saved = global.fetch;
  try {
    // 3. 直连成功：不请求代理，且不带 Cookie/Referer。
    resetDirectImageHealth();
    let calls = [];
    global.fetch = async (url, opts) => { calls.push({ url, opts }); return imageResponse('direct'); };
    let blob = await fetchChapterImageBlob({ directUrl: sample, proxyUrl: '/api/img?u=x', headers: {} });
    assert.equal(await blob.text(), 'direct');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, sample);
    assert.equal(calls[0].opts.credentials, 'omit');
    assert.equal(calls[0].opts.referrerPolicy, 'no-referrer');
    assert.equal(calls[0].opts.mode, 'cors');

    // 4. 直连网络错误（含 CSP 拦截）→ 回退代理；非图片响应同样回退。
    resetDirectImageHealth();
    calls = [];
    global.fetch = async (url, opts) => {
      calls.push(url);
      if (url === sample) throw new TypeError('Failed to fetch');
      assert.equal(opts.credentials, 'same-origin');
      assert.equal(opts.headers['X-JMW-Data-Source'], 'builtin');
      return imageResponse('proxy');
    };
    blob = await fetchChapterImageBlob({ directUrl: sample, proxyUrl: '/api/img?u=x', headers: { 'X-JMW-Data-Source': 'builtin' } });
    assert.equal(await blob.text(), 'proxy');
    assert.deepEqual(calls, [sample, '/api/img?u=x']);
    assert.ok(directImageAvailable(), 'one failure does not disable direct mode');

    // 5. 连续两次失败后进入冷却：后续请求直接走代理。
    calls = [];
    global.fetch = async (url) => {
      calls.push(url);
      return url === sample ? imageResponse('<html>blocked</html>', 'text/html') : imageResponse('proxy');
    };
    await fetchChapterImageBlob({ directUrl: sample, proxyUrl: '/api/img?u=x', headers: {} });
    assert.equal(directImageAvailable(), false, 'second consecutive failure starts cooldown');
    assert.ok(!directImageAvailable(Date.now() + 9 * 60 * 1000));
    assert.ok(directImageAvailable(Date.now() + 11 * 60 * 1000), 'cooldown expires');
    calls = [];
    await fetchChapterImageBlob({ directUrl: sample, proxyUrl: '/api/img?u=x', headers: {} });
    assert.deepEqual(calls, ['/api/img?u=x'], 'cooling direct mode goes straight to proxy');

    // 6. 成功会清零失败计数：失败-成功-失败不触发冷却。
    resetDirectImageHealth();
    let mode = 'fail';
    global.fetch = async (url) => {
      if (url !== sample) return imageResponse('proxy');
      if (mode === 'fail') throw new TypeError('Failed to fetch');
      return imageResponse('direct');
    };
    await fetchChapterImageBlob({ directUrl: sample, proxyUrl: '/p', headers: {} });
    mode = 'ok';
    await fetchChapterImageBlob({ directUrl: sample, proxyUrl: '/p', headers: {} });
    mode = 'fail';
    await fetchChapterImageBlob({ directUrl: sample, proxyUrl: '/p', headers: {} });
    assert.ok(directImageAvailable());

    // 7. 路由取消：直接抛出，不回退代理，也不计入直连失败。
    resetDirectImageHealth();
    const controller = new AbortController();
    calls = [];
    global.fetch = (url, opts) => new Promise((_, reject) => {
      calls.push(url);
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
      controller.abort();
    });
    await assert.rejects(fetchChapterImageBlob({ directUrl: sample, proxyUrl: '/p', headers: {}, signal: controller.signal }));
    assert.deepEqual(calls, [sample]);
    resetDirectImageHealth();

    // 8. 无直连地址（设置关闭或非白名单）：只走代理；代理错误保持原有报错。
    calls = [];
    global.fetch = async (url) => { calls.push(url); return imageResponse('nope', 'image/webp', 502); };
    await assert.rejects(fetchChapterImageBlob({ directUrl: '', proxyUrl: '/p', headers: {}, label: '图片 3 ' }), /图片 3 获取失败（502）/);
    assert.deepEqual(calls, ['/p']);
  } finally {
    global.fetch = saved;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log('reader direct image all pass');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
