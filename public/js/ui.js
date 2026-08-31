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
  const category = String(
    item.category_sub?.title || item.category?.title || item.category || '',
  ).trim();
  const image = h('img', {
    loading: 'lazy', decoding: 'async', src: imgSrcOf(item), alt: item.name || '封面',
    onerror: (e) => {
      e.currentTarget.classList.add('is-broken');
      e.currentTarget.parentElement?.classList.add('is-broken');
      e.currentTarget.removeAttribute('src');
    },
  });
  const cover = h('div', { class: 'cover' }, image);
  if (category) cover.append(h('span', { class: 'card-badge' }, category));
  if (canOpen) cover.append(h('span', { class: 'cover-action', 'aria-hidden': 'true' }, icon('arrow-up-right', 15)));
  const card = h('div', {
    class: 'comic-card',
    ...(category ? { 'data-kind': category } : {}),
    ...(canOpen ? { onclick: open, 'aria-label': `查看${item.name || '漫画'}详情` } : { 'aria-disabled': 'true' }),
  });
  if (canOpen) asActivatable(card, open);
  card.append(
    cover,
    h('div', { class: 'card-copy' },
      h('div', { class: 'name' }, item.name || '未知'),
      h('div', { class: 'card-meta' },
        item.author ? String(item.author).split(/[、,，\/]/)[0] || '' : (category || 'JM Web'),
      ),
    ),
  );
  return card;
}

/** 与漫画网格同尺寸的轻量骨架，避免首屏列表从空白突然跳变。 */
export function comicSkeletons(count = 12) {
  const total = Math.max(1, Math.min(30, Number(count) || 12));
  return Array.from({ length: total }, () => h('div', {
    class: 'comic-card skeleton-card', 'aria-hidden': 'true',
  },
  h('div', { class: 'cover skeleton-block' }),
  h('div', { class: 'skeleton-line wide' }),
  h('div', { class: 'skeleton-line short' })));
}

/**
 * 移动端下拉刷新。只在页面已经位于顶部、纵向手势明确后接管触摸，
 * 横向内容条、表单控件和阅读器不会被拦截。
 */
export function installPullToRefresh(container, refresh, options = {}) {
  if (!container || typeof refresh !== 'function' || typeof window === 'undefined') return () => {};
  const threshold = Math.max(48, Math.min(100, Number(options.threshold) || 68));
  const indicator = h('div', {
    class: 'pull-refresh-indicator', role: 'status', 'aria-live': 'polite',
  }, h('span', { class: 'pull-refresh-spinner', 'aria-hidden': 'true' }), h('span', null, '下拉刷新'));
  container.classList.add('pull-refresh-host');
  container.prepend(indicator);
  let startX = 0; let startY = 0; let distance = 0;
  let tracking = false; let pulling = false; let refreshing = false;

  const atTop = () => Math.max(0, Number(window.scrollY)
    || Number(document.scrollingElement?.scrollTop) || 0) <= 1;
  const blockedTarget = (target) => target instanceof Element
    && !!target.closest('input,textarea,select,[contenteditable="true"],.hscroll,.chips,dialog');
  const setDistance = (value) => {
    distance = Math.max(0, Math.min(104, value));
    container.style.setProperty('--pull-distance', `${distance}px`);
    container.classList.toggle('is-pulling', distance > 0);
    container.classList.toggle('is-ready', distance >= threshold);
    indicator.lastElementChild.textContent = distance >= threshold ? '松开刷新' : '下拉刷新';
  };
  const reset = () => {
    tracking = false; pulling = false; setDistance(0);
  };
  const onStart = (event) => {
    if (refreshing || event.touches.length !== 1 || !atTop() || blockedTarget(event.target)
        || document.body.classList.contains('reading') || document.body.classList.contains('offline-reading')) return;
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
    tracking = true;
  };
  const onMove = (event) => {
    if (!tracking || event.touches.length !== 1) return;
    const dx = event.touches[0].clientX - startX;
    const dy = event.touches[0].clientY - startY;
    if (!pulling && (dy <= 7 || Math.abs(dx) > Math.abs(dy))) {
      if (dy < -4 || Math.abs(dx) > 12) reset();
      return;
    }
    if (!atTop() || dy <= 0) return reset();
    pulling = true;
    event.preventDefault();
    setDistance(Math.pow(Math.max(0, dy - 6), 0.82) * 1.35);
  };
  const onEnd = async () => {
    if (!tracking) return;
    const shouldRefresh = pulling && distance >= threshold;
    reset();
    if (!shouldRefresh || refreshing) return;
    refreshing = true;
    container.classList.add('is-refreshing');
    indicator.lastElementChild.textContent = '正在刷新…';
    try { await refresh(); }
    catch (error) { toast(error?.message || '刷新失败'); }
    finally {
      refreshing = false;
      container.classList.remove('is-refreshing');
      indicator.lastElementChild.textContent = '下拉刷新';
    }
  };
  container.addEventListener('touchstart', onStart, { passive: true });
  container.addEventListener('touchmove', onMove, { passive: false });
  container.addEventListener('touchend', onEnd, { passive: true });
  container.addEventListener('touchcancel', reset, { passive: true });
  return () => {
    container.removeEventListener('touchstart', onStart);
    container.removeEventListener('touchmove', onMove);
    container.removeEventListener('touchend', onEnd);
    container.removeEventListener('touchcancel', reset);
    container.classList.remove('pull-refresh-host', 'is-pulling', 'is-ready', 'is-refreshing');
    container.style.removeProperty('--pull-distance');
    indicator.remove();
  };
}

