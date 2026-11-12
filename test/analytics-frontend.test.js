'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type) { for (const fn of [...(this.listeners.get(type) || [])]) fn({ type }); }
  size(type) { return this.listeners.get(type)?.size || 0; }
}
class Element {
  constructor(tag, attrs, children) { this.tag = tag; this.attrs = attrs || {}; this.children = children.flat(Infinity).filter((v) => v != null); }
  append(...children) { this.children.push(...children.flat(Infinity).filter((v) => v != null)); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(k, v) { this.attrs[k] = v; }
  set textContent(value) { this.children = [String(value)]; }
  focus() {
    if (Element.activeElement) Element.activeElement.focused = false;
    Element.activeElement = this;
    this.focused = true;
    this.attrs.onfocus?.();
  }
  get textContent() { return this.children.map((v) => v instanceof Element ? v.textContent : String(v)).join(''); }
}
const h = (tag, attrs, ...children) => new Element(tag, attrs, children);
const find = (el, predicate) => el instanceof Element ? (predicate(el) ? el : el.children.map((c) => find(c, predicate)).find(Boolean)) : null;
const findAll = (el, predicate) => el instanceof Element ? [...(predicate(el) ? [el] : []), ...el.children.flatMap((child) => findAll(child, predicate))] : [];
const hasClass = (el, name) => String(el.attrs.class || '').split(/\s+/).includes(name);
const flush = () => new Promise((resolve) => setImmediate(resolve));
(async () => {
  const document = new Events(), window = new Events();
  document.visibilityState = 'visible';
  let clock = 100000, allowed = true, intervalSeq = 0;
  const calls = [], intervals = new Map(), timers = new Map();
  const context = vm.createContext({ document, window, navigator: { onLine: true }, Date: { now: () => clock }, AbortController,
    setInterval: (fn) => { const id = ++intervalSeq; intervals.set(id, fn); return id; }, clearInterval: (id) => intervals.delete(id),
    setTimeout: (fn) => { const id = ++intervalSeq; timers.set(id, fn); return id; }, clearTimeout: (id) => timers.delete(id),
    apiRequest: async (url, options) => { calls.push({ url, ...options, data: JSON.parse(options.body) }); return { ok: true }; },
  });
  const client = read('public/js/analytics-client.js').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(client + '\nglobalThis.client = { startAnalytics, trackPage, trackComic };', context);
  context.client.trackPage();
  assert.strictEqual(calls.length, 0, '门禁通过前不采集');
  context.client.startAnalytics({ canTrack: () => allowed });
  await flush();
  assert.strictEqual(calls.length, 1);
  context.client.startAnalytics({ canTrack: () => allowed });
  assert.strictEqual(intervals.size, 1, '启动幂等');
  context.client.trackComic('server-proof', new AbortController().signal);
  await flush();
  assert.strictEqual(calls.at(-1).data.kind, 'comic');
  assert.strictEqual(calls.at(-1).data.proof, 'server-proof');
  assert.strictEqual(document.size('visibilitychange'), 1, '发送后清理路由监听');
  const before = calls.length;
  document.visibilityState = 'hidden';
  clock += 120000;
  for (const fn of intervals.values()) fn();
  assert.strictEqual(calls.length, before, '后台标签页不增加活跃');
  const aborted = new AbortController();
  context.client.trackComic('old-route', aborted.signal);
  assert.strictEqual(document.size('visibilitychange'), 2);
  aborted.abort();
  assert.strictEqual(document.size('visibilitychange'), 1);
  document.visibilityState = 'visible'; document.emit('visibilitychange');
  await flush();
  assert.strictEqual(calls.at(-1).data.kind, 'active');
  assert(!calls.some((v) => v.data.proof === 'old-route'), '退出路由不发过期埋点');
  allowed = false;
  const lockedBefore = calls.length;
  context.client.trackPage();
  context.client.trackComic('unlock-route', new AbortController().signal);
  for (const fn of intervals.values()) fn();
  assert.strictEqual(calls.length, lockedBefore, '本地锁定时不采集');
  allowed = true; window.emit('jmw-local-unlocked');
  await flush();
  assert(calls.some((v) => v.data.proof === 'unlock-route'));
  window.emit('pagehide');
  assert.strictEqual(intervals.size, 0);
  window.emit('pageshow');
  assert.strictEqual(intervals.size, 1, 'BFCache 恢复不重复计时器');
  await flush();
  assert.strictEqual(timers.size, 0, '请求完成后取消超时');

  let response = {
    available: true, persistenceOk: true, limited: false, startedAt: Date.parse('2026-11-10T00:00:00Z'), generatedAt: Date.parse('2026-11-11T00:00:00Z'),
    from: '2026-11-05', to: '2026-11-11', totals: { users: 3, accounts: 1, anonymous: 2, pageViews: 9, comicUsers: 3, comics: 1 },
    trend: [{ date: '2026-11-11', users: 3, accounts: 1, pageViews: 9 }],
    ranking: [{ aid: '123', title: '<img src=x onerror=alert(1)>', users: 3, views: 10 }], page: 1, pageSize: 20, total: 21,
  };
  const viewContext = vm.createContext({ h, icon: (name) => h('svg', { name }), loadingBox: () => h('p', null, 'loading'), errorBox: (v) => h('p', { class: 'error-box' }, v),
    Date, Number, Math, apiRequest: async () => response });
  vm.runInContext(read('public/js/analytics-view.js').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '') + '\nglobalThis.analyticsView = analyticsView;globalThis.analyticsChartScale = analyticsChartScale;globalThis.analyticsChartRows = analyticsChartRows;', viewContext);
  const ctx = { signal: new AbortController().signal, isActive: () => true, refresh() {} };
  let root = h('div');
  await viewContext.analyticsView(root, new URLSearchParams(), ctx);
  assert(root.textContent.includes('活跃用户'));
  assert(root.textContent.includes('<img src=x onerror=alert(1)>'));
  assert(!find(root, (el) => el.tag === 'img'), '上游标题必须作为纯文本');
  assert(!find(root, (el) => Object.hasOwn(el.attrs, 'html')), '统计 DOM 禁止 innerHTML');
  assert(find(root, (el) => el.tag === 'table'), '趋势必须提供可访问数据表');
  root = h('div');
  await viewContext.analyticsView(root, new URLSearchParams('days=30'), ctx, true);
  assert(find(root, (el) => el.attrs.href === '#/popular?days=30&page=2'), '完整排行支持翻页');
  response = { ...response, totals: { users: 0 }, ranking: [] };
  root = h('div'); await viewContext.analyticsView(root, new URLSearchParams(), ctx);
  assert(root.textContent.includes('不使用旧日志或 AI 热度回填'));
  response = { ...response, available: false };
  root = h('div'); await viewContext.analyticsView(root, new URLSearchParams(), ctx);
  assert(root.textContent.includes('统计状态暂不可用'));
  root = h('div'); await viewContext.analyticsView(root, new URLSearchParams(), { ...ctx, isActive: () => false });
  assert(root.textContent.includes('loading'), '过期响应不得修改已退出的页面');
  // 图表数据映射、整数刻度、空态与实际按钮行为（不触发额外查询）。
  for (const peak of [0, 1, 2, 3, 7, 36, 99, 1500, 120000]) {
    const scale = viewContext.analyticsChartScale(peak);
    assert(scale.max >= peak && scale.max > 0);
    assert.strictEqual(scale.ticks[0], 0, '柱形图必须从 0 开始');
    assert(scale.ticks.every(Number.isInteger), '人数刻度不可出现半个人');
    assert.strictEqual(scale.ticks.length, 5);
  }
  const sample = [
    { date: '2026-11-09', users: 0, accounts: 0, pageViews: 0 },
    { date: '2026-11-10', users: 10, accounts: 4, pageViews: 30 },
    { date: '2026-11-11', users: 0, accounts: 0, pageViews: 0 },
  ];
  const chartRows = viewContext.analyticsChartRows(sample, Date.parse('2026-11-09T16:00:00Z'));
  assert.strictEqual(chartRows[0].available, false, '北京时间启用前不能伪装成零访问');
  assert.strictEqual(chartRows[1].available, true);
  assert.strictEqual(chartRows[2].available, true, '启用后真实的零必须保留');
  response = { ...response, available: true, trend: sample, totals: { users: 10 }, startedAt: Date.parse('2026-11-10T00:00:00Z') };
  root = h('div');
  await viewContext.analyticsView(root, new URLSearchParams(), ctx);
  const inspector = find(root, (el) => hasClass(el, 'analytics-inspector'));
  assert(inspector.textContent.includes('2026-11-11'));
  let columns = findAll(root, (el) => hasClass(el, 'analytics-column'));
  assert(columns[0].attrs.disabled, '未启用日期不能被当作真实零选择');
  assert(find(root, (el) => hasClass(el, 'analytics-zero')), '真实零必须有零值标记');
  columns[1].attrs.onclick();
  assert(inspector.textContent.includes('2026-11-10'));
  assert(inspector.textContent.includes('匿名访客6位'));
  const stacks = findAll(root, (el) => hasClass(el, 'analytics-column-stack'));
  assert.strictEqual(stacks[1].children[0].attrs.style.height, '40%');
  assert.strictEqual(stacks[1].children[1].attrs.style.height, '60%');
  const reference = find(root, (el) => hasClass(el, 'analytics-average-line'));
  assert.strictEqual(reference.attrs.style.bottom, '25%', '日均只用已启用日期，不能加上启用前的零');
  const heading = find(root, (el) => hasClass(el, 'analytics-chart-heading'));
  const description = find(heading, (el) => el.tag === 'p');
  assert.strictEqual(description.textContent, '北京时间 · 活跃用户每天去重');
  const switchButton = find(root, (el) => el.tag === 'button' && el.textContent === '页面访问');
  switchButton.attrs.onclick();
  assert.strictEqual(switchButton.attrs['aria-pressed'], 'true');
  assert(root.textContent.includes('日均页面访问15次'));
  assert.strictEqual(description.textContent, '北京时间 · 页面打开次数，非去重用户数', '页面访问模式必须展示次数口径');
  find(root, (el) => el.tag === 'button' && el.textContent === '活跃用户').attrs.onclick();
  assert.strictEqual(description.textContent, '北京时间 · 活跃用户每天去重', '切回用户数时恢复去重说明');
  switchButton.attrs.onclick();
  columns = findAll(root, (el) => hasClass(el, 'analytics-column'));
  assert.strictEqual(findAll(root, (el) => hasClass(el, 'analytics-chart-columns')).length, 1, '切换不可堆叠图表节点');
  let prevented = false;
  columns[1].attrs.onkeydown({ key: 'ArrowRight', preventDefault: () => { prevented = true; } });
  assert(prevented && inspector.textContent.includes('2026-11-11'));
  assert.strictEqual(columns[2].attrs.tabindex, '0');
  assert(columns[2].focused);
  columns[2].attrs.onkeydown({ key: 'Home', preventDefault() {} });
  assert(inspector.textContent.includes('2026-11-10'), '键盘跳过未启用日期');
  find(root, (el) => el.attrs['aria-label'] === '查看后一天').attrs.onclick();
  assert(inspector.textContent.includes('2026-11-11'), '手机端可用相邻日期按钮查看密集数据');
  const startedAtBeforeMixed = response.startedAt;
  response = { ...response, startedAt: Date.parse('2026-11-09T00:00:00Z') };
  const mixedRoot = h('div');
  await viewContext.analyticsView(mixedRoot, new URLSearchParams(), ctx);
  const mixedColumns = findAll(mixedRoot, (el) => hasClass(el, 'analytics-column'));
  const mixedInspector = find(mixedRoot, (el) => hasClass(el, 'analytics-inspector'));
  const mixedNext = find(mixedRoot, (el) => el.attrs['aria-label'] === '查看后一天');
  mixedColumns[0].focus();
  mixedColumns[1].attrs.onpointerenter({ pointerType: 'mouse' });
  assert(mixedInspector.textContent.includes('2026-11-10'), '鼠标悬停仍可预览其他日期');
  assert.strictEqual(Element.activeElement, mixedColumns[0], '悬停不可抢走键盘焦点');
  mixedColumns[0].attrs.onkeydown({ key: 'ArrowRight', preventDefault() {} });
  assert(mixedInspector.textContent.includes('2026-11-10'), '方向键须以实际焦点为起点，而非悬停日期');
  assert.strictEqual(mixedColumns[1].attrs.tabindex, '0');
  mixedColumns[2].attrs.onpointerenter({ pointerType: 'mouse' });
  assert.strictEqual(mixedColumns[1].attrs.tabindex, '0', '悬停须保留原键盘入口');
  assert.strictEqual(mixedColumns[2].attrs.tabindex, '-1');
  assert.strictEqual(mixedColumns[1].attrs['aria-pressed'], 'true', '悬停预览不改变已选日期');
  assert.strictEqual(mixedNext.disabled, false, '悬停预览不应禁用已选日期的后一天按钮');
  mixedColumns[2].attrs.onpointerleave({ pointerType: 'mouse' });
  assert(mixedInspector.textContent.includes('2026-11-10'), '鼠标离开后恢复已选日期');
  mixedColumns[2].attrs.onpointerenter({ pointerType: 'mouse' });
  mixedColumns[1].attrs.onkeydown({ key: 'ArrowRight', preventDefault() {} });
  assert.strictEqual(Element.activeElement, mixedColumns[2], '方向键移动至相邻有效日期');
  mixedColumns[1].attrs.onpointerenter({ pointerType: 'touch' });
  assert(mixedInspector.textContent.includes('2026-11-11'), '触屏 pointerenter 不预览日期');
  mixedColumns[0].attrs.onpointerenter({ pointerType: 'mouse' });
  mixedColumns[2].attrs.onkeydown({ key: 'ArrowLeft', preventDefault() {} });
  assert.strictEqual(Element.activeElement, mixedColumns[1], '左方向键同样以实际焦点为起点');
  mixedColumns[0].attrs.onpointerenter({ pointerType: 'mouse' });
  find(mixedRoot, (el) => el.tag === 'button' && el.textContent === '页面访问').attrs.onclick();
  assert(mixedInspector.textContent.includes('2026-11-10'), '指标切换清除悬停预览并保留选中日期');
  assert.strictEqual(findAll(mixedRoot, (el) => hasClass(el, 'analytics-column'))[1].attrs.tabindex, '0');
  // redraw 后获取新节点，不能用旧图表引用模拟后续交互。
  const redrawnColumns = findAll(mixedRoot, (el) => hasClass(el, 'analytics-column'));
  redrawnColumns[1].attrs.onclick();
  redrawnColumns[1].attrs.onpointerleave({ pointerType: 'mouse' });
  assert(mixedInspector.textContent.includes('2026-11-10'), '点击日期后，离开仍保留所选日期');
  response = { ...response, startedAt: startedAtBeforeMixed };
  const was = inspector.textContent;
  const chartAbort = new AbortController();
  let staleRoot = h('div');
  await viewContext.analyticsView(staleRoot, new URLSearchParams(), { ...ctx, signal: chartAbort.signal });
  const staleInspector = find(staleRoot, (el) => hasClass(el, 'analytics-inspector'));
  chartAbort.abort();
  const staleColumn = findAll(staleRoot, (el) => hasClass(el, 'analytics-column'))[1];
  staleColumn.attrs.onclick();
  staleColumn.attrs.onpointerenter({ pointerType: 'mouse' });
  staleColumn.attrs.onpointerleave({ pointerType: 'mouse' });
  assert.strictEqual(staleInspector.textContent, was, '路由退出后停止交互更新');
  response = { ...response, trend: [{ date: '2026-11-11', users: 1, accounts: 1, pageViews: 1 }] };
  root = h('div'); await viewContext.analyticsView(root, new URLSearchParams('days=1'), ctx);
  assert.strictEqual(findAll(root, (el) => hasClass(el, 'analytics-column')).length, 1, '单日图正确渲染');
  const styles = findAll(root, (el) => el.attrs.style).map((el) => JSON.stringify(el.attrs.style)).join('');
  assert(!/NaN|Infinity/.test(styles));
  response = { ...response, trend: sample, startedAt: Date.parse('2026-11-15T00:00:00Z') };
  root = h('div'); await viewContext.analyticsView(root, new URLSearchParams(), ctx);
  assert(root.textContent.includes('此范围尚未启用统计'));
  response = { ...response, startedAt: Date.parse('2026-11-10T00:00:00Z'), trend: [{ date: '2026-11-11', users: 0, accounts: 0, pageViews: 0 }] };
  root = h('div'); await viewContext.analyticsView(root, new URLSearchParams('days=1'), ctx);
  assert(root.textContent.includes('已启用日期暂无活跃用户'), '真实零访问应明确显示空态，避免误认图表故障');
  const reader = read('public/js/reader.js');
  assert(reader.indexOf('trackComic(data.analyticsProof, signal)') > reader.indexOf('state.translationAvailable ='), '阅读器应在成功 render 后记访问');
  assert(!read('public/js/downloads.js').includes('trackComic'), '下载不发漫画埋点');
  console.log('analytics frontend all pass (foreground, gate, locks, route abort, lifecycle, XSS, empty, pagination, stale response)');
})().catch((e) => { console.error(e); process.exitCode = 1; });
