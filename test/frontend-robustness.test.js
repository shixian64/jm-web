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

function findByClass(root, className) {
  if (root instanceof FakeElement && String(root.className).split(/\s+/).includes(className)) return root;
  for (const child of root.children || []) {
    const found = child instanceof FakeElement ? findByClass(child, className) : null;
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
  const viewsUrl = pathToFileURL(path.resolve(__dirname, '..', 'public', 'js', 'views.js')).href;
  const { normalizeChapterImages, normalizeReaderSeries } = await import(readerUrl);
  const { networkView, aboutView } = await import(advancedUrl);
  const {
    COMMENT_PAGE_SIZE, imgSrc, chapterImgSrc, commentAvatarSrc, commentContentText,
    commentPageCount, commentPageHasMore, isCommentSpoiler,
  } = await import(apiUrl);
  const { comicCard, installImageRetry } = await import(uiUrl);
  const { commentItem } = await import(viewsUrl);

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

  // /forum 正文是 HTML 包装字符串，但只能以安全文本呈现；保留换行和
  // 表情 alt，绝不能把事件属性、脚本或其它上游标签送进 innerHTML。
  assert.strictEqual(commentContentText(
    '<div style="flex-direction:row">第一行<br>第二行 <img src="x" onerror="alert(1)" alt=":笑:"></div>' +
    '<script>alert("xss")</script>',
  ), '第一行\n第二行 :笑:');
  assert.strictEqual(commentContentText('&lt;script&gt;只应作为文字&lt;/script&gt;'), '<script>只应作为文字</script>');
  assert.strictEqual(commentContentText({ toString: () => '<img onerror=alert(1)>' }), '');

  // 当前线上协议中 1 是普通评论、2 才是官网默认隐藏的剧透评论。
  assert.strictEqual(isCommentSpoiler('1'), false);
  assert.strictEqual(isCommentSpoiler('2'), true);
  assert.strictEqual(isCommentSpoiler(2), true);
  assert.strictEqual(isCommentSpoiler(true), true);

  assert.strictEqual(
    commentAvatarSrc('15014403.jpg'),
    '/api/img?path=%2Fmedia%2Fusers%2F15014403.jpg',
  );
  assert.strictEqual(
    commentAvatarSrc('/media/users/nopic-Male.gif'),
    '/api/img?path=%2Fmedia%2Fusers%2Fnopic-Male.gif',
  );
  assert.strictEqual(commentAvatarSrc('javascript:alert(1)'), '');
  assert.strictEqual(commentAvatarSrc('../private.jpg'), '');

  assert.strictEqual(COMMENT_PAGE_SIZE, 10);
  assert.strictEqual(commentPageCount('95'), 10);
  assert.strictEqual(commentPageCount(65), 7);
  assert.strictEqual(commentPageHasMore({ total: 25, page: 1, itemCount: 10 }), true);
  assert.strictEqual(commentPageHasMore({ total: 25, page: 2, itemCount: 10 }), true);
  assert.strictEqual(commentPageHasMore({ total: 25, page: 3, itemCount: 5 }), false);
  assert.strictEqual(commentPageHasMore({ total: 20, page: 2, itemCount: 10 }), false);
  assert.strictEqual(commentPageHasMore({ total: '', page: 1, itemCount: 10 }), true);

  // 适配函数必须真正用于漫画详情评论节点，避免帮助函数正确但渲染路径仍
  // 继续使用原始 HTML、旧剧透值或错误头像地址。
  const renderedComment = commentItem({
    CID: '77', nickname: '测试用户', spoiler: '2', photo: '15014403.jpg',
    content: '<div>安全正文<img src="x" onerror="alert(1)" alt=":笑:"></div>',
  });
  const renderedContent = findByClass(renderedComment, 'content');
  const renderedAvatar = findByClass(renderedComment, 'avatar');
  assert(renderedContent && renderedAvatar, '评论必须渲染正文和头像节点');
  assert.strictEqual(renderedContent.textContent, '安全正文:笑:');
  assert(String(renderedContent.className).split(/\s+/).includes('spoiler'));
  assert.strictEqual(
    renderedAvatar.children[0].attributes.src,
    '/api/img?path=%2Fmedia%2Fusers%2F15014403.jpg',
  );
  const renderedAvatarImage = renderedAvatar.children[0];
  renderedAvatarImage.onerror();
  renderedAvatarImage.onerror();
  renderedAvatarImage.onerror();
  assert.strictEqual(renderedAvatar.textContent, '测', '头像重试耗尽后必须回退昵称首字');
  const normalComment = commentItem({ CID: '78', spoiler: '1', content: '<div>普通评论</div>' });
  assert(!String(findByClass(normalComment, 'content').className).split(/\s+/).includes('spoiler'));
  assert.strictEqual(findByClass(normalComment, 'avatar').textContent, '友');

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

  // 首次业务 render 必须由门禁判断后的单一启动函数触发；boot 自身不得在
  // /api/me 返回前渲染路由，也不能重复绑定 hashchange。
  const appSource = require('fs').readFileSync(path.resolve(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const advancedSource = require('fs').readFileSync(path.resolve(__dirname, '..', 'public', 'js', 'advanced.js'), 'utf8');
  const startBegin = appSource.indexOf('function startApplication()');
  const bootBegin = appSource.indexOf('async function boot()');
  const bootEnd = appSource.indexOf('\nlet avatarRefreshSeq', bootBegin);
  assert.ok(startBegin >= 0 && bootBegin > startBegin && bootEnd > bootBegin);
  const startSource = appSource.slice(startBegin, bootBegin);
  const bootSource = appSource.slice(bootBegin, bootEnd);
  assert.match(startSource, /if \(applicationStarted\) return;/);
  assert.strictEqual((startSource.match(/addEventListener\('hashchange'/g) || []).length, 1);
  assert.strictEqual((startSource.match(/\brender\(\);/g) || []).length, 1);
  assert.ok(!/\brender\(\);/.test(bootSource), 'boot 不得在门禁判断前直接 render');
  assert.ok(bootSource.indexOf("await fetch('/api/me'") < bootSource.indexOf('passwordGate(startApplication)'));
  assert.match(bootSource, /catch \(e\)[\s\S]*startApplication\(\);/,
    '门禁探测网络失败后必须进入可见的应用错误态');
  assert.match(bootSource, /new AbortController\(\)/,
    '门禁探测必须可超时，避免网络卡住时永久空白');
  assert.match(advancedSource, /if \(!unlockedTasksDeferred\) runUnlockedTasks\(\)/,
    '引导完成不得绕过站点访问门禁触发自动任务');

  console.log('frontend robustness all pass');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
