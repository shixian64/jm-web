import { apiRequest, imgSrc } from './api.js';
import { h, loadingBox, errorBox, installImageRetry } from './ui.js';
import { icon } from './icons.js';

const number = (n) => Number(n || 0).toLocaleString('zh-CN');
const PERIODS = [[1, '今天'], [7, '7 天'], [30, '30 天']];

export async function analyticsView(root, query, ctx, rankingOnly = false) {
  const days = [1, 7, 30].includes(Number(query.get('days'))) ? Number(query.get('days')) : 7;
  const requestedPage = Number(query.get('page'));
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(100000, requestedPage) : 1;
  const path = rankingOnly ? '/popular' : '/analytics';
  const content = h('div', { class: 'analytics-content', 'aria-live': 'polite', 'aria-busy': 'true' }, loadingBox());
  const tab = (href, label, active) => h('a', { href, class: active ? 'active' : '', 'aria-current': active ? 'page' : null }, label);
  const view = h('section', { class: 'page analytics-page' },
    h('header', { class: 'analytics-head' },
      h('h1', null, '数据统计'),
      h('nav', { class: 'analytics-periods', 'aria-label': '时间范围' }, PERIODS.map(([d, label]) =>
        h('a', { class: d === days ? 'active' : '', href: `#${path}?days=${d}`, 'aria-current': d === days ? 'true' : null }, label)))),
    h('nav', { class: 'analytics-tabs', 'aria-label': '统计分类' },
      tab(`#/analytics?days=${days}`, '用户概览', !rankingOnly),
      tab(`#/popular?days=${days}`, '人气漫画', rankingOnly)),
    content,
  );
  root.append(view);
  try {
    const data = await apiRequest(`/analytics?days=${days}&page=${rankingOnly ? page : 1}`, { signal: ctx.signal });
    if (!ctx.isActive()) return;
    content.replaceChildren();
    content.setAttribute('aria-busy', 'false');
    if (!data.available) {
      content.append(errorBox('统计状态暂不可用'));
      return;
    }
    if (data.limited || !data.persistenceOk) content.append(h('p', { class: 'analytics-warning', role: 'status' },
      data.limited ? '采集已达容量上限，数据不完整' : '统计保存失败，最近数据可能丢失'));
    if (rankingOnly) renderRanking(content, data, days);
    else renderUsers(content, data, ctx, days);
  } catch (e) {
    if (!ctx.isActive() || e?.name === 'AbortError') return;
    content.setAttribute('aria-busy', 'false');
    content.replaceChildren(errorBox('统计加载失败，请稍后刷新'));
  }
}

function renderUsers(content, data, ctx, days) {
  const t = data.totals || {};
  const users = count(t.users), views = count(t.pageViews);
  const decimal = (value) => value.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
  const activeDays = analyticsChartRows(data.trend || [], data.startedAt).filter((row) => row.available).length;
  content.append(h('div', { class: 'analytics-metrics' },
    metric('活跃用户', users, 'users', `登录 ${number(t.accounts)} · 匿名 ${number(t.anonymous)}`, true),
    metric('页面访问', views, 'layout-grid', days > 1 && activeDays ? `日均 ${decimal(views / activeDays)}` : '次'),
    metric('人均访问', users ? decimal(views / users) : '—', 'user', '次 / 人')));
  // 单日只有一根柱，趋势图与上方指标完全重复，不渲染。
  if (days > 1) content.append(trendChart(data.trend || [], ctx, data.startedAt, data.generatedAt));
}

