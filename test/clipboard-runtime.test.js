'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const storedSetting = JSON.stringify({
  onboardingCompleted: true,
  clipboardAutoDetectEnabled: true,
});
global.localStorage = {
  getItem: (key) => key === 'jmw_setting' ? storedSetting : null,
  setItem() {},
  removeItem() {},
};

const windowListeners = new Map();
const documentListeners = new Map();
const addListener = (map) => (type, handler) => {
  const rows = map.get(type) || [];
  rows.push(handler);
  map.set(type, rows);
};
const dispatch = (map, type, event = {}) => {
  for (const handler of map.get(type) || []) handler(event);
};
const classList = { add() {}, remove() {}, toggle() {} };

class FakeText {
  constructor(value) {
    this.textContent = String(value);
    this.parentElement = null;
  }
}

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.children = [];
    this.listeners = new Map();
    this.attributes = {};
    this.className = '';
    this.parentElement = null;
    this.removed = false;
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }

  addEventListener(type, handler) {
    const rows = this.listeners.get(type) || [];
    rows.push(handler);
    this.listeners.set(type, rows);
  }

  appendChild(child) {
    child.parentElement = this;
    this.childNodes.push(child);
    if (child instanceof FakeElement) this.children.push(child);
    return child;
  }

  append(...children) { children.forEach((child) => this.appendChild(child)); }

  remove() {
    this.removed = true;
    if (!this.parentElement) return;
    this.parentElement.childNodes = this.parentElement.childNodes.filter((child) => child !== this);
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }
}

const body = new FakeElement('body');
let passwordGatePresent = false;
global.window = {
  addEventListener: addListener(windowListeners),
  matchMedia: () => ({ matches: false }),
};
global.document = {
  visibilityState: 'visible',
  title: '',
  documentElement: {
    dataset: {}, classList,
    style: { setProperty() {}, removeProperty() {} },
  },
  body,
  addEventListener: addListener(documentListeners),
  createElement: (tag) => new FakeElement(tag),
  createTextNode: (value) => new FakeText(value),
  getElementById: (id) => id === 'password-gate-input' && passwordGatePresent ? {} : null,
  querySelector: () => null,
};
let passiveReadCount = 0;
Object.defineProperty(global, 'navigator', {
  configurable: true,
  value: { clipboard: { readText: async () => { passiveReadCount++; return 'JM999999'; } } },
});

const originalSetTimeout = global.setTimeout;
const deferredTimers = [];
global.setTimeout = (callback, delay) => {
  deferredTimers.push({ callback, delay });
  return deferredTimers.length;
};

(async () => {
  const advancedPath = path.resolve(__dirname, '..', 'public', 'js', 'advanced.js');
  const advancedUrl = `${pathToFileURL(advancedPath).href}?clipboard-runtime=${Date.now()}`;
  const { clipboardAlbumIdFromText, installAdvancedRuntime } = await import(advancedUrl);

  assert.strictEqual(clipboardAlbumIdFromText('刚复制了 JM123456'), '123456');
  assert.strictEqual(clipboardAlbumIdFromText('https://example.test/album/98765'), '98765');
  assert.strictEqual(clipboardAlbumIdFromText('photo/4567'), '4567');
  assert.strictEqual(clipboardAlbumIdFromText('普通文字 123456'), '',
    '被动检测只识别带 JM/album/photo 上下文的编号');
  assert.strictEqual(clipboardAlbumIdFromText(null), '');

  installAdvancedRuntime();
  installAdvancedRuntime();
  assert.strictEqual((documentListeners.get('paste') || []).length, 1,
    '重复安装运行时不得重复注册 paste 监听器');

  dispatch(windowListeners, 'focus');
  dispatch(documentListeners, 'visibilitychange');
  dispatch(windowListeners, 'jmw-local-unlocked');

  let passwordPasteReadCount = 0;
  passwordGatePresent = true;
  dispatch(documentListeners, 'paste', {
    clipboardData: { getData: () => { passwordPasteReadCount++; return 'JM654321'; } },
  });
  passwordGatePresent = false;
  assert.strictEqual(passwordPasteReadCount, 0,
    '访问口令框存在时不得读取 paste 数据或创建漫画通知');
  assert.strictEqual(body.children.length, 0,
    '访问口令框中的粘贴不得创建漫画通知');

  let passwordTargetReadCount = 0;
  let sensitiveTargetSelector = '';
  dispatch(documentListeners, 'paste', {
    target: {
      closest: (selector) => {
        sensitiveTargetSelector = selector;
        return true;
      },
    },
    clipboardData: { getData: () => { passwordTargetReadCount++; return 'JM135790'; } },
  });
  assert.match(sensitiveTargetSelector, /input\[type=["']password["']\]/,
    'paste 目标检查必须覆盖密码输入框');
  assert.strictEqual(passwordTargetReadCount, 0,
    '密码类 paste 目标必须在访问 clipboardData 前返回');
  assert.strictEqual(body.children.length, 0,
    '密码类 paste 目标不得创建漫画通知');

  let plainPasteReadCount = 0;
  dispatch(documentListeners, 'paste', {
    clipboardData: { getData: () => { plainPasteReadCount++; return '普通文本，不含漫画编号'; } },
  });
  assert.strictEqual(plainPasteReadCount, 1, '普通 paste 只读取事件自带数据一次');
  assert.strictEqual(body.children.length, 0, '普通文本 paste 不应创建通知');

  let validPasteReadCount = 0;
  dispatch(documentListeners, 'paste', {
    clipboardData: { getData: () => { validPasteReadCount++; return '复制链接 album/246810'; } },
  });
  assert.strictEqual(validPasteReadCount, 1, '有效 paste 只读取事件自带数据一次');
  assert.strictEqual(body.children.length, 1, '有效 JM paste 应创建一条通知');
  const notice = body.children[0];
  assert.strictEqual(notice.className, 'clipboard-notice');
  assert.strictEqual(notice.children.length, 2, '通知应保留“打开”和“忽略”操作');
  assert.strictEqual(deferredTimers.length, 1, '有效通知应只安排一个自动移除计时器');
  assert.strictEqual(deferredTimers[0].delay, 12000);

  await Promise.resolve();
  assert.strictEqual(passiveReadCount, 0,
    '启动、窗口聚焦、可见性恢复、解锁和 paste 事件都不得调用 Clipboard.readText');

  const source = fs.readFileSync(advancedPath, 'utf8');
  assert.strictEqual((source.match(/navigator\.clipboard\.readText\(\)/g) || []).length, 1,
    'Clipboard.readText 只能保留在用户显式点击的“读取剪贴板”按钮中');
  assert.match(source, /document\.addEventListener\('paste', handleClipboardPaste\)/,
    '自动检测必须基于用户触发的 paste 事件');

  const installStart = source.indexOf('export function installAdvancedRuntime()');
  const runEnd = source.indexOf('\n}', source.indexOf('function runUnlockedTasks()', installStart));
  assert.ok(installStart >= 0 && runEnd > installStart);
  const runtimeSource = source.slice(installStart, runEnd + 2);
  assert.ok(!runtimeSource.includes('navigator.clipboard.readText'),
    '启动、focus 和可见性恢复路径不得读取系统剪贴板');
  assert.ok(!runtimeSource.includes('inspectClipboard'),
    '运行时不得恢复旧的被动剪贴板检测入口');

  console.log('clipboard runtime privacy checks pass');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  global.setTimeout = originalSetTimeout;
});
