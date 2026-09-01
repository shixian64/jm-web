'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const gatePath = path.resolve(__dirname, '..', 'public', 'js', 'gate.js');
  const uiPath = path.resolve(__dirname, '..', 'public', 'js', 'ui.js');
  const gateUrl = `${pathToFileURL(gatePath).href}?mobile-focus=${Date.now()}`;
  const uiUrl = `${pathToFileURL(uiPath).href}?mobile-focus=${Date.now()}`;
  const {
    passwordGate,
    shouldAutoFocusPasswordInput,
    passwordGateInitialFocusTarget,
  } = await import(gateUrl);
  const { shouldAutoFocusEditable } = await import(uiUrl);

  const mediaWindow = (...matchedQueries) => ({
    matchMedia: (query) => ({ matches: matchedQueries.includes(query) }),
  });
  const input = { id: 'input' };
  const dialog = { id: 'dialog' };

  assert.strictEqual(shouldAutoFocusEditable(mediaWindow('(pointer: coarse)')), false,
    '通用策略必须把粗指针触屏设备视为不安全的 editable 自动聚焦环境');
  assert.strictEqual(shouldAutoFocusEditable(mediaWindow('(hover: none)')), false,
    '通用策略必须把无悬停设备视为不安全的 editable 自动聚焦环境');
  assert.strictEqual(shouldAutoFocusPasswordInput(mediaWindow('(pointer: coarse)')), false,
    '粗指针触屏设备不得自动聚焦密码输入框');
  assert.strictEqual(shouldAutoFocusPasswordInput(mediaWindow('(hover: none)')), false,
    '无悬停能力的移动设备不得自动聚焦密码输入框');
  assert.strictEqual(passwordGateInitialFocusTarget(input, dialog, mediaWindow('(pointer: coarse)')), dialog,
    '移动端初始焦点应落在对话框，避免 iOS 持续显示粘贴浮层');

  const desktop = mediaWindow();
  assert.strictEqual(shouldAutoFocusEditable(desktop), true);
  assert.strictEqual(shouldAutoFocusPasswordInput(desktop), true);
  assert.strictEqual(passwordGateInitialFocusTarget(input, dialog, desktop), input,
    '桌面端应继续支持直接输入口令');

  assert.strictEqual(shouldAutoFocusPasswordInput({}), true,
    '不支持 matchMedia 的旧浏览器保持原有桌面行为');
  assert.strictEqual(shouldAutoFocusPasswordInput({ matchMedia: () => { throw new Error('unsupported'); } }), true,
    '媒体查询异常不得阻断口令门控');

  // 策略函数必须真正接入门禁挂载和下一帧抢焦点路径，防止后续重构又直接
  // 对 password input 调用 focus，导致 iOS 的系统粘贴浮层回归。
  const source = fs.readFileSync(gatePath, 'utf8');
  const wrapperStart = source.indexOf('export function shouldAutoFocusPasswordInput');
  const wrapperEnd = source.indexOf('\n}', wrapperStart);
  assert.ok(wrapperStart >= 0 && wrapperEnd > wrapperStart);
  assert.match(source.slice(wrapperStart, wrapperEnd + 2), /shouldAutoFocusEditable/,
    '口令门控兼容包装必须复用通用移动端 editable 聚焦策略');
  const mountStart = source.indexOf("if (appRoot) appRoot.setAttribute('inert', '');");
  const mountEnd = source.indexOf('\n  return cleanup;', mountStart);
  assert.ok(mountStart >= 0 && mountEnd > mountStart);
  const mountSource = source.slice(mountStart, mountEnd);
  assert.match(mountSource, /passwordGateInitialFocusTarget\(input, overlay\)/);
  assert.strictEqual((mountSource.match(/initialFocusTarget\.focus\(/g) || []).length, 2,
    '立即挂载和 RAF 竞争处理必须复用同一个触屏安全焦点目标');
  assert.ok(!mountSource.includes('input.focus('), '门禁挂载路径不得绕过移动端焦点策略');
  assert.match(source, /role: 'dialog'.*tabindex: '-1'/,
    '移动端焦点目标 dialog 必须可被程序化聚焦');

  // 口令层出现前如果活动路由已经聚焦搜索框，移动端验证成功后也不能把焦点
  // 恢复到该 editable，否则仍会重新唤起 iOS 的编辑/粘贴浮层。
  class FakeHTMLElement {
    constructor(tag = 'div') {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.childNodes = [];
      this.listeners = new Map();
      this.attributes = new Map();
      this.classList = { add() {}, remove() {}, toggle() {} };
      this.dataset = {};
      this.style = {};
      this.disabled = false;
      this.inert = false;
      this.isConnected = true;
      this.focusCount = 0;
      this.innerHTML = '';
      this.value = '';
    }

    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(type, handler) {
      const rows = this.listeners.get(type) || [];
      rows.push(handler);
      this.listeners.set(type, rows);
    }
    appendChild(child) {
      child.parentElement = this;
      child.isConnected = true;
      this.childNodes.push(child);
      if (child instanceof FakeHTMLElement) this.children.push(child);
      return child;
    }
    append(...children) { children.forEach((child) => this.appendChild(child)); }
    remove() { this.isConnected = false; }
    focus() {
      this.focusCount++;
      global.document.activeElement = this;
    }
    querySelector(selector) {
      if (selector === '.err') return this.find((node) => node.className === 'err');
      return null;
    }
    find(predicate) {
      if (predicate(this)) return this;
      for (const child of this.children) {
        const found = child.find(predicate);
        if (found) return found;
      }
      return null;
    }
    async dispatch(type, event) {
      await Promise.all((this.listeners.get(type) || []).map((handler) => handler(event)));
    }
  }
  class FakeText {
    constructor(value) { this.textContent = String(value); this.isConnected = true; }
  }

  const originalGlobals = {
    HTMLElement: global.HTMLElement,
    window: global.window,
    document: global.document,
    fetch: global.fetch,
    requestAnimationFrame: global.requestAnimationFrame,
    cancelAnimationFrame: global.cancelAnimationFrame,
  };
  const appRoot = new FakeHTMLElement('div');
  const priorEditable = new FakeHTMLElement('input');
  const body = new FakeHTMLElement('body');
  global.HTMLElement = FakeHTMLElement;
  global.window = mediaWindow('(pointer: coarse)');
  global.document = {
    activeElement: priorEditable,
    body,
    getElementById: (id) => id === 'app' ? appRoot : null,
    createElement: (tag) => new FakeHTMLElement(tag),
    createElementNS: (_namespace, tag) => new FakeHTMLElement(tag),
    createTextNode: (value) => new FakeText(value),
  };
  global.requestAnimationFrame = () => 1;
  global.cancelAnimationFrame = () => {};
  global.fetch = async () => new Response('{"ok":true}', {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  let successCount = 0;
  passwordGate(() => { successCount++; });
  const overlay = body.children[0];
  const form = overlay.find((node) => node.tagName === 'FORM');
  assert(overlay && form, '测试门控必须成功挂载');
  assert.strictEqual(priorEditable.focusCount, 0,
    '移动端门控挂载时不得重新聚焦此前 editable');
  await form.dispatch('submit', { preventDefault() {} });
  assert.strictEqual(successCount, 1, '口令验证成功回调应正常执行');
  assert.strictEqual(priorEditable.focusCount, 0,
    '移动端口令验证完成后不得恢复到此前 editable');
  for (const [name, value] of Object.entries(originalGlobals)) {
    if (value === undefined) delete global[name]; else global[name] = value;
  }

  // 应用锁和空搜索页是另外两条首屏 editable 聚焦链；二者必须接入同一策略，
  // 不能只修访问口令层。
  const advancedPath = path.resolve(__dirname, '..', 'public', 'js', 'advanced.js');
  const advancedSource = fs.readFileSync(advancedPath, 'utf8');
  const lockStart = advancedSource.indexOf('async function showLockGate');
  const lockEnd = advancedSource.indexOf('\nexport function isLocalAppLocked', lockStart);
  assert.ok(lockStart >= 0 && lockEnd > lockStart);
  const lockSource = advancedSource.slice(lockStart, lockEnd);
  assert.match(lockSource,
    /const initialFocusTarget\s*=\s*shouldAutoFocusEditable\(\)\s*\?\s*desktopFocusTarget\s*:\s*lockOverlay/,
    '应用锁 PIN 首屏必须在移动端把初始焦点落到非 editable 的锁屏容器');
  assert.ok(!/queueMicrotask\(\(\) => \(pinInput \|\|/.test(lockSource),
    '应用锁不得再无条件优先聚焦 PIN 输入框');

  const viewsPath = path.resolve(__dirname, '..', 'public', 'js', 'views.js');
  const viewsSource = fs.readFileSync(viewsPath, 'utf8');
  const searchStart = viewsSource.indexOf('export function searchView');
  const searchEnd = viewsSource.indexOf('\n  addSearchHistory(q);', searchStart);
  assert.ok(searchStart >= 0 && searchEnd > searchStart);
  assert.match(viewsSource.slice(searchStart, searchEnd),
    /let autoFocusPending\s*=\s*\([^;]+\)\s*&&\s*shouldAutoFocusEditable\(\)/,
    '初始 #/search 空搜索页只能在通用策略允许时安排输入框自动聚焦');

  console.log('mobile password gate focus checks pass');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
