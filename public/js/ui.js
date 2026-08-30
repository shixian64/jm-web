// UI 工具：元素构建、Toast、通用组件（封面卡片、分页、错误态）
import { icon } from './icons.js';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue; // false 不能 setAttribute（disabled/selected 等布尔属性只要存在即生效）
    if (v === true) { el.setAttribute(k, ''); continue; }
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v);
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

let toastTimer = null;
export function toast(msg, ms = 2200) {
  const root = document.getElementById('toast-root');
  root.innerHTML = '';
  const t = h('div', { class: 'toast' }, msg);
  root.appendChild(t);
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), ms);
}

/** 让 div 等非原生可点元素获得键盘可达性 */
function asActivatable(el, onclick) {
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onclick(e);
    }
  });
  return el;
}

/** 封面卡片（3:4 封面 + 两行标题） */
export function comicCard(item) {
  item = item || {};
  const rawId = item.id ?? item.aid ?? item.AID;
  const id = rawId == null ? '' : String(rawId);
  const canOpen = /^\d+$/.test(id);
  const open = () => { location.hash = `#/album/${id}`; };
  const card = h('div', {
    class: 'comic-card',
    ...(canOpen ? { onclick: open, 'aria-label': `查看${item.name || '漫画'}详情` } : { 'aria-disabled': 'true' }),
  });
  if (canOpen) asActivatable(card, open);
  card.append(
    h('div', { class: 'cover' },
      h('img', { loading: 'lazy', src: imgSrcOf(item), alt: item.name || '封面' }),
    ),
    h('div', { class: 'name' }, item.name || '未知'),
    item.author ? h('div', { class: 'author' }, String(item.author).split(/[、,，\/]/)[0] || '') : null,
  );
  return card;
}

import { imgSrc } from './api.js';
function imgSrcOf(item) { return imgSrc(item); }

/** 无限滚动列表容器：返回 { root, destroy }；路由离开时必须调用 destroy */
export function infiniteList(loader) {
  const grid = h('div', { class: 'grid' });
  const sentinel = h('div');
  const root = h('div', null, grid, sentinel);
  let page = 0;
  let loading = false;
  let finished = false;
  let failed = false;
  let obs = null;
  let controller = null;
  let destroyed = false;

  async function loadMore() {
    if (destroyed || loading || finished || failed) return;
    loading = true;
    failed = false;
    if (obs) obs.disconnect();
    const requestController = new AbortController();
    controller = requestController;
    const spinner = h('div', { class: 'loading-more' }, h('div', { class: 'spinner-sm' }));
    sentinel.replaceChildren(spinner);
    try {
      const next = page + 1;
      const { items, hasMore } = await loader(next, requestController.signal);
      if (destroyed || requestController.signal.aborted) return;
      page = next;
      if (!items.length && page === 1) {
        grid.replaceChildren(h('div', { class: 'empty', style: { gridColumn: '1/-1' } },
          h('div', { class: 'big' }, icon('inbox', 40)), '这里什么都没有'));
      }
      grid.append(...items);
      if (!hasMore) {
        finished = true;
        if (page > 1) sentinel.replaceChildren(h('div', { style: 'text-align:center;color:var(--text-2);font-size:12px;padding:14px' }, '· 已经到底了 ·'));
        else sentinel.replaceChildren();
      }
    } catch (e) {
      if (destroyed || requestController.signal.aborted || (e && e.name === 'AbortError')) return;
      failed = true;
      toast(e.message);
      sentinel.replaceChildren(h('div', { class: 'error-box' },
        h('div', null, e.message),
        h('button', { class: 'btn', onclick: retry }, '重试'),
      ));
    } finally {
      if (controller === requestController) controller = null;
      loading = false;
      // 仅成功时继续观察哨兵；失败后由用户手动重试。
      if (!destroyed && !failed && !finished) retryObserve();
    }
  }

  function retry() {
    if (destroyed) return;
    failed = false;
    sentinel.replaceChildren();
    loadMore();
  }

  function retryObserve() {
    if (destroyed || finished || failed) return;
    if (obs) obs.disconnect();
    obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore();
    }, { rootMargin: '600px 0px' });
    obs.observe(sentinel);
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (obs) obs.disconnect();
    obs = null;
    if (controller) controller.abort();
    controller = null;
  }

  retryObserve();
  return { root, destroy };
}

/** 简单分页（分类/每周必看） */
export function pager({ page, total, onChange }) {
  const cur = h('span', { class: 'cur' }, `${page} / ${total || '?'}`);
  return h('div', { class: 'pager' },
    h('button', { class: 'btn', disabled: page <= 1, onclick: () => onChange(page - 1) }, '上一页'),
    cur,
    h('button', { class: 'btn', disabled: total ? page >= total : false, onclick: () => onChange(page + 1) }, '下一页'),
  );
}

export function errorBox(message, retry) {
  return h('div', { class: 'error-box' },
    h('div', { class: 'big', style: 'margin-bottom:8px' }, icon('triangle-alert', 38)),
    h('div', null, message),
    retry ? h('button', { class: 'btn', onclick: retry }, '重试') : null,
  );
}

export function loadingBox(text = '加载中…') {
  return h('div', { class: 'empty' }, h('div', { class: 'spinner' }), text);
}
