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
  const { comicCard, installImageRetry, disposeImageRetries, observeImageRetries } = await import(uiUrl);
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
  // /me 返回的 photo 是带版本 query 的裸文件名；顶栏与个人页头像必须复用同一映射，
  // 否则会拼出 /api/img?path=/nopic-Male.gif?v=0 并被代理以 400 拒绝。
  assert.strictEqual(
    commentAvatarSrc('nopic-Male.gif?v=0'),
    '/api/img?path=%2Fmedia%2Fusers%2Fnopic-Male.gif',
  );
  for (const file of ['app.js', 'user.js']) {
    const avatarSource = require('fs').readFileSync(path.resolve(__dirname, '../public/js', file), 'utf8');
    assert.match(avatarSource, /commentAvatarSrc\(me\.photo\)/, `${file} 头像须经 commentAvatarSrc`);
    assert.doesNotMatch(avatarSource, /api\/img\?path=\$\{encodeURIComponent\(me\.photo/, `${file} 不得手拼头像路径`);
  }

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

  // 路由离开不仅停止未来重试，也要撤销正在下载的封面和未开始的观察项。
  const inFlightCover = new FakeElement('img');
  installImageRetry(inFlightCover, '/api/img?path=cover-fixture', { delays: [100] });
  assert.strictEqual(inFlightCover.attributes.src, '/api/img?path=cover-fixture');
  inFlightCover.onerror(); // 同时覆盖已安排退避重试的清理。
  const watched = new Set();
  let imageObserverCallback;
  global.IntersectionObserver = class {
    constructor(callback) { imageObserverCallback = callback; }
    observe(image) { watched.add(image); }
    unobserve(image) { watched.delete(image); }
  };
  const pendingCover = new FakeElement('img');
  installImageRetry(pendingCover, '/api/img?path=pending-fixture', { lazy: true });
  assert(watched.has(pendingCover));
  disposeImageRetries({ querySelectorAll: () => [inFlightCover, pendingCover] });
  assert.strictEqual(inFlightCover.attributes.src, undefined, '离开路由必须撤销在途封面 src');
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.strictEqual(inFlightCover.attributes.src, undefined, '已清理的计时器不能重新启动请求');
  assert.strictEqual(watched.size, 0, '已离开路由的封面必须解除观察');
  imageObserverCallback([{ target: pendingCover, isIntersecting: true }]);
  assert.strictEqual(pendingCover.attributes.src, undefined, '迟到的观察回调不能启动旧路由请求');
  disposeImageRetries({ querySelectorAll: () => [inFlightCover, pendingCover] });
  const reusedCover = new FakeElement('img');
  const oldDispose = installImageRetry(reusedCover, '/api/img?path=old-fixture');
  installImageRetry(reusedCover, '/api/img?path=new-fixture', { lazy: true });
  oldDispose();
  assert(watched.has(reusedCover), '过期清理函数不得注销新加载器的 lazy 观察项');
  imageObserverCallback([{ target: reusedCover, isIntersecting: true }]);
  assert.strictEqual(reusedCover.attributes.src, '/api/img?path=new-fixture');
  disposeImageRetries({ querySelectorAll: () => [reusedCover] });
  assert.strictEqual(reusedCover.attributes.src, undefined, '过期清理函数不得注销新加载器');

  // 已完成的旧加载器也不能在同节点重新绑定后注销新 lazy 加载器。
  const loadedCover = new FakeElement('img');
  const loadedDispose = installImageRetry(loadedCover, '/api/img?path=loaded-fixture');
  loadedCover.onload();
  installImageRetry(loadedCover, '/api/img?path=reloaded-fixture', { lazy: true });
  loadedDispose();
  assert(watched.has(loadedCover));
  imageObserverCallback([{ target: loadedCover, isIntersecting: true }]);
  assert.strictEqual(loadedCover.attributes.src, '/api/img?path=reloaded-fixture');
  disposeImageRetries(loadedCover);
  assert.strictEqual(loadedCover.attributes.src, undefined, 'root 本身是 img 时也必须取消');

  const reboundLazy = new FakeElement('img');
  const oldLazyDispose = installImageRetry(reboundLazy, '/api/img?path=old-lazy', { lazy: true });
  installImageRetry(reboundLazy, '/api/img?path=new-lazy', { lazy: true });
  oldLazyDispose();
  assert(watched.has(reboundLazy), '旧 lazy cleanup 不得 unobserve 新 lazy 加载器');
  imageObserverCallback([{ target: reboundLazy, isIntersecting: true }]);
  assert.strictEqual(reboundLazy.attributes.src, '/api/img?path=new-lazy');
  disposeImageRetries(reboundLazy);

  // 刷新先替换 DOM 后，路由扫描已找不到旧节点；必须在移除子树时清理。
  assert.strictEqual(typeof observeImageRetries, 'function');
  const mutations = [];
  global.MutationObserver = class {
    constructor(callback) { this.callback = callback; this.records = []; mutations.push(this); }
    observe(root, options) { this.root = root; this.options = options; }
    takeRecords() { const records = this.records; this.records = []; return records; }
    disconnect() { this.disconnected = true; this.records = []; }
    deliver() { this.callback(this.takeRecords()); }
  };
  const activeImages = new Set();
  const routeRoot = { contains: (image) => activeImages.has(image), querySelectorAll: () => [...activeImages] };
  observeImageRetries(routeRoot);
  observeImageRetries(routeRoot);
  assert.strictEqual(mutations.length, 1, '同一路由根节点不能重复注册 Observer');
  const mutation = mutations[0];
  assert.deepStrictEqual(mutation.options, { childList: true, subtree: true });
  const removedLoading = new FakeElement('img');
  const removedPending = new FakeElement('img');
  const movedCover = new FakeElement('img');
  installImageRetry(removedLoading, '/api/img?path=removed-loading', { delays: [100] });
  removedLoading.onerror();
  installImageRetry(removedPending, '/api/img?path=removed-pending', { lazy: true });
  installImageRetry(movedCover, '/api/img?path=moved-cover', { lazy: true });
  activeImages.add(movedCover); // 同一 root 内移动/重插：最终仍然属于此路由。
  removedLoading.isConnected = false;
  removedPending.isConnected = false;
  const removedSubtree = { querySelectorAll: () => [removedLoading, removedPending, movedCover] };
  mutation.records.push({ removedNodes: [removedSubtree, movedCover] });
  mutation.deliver();
  assert.strictEqual(removedLoading.attributes.src, undefined);
  assert(!watched.has(removedPending), '已脱离 DOM 的离屏封面必须解除观察');
  assert(watched.has(movedCover), 'root 内移动不能误取消仍有效的图片');
  imageObserverCallback([{ target: movedCover, isIntersecting: true }]);
  assert.strictEqual(movedCover.attributes.src, '/api/img?path=moved-cover');
  removedPending.isConnected = true; // 迟到 IO 即使看到节点已连接，也不能复活旧加载器。
  imageObserverCallback([{ target: removedPending, isIntersecting: true }]);
  assert.strictEqual(removedPending.attributes.src, undefined);
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.strictEqual(removedLoading.attributes.src, undefined, '移除节点的重试计时器不得复活');

  // 同一任务中先刷新再退出，MO 尚未回调：销毁必须同步排空 pending records。
  const pendingRemoval = new FakeElement('img');
  const pendingOffscreen = new FakeElement('img');
  installImageRetry(pendingRemoval, '/api/img?path=pending-removal');
  installImageRetry(pendingOffscreen, '/api/img?path=pending-offscreen', { lazy: true });
  mutation.records.push({ removedNodes: [pendingRemoval, pendingOffscreen] });
  disposeImageRetries(routeRoot);
  assert.strictEqual(pendingRemoval.attributes.src, undefined);
  assert(!watched.has(pendingOffscreen));
  assert.strictEqual(movedCover.attributes.src, undefined);
  assert(mutation.disconnected, '离开路由必须断开 DOM Observer');
  disposeImageRetries(routeRoot);

  // 旧路由的迟到 MO 回调不能取消新路由复用节点上的加载器。
  observeImageRetries(routeRoot);
  activeImages.delete(movedCover); // 新加载器已安装，但其子树尚未插入 main。
  installImageRetry(movedCover, '/api/img?path=new-route', { lazy: true });
  mutation.callback([{ removedNodes: [movedCover] }]);
  assert(watched.has(movedCover));
  activeImages.add(movedCover);
  imageObserverCallback([{ target: movedCover, isIntersecting: true }]);
  assert.strictEqual(movedCover.attributes.src, '/api/img?path=new-route');
  disposeImageRetries(routeRoot);
  assert.strictEqual(watched.size, 0);
  delete global.MutationObserver;
  delete global.IntersectionObserver;
  const cleanupAppSource = require('fs').readFileSync(path.resolve(__dirname, '../public/js/app.js'), 'utf8');
  assert.match(cleanupAppSource, /controller\.abort\(\);\s+disposeImageRetries\(main\);/, '路由销毁必须实际调用图片清理');
  assert.match(cleanupAppSource, /observeImageRetries\(main\);[\s\S]*?route\.view\(main, m, search, ctx\)/, '渲染 View 前必须注册移除节点清理');

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

  // 章节 AI 的详细描述/简洁总结先只持久化，不能在当前章节列表中直接展示；
  // 标题由服务端按“原标题优先、AI 标题兜底”注入后再渲染。
  const viewsSource = require('fs').readFileSync(path.resolve(__dirname, '..', 'public', 'js', 'views.js'), 'utf8');
  assert.ok(!viewsSource.includes('aiSummary'), '章节列表不得直接显示 AI 总结');
  assert.ok(!viewsSource.includes('chapterAi('), '章节列表暂不应主动拉取 AI 结果展示');

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
