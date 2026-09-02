'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

class FakeText {
  constructor(value) { this.value = String(value); this.isConnected = true; }
  get textContent() { return this.value; }
  set textContent(value) { this.value = String(value); }
}

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.className = '';
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
    this.isConnected = true;
    this.disabled = false;
    this.innerHTML = '';
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'disabled') this.disabled = true;
    if (name === 'value') this.value = String(value);
  }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, handler) { this[`on${name}`] = handler; }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  remove() { this.isConnected = false; }
  get textContent() {
    return this.children.map((child) => child && child.textContent != null ? child.textContent : '').join('');
  }
  set textContent(value) { this.children = [new FakeText(value)]; }
}

function findByText(root, label) {
  if (root instanceof FakeElement && root.textContent === label) return root;
  for (const child of root.children || []) {
    const found = child instanceof FakeElement ? findByText(child, label) : null;
    if (found) return found;
  }
  return null;
}

global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.document = {
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (_namespace, tag) => new FakeElement(tag),
  createTextNode: (value) => new FakeText(value),
  getElementById: () => new FakeElement('div'),
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

(async () => {
  const readerUrl = pathToFileURL(path.resolve(__dirname, '..', 'public', 'js', 'reader.js')).href;
  const advancedUrl = pathToFileURL(path.resolve(__dirname, '..', 'public', 'js', 'advanced.js')).href;
  const apiUrl = pathToFileURL(path.resolve(__dirname, '..', 'public', 'js', 'api.js')).href;
  const uiUrl = pathToFileURL(path.resolve(__dirname, '..', 'public', 'js', 'ui.js')).href;
  const { normalizeChapterImages, normalizeReaderSeries } = await import(readerUrl);
  const { networkView, aboutView } = await import(advancedUrl);
  const { imgSrc, chapterImgSrc } = await import(apiUrl);
  const { comicCard, installImageRetry } = await import(uiUrl);

  // 列表上游字段异常时，封面地址和卡片渲染都必须退化为安全空值，
  // 不能因对数字/对象调用 startsWith 或把对象直接 append 到 DOM 而中断整页。
  assert.strictEqual(imgSrc({ image: 123, id: { toString: () => 'secret' } }), '');
  assert.strictEqual(imgSrc({ image: '  /media/albums/a.jpg  ', id: '42' }), '/api/img?path=%2Fmedia%2Falbums%2Fa.jpg');
  assert.strictEqual(imgSrc({ image: '', id: 'not-an-id' }), '');
  assert.strictEqual(imgSrc({ image: '', cover: '/media/albums/77.jpg', AID: '77' }), '/api/img?path=%2Fmedia%2Falbums%2F77.jpg');
  assert.strictEqual(imgSrc({ cover: '/api/img?path=%2Fmedia%2Falbums%2F77.jpg', id: '77' }), '/api/img?path=%2Fmedia%2Falbums%2F77.jpg');
  assert.strictEqual(imgSrc({ image: '', AID: '88' }), '/api/img?path=%2Fmedia%2Falbums%2F88_3x4.jpg');
  assert.strictEqual(chapterImgSrc({ url: 'https://evil.example' }), '');
  assert.doesNotThrow(() => comicCard({ image: { nested: true }, name: { bad: true }, author: { bad: true }, id: 101 }));

  // 短暂图片代理失败不应一次 onerror 就永久变成占位图；耗尽重试后才移除 src。
  const retryImage = new FakeElement('img');
  const stopRetry = installImageRetry(retryImage, '/api/img?path=%2Fmedia%2Falbums%2F77.jpg', {
    maxRetries: 1, delays: [100],
  });
  assert.strictEqual(retryImage.attributes.src, '/api/img?path=%2Fmedia%2Falbums%2F77.jpg');
  retryImage.onerror();
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.match(retryImage.attributes.src, /_jmw_retry=1/);
  retryImage.onerror();
  assert.strictEqual(Object.prototype.hasOwnProperty.call(retryImage.attributes, 'src'), false);
  stopRetry();

  assert.deepStrictEqual(normalizeChapterImages(null), []);
  assert.deepStrictEqual(normalizeChapterImages({}), []);
  const images = normalizeChapterImages([
    null,
    { url: 'javascript:alert(1)', name: 'bad.webp' },
    { url: 'http://cdn.example/unsafe.webp', name: 'unsafe.webp' },
    { url: 'https://user:secret@cdn.example/private.webp', name: 'credential.webp' },
    { url: 'https://cdn.example/a.webp#fragment', name: 'a.webp', page: 1 },
    { url: 'https://cdn.example/path/b.gif' },
  ]);
  assert.strictEqual(images.length, 2);
  assert.strictEqual(images[0].url, 'https://cdn.example/a.webp');
  assert.strictEqual(images[0].page, '1');
  assert.strictEqual(images[1].name, 'b.gif');

  assert.deepStrictEqual(normalizeReaderSeries({}), []);
  assert.deepStrictEqual(normalizeReaderSeries([
    null, { id: 'bad' }, { id: 101, name: ' 第一章 ', sort: 2 }, { id: '102', name: '' },
  ]), [
    { id: '101', name: '第一章', sort: 2 },
    { id: '102', name: '', sort: 1 },
  ]);

  const config = {
    dataSources: {
      builtin: { hosts: 2 }, network: { configured: false }, mixed: { hosts: 3 },
    },
  };
  global.fetch = async (url) => {
    if (url === '/api/doh') return jsonResponse({
      restricted: true, enabled: false, providers: [{ id: 'custom', name: '自定义 DoH', url: '' }],
    });
    if (url === '/api/config') return jsonResponse(config);
    throw new Error(`unexpected request: ${url}`);
  };
  const networkRoot = new FakeElement('main');
  await networkView(networkRoot, null, null, { signal: new AbortController().signal, isActive: () => true });
  assert.match(networkRoot.textContent, /DoH 设置仅限站点管理员/);
  assert.match(networkRoot.textContent, /数据源/);
  assert.match(networkRoot.textContent, /内置直连（2 条线路）/);
  assert.ok(!networkRoot.textContent.includes('保存并启用'));

  global.fetch = async (url) => {
    if (url === '/healthz') return jsonResponse({ ok: false }, 503);
    if (url === '/api/update') return jsonResponse({ currentVersion: '1.0.0', available: false });
    throw new Error(`unexpected request: ${url}`);
  };
  const aboutRoot = new FakeElement('main');
  await aboutView(aboutRoot, null, null, { signal: new AbortController().signal, isActive: () => true });
  assert.match(aboutRoot.textContent, /健康检查失败（503）/);

  // 日志按钮在无 Clipboard API 或 403 时的行为由统一 try/catch 保护；静态确认
  // 不允许未来又退回裸 Promise 链而产生 unhandled rejection。
  const source = require('fs').readFileSync(path.resolve(__dirname, '..', 'public', 'js', 'advanced.js'), 'utf8');
  assert.ok(source.includes("typeof navigator.clipboard.writeText !== 'function'"));
  assert.ok(source.includes("jsonRequest('/logs', { method: 'DELETE', signal: ctx?.signal })"));

  console.log('frontend robustness all pass');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
