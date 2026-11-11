import { apiRequest } from './api.js';
import { h, loadingBox, errorBox } from './ui.js';
import { icon } from './icons.js';

const number = (n) => Number(n || 0).toLocaleString('zh-CN');
const note = '账号跨设备去重，匿名访客按浏览器去重；匿名记录在该浏览器登录时归并。不等同于真实人数。';
const stamp = (value) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

export async function analyticsView(root, query, ctx, rankingOnly = false) {
  const days = [1, 7, 30].includes(Number(query.get('days'))) ? Number(query.get('days')) : 7;
  const requestedPage = Number(query.get('page'));
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(100000, requestedPage) : 1;
  const path = rankingOnly ? '/popular' : '/analytics';
  const title = rankingOnly ? '近期人气漫画' : '最近用户数据';
  const content = h('div', { class: 'analytics-content', 'aria-live': 'polite', 'aria-busy': 'true' }, loadingBox());
  const refresh = h('button', { class: 'btn', type: 'button', onclick: () => ctx.refresh() }, icon('history', 16), ' 刷新');
  const view = h('section', { class: 'page analytics-page' },
    h('header', { class: 'analytics-heading' }, h('div', null,
      h('div', { class: 'analytics-eyebrow' }, 'JM WEB · 近期概览'), h('h1', null, title),
      h('p', { class: 'analytics-muted' }, rankingOnly ? '看大家最近在读什么，按访问用户数排序。' : '只看汇总趋势，不公开个人阅读记录。')), refresh),
    h('nav', { class: 'analytics-tabs', 'aria-label': '统计页面' },
      h('a', { href: `#/analytics?days=${days}`, class: rankingOnly ? '' : 'active', 'aria-current': rankingOnly ? null : 'page' }, '用户仪表盘'),
      h('a', { href: `#/popular?days=${days}`, class: rankingOnly ? 'active' : '', 'aria-current': rankingOnly ? 'page' : null }, '漫画人气榜')),
    h('nav', { class: 'analytics-periods', 'aria-label': '统计时间范围' }, [1, 7, 30].map((d) =>
      h('a', { class: `chip${d === days ? ' active' : ''}`, href: `#${path}?days=${d}`, 'aria-current': d === days ? 'true' : null }, d === 1 ? '今天' : `近 ${d} 天`))),
    content,
    h('details', { class: 'analytics-definition' }, h('summary', null, '统计口径与隐私'),
      h('p', null, note),
      h('p', null, '自然日按北京时间计算，近 7 / 30 天包含今天，不是滚动小时。范围用户数跨日去重，不能把每日用户数相加。'),
      h('p', null, '访问次数为前台应用页面打开次数；漫画访问仅在详情或在线章节成功展示后计入，同一用户重复访问不增加榜单用户数。30 秒内重复漫画埋点合并。后台下载、预取、图片请求、离线阅读不计入。'),
      h('p', null, '仅统计本功能启用后的活动，最近 30 个自然日自动过期。不记录原始账号 ID、用户名、IP 或设备指纹；不返回个人列表。禁用 Cookie、清理浏览器、退出账号及脚本访问仍可能影响口径。')),
  );
  root.append(view);
  try {
    const data = await apiRequest(`/analytics?days=${days}&page=${rankingOnly ? page : 1}`, { signal: ctx.signal });
    if (!ctx.isActive()) return;
    content.replaceChildren();
    content.setAttribute('aria-busy', 'false');
    if (!data.available) {
      content.append(errorBox('统计状态暂不可用，原始状态文件已保留，请联系维护者检查。'));
      return;
    }
    if (data.limited || !data.persistenceOk) content.append(h('p', { class: 'analytics-warning', role: 'status' },
      data.limited ? '所选期间曾达到采集容量，数据不完整，不能视为全量人数。' : '统计暂未成功保存，重启可能丢失最近数据。'));
    content.append(h('p', { class: 'analytics-muted analytics-range' }, `${data.from} 至 ${data.to} · 北京时间 · 更新于 ${stamp(data.generatedAt)}`));
    if (!rankingOnly) {
      const t = data.totals;
      content.append(h('div', { class: 'analytics-metrics' },
        metric('活跃用户', t.users, '范围内去重账号 + 匿名浏览器', 'users'),
        metric('账号用户', t.accounts, '按 JM 账号去重', 'user'),
        metric('匿名访客', t.anonymous, '按浏览器标识去重', 'eye'),
        metric('应用访问次数', t.pageViews, '前台页面打开，非 API 请求', 'layout-grid'),
        metric('漫画访问用户', t.comicUsers, '打开详情或在线阅读的用户', 'book-open'),
        metric('访问漫画数', t.comics, '范围内被访问过的作品', 'book')));
      content.append(trendChart(data.trend, ctx, data.startedAt, data.generatedAt));
      content.append(h('div', { class: 'analytics-subheading' }, h('h2', null, '人气漫画 · TOP 5'),
        h('a', { href: `#/popular?days=${days}` }, '查看完整排行 →')));
    }
    if (!data.totals.users) content.append(h('div', { class: 'analytics-empty' }, icon('users', 32),
      h('h2', null, '开始积累新的访问数据'), h('p', null, '此范围暂无采集记录，不使用旧日志或 AI 热度回填。')));
    const rows = rankingOnly ? data.ranking : data.ranking.slice(0, 5);
    if (rows.length) content.append(rankList(rows, rankingOnly ? (data.page - 1) * data.pageSize : 0));
    else if (data.totals.users) content.append(h('div', { class: 'analytics-empty' }, '还没有漫画访问记录，成功打开详情或在线阅读后会出现在这里。'));
    if (rankingOnly && data.total > data.pageSize) content.append(h('nav', { class: 'analytics-pagination', 'aria-label': '排行榜分页' },
      data.page > 1 ? h('a', { class: 'btn', href: `#/popular?days=${days}&page=${data.page - 1}` }, '上一页') : null,
      h('span', null, `第 ${data.page} / ${Math.ceil(data.total / data.pageSize)} 页`),
      data.page * data.pageSize < data.total ? h('a', { class: 'btn', href: `#/popular?days=${days}&page=${data.page + 1}` }, '下一页') : null));
    content.append(h('p', { class: 'analytics-muted analytics-since' }, `开始统计：${stamp(data.startedAt)} · 每次刷新获取最新汇总`));
  } catch (e) {
    if (!ctx.isActive() || e?.name === 'AbortError') return;
    content.setAttribute('aria-busy', 'false');
    content.replaceChildren(errorBox('统计加载失败，请稍后刷新。正常阅读不受影响。'));
  }
}
function metric(label, value, description, name) {
  return h('article', { class: 'analytics-metric' }, h('div', { class: 'analytics-metric-label' }, label, icon(name, 18)),
    h('strong', null, number(value)), h('span', { class: 'analytics-muted' }, description));
}
function rankList(rows, offset) {
  const max = Math.max(1, ...rows.map((row) => count(row.users)));
  return h('ol', { class: 'analytics-ranking', start: offset + 1 }, rows.map((item, i) =>
    h('li', null, h('a', { href: `#/album/${item.aid}`, class: 'analytics-rank-link' },
      h('span', { class: `analytics-rank-number${offset + i < 3 ? ' podium' : ''}` }, String(offset + i + 1).padStart(2, '0')),
      h('div', { class: 'analytics-rank-title' }, h('strong', null, item.title),
        h('span', null, `JM${item.aid} · ${number(item.views)} 次漫画访问`),
        h('div', { class: 'analytics-rank-track', 'aria-hidden': 'true', title: '条形长度相对本页最高用户数，非用户占比' },
          h('i', { style: { width: `${count(item.users) / max * 100}%` } }))),
      h('div', { class: 'analytics-rank-count' }, h('strong', null, number(item.users)), h('span', null, '访问用户')), icon('arrow-up-right', 18)))));
}

