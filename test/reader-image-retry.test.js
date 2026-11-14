'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
(async () => {
  const readerPath = path.join(__dirname, '../public/js/reader.js');
  const { fetchReaderImageResponse } = await import(pathToFileURL(readerPath).href);
  assert.equal(typeof fetchReaderImageResponse, 'function');
  const saved = { fetch, setTimeout, clearTimeout, random: Math.random };
  const delays = [], pending = new Set();
  let autoTimers = true;
  global.setTimeout = (fn, ms) => {
    const token = {}; pending.add(token); delays.push(ms);
    if (autoTimers) queueMicrotask(() => { if (pending.delete(token)) fn(); });
    return token;
  };
  global.clearTimeout = token => pending.delete(token);
  Math.random = () => 0;
  try {
    const controller = new AbortController();
    let calls = 0, cancelled = 0;
    const ok = new Response('image-fixture', { headers: { 'Content-Type': 'image/webp' } });
    global.fetch = async (_url, options) => {
      calls++; assert.equal(options.signal, controller.signal);
      assert.equal(options.method, 'GET');
      assert.equal(options.headers['X-JMW-Data-Source'], 'builtin');
      return calls < 3 ? { status: 503, headers: new Headers({ 'Retry-After': '1' }), body: { cancel: async () => { cancelled++; } } } : ok;
    };
    const result = await fetchReaderImageResponse('/api/img?path=fixture', {
      signal: controller.signal, headers: { 'X-JMW-Data-Source': 'builtin' }, credentials: 'same-origin',
    });
    assert.equal(result, ok);
    assert.equal(calls, 3); assert.equal(cancelled, 2);
    assert.deepEqual(delays.splice(0), [1000, 2000]);
    assert.equal(await result.text(), 'image-fixture');

    // Never repeat upstream traversals, authentication failures or permanent errors.
    for (const status of [400, 401, 403, 404, 413, 415, 500, 502, 504]) {
      calls = 0;
      global.fetch = async () => { calls++; return new Response('error', { status, headers: { 'Retry-After': '1' } }); };
      assert.equal((await fetchReaderImageResponse('/api/img', {})).status, status);
      assert.equal(calls, 1);
    }
    for (const retryAfter of [null, 'invalid', '-1', '60']) {
      calls = 0;
      global.fetch = async () => { calls++; return new Response('busy', { status: 503, headers: retryAfter === null ? {} : { 'Retry-After': retryAfter } }); };
      assert.equal((await fetchReaderImageResponse('/api/img', {})).status, 503);
      assert.equal(calls, 1, 'invalid or excessively long server delay must not be retried early');
    }
    calls = 0;
    global.fetch = async () => { calls++; return new Response('busy', { status: 429, headers: { 'Retry-After': '1' } }); };
    assert.equal((await fetchReaderImageResponse('/api/img', {})).status, 429);
    assert.equal(calls, 3, 'retries must be bounded');
    assert.deepEqual(delays.splice(0), [1000, 2000]);
    calls = 0;
    global.fetch = async () => { calls++; throw new TypeError('network-fixture'); };
    await assert.rejects(fetchReaderImageResponse('/api/img', {}), /network-fixture/);
    assert.equal(calls, 1, 'do not amplify upstream network retries');

    // Retry-After also accepts an HTTP date; never retry before that delay.
    calls = 0;
    const retryDate = new Date(Date.now() + 4500).toUTCString();
    global.fetch = async () => {
      calls++;
      return new Response('fixture', calls === 1 ? { status: 503, headers: { 'Retry-After': retryDate } } : {});
    };
    assert.equal((await fetchReaderImageResponse('/api/img', {})).status, 200);
    assert.equal(calls, 2);
    const dateDelay = delays.pop();
    assert(dateDelay >= 3000 && dateDelay <= 4500);

    // Abort during backoff releases the timer and never starts another request.
    autoTimers = false; calls = 0;
    const abortController = new AbortController();
    global.fetch = async () => { calls++; return new Response('busy', { status: 503, headers: { 'Retry-After': '1' } }); };
    const aborted = fetchReaderImageResponse('/api/img', { signal: abortController.signal });
    for (let i = 0; i < 10 && !pending.size; i++) await Promise.resolve();
    assert.equal(pending.size, 1);
    abortController.abort();
    await assert.rejects(aborted, error => error.name === 'AbortError');
    assert.equal(pending.size, 0); assert.equal(calls, 1);
    await assert.rejects(fetchReaderImageResponse('/api/img', { signal: abortController.signal }), error => error.name === 'AbortError');
    assert.equal(calls, 1);
    const source = fs.readFileSync(readerPath, 'utf8');
    // 阅读器原图经 fetchChapterImageBlob（直连失败回退代理），代理分支仍走准入重试。
    assert.match(source, /blob = await fetchChapterImageBlob\(\{[\s\S]{0,200}proxyUrl: srcOf\(idx\),/);
    assert.match(source, /const res = await fetchReaderImageResponse\(proxyUrl, \{/);
    console.log('reader admission retry / bounded backoff / body cleanup / cancellation all pass');
  } finally {
    global.fetch = saved.fetch; global.setTimeout = saved.setTimeout; global.clearTimeout = saved.clearTimeout; Math.random = saved.random;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