import { imgSrc } from './api.js';
function imgSrcOf(item) { return imgSrc(item); }

/** 无限滚动列表容器：返回 { root, destroy }；路由离开时必须调用 destroy */
export function infiniteList(loader) {
  const grid = h('div', { class: 'grid' }, comicSkeletons());
  const sentinel = h('div');
  const root = h('div', null, grid, sentinel);
  let page = 0;
  let loading = false;
  let finished = false;
  let failed = false;
  let obs = null;
  let controller = null;
  let destroyed = false;
  let refreshPromise = null;
  let removePullRefresh = null;

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
      grid.querySelectorAll(':scope > .skeleton-card').forEach((node) => node.remove());
      if (!items.length && page === 1) {
        grid.replaceChildren(h('div', { class: 'empty', style: { gridColumn: '1/-1' } },
          h('div', { class: 'big' }, icon('inbox', 40)), '这里什么都没有'));
      }
      if (items.length) grid.querySelector(':scope > .empty')?.remove();
      grid.append(...items);
      if (!hasMore) {
        finished = true;
        if (page > 1) sentinel.replaceChildren(h('div', { style: 'text-align:center;color:var(--text-2);font-size:12px;padding:14px' }, '· 已经到底了 ·'));
        else sentinel.replaceChildren();
      }
    } catch (e) {
      if (destroyed || requestController.signal.aborted || (e && e.name === 'AbortError')) return;
      failed = true;
      grid.querySelectorAll(':scope > .skeleton-card').forEach((node) => node.remove());
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
    removePullRefresh?.();
    removePullRefresh = null;
  }

  function refresh() {
    if (destroyed) return Promise.resolve();
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      controller?.abort();
      while (loading && !destroyed) await new Promise((resolve) => setTimeout(resolve, 0));
      if (destroyed) return;
      page = 0;
      failed = false;
      finished = false;
      sentinel.replaceChildren();
      grid.replaceChildren(...comicSkeletons());
      await loadMore();
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  async function loadAll(maxPages = 200) {
    let attempts = 0;
    while (!destroyed && !finished && !failed && attempts < maxPages) {
      if (loading) await new Promise((resolve) => setTimeout(resolve, 40));
      else { attempts++; await loadMore(); }
    }
    return { page, finished, failed };
  }

  removePullRefresh = installPullToRefresh(root, refresh);
  retryObserve();
  queueMicrotask(loadMore);
  return { root, destroy, loadAll, refresh };
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