function renderRanking(content, data, days) {
  const t = data.totals || {};
  const rows = Array.isArray(data.ranking) ? data.ranking : [];
  if (!rows.length) {
    content.append(h('div', { class: 'analytics-empty' }, icon('book-open', 28), h('p', null, '暂无阅读记录')));
    return;
  }
  content.append(h('p', { class: 'analytics-ranking-summary' },
    h('strong', null, number(t.comicUsers)), ' 人阅读了 ', h('strong', null, number(t.comics)), ' 部漫画'));
  content.append(rankList(rows, (data.page - 1) * data.pageSize));
  if (data.total > data.pageSize) {
    const pages = Math.ceil(data.total / data.pageSize);
    content.append(h('nav', { class: 'analytics-pagination', 'aria-label': '排行榜分页' },
      data.page > 1 ? h('a', { class: 'btn', href: `#/popular?days=${days}&page=${data.page - 1}` }, '上一页') : h('span'),
      h('span', null, `${data.page} / ${pages}`),
      data.page < pages ? h('a', { class: 'btn', href: `#/popular?days=${days}&page=${data.page + 1}` }, '下一页') : h('span')));
  }
}

function metric(label, value, name, sub = '', primary = false) {
  return h('article', { class: `analytics-metric${primary ? ' is-primary' : ''}` },
    h('div', { class: 'analytics-metric-label' }, icon(name, 16), label),
    h('strong', null, typeof value === 'number' ? number(value) : value),
    sub ? h('span', { class: 'analytics-metric-sub' }, sub) : null);
}

function rankList(rows, offset) {
  const max = Math.max(1, ...rows.map((row) => count(row.users)));
  return h('ol', { class: 'analytics-ranking', start: offset + 1 }, rows.map((item, i) => {
    const rank = offset + i + 1;
    const cover = h('img', { alt: '', loading: 'lazy', decoding: 'async', onload: () => cover.classList?.add('is-loaded') });
    installImageRetry(cover, imgSrc({ aid: item.aid }), { lazy: true });
    return h('li', null, h('a', { href: `#/album/${item.aid}`, class: 'analytics-rank-link' },
      h('span', { class: `analytics-rank-number${rank <= 3 ? ` top top-${rank}` : ''}` }, String(rank)),
      h('span', { class: 'analytics-rank-cover', 'aria-hidden': 'true' }, cover),
      h('span', { class: 'analytics-rank-body' },
        h('strong', null, item.title),
        h('span', { class: 'analytics-rank-meta' },
          h('span', { class: 'analytics-rank-track', 'aria-hidden': 'true' }, h('i', { style: { width: `${count(item.users) / max * 100}%` } })),
          h('small', null, `${number(item.views)} 次阅读`))),
      h('span', { class: 'analytics-rank-count' }, h('strong', null, number(item.users)), h('small', null, '人'))));
  }));
}

const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const shortNumber = (value) => value >= 10000 ? `${Number((value / 10000).toFixed(1))}万`
  : value >= 1000 ? `${Number((value / 1000).toFixed(1))}k` : number(value);
const localDay = (value) => {
  if (!Number.isFinite(value)) return '';
  const date = new Date(value + 8 * 3600000);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
};

// 刻度始终从 0 开始，步长为整数；不让小样本出现半个人，也不裁切尖峰。
export function analyticsChartScale(max) {
  const raw = Math.max(1, count(max) / 4);
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((factor) => factor * power).find((value) => value >= raw);
  return { step, max: step * 4, ticks: [0, 1, 2, 3, 4].map((index) => index * step) };
}
export function analyticsChartRows(rows, startedAt) {
  const since = localDay(startedAt);
  return rows.map((row) => ({ ...row, users: count(row.users), accounts: Math.min(count(row.users), count(row.accounts)),
    pageViews: count(row.pageViews), available: !since || row.date >= since }));
}

