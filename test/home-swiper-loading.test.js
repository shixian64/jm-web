'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

class FakeText {
  constructor(value) {
    this.textContent = String(value);
    this.parentElement = null;
  }
}

class FakeClassList {
  constructor(element) {
    this.element = element;
    this.values = new Set();
  }

  fromString(value) {
    this.values = new Set(String(value || '').split(/\s+/).filter(Boolean));
  }

  sync() { this.element._className = [...this.values].join(' '); }

  add(...names) {
    names.forEach((name) => this.values.add(name));
    this.sync();
  }

  remove(...names) {
    names.forEach((name) => this.values.delete(name));
    this.sync();
  }

  toggle(name, force) {
    const enabled = force === undefined ? !this.values.has(name) : !!force;
    if (enabled) this.values.add(name); else this.values.delete(name);
    this.sync();
    return enabled;
  }

  contains(name) { return this.values.has(name); }
}

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.parentElement = null;
    this.classList = new FakeClassList(this);
    this._className = '';
    this.tabIndex = -1;
    this.innerHTML = '';
  }

  get className() { return this._className; }
  set className(value) {
    this._className = String(value || '');
    this.classList.fromString(this._className);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'tabindex') this.tabIndex = Number(value);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  addEventListener(name, handler) {
    const handlers = this.listeners.get(name) || [];
    handlers.push(handler);
    this.listeners.set(name, handlers);
  }

  removeEventListener(name, handler) {
    const handlers = this.listeners.get(name) || [];
    this.listeners.set(name, handlers.filter((item) => item !== handler));
  }

  dispatch(name, extra = {}) {
    const event = { stopPropagation() {}, preventDefault() {}, relatedTarget: null, ...extra };
    for (const handler of this.listeners.get(name) || []) handler(event);
  }

  appendChild(child) {
    child.parentElement = this;
    this.childNodes.push(child);
    if (child instanceof FakeElement) this.children.push(child);
    return child;
  }

  append(...children) { children.forEach((child) => this.appendChild(child)); }

  querySelectorAll(selector) {
    const tag = String(selector).toUpperCase();
    const matches = [];
    for (const child of this.children) {
      if (child.tagName === tag) matches.push(child);
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }

  matches() { return false; }

  contains(target) {
    return target === this || this.children.some((child) => child.contains(target));
  }
}

function findByClass(root, className) {
  if (root.classList?.contains(className)) return root;
  for (const child of root.children || []) {
    const found = findByClass(child, className);
    if (found) return found;
  }
  return null;
}

function loadedIndexes(slides) {
  return slides.flatMap((slide, index) => slide.style.backgroundImage ? [index] : []);
}

const originalGlobals = {
  document: global.document,
  localStorage: global.localStorage,
  location: global.location,
  setInterval: global.setInterval,
  clearInterval: global.clearInterval,
};

function restoreGlobals() {
  for (const [name, value] of Object.entries(originalGlobals)) {
    if (value === undefined) delete global[name]; else global[name] = value;
  }
}

(async () => {
  const intervals = new Map();
  let intervalId = 0;
  global.setInterval = (callback, delay) => {
    const id = ++intervalId;
    intervals.set(id, { callback, delay });
    return id;
  };
  global.clearInterval = (id) => { intervals.delete(id); };
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  global.location = { hash: '#/' };
  global.document = {
    activeElement: null,
    documentElement: { dataset: {}, style: {}, classList: new FakeClassList({ _className: '' }) },
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_namespace, tag) => new FakeElement(tag),
    createTextNode: (value) => new FakeText(value),
  };

  const viewsUrl = `${pathToFileURL(path.resolve(__dirname, '..', 'public', 'js', 'views.js')).href}?swiper=${Date.now()}`;
  const { buildSwiper } = await import(viewsUrl);
  const items = Array.from({ length: 6 }, (_, index) => ({
    id: String(index + 1),
    name: `漫画 ${index + 1}`,
    image: `/media/albums/${index + 1}.jpg`,
  }));

  const cleanups = [];
  const swiper = buildSwiper(items, cleanups, '测试精选');
  const slides = swiper.children.filter((child) => child.classList.contains('slide'));
  assert.strictEqual(slides.length, 6);
  assert.deepStrictEqual(loadedIndexes(slides), [0], '首屏只能请求 active 背景图');
  assert.match(slides[0].style.backgroundImage, /%2Fmedia%2Falbums%2F1\.jpg/);
  assert.strictEqual(slides[0].getAttribute('aria-hidden'), 'false');
  assert.strictEqual(slides[0].tabIndex, 0);
  slides.slice(1).forEach((slide) => {
    assert.strictEqual(slide.dataset.backgroundReady, undefined, '不可见 slide 不应提前进入加载队列');
    assert.strictEqual(slide.getAttribute('aria-hidden'), 'true');
    assert.strictEqual(slide.tabIndex, -1);
  });

  findByClass(swiper, 'next').dispatch('click');
  assert.deepStrictEqual(loadedIndexes(slides), [0, 1, 2], '切到下一张时只加载目标和目标的下一张');
  assert.ok(slides[1].classList.contains('on'));
  assert.strictEqual(slides[1].getAttribute('aria-hidden'), 'false');
  assert.strictEqual(slides[1].tabIndex, 0);
  assert.strictEqual(slides[0].getAttribute('aria-hidden'), 'true');
  assert.strictEqual(slides[0].tabIndex, -1);

  const activeTimer = [...intervals.values()][0];
  assert.strictEqual(activeTimer.delay, 5000, '自动轮播间隔不得改变');
  activeTimer.callback();
  assert.ok(slides[2].classList.contains('on'), '自动轮播仍应切到下一张');
  assert.deepStrictEqual(loadedIndexes(slides), [0, 1, 2, 3]);

  // 跨页点击圆点时也只能新增目标图和它的下一张，不得补齐中间图片。
  const jumpCleanups = [];
  const jumpSwiper = buildSwiper(items, jumpCleanups, '测试精选');
  const jumpSlides = jumpSwiper.children.filter((child) => child.classList.contains('slide'));
  const dots = findByClass(jumpSwiper, 'dots');
  dots.children[4].dispatch('click');
  assert.deepStrictEqual(loadedIndexes(jumpSlides), [0, 4, 5]);
  assert.ok(jumpSlides[4].classList.contains('on'));

  [...cleanups, ...jumpCleanups].forEach((cleanup) => cleanup());
  assert.strictEqual(intervals.size, 0, '销毁首页时必须继续清理自动轮播定时器');

  restoreGlobals();
  console.log('home swiper lazy background loading checks pass');
})().catch((error) => {
  restoreGlobals();
  console.error(error);
  process.exitCode = 1;
});
