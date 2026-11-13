// UI 工具：元素构建、Toast、通用组件（封面卡片、分页、错误态）
import { icon } from './icons.js';

/**
 * 路由层错误文案：只呈现稳定提示，不把内部堆栈、文件路径或第三方响应
 * 暴露到页面。401 必须区分“站点访问门禁失效”与“JM 登录失效”，前者由
 * 应用拉起 gate 重新验证，后者引导用户重新登录 JM 账号。
 */
export function routeErrorMessage(error) {
  const status = Number(error?.status);
  if (status === 401) {
    return error?.needAuth ? '需要访问口令，请先完成验证。' : 'JM 登录已失效，请重新登录。';
  }
  if (status === 403) return '当前操作需要站点管理员权限。';
  if (status === 404) return '请求的内容不存在或已下线。';
  if (status === 429) return '请求过于频繁，请稍后重试。';
  if (status >= 500 && status <= 599) return '服务暂时不可用，请稍后重试。';
  return '页面加载失败，请稍后重试。';
}

/**
 * 是否允许页面在没有直接用户手势时自动聚焦可编辑控件。
 *
 * iOS/WebKit（包括 iPhone 上的 Edge）会把脚本触发的输入框聚焦视为编辑
 * 会话，并可能持续展示系统“粘贴”菜单。触屏/无悬停设备因此只在用户主动
 * 点击输入框后进入编辑态；桌面端继续保留自动聚焦的键盘效率。
 */
export function shouldAutoFocusEditable(targetWindow) {
  const host = targetWindow || (typeof window !== 'undefined' ? window : null);
  if (!host || typeof host.matchMedia !== 'function') return true;
  try {
    return !host.matchMedia('(pointer: coarse)').matches
      && !host.matchMedia('(hover: none)').matches;
  } catch (_) {
    return true;
  }
}

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
  if (!root) return;
  const t = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' }, msg);
  root.replaceChildren(t);
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

function retryImageUrl(source, attempt) {
  const value = String(source || '');
  const hashIndex = value.indexOf('#');
  const head = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const hash = hashIndex >= 0 ? value.slice(hashIndex) : '';
  const separator = head.includes('?') ? '&' : '?';
  return `${head}${separator}_jmw_retry=${attempt}${hash}`;
}

let retryImageObserver = null;
const retryImageStarts = new WeakMap();
const imageRetryCleanups = new WeakMap();
const imageRetryRootObservers = new WeakMap();

function disposeImageRetryTree(root, keepRoot = null) {
  const dispose = (image) => {
    if (!keepRoot?.contains(image)) imageRetryCleanups.get(image)?.();
  };
  dispose(root); // removedNodes 及调用方的 root 都可能就是 img。
  for (const image of root?.querySelectorAll?.('img') || []) dispose(image);
}

/** 刷新/替换子树也要取消旧封面；仅观察当前路由 main，不持有全局图片列表。 */
export function observeImageRetries(root) {
  if (!root || typeof MutationObserver !== 'function' || imageRetryRootObservers.has(root)) return;
  const cleanupRemoved = (records) => {
    for (const record of records) {
      for (const node of record.removedNodes) {
        // 同一 root 内移动/同步重插仍有效，不能误取消；子树内也逐图检查。
        if (!root.contains(node)) disposeImageRetryTree(node, root);
      }
    }
  };
  const observer = new MutationObserver((records) => {
    // disconnect 后迟到的旧回调不能影响同一个 main 上的新路由。
    if (imageRetryRootObservers.get(root)?.observer === observer) cleanupRemoved(records);
  });
  imageRetryRootObservers.set(root, { observer, cleanupRemoved });
  observer.observe(root, { childList: true, subtree: true });
}

/** 路由销毁时撤销在途/待观察的封面，给阅读器释放图片通道。 */
export function disposeImageRetries(root) {
  const watcher = imageRetryRootObservers.get(root);
  if (watcher) {
    // 同一任务内先 replaceChildren 再退出时，移除记录尚未异步交付。
    watcher.cleanupRemoved(watcher.observer.takeRecords());
    watcher.observer.disconnect();
    imageRetryRootObservers.delete(root);
  }
  disposeImageRetryTree(root);
}


function getRetryImageObserver() {
  if (retryImageObserver || typeof IntersectionObserver !== 'function') return retryImageObserver;
  retryImageObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const target = entry.target;
      if (target.isConnected === false) {
        retryImageObserver.unobserve(target);
        retryImageStarts.delete(target);
        continue;
      }
      if (!entry.isIntersecting && Number(entry.intersectionRatio || 0) <= 0) continue;
      const start = retryImageStarts.get(target);
      if (!start) continue;
      retryImageStarts.delete(target);
      retryImageObserver.unobserve(target);
      start();
    }
  }, { rootMargin: '300px 200px' });
  return retryImageObserver;
}