function trendChart(source, ctx, startedAt, generatedAt) {
  const rows = analyticsChartRows(source, startedAt);
  const today = localDay(generatedAt);
  const available = rows.map((row, index) => row.available ? index : -1).filter((index) => index >= 0);
  let selected = available.at(-1) ?? Math.max(0, rows.length - 1);
  let field = 'users';
  let columns = [];
  const active = () => !ctx?.signal?.aborted && (ctx?.isActive?.() ?? true);
  const modes = [['users', '用户'], ['pageViews', '访问']];
  const switchers = modes.map(([key, label]) => h('button', { type: 'button', class: 'analytics-chart-switch',
    'aria-pressed': key === field ? 'true' : 'false', onclick: () => {
      if (!active() || key === field) return;
      field = key;
      draw();
    } }, label));
  const summary = h('div', { class: 'analytics-chart-summary' });
  const legend = h('div', { class: 'analytics-chart-legend', 'aria-label': '图例' });
  const plot = h('div', { class: 'analytics-chart-plot' });
  const selectedDate = h('strong', { class: 'analytics-inspector-date' });
  const selectedValues = h('div', { class: 'analytics-inspector-values' });
  const step = (direction) => {
    const position = available.indexOf(selected);
    select(available[Math.max(0, Math.min(available.length - 1, position + direction))]);
  };
  const previous = h('button', { type: 'button', class: 'analytics-day-step', 'aria-label': '查看前一天', onclick: () => step(-1) }, icon('arrow-left', 15));
  const next = h('button', { type: 'button', class: 'analytics-day-step', 'aria-label': '查看后一天', onclick: () => step(1) }, icon('arrow-right', 15));
  function select(index, focus = false) {
    if (!active() || !rows[index]?.available) return;
    selected = index;
    columns.forEach((column, i) => {
      column.setAttribute('aria-pressed', i === index ? 'true' : 'false');
      column.setAttribute('tabindex', i === index ? '0' : '-1');
    });
    preview(index);
    previous.disabled = index === available[0];
    next.disabled = index === available.at(-1);
    if (focus) columns[index]?.focus?.({ preventScroll: true });
  }
  // 悬停只预览内容，不修改选中日期、键盘入口或实际焦点。
  function preview(index) {
    if (!active() || !rows[index]?.available) return;
    columns.forEach((column, i) => {
      column.setAttribute('class', `analytics-column${i === index ? ' is-selected' : ''}${!rows[i].available ? ' is-unavailable' : ''}`);
    });
    const row = rows[index];
    selectedDate.textContent = row.date === today ? `${row.date.slice(5)} 今天` : row.date.slice(5);
    selectedValues.replaceChildren(...[
      ['活跃', row.users, 'users'], ['登录', row.accounts, ''],
      ['匿名', row.users - row.accounts, ''], ['访问', row.pageViews, 'pageViews'],
    ].map(([label, value, key]) => h('span', { class: `analytics-inspector-value${key === field ? ' is-emphasis' : ''}` },
      h('small', null, label), h('strong', null, number(value)))));
  }
  function draw() {
    if (!active()) return;
    const values = rows.filter((row) => row.available).map((row) => row[field]);
    const peak = Math.max(0, ...values);
    const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    const scale = analyticsChartScale(peak);
    const label = field === 'users' ? '活跃用户' : '页面访问';
    switchers.forEach((button, index) => button.setAttribute('aria-pressed', modes[index][0] === field ? 'true' : 'false'));
    summary.replaceChildren(
      h('span', null, '日均', h('strong', null, values.length ? average.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) : '—')),
      h('span', null, '峰值', h('strong', null, values.length ? number(peak) : '—')));
    legend.replaceChildren(...(field === 'users' ? [['account', '登录'], ['anonymous', '匿名']] : [['visits', '访问']])
      .map(([name, text]) => h('span', null, h('i', { class: `analytics-key ${name}`, 'aria-hidden': 'true' }), text)),
      h('span', null, h('i', { class: 'analytics-key average', 'aria-hidden': 'true' }), '日均'));
    const grid = h('div', { class: 'analytics-chart-grid', 'aria-hidden': 'true' },
      scale.ticks.map((tick) => h('i', { style: { bottom: `${tick / scale.max * 100}%` } })));
    const axis = h('div', { class: 'analytics-y-axis', 'aria-hidden': 'true' },
      scale.ticks.map((tick) => h('span', { style: { bottom: `${tick / scale.max * 100}%` } }, shortNumber(tick))));
    columns = rows.map((row, index) => {
      const height = row.available ? row[field] / scale.max * 100 : 0;
      const details = row.available ? `${row.date}：活跃用户 ${number(row.users)}，登录用户 ${number(row.accounts)}，匿名访客 ${number(row.users - row.accounts)}，页面访问 ${number(row.pageViews)}` : `${row.date}：未统计`;
      return h('button', { type: 'button', class: 'analytics-column', disabled: !row.available,
        'aria-label': details, onclick: () => select(index), onfocus: () => select(index),
        onpointerenter: (event) => { if (event.pointerType === 'mouse') preview(index); },
        onpointerleave: (event) => { if (event.pointerType === 'mouse') preview(selected); },
        onkeydown: (event) => {
          const direction = ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key);
          if (!direction || !active()) return;
          event.preventDefault();
          const position = available.indexOf(index);
          const target = event.key === 'Home' ? available[0] : event.key === 'End' ? available.at(-1)
            : available[Math.max(0, Math.min(available.length - 1, position + (event.key === 'ArrowLeft' ? -1 : 1)))];
          select(target, true);
        } },
        row.available ? h('span', { class: 'analytics-column-value', style: { bottom: `${height}%` }, 'aria-hidden': 'true' }, shortNumber(row[field])) : null,
        h('span', { class: `analytics-column-stack${field === 'pageViews' ? ' visits' : ''}`, style: { height: `${height}%` }, 'aria-hidden': 'true' },
          field === 'users' ? [h('i', { class: 'account', style: { height: `${row.users ? row.accounts / row.users * 100 : 0}%` } }),
            h('i', { class: 'anonymous', style: { height: `${row.users ? (row.users - row.accounts) / row.users * 100 : 0}%` } })] : h('i', { class: 'visits', style: { height: '100%' } })),
        row.available && !row[field] ? h('span', { class: 'analytics-zero', 'aria-hidden': 'true' }) : null);
    });
    const bars = h('div', { class: `analytics-chart-columns${rows.length > 7 ? ' is-dense' : ''}`, role: 'group', 'aria-label': `每日${label}，左右方向键切换日期` }, columns);
    const canvas = h('div', { class: 'analytics-chart-canvas' }, grid,
      values.length && peak ? h('div', { class: 'analytics-average-line', style: { bottom: `${average / scale.max * 100}%` }, 'aria-hidden': 'true' }) : null, bars,
      !peak ? h('div', { class: 'analytics-chart-no-data', role: 'status' }, values.length ? '暂无数据' : '尚未开始统计') : null);
    const labelStep = rows.length > 7 ? Math.ceil(rows.length / 6) : 1;
    const dates = h('div', { class: `analytics-chart-dates${rows.length > 7 ? ' is-dense' : ''}`, 'aria-hidden': 'true' }, rows.map((row, index) =>
      h('span', { class: row.date === today ? 'is-today' : '' }, index % labelStep === 0 || index === rows.length - 1 ? row.date.slice(5) : '')));
    plot.replaceChildren(axis, canvas, h('div'), dates);
    if (available.length) select(selected);
    else { selectedDate.textContent = '尚未开始统计'; selectedValues.replaceChildren(); previous.disabled = true; next.disabled = true; }
  }
  const chart = h('section', { class: 'analytics-trend' },
    h('div', { class: 'analytics-chart-heading' },
      h('h2', null, '每日趋势'),
      h('div', { class: 'analytics-chart-switches', role: 'group', 'aria-label': '趋势指标' }, switchers)),
    h('div', { class: 'analytics-chart-meta' }, summary, legend),
    plot,
    h('div', { class: 'analytics-inspector', 'aria-live': 'polite', 'aria-atomic': 'true' },
      h('div', { class: 'analytics-day-controls' }, previous, selectedDate, next), selectedValues),
    h('details', { class: 'analytics-daily' }, h('summary', null, '每日明细'),
      h('div', { class: 'analytics-table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['日期', '活跃用户', '登录用户', '匿名访客', '页面访问'].map((value) => h('th', { scope: 'col' }, value)))),
        h('tbody', null, rows.slice().reverse().map((row) => h('tr', null, h('th', { scope: 'row' }, row.date),
          ...(row.available ? [row.users, row.accounts, row.users - row.accounts, row.pageViews].map(number) : ['—', '—', '—', '—'])
            .map((value) => h('td', null, value)))))))));
  draw();
  return chart;
}