const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const shortNumber = (value) => value >= 10000 ? `${Number((value / 10000).toFixed(1))}万`
  : value >= 1000 ? `${Number((value / 1000).toFixed(1))}千` : number(value);
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
  const modes = [['users', '活跃用户'], ['pageViews', '页面访问']];
  const switchers = modes.map(([key, label]) => h('button', { type: 'button', class: 'analytics-chart-switch',
    'aria-pressed': key === field ? 'true' : 'false', onclick: () => {
      if (!active() || key === field) return;
      field = key;
      draw();
    } }, label));
  const caption = h('p', { class: 'analytics-muted analytics-chart-caption' });
  const summary = h('div', { class: 'analytics-chart-summary' });
  const legend = h('div', { class: 'analytics-chart-legend', 'aria-label': '图例' });
  const plot = h('div', { class: 'analytics-chart-plot' });
  const selectedDate = h('strong');
  const selectedHint = h('span', { class: 'analytics-muted' });
  const selectedValues = h('div', { class: 'analytics-inspector-values' });
  const step = (direction) => {
    const position = available.indexOf(selected);
    select(available[Math.max(0, Math.min(available.length - 1, position + direction))]);
  };
  const previous = h('button', { type: 'button', class: 'analytics-day-step', 'aria-label': '查看前一天', onclick: () => step(-1) }, icon('arrow-left', 16));
  const next = h('button', { type: 'button', class: 'analytics-day-step', 'aria-label': '查看后一天', onclick: () => step(1) }, icon('arrow-right', 16));
  function select(index, focus = false) {
    if (!active() || !rows[index]?.available) return;
    selected = index;
    columns.forEach((column, i) => {
      column.setAttribute('class', `analytics-column${i === index ? ' is-selected' : ''}${!rows[i].available ? ' is-unavailable' : ''}`);
      column.setAttribute('aria-pressed', i === index ? 'true' : 'false');
      column.setAttribute('tabindex', i === index ? '0' : '-1');
    });
    const row = rows[index];
    selectedDate.textContent = row.date;
    selectedHint.textContent = row.date === today ? '今日 · 数据仍在更新' : row.date === localDay(startedAt) ? '启用当日 · 非完整自然日' : '北京时间 · 当日汇总';
    selectedValues.replaceChildren(...[
      ['活跃用户', row.users, '人'], ['账号用户', row.accounts, '人'],
      ['匿名访客', row.users - row.accounts, '位'], ['页面访问', row.pageViews, '次'],
    ].map(([label, value, unit]) => h('div', { class: `analytics-inspector-value${(field === 'users' ? label === '活跃用户' : label === '页面访问') ? ' is-emphasis' : ''}` },
      h('span', null, label), h('strong', null, number(value), h('small', null, unit)))));
    previous.disabled = index === available[0];
    next.disabled = index === available.at(-1);
    if (focus) columns[index]?.focus?.({ preventScroll: true });
  }
  function draw() {
    if (!active()) return;
    const values = rows.filter((row) => row.available).map((row) => row[field]);
    const peak = Math.max(0, ...values);
    const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    const scale = analyticsChartScale(peak);
    const unit = field === 'users' ? '人' : '次';
    const label = field === 'users' ? '活跃用户' : '页面访问';
    switchers.forEach((button, index) => button.setAttribute('aria-pressed', modes[index][0] === field ? 'true' : 'false'));
    summary.replaceChildren(h('div', null, h('span', null, '日均' + label), h('strong', null,
      values.length ? average.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) : '—', h('small', null, unit))),
      h('div', null, h('span', null, '单日峰值'), h('strong', null, values.length ? number(peak) : '—', h('small', null, unit))));
    legend.replaceChildren(...(field === 'users' ? [['account', '账号用户'], ['anonymous', '匿名访客']] : [['visits', '页面访问']])
      .map(([name, text]) => h('span', null, h('i', { class: `analytics-key ${name}`, 'aria-hidden': 'true' }), text)),
      h('span', null, h('i', { class: 'analytics-key average', 'aria-hidden': 'true' }), '日均参考线'));
    caption.textContent = `日均仅计算已启用日期（含今日及启用当日）。${rows.some((row) => !row.available) ? '未启用日期留空，不当作 0。' : ''}点击柱形或用左右键查看当天数据。`;
    const grid = h('div', { class: 'analytics-chart-grid', 'aria-hidden': 'true' },
      scale.ticks.map((tick) => h('i', { style: { bottom: `${tick / scale.max * 100}%` } })));
    const axis = h('div', { class: 'analytics-y-axis', 'aria-hidden': 'true' },
      h('span', { class: 'analytics-axis-unit' }, unit),
      scale.ticks.map((tick) => h('span', { style: { bottom: `${tick / scale.max * 100}%` } }, shortNumber(tick))));
    columns = rows.map((row, index) => {
      const height = row.available ? row[field] / scale.max * 100 : 0;
      const details = row.available ? `${row.date}：活跃用户 ${number(row.users)} 人，账号用户 ${number(row.accounts)} 人，匿名访客 ${number(row.users - row.accounts)} 位，页面访问 ${number(row.pageViews)} 次` : `${row.date}：统计尚未启用`;
      return h('button', { type: 'button', class: 'analytics-column', disabled: !row.available,
        'aria-label': details, title: details, onclick: () => select(index), onfocus: () => select(index),
        onpointerenter: (event) => { if (event.pointerType === 'mouse') select(index); },
        onkeydown: (event) => {
          const direction = ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key);
          if (!direction || !active()) return;
          event.preventDefault();
          const position = available.indexOf(selected);
          const target = event.key === 'Home' ? available[0] : event.key === 'End' ? available.at(-1)
            : available[Math.max(0, Math.min(available.length - 1, position + (event.key === 'ArrowLeft' ? -1 : 1)))];
          select(target, true);
        } },
        row.available ? h('span', { class: 'analytics-column-value', style: { bottom: `${height}%` }, 'aria-hidden': 'true' }, shortNumber(row[field])) : null,
        h('span', { class: `analytics-column-stack${field === 'pageViews' ? ' visits' : ''}`, style: { height: `${height}%` }, 'aria-hidden': 'true' },
          field === 'users' ? [h('i', { class: 'account', style: { height: `${row.users ? row.accounts / row.users * 100 : 0}%` } }),
            h('i', { class: 'anonymous', style: { height: `${row.users ? (row.users - row.accounts) / row.users * 100 : 0}%` } })] : h('i', { class: 'visits', style: { height: '100%' } })),
        row.available && !row[field] ? h('span', { class: 'analytics-zero', 'aria-hidden': 'true' }) : null,
        !row.available ? h('span', { class: 'analytics-missing', 'aria-hidden': 'true' }, '—') : null);
    });
    const bars = h('div', { class: `analytics-chart-columns${rows.length > 7 ? ' is-dense' : ''}`, role: 'group', 'aria-label': `每日${label}，单位：${unit}，左右方向键切换日期` }, columns);
    const canvas = h('div', { class: 'analytics-chart-canvas' }, grid,
      values.length ? h('div', { class: 'analytics-average-line', style: { bottom: `${average / scale.max * 100}%` }, 'aria-hidden': 'true' }) : null, bars,
      !peak ? h('div', { class: 'analytics-chart-no-data', role: 'status' }, values.length ? `已启用日期暂无${label}` : '所选范围尚未启用统计') : null);
    const labelStep = rows.length > 7 ? Math.ceil(rows.length / 5) : 1;
    const dates = h('div', { class: `analytics-chart-dates${rows.length > 7 ? ' is-dense' : ''}`, 'aria-hidden': 'true' }, rows.map((row, index) =>
      h('span', { class: row.date === today ? 'is-today' : '' }, index % labelStep === 0 || index === rows.length - 1 ? row.date.slice(5) : '')));
    plot.replaceChildren(axis, canvas, h('div'), dates);
    if (available.length) select(selected);
    else { selectedDate.textContent = '此范围尚未启用统计'; selectedHint.textContent = '未启用日期不视为零访问'; selectedValues.replaceChildren(); previous.disabled = true; next.disabled = true; }
  }
  const chart = h('section', { class: 'analytics-trend' },
    h('div', { class: 'analytics-chart-heading' }, h('div', null, h('h2', null, '访问趋势'),
      h('p', { class: 'analytics-muted' }, '北京时间 · 活跃用户每天去重')), h('div', { class: 'analytics-chart-switches', role: 'group', 'aria-label': '趋势指标' }, switchers)),
    summary, legend, plot,
    h('div', { class: 'analytics-inspector', 'aria-live': 'polite', 'aria-atomic': 'true' },
      h('div', { class: 'analytics-inspector-heading' }, h('div', null, selectedDate, selectedHint), h('div', { class: 'analytics-day-controls' }, previous, next)), selectedValues),
    caption,
    h('details', { class: 'analytics-daily' }, h('summary', null, '查看每日数据明细'),
      h('div', { class: 'analytics-table-wrap' }, h('table', null,
        h('caption', null, '每日用户和访问次数（北京时间）'),
        h('thead', null, h('tr', null, ['日期', '活跃用户', '账号用户', '匿名访客', '页面访问'].map((value) => h('th', { scope: 'col' }, value)))),
        h('tbody', null, rows.map((row) => h('tr', null, h('th', { scope: 'row' }, row.date),
          ...(row.available ? [row.users, row.accounts, row.users - row.accounts, row.pageViews].map(number) : ['未启用', '—', '—', '—'])
            .map((value) => h('td', null, value)))))))));
  draw();
  return chart;
}