/**
 * 封面等非关键图片的有限重试。图片代理可能因短暂 503/上游超时失败，
 * 原生 <img> 不会读取 Retry-After，因此这里用指数退避再尝试几次；
 * 只有耗尽次数后才显示“暂无封面”。返回清理函数供页面销毁时释放计时器。
 */
export function installImageRetry(image, source, options = {}) {
  if (!image || typeof image.addEventListener !== 'function') return () => {};
  imageRetryCleanups.get(image)?.();
  options = options && typeof options === 'object' ? options : {};
  const original = typeof source === 'string' ? source.trim() : '';
  const configuredRetries = Number(options.maxRetries);
  const maxRetries = Number.isFinite(configuredRetries)
    ? Math.max(0, Math.min(4, Math.floor(configuredRetries))) : 3;
  const delays = Array.isArray(options.delays) && options.delays.length
    ? options.delays.map((value) => Math.max(100, Number(value) || 0))
    : [450, 1000, 1800, 3000];
  let attempts = 0;
  let timer = null;
  let finished = false;
  let disposed = false;
  let started = false;
  let observer = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const markBroken = () => {
    if (finished) return;
    finished = true;
    imageRetryCleanups.delete(image);
    clearTimer();
    if (observer) observer.unobserve(image);
    retryImageStarts.delete(image);
    image.classList?.add('is-broken');
    image.parentElement?.classList?.add('is-broken');
    image.removeAttribute?.('src');
    if (typeof options.onBroken === 'function') options.onBroken(image);
  };
  const onLoad = () => {
    if (finished) return;
    finished = true;
    imageRetryCleanups.delete(image);
    clearTimer();
    if (observer) observer.unobserve(image);
    retryImageStarts.delete(image);
    image.classList?.remove('is-retrying');
    if (typeof options.onLoad === 'function') options.onLoad(image);
  };
  const onError = () => {
    if (finished) return;
    if (!original || attempts >= maxRetries) {
      markBroken();
      return;
    }
    const retry = ++attempts;
    image.classList?.add('is-retrying');
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      // 路由离开后节点可能已经脱离文档，不再制造新的网络请求。
      if (finished || image.isConnected === false) return;
      image.setAttribute('src', retryImageUrl(original, retry));
    }, delays[Math.min(retry - 1, delays.length - 1)] || 1000);
  };

  const start = () => {
    if (finished || started || !original) return;
    started = true;
    image.setAttribute('src', original);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    const ownsImage = imageRetryCleanups.get(image) === dispose;
    const cancelRequest = ownsImage && started && !finished;
    finished = true;
    clearTimer();
    if (ownsImage) {
      if (observer) observer.unobserve(image);
      retryImageStarts.delete(image);
      imageRetryCleanups.delete(image);
    }
    image.removeEventListener?.('load', onLoad);
    image.removeEventListener?.('error', onError);
    if (cancelRequest) image.removeAttribute?.('src');
  };
  imageRetryCleanups.set(image, dispose);
  image.addEventListener('load', onLoad);
  image.addEventListener('error', onError);
  if (original) {
    observer = options.lazy ? getRetryImageObserver() : null;
    if (observer) {
      retryImageStarts.set(image, start);
      observer.observe(image);
    } else start();
  } else markBroken();
  return dispose;
}

