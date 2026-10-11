'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const turn = () => new Promise((resolve) => setImmediate(resolve));

class ClassList {
  constructor(el) { this.el = el; }
  contains(name) { return this.el.className.split(/\s+/).includes(name); }
  add(...names) { this.el.className = [...new Set([...this.el.className.split(/\s+/).filter(Boolean), ...names])].join(' '); }
  remove(...names) { this.el.className = this.el.className.split(/\s+/).filter((x) => !names.includes(x)).join(' '); }
  toggle(name, force = !this.contains(name)) { if (force) this.add(name); else this.remove(name); return force; }
}

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null;
    this.dataset = {}; this.attributes = {}; this.className = ''; this.classList = new ClassList(this);
    this.style = { setProperty() {}, removeProperty() {} }; this.listeners = new Map();
    this.hidden = false; this.value = ''; this.disabled = false;
  }
  get isConnected() { return !!this.parentElement || this === document.body; }
  get firstElementChild() { return this.children.find((x) => x instanceof Element); }
  get lastElementChild() { return [...this.children].reverse().find((x) => x instanceof Element); }
  get textContent() { return this.children.map((x) => x.textContent).join(''); }
  set textContent(value) { this.children = [{ textContent: String(value), parentElement: this }]; }
  set innerHTML(_value) { this.children = []; }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'hidden' || name === 'disabled') this[name] = true;
    if (name === 'value') this.value = String(value);
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  append(...children) { children.forEach((x) => this.appendChild(x)); }
  prepend(...children) { children.forEach((x) => { x.parentElement = this; }); this.children.unshift(...children); }
  replaceChildren(...children) { this.children.forEach((x) => { x.parentElement = null; }); this.children = []; this.append(...children); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((x) => x !== this); this.parentElement = null; }
  replaceWith(child) { const parent = this.parentElement; if (!parent) return; const index = parent.children.indexOf(this); parent.children[index] = child; child.parentElement = parent; this.parentElement = null; }
  contains(target) { return target === this || this.children.some((x) => x instanceof Element && x.contains(target)); }
  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some((x) => this.matches(x.trim()));
    const attribute = selector.match(/\[([^\]=]+)(?:="([^"]*)")?\]/);
    if (attribute) {
      const name = attribute[1];
      const value = name.startsWith('data-') ? this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] : this.attributes[name];
      if (value === undefined || (attribute[2] !== undefined && value !== attribute[2])) return false;
      selector = selector.replace(attribute[0], '');
    }
    if (!selector) return true;
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    return this.tagName === selector.toUpperCase();
  }
  closest(selector) { for (let el = this; el; el = el.parentElement) if (el.matches(selector)) return el; return null; }
  querySelectorAll(selector) {
    if (selector.startsWith(':scope > ')) return this.children.filter((x) => x instanceof Element && x.matches(selector.slice(9)));
    const parts = selector.split(/\s+/);
    const found = [];
    for (const child of this.children) if (child instanceof Element) {
      if (child.matches(parts.at(-1)) && (parts.length === 1 || child.parentElement?.closest(parts[0]))) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(name, handler) { const rows = this.listeners.get(name) || []; rows.push(handler); this.listeners.set(name, rows); }
  removeEventListener(name, handler) { this.listeners.set(name, (this.listeners.get(name) || []).filter((x) => x !== handler)); }
  async dispatch(name, event = {}) {
    const payload = { target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...event };
    await Promise.all([...(this.listeners.get(name) || []), ...(typeof this[`on${name}`] === 'function' ? [this[`on${name}`]] : [])].map((fn) => fn(payload)));
  }
}

(async () => {
  assert.match(fs.readFileSync(path.resolve(__dirname, '../public/css/app.css'), 'utf8'),
    /\.navigation-update\[hidden\]\s*\{\s*display:\s*none/,
    '更新提示的 hidden 状态不能被 .btn 的 display 覆盖');
  let now = 1000;
  const originalNow = Date.now;
  Date.now = () => now;
  const observers = [];
  global.Element = Element;
  const storage = new Map();
  global.localStorage = { getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
  global.location = { hash: '#/favorites' };
  global.window = new EventTarget(); window.scrollY = 0;
  global.document = {
    createElement: (tag) => new Element(tag), createElementNS: (_, tag) => new Element(tag),
    createTextNode: (text) => ({ textContent: String(text) }),
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, classList: { toggle() {} } },
    querySelector: () => null, getElementById: () => new Element('div'), scrollingElement: { scrollTop: 0 },
    body: new Element('body'),
  };
  global.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  };
  const { favoritesView } = await import(pathToFileURL(path.resolve(__dirname, '../public/js/user.js')));
  const { setting, updateSetting } = await import(pathToFileURL(path.resolve(__dirname, '../public/js/store.js')));
  const { api, navigationState } = await import(pathToFileURL(path.resolve(__dirname, '../public/js/api.js')));
  let requests = 0; let offset = 0; let folderName = '原收藏夹'; let failPage = 0; let unauthorized = false;
  global.fetch = async (url) => {
    if (url === '/api/logout') return new Response('{"ok":true}');
    const parsed = new URL(url, 'http://test');
    assert.equal(parsed.pathname, '/api/favorites');
    requests++;
    const page = Number(parsed.searchParams.get('page'));
    if (unauthorized) return new Response('{"error":"expired"}', { status: 401 });
    if (page === failPage) return new Response('{"error":"offline"}', { status: 503 });
    const count = page === 3 ? 4 : 20;
    const list = Array.from({ length: count }, (_, index) => ({
      id: offset + (page - 1) * 20 + index + 1, name: `作品 ${index}`, author: ['作者A'], tags: ['标签A'],
    }));
    return new Response(JSON.stringify({ scope: 'cloud', data: {
      list, total: 44, source_count: count, source_page_key: list.map((x) => x.id).join(','),
      folder_list: { 0: '全部', 1: folderName }, session_folder_ids: [],
    } }));
  };
  function mount(restoreScroll = false, query = 'o=mp', entryId = 42) {
    const root = new Element('main'); document.body.append(root);
    const controller = new AbortController();
    let refreshes = 0;
    const ctx = { entryId, restoreScroll, signal: controller.signal,
      isActive: () => !controller.signal.aborted, refresh: () => { refreshes++; } };
    const cleanup = favoritesView(root, new URLSearchParams(query), ctx);
    return { root, ctx, refreshes: () => refreshes, cleanup() { controller.abort(); cleanup(); root.remove(); } };
  }
  const cards = (view) => view.root.querySelectorAll('.comic-card').filter((x) => !x.classList.contains('skeleton-card'));
  async function nextPage(view) {
    const observer = [...observers].reverse().find((x) => [...x.targets].some((target) => target.parentElement?.querySelector('.grid')));
    assert(observer, '必须存在分页哨兵');
    observer.callback([{ isIntersecting: true }]);
    await turn();
  }

  let view = mount(); await turn();
  assert.equal(cards(view).length, 20);
  await nextPage(view); await nextPage(view);
  assert.equal(cards(view).length, 44);
  assert.equal(requests, 3);
  const input = view.root.querySelector('.favorite-search-input'); input.value = '作者A'; await input.dispatch('input');
  await view.root.querySelector('.favorite-filter-toggle').dispatch('click');
  const chip = view.root.querySelector('.favorite-facet-chips').querySelector('button'); await chip.dispatch('click');
  view.cleanup();
  view = mount(true);
  assert.equal(cards(view).length, 44, '返回时必须同步恢复全部三页，不能等 Observer');
  assert.equal(view.root.querySelector('.favorite-search-input').value, '作者A');
  assert.equal(view.root.querySelector('.favorite-filter-panel').hidden, false);
  await turn();
  assert(view.root.querySelector('.favorite-facet-chips').querySelector('button').classList.contains('active'));
  await turn(); assert.equal(requests, 3, '新鲜快照返回不得重复请求收藏');

  // 复用现有真实下拉手势，验证强制刷新不是再次命中快照。
  folderName = '新收藏夹';
  const pullRoot = view.root.querySelector('.pull-refresh-host');
  assert.equal(pullRoot.listeners.get('touchend').length, 1, '不得重复安装下拉刷新');
  await pullRoot.dispatch('touchstart', { touches: [{ clientX: 0, clientY: 0 }] });
  await pullRoot.dispatch('touchmove', { touches: [{ clientX: 0, clientY: 160 }] });
  await pullRoot.dispatch('touchend', { touches: [] });
  assert.equal(requests, 4);
  assert.equal(cards(view).length, 20);
  assert(view.root.querySelector('.favorite-folders').textContent.includes('新收藏夹'), '刷新必须重新 hydrate 收藏夹元数据');
  await nextPage(view); await nextPage(view);
  view.cleanup(); now += 120_001; offset = 100;
  const before = requests;
  view = mount(true);
  assert.equal(cards(view)[0].dataset.favoriteId, '1', '后台更新前先展示完整旧快照');
  await turn(); await turn();
  assert.equal(requests - before, 3, '重验证必须覆盖已缓存三页，不只更新第一页');
  assert.equal(cards(view)[0].dataset.favoriteId, '1', '后台结果不得擅自重排活动视图');
  const key = navigationState.key('mp', 0);
  const newer = navigationState.get(key).value;
  assert.deepEqual(newer.pages.map((p) => p.data.list[0].id), [101, 121, 141], '原子提交整批新分页');
  const notice = view.root.querySelectorAll('button').find((x) => x.textContent === '收藏有更新，点击刷新');
  assert.equal(notice.hidden, false);
  view.cleanup();
  assert.deepEqual(navigationState.get(key).value, newer, '旧视图 cleanup 不能回写旧分页');
  view = mount(true);
  assert.equal(cards(view)[0].dataset.favoriteId, '101');
  assert.equal(cards(view).length, 44);
  view.cleanup();

  now += 120_001; offset = 200; failPage = 2;
  view = mount(true); await turn(); await turn();
  assert.deepEqual(navigationState.get(key).value, newer, '重验证第二页失败，不得保存新第一页 + 旧后续页');
  view.cleanup(); failPage = 0;
  unauthorized = true;
  view = mount(true); await turn();
  assert.equal(cards(view).length, 0, '后台 401 必须移除已经显示的旧账号收藏');
  assert(view.root.textContent.includes('请重新登录'));
  view.cleanup(); assert.equal(navigationState.get(key), null);

  unauthorized = false; view = mount(); await turn();
  await api.logout();
  assert.equal(cards(view).length, 0, '退出成功必须立即移除活动页面上的旧收藏');
  assert(view.refreshes() > 0);
  view.cleanup(); assert.equal(navigationState.get(key), null);
  const normalFetch = global.fetch;
  let releaseFirst;
  let blockFirst = true;
  global.fetch = (url, options) => {
    if (url.startsWith('/api/like')) return Promise.resolve(new Response('{"ok":true}'));
    if (url.startsWith('/api/favorites') && blockFirst) {
      blockFirst = false;
      return new Promise((resolve) => { releaseFirst = () => normalFetch(url, options).then(resolve); });
    }
    return normalFetch(url, options);
  };
  view = mount(); await turn();
  await api.like(999);
  releaseFirst(); await turn();
  await nextPage(view);
  assert.equal(cards(view).length, 20, '无关详情失效后，收藏冷加载必须能用新世代重试');
  view.cleanup();
  const replaced = [];
  global.history = { state: { __jmw_route_entry: { id: 500, key: '#/favorites' } },
    replaceState(next, _title, url) { this.state = next; replaced.push(url); location.hash = url; } };
  updateSetting({ favoriteOrder: 'mp', favoriteFolder: '1' });
  view = mount(false, '', 500); await turn();
  assert.equal(view.root.querySelector('.favorite-order').querySelector('a[aria-current="page"]').textContent, '更新时间');
  assert.equal(view.root.querySelector('.favorite-folders').querySelector('a[aria-current="page"]').textContent, folderName);
  assert.equal(location.hash, '#/favorites?o=mp&folder=1');
  assert.equal(history.state.__jmw_route_entry.id, 500, '补全默认 URL 不得新增历史项');
  assert.equal(JSON.parse(storage.get('jmw_setting')).favoriteFolder, '1', '只持久化分组/排序 UI 偏好');
  view.cleanup();
  view = mount(false, 'o=mp&folder=0', 501); await turn();
  assert.equal(setting.favoriteFolder, '0', '快捷更新入口必须覆盖上次分组，显示全部更新');
  assert.equal(setting.favoriteOrder, 'mp');
  view.cleanup();
  view = mount(false, 'o=invalid&folder=../../outside', 502); await turn();
  assert.equal(location.hash, '#/favorites?o=mr&folder=0', '损坏或外部传入的偏好应规范化');
  view.cleanup();
  updateSetting({ favoriteOrder: 'mp', favoriteFolder: '1' });
  await api.logout();
  assert.equal(setting.favoriteFolder, '0', '退出时清除旧账号分组偏好');
  assert.equal(setting.favoriteOrder, 'mp', '排序是普通 UI 偏好，退出后可保留');
  delete global.history;
  Date.now = originalNow;
  console.log('favorites back-navigation/snapshot/filter/pull-refresh/auth all pass');
})().catch((error) => { console.error(error); process.exitCode = 1; });