/** 封面卡片（3:4 封面 + 两行标题） */
export function comicCard(item) {
  item = item && typeof item === 'object' ? item : {};
  const text = (value) => (typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '');
  const name = text(item.name) || '未知';
  const rawId = item.id ?? item.aid ?? item.AID;
  const id = rawId == null ? '' : String(rawId);
  const canOpen = /^\d+$/.test(id);
  const href = `#/album/${id}`;
  const category = text(item.category_sub?.title || item.category?.title || item.category);
  const image = h('img', {
    loading: 'lazy', decoding: 'async', fetchpriority: 'low', alt: name,
  });
  const cover = h('div', { class: 'cover' }, image);
  installImageRetry(image, imgSrcOf(item), { lazy: true });
  if (category) cover.append(h('span', { class: 'card-badge' }, category));
  // 使用原生链接而不是仅绑定 click 的 div：这样浏览器的“在新标签页打开”、
  // Ctrl/⌘+Click、中键和长按菜单都能正常工作，同时单击仍由 hash 路由接管。
  const card = h('a', {
    class: 'comic-card',
    ...(canOpen ? { href } : {}),
    ...(category ? { 'data-kind': category } : {}),
    ...(canOpen ? { 'aria-label': `查看${name === '未知' ? '漫画' : name}详情` } : { 'aria-disabled': 'true', tabindex: '-1' }),
  });
  const authorText = text(item.author) ? text(item.author).split(/[、,，\/]/)[0] || '' : '';
  card.append(
    cover,
    h('div', { class: 'card-copy' },
      h('div', { class: 'name' }, name),
      h('div', { class: 'card-meta' }, authorText || category || '漫画'),
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
    && !!target.closest('input,textarea,select,[contenteditable="true"],.hscroll,.chips,dialog,.jmw-modal-backdrop');
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
export function infiniteList(loader, options = {}) {
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

  function appendPage({ items, hasMore }, next) {
    page = next;
    grid.querySelectorAll(':scope > .skeleton-card').forEach((node) => node.remove());
    if (!items.length && page === 1) {
      const customEmpty = typeof options.empty === 'function' ? options.empty() : null;
      const empty = customEmpty || h('div', { class: 'empty', style: { gridColumn: '1/-1' } },
        h('div', { class: 'big' }, icon('inbox', 40)), '这里什么都没有');
      empty.dataset.listEmpty = '1';
      grid.replaceChildren(empty);
    }
    if (items.length) grid.querySelector(':scope > [data-list-empty]')?.remove();
    grid.append(...items);
    if (!hasMore) {
      finished = true;
      if (page > 1) sentinel.replaceChildren(h('div', { style: 'text-align:center;color:var(--text-2);font-size:12px;padding:14px' }, '· 已经到底了 ·'));
      else sentinel.replaceChildren();
    }
  }

  async function loadMore() {
    if (destroyed || loading || finished || failed) return;
    if (options.canLoadMore && !options.canLoadMore()) return;
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
      appendPage({ items, hasMore }, next);
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
      await options.onRefresh?.();
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
    while (!destroyed && !finished && !failed && attempts < maxPages
        && (!options.canLoadMore || options.canLoadMore())) {
      if (loading) await new Promise((resolve) => setTimeout(resolve, 40));
      else { attempts++; await loadMore(); }
    }
    return { page, finished, failed };
  }

  removePullRefresh = installPullToRefresh(root, refresh);
  // 返回导航直接恢复连续的完整分页，不依赖 Observer 一页页“长回来”。
  const initialPages = typeof options.initialPages === 'function' ? options.initialPages() : (options.initialPages || []);
  for (const result of initialPages) {
    if (finished) break;
    appendPage(result, page + 1);
  }
  if (!finished) retryObserve();
  if (!page) queueMicrotask(loadMore);
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
  return h('div', { class: 'empty loading-state', role: 'status', 'aria-live': 'polite', 'aria-label': text },
    h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('div', null, text));
}

/** 二级/三级子页面统一返回导航条（适配 PWA 独立窗口与深层子页） */
export function subpageBackLink(href = '#/user', label = '返回上一级') {
  return h('a', { class: 'subpage-back', href },
    icon('chevron-left', 16),
    h('span', null, label),
  );
}

let modalSeq = 0;
const openModals = new Set();

/** 关闭当前全部模态框（如应用锁上锁前，避免锁屏下方旧弹窗浮在锁屏之上仍可操作） */
export function closeAllModals(reason = 'dismiss') {
  [...openModals].forEach((close) => close(reason));
}

/**
 * 轻量无障碍模态框（替代原生 alert / confirm / prompt）。
 * 触屏设备遵循 shouldAutoFocusEditable 策略，不被动抢占输入框焦点。
 */
export function openModal(options = {}) {
  const {
    title = '',
    description = '',
    body = null,
    actions = [],
    onClose = null,
    initialFocus = null,
    className = '',
  } = options;
  const titleId = `jmw-modal-title-${++modalSeq}`;
  const priorActive = typeof document !== 'undefined' ? document.activeElement : null;
  let closed = false;

  const closeBtn = h('button', {
    class: 'icon-btn jmw-modal-close',
    type: 'button',
    'aria-label': '关闭对话框',
    onclick: () => close(),
  }, icon('x', 18));

  const panel = h('div', {
    class: ['jmw-modal', className].filter(Boolean).join(' '),
    role: 'dialog',
    'aria-modal': 'true',
    ...(title ? { 'aria-labelledby': titleId } : { 'aria-label': '对话框' }),
    tabindex: '-1',
  },
  h('div', { class: 'jmw-modal-head' },
    title ? h('h3', { id: titleId, class: 'jmw-modal-title' }, title) : h('span'),
    closeBtn,
  ),
  description ? h('p', { class: 'jmw-modal-desc' }, description) : null,
  body ? h('div', { class: 'jmw-modal-body' }, body) : null,
  actions && actions.length ? h('div', { class: 'jmw-modal-actions' }, ...actions) : null);

  const backdrop = h('div', {
    class: 'jmw-modal-backdrop',
    onclick: (event) => {
      if (event.target === backdrop) close();
    },
  }, panel);

  function focusableItems() {
    if (typeof panel.querySelectorAll !== 'function') return [];
    return [...panel.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((node) => !node.hidden && node.getAttribute?.('aria-hidden') !== 'true');
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Tab') {
      const items = focusableItems();
      if (!items.length) {
        event.preventDefault();
        try { panel.focus({ preventScroll: true }); } catch (_) {}
        return;
      }
      const active = typeof document !== 'undefined' ? document.activeElement : null;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey) {
        if (active === first || active === panel || !panel.contains?.(active)) {
          event.preventDefault();
          try { last.focus({ preventScroll: true }); } catch (_) {}
        }
      } else if (active === last || !panel.contains?.(active)) {
        event.preventDefault();
        try { first.focus({ preventScroll: true }); } catch (_) {}
      }
    }
  }

  function onHashChange() {
    close();
  }

  function close(reason = 'dismiss') {
    if (closed) return;
    closed = true;
    openModals.delete(close);
    if (typeof document !== 'undefined') document.removeEventListener('keydown', onKeyDown, true);
    if (typeof window !== 'undefined') window.removeEventListener('hashchange', onHashChange);
    backdrop.remove();
    if (priorActive && typeof priorActive.focus === 'function' && priorActive.isConnected !== false) {
      const tag = String(priorActive.tagName || '').toUpperCase();
      const isEditable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || priorActive.isContentEditable;
      if (!isEditable || shouldAutoFocusEditable()) {
        try { priorActive.focus({ preventScroll: true }); } catch (_) {}
      }
    }
    if (typeof onClose === 'function') onClose(reason);
  }

  openModals.add(close);
  if (typeof document !== 'undefined') {
    document.addEventListener('keydown', onKeyDown, true);
    document.body.appendChild(backdrop);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('hashchange', onHashChange, { once: true });
  }

  const focusTarget = (() => {
    if (!initialFocus) return panel;
    const tag = String(initialFocus.tagName || '').toUpperCase();
    const isEditable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if (isEditable && !shouldAutoFocusEditable()) return panel;
    return initialFocus;
  })();
  queueMicrotask(() => {
    if (!closed && typeof focusTarget?.focus === 'function') {
      try { focusTarget.focus({ preventScroll: true }); } catch (_) {}
    }
  });

  return { close, backdrop, panel };
}

/** 确认弹窗：返回 Promise<boolean> */
export function confirmDialog({
  title = '确认操作',
  message = '',
  confirmText = '确认',
  cancelText = '取消',
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result, modal) => {
      if (settled) return;
      settled = true;
      modal?.close('action');
      resolve(result);
    };
    const cancelBtn = h('button', {
      class: 'btn',
      type: 'button',
      onclick: () => finish(false, modal),
    }, cancelText);
    const confirmBtn = h('button', {
      class: danger ? 'btn danger' : 'btn primary',
      type: 'button',
      onclick: () => finish(true, modal),
    }, confirmText);
    const modal = openModal({
      title,
      description: message,
      actions: [cancelBtn, confirmBtn],
      initialFocus: danger ? cancelBtn : confirmBtn,
      onClose: () => finish(false, null),
    });
  });
}

/** 输入弹窗：返回 Promise<string | null>（取消时返回 null） */
export function promptDialog({
  title = '输入内容',
  message = '',
  placeholder = '',
  initialValue = '',
  type = 'text',
  multiline = false,
  rows = 5,
  confirmText = '确定',
  cancelText = '取消',
  autocomplete = 'off',
  sensitive = false,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const isSecret = type === 'password' || sensitive;
    const field = multiline
      ? h('textarea', {
          class: 'input jmw-modal-textarea',
          rows: String(rows),
          placeholder,
          ...(isSecret ? { dataset: { clipboardPrivate: 'true' } } : {}),
        })
      : h('input', {
          class: 'input',
          type,
          placeholder,
          autocomplete,
          ...(isSecret ? { dataset: { clipboardPrivate: 'true' } } : {}),
        });
    field.value = String(initialValue ?? '');

    let modal = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      modal?.close('action');
      resolve(value);
    };

    const form = h('form', {
      class: 'jmw-modal-form',
      onsubmit: (event) => {
        event.preventDefault();
        finish(field.value);
      },
    }, field);

    if (multiline) {
      field.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault();
          finish(field.value);
        }
      });
    }

    const cancelBtn = h('button', {
      class: 'btn',
      type: 'button',
      onclick: () => finish(null),
    }, cancelText);
    const confirmBtn = h('button', {
      class: 'btn primary',
      type: 'button',
      onclick: () => finish(field.value),
    }, confirmText);

    modal = openModal({
      title,
      description: message,
      body: form,
      actions: [cancelBtn, confirmBtn],
      initialFocus: field,
      onClose: () => finish(null),
    });
  });
}
