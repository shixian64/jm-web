// 阅读器：滚动 / 左右翻页 / 纯点击，Canvas 解扰，预加载，章节抽屉与阅读中设置
// 协议与还原算法对齐 jm-mobile 的 ComicReadViewModel + ComicPicImageState
import { chapterImgSrc, imgSrc, selectedDataSource } from './api.js';
import { setting, updateSetting, recordAlbumHistory } from './store.js';
import { needsScramble, decodeFromBlob } from './descramble.js';
import { h } from './ui.js';
import { icon } from './icons.js';
import { createReaderSettings } from './reader-settings.js';
import {
  getOfflineAlbum, getOfflineChapter, getOfflineImage, deleteOfflineImage,
  listOfflineChapters, listOfflineImages,
} from './offline.js';

const MIB = 1024 * 1024;
const RAW_CACHE_DEFAULT_BYTES = 64 * MIB;
const RAW_CACHE_MEMORY_OPT_BYTES = 32 * MIB;
const READER_TUTORIAL_KEY = 'jmw_reader_tutorial_dismissed_v1';
const SAFE_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

/**
 * 计算原图 Blob 缓存预算。按设备内存自适应，且在“内存优化”开启时
 * 使用更保守的固定预算；未知 deviceMemory 的浏览器取 64 MiB。
 * 该预算只约束浏览器缓存，不会改变服务端的图片代理上限。
 */
export function readerRawCacheBytes({ deviceMemory, memoryOptimized = false } = {}) {
  if (memoryOptimized === true) return RAW_CACHE_MEMORY_OPT_BYTES;
  const dm = Number(deviceMemory);
  if (Number.isFinite(dm) && dm > 0) {
    if (dm <= 1) return 48 * MIB;
    if (dm <= 2) return 64 * MIB;
    if (dm >= 8) return 128 * MIB;
    return 96 * MIB;
  }
  return RAW_CACHE_DEFAULT_BYTES;
}

export function blobByteSize(value) {
  const size = Number(value?.size);
  return Number.isFinite(size) && size > 0 ? size : 0;
}

export function recommendedDecodeConcurrency({ deviceMemory, memoryOptimized = false, configured = 2 } = {}) {
  if (memoryOptimized === true) return Math.max(1, Math.min(4, Number(configured) || 2));
  const dm = Number(deviceMemory);
  if (Number.isFinite(dm) && dm > 0) {
    if (dm <= 1) return 1;
    if (dm <= 2) return 2;
  }
  return 3;
}

export function normalizeChapterImages(value) {
  if (!Array.isArray(value)) return [];
  const images = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    let parsed;
    try { parsed = new URL(String(item.url || '').trim()); } catch (_) { continue; }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) continue;
    parsed.hash = '';
    const fallbackName = parsed.pathname.split('/').pop() || `page-${images.length + 1}`;
    images.push({
      ...item,
      url: parsed.href,
      name: String(item.name || fallbackName),
      page: String(item.page || '').trim(),
    });
  }
  return images;
}

export function normalizeReaderSeries(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === 'object' && /^\d+$/.test(String(item.id || '')))
    .map((item, index) => ({
      id: String(item.id),
      name: String(item.name || '').trim(),
      sort: Number(item.sort) || index,
    }));
}

/**
 * 生成阅读器预取顺序。prefetchCount 表示当前页两侧各自的最大半径，
 * 不再额外扩大窗口；顺序对齐客户端：当前页、后续页、前序页。
 */
export function readerPrefetchOrder(current, total, prefetchCount) {
  const length = Math.max(0, Math.trunc(Number(total) || 0));
  const center = Math.trunc(Number(current));
  if (!Number.isInteger(center) || center < 0 || center >= length) return [];
  const radius = Math.max(1, Math.min(12, Math.trunc(Number(prefetchCount) || 3)));
  const order = [center];
  for (let distance = 1; distance <= radius; distance++) {
    if (center + distance < length) order.push(center + distance);
  }
  for (let distance = 1; distance <= radius; distance++) {
    if (center - distance >= 0) order.push(center - distance);
  }
  return order;
}

/** 仅保留严格预取窗口内的合法页码，同时维持调用方原有顺序。 */
export function filterReaderPrefetchWindow(indices, current, total, prefetchCount) {
  if (!Array.isArray(indices)) return [];
  const allowed = new Set(readerPrefetchOrder(current, total, prefetchCount));
  return indices.filter((index) => Number.isInteger(index) && allowed.has(index));
}

/**
 * 当前页完成前不启动任何邻页任务。返回的 Promise 在当前页完成且邻页任务均已
 * 按既定顺序启动后解决；邻页自身仍并行执行，不阻塞阅读器交互。
 */
export function scheduleReaderPrefetch(order, ensureDecoded, onDecoded, isActive = () => true, onDiscarded) {
  if (!Array.isArray(order) || !order.length || typeof ensureDecoded !== 'function' || !isActive()) {
    return Promise.resolve();
  }
  const start = (index) => {
    try {
      return Promise.resolve(ensureDecoded(index));
    } catch (_) {
      return Promise.resolve(null);
    }
  };
  const deliver = (index, rec) => {
    if (!rec) return;
    if (isActive()) {
      if (typeof onDecoded === 'function') onDecoded(index, rec);
    } else if (typeof onDiscarded === 'function') {
      onDiscarded(index, rec);
    }
  };
  const afterCurrent = (rec) => {
    if (!isActive()) {
      if (rec && typeof onDiscarded === 'function') onDiscarded(order[0], rec);
      return;
    }
    deliver(order[0], rec);
    if (!isActive()) return;
    for (const index of order.slice(1)) {
      if (!isActive()) break;
      start(index).then(
        (nextRec) => deliver(index, nextRec),
        () => {},
      );
    }
  };
  return start(order[0]).then(afterCurrent, () => afterCurrent(null));
}

/** 最终 <img> 已验证可解码后，才把天然尺寸写回缓存。 */
export function backfillReaderImageDimensions({ image, slot, index, record, state, generation, sourceVersion }) {
  if (!image || !slot || !record || !state || state.destroyed || !slot.isConnected
      || slot.dataset.idx !== String(index) || slot.dataset.objectUrl !== record.url
      || state.decoded?.get(index) !== record || record.generation !== generation
      || record.sourceVersion !== sourceVersion) return false;
  const width = Number(image.naturalWidth);
  const height = Number(image.naturalHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
  record.width = width;
  record.height = height;
  state.dims.set(index, { width, height });
  return true;
}

export function mountReader(root, photoId, query, options = {}) {
  const aid = query.get('aid') || '';
  const requestedPage = query.get('page');
  const offline = options.offline === true;
  const body = document.body;
  body.classList.add('reading', 'no-tab');
  const abortController = new AbortController();
  const { signal } = abortController;

  const savedMode = ['scroll', 'page', 'pageReverse', 'tap'].includes(setting.readMode)
    ? setting.readMode : 'scroll';
  const state = {
    photoId: String(photoId),
    aid,
    albumName: '',
    cover: null,
    chapters: [], // [{id, name}]
    curChapterIdx: -1,
    images: [],
    scrambleId: 0,
    speed: '',
    mode: savedMode,
    cur: 0,
    pageOffset: .5,
    zoom: 1,
    panX: 0,
    panY: 0,
    decoded: new Map(),  // idx -> { url, width, height }
    raws: new Map(),     // idx -> blob（原始图缓存，按字节预算的 LRU）
    rawBytes: 0,
    dims: new Map(),     // idx -> {width, height}
    destroyed: false,
  };

  const decodeQueue = new Map(); // idx -> 进行中的解码 Promise（并发去重 + 复用）
  const retiredObjectUrls = new Set();
  let imageController = new AbortController();
  let imageGeneration = 0;
  let imageSourceVersion = 0;
  let activeDecodes = 0;
  let prefetchSequence = 0;
  let sourceRefreshSeq = 0;
  let sourceRefreshPending = false;
  let activeImageShunt = ['1', '2', '3', '4'].includes(String(setting.shunt)) ? String(setting.shunt) : '1';
  let scrollObserver = null;
  let scrollRaf = 0;
  let historyTimer = null;
  let historyPending = false;
  let hintTimer = null;
  let restoreTimer = null;
  let toolbarTimer = null;
  let progressTimer = null;
  let tutorialTimer = null;
  let tutorialEl = null;
  let wakeLock = null;
  let explicitStartPending = requestedPage != null;
  const deviceMemory = typeof navigator !== 'undefined' ? navigator.deviceMemory : undefined;

  function rawCacheLimitBytes() {
    return readerRawCacheBytes({
      deviceMemory,
      memoryOptimized: setting.readMemoryOptEnabled === true,
    });
  }

  function dropRaw(index) {
    const old = state.raws.get(index);
    if (!old) return false;
    state.raws.delete(index);
    state.rawBytes = Math.max(0, state.rawBytes - blobByteSize(old));
    return true;
  }

  function clearRawCache() {
    state.raws.clear();
    state.rawBytes = 0;
  }

  function cacheRaw(index, blob) {
    const size = blobByteSize(blob);
    dropRaw(index);
    // 单张图超过预算时仍返回给当前页，但不留在 LRU，避免下一次请求
    // 又立刻触发一次大对象驻留/淘汰循环。
    if (!size || size > rawCacheLimitBytes()) return;
    state.raws.set(index, blob);
    state.rawBytes += size;
    trimRawCache();
  }

  function trimRawCache() {
    const budget = rawCacheLimitBytes();
    while (state.rawBytes > budget && state.raws.size) {
      const firstKey = state.raws.keys().next().value;
      dropRaw(firstKey);
    }
  }
  const colorSchemeMedia = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const onColorSchemeChange = () => {
    if (!state.destroyed && setting.theme === 'auto') applyReaderSettings();
  };

  function abortError() {
    try {
      return new DOMException('阅读器已关闭', 'AbortError');
    } catch (_) {
      const err = new Error('阅读器已关闭');
      err.name = 'AbortError';
      return err;
    }
  }

  function assertActive() {
    if (state.destroyed || signal.aborted) throw abortError();
  }

  function assertImageActive(generation, imageSignal) {
    assertActive();
    if (generation !== imageGeneration || imageSignal.aborted) throw abortError();
  }

  async function readerRequest(path) {
    let res;
    try {
      res = await fetch('/api' + path, {
        headers: { 'Content-Type': 'application/json', 'X-JMW-Data-Source': selectedDataSource() },
        signal,
      });
    } catch (e) {
      if (signal.aborted || e.name === 'AbortError') throw abortError();
      throw new Error('网络错误：' + e.message);
    }
    let json = null;
    try { json = await res.json(); } catch (_) {}
    if (!res.ok) {
      const err = new Error((json && json.error) || `请求失败（${res.status}）`);
      err.status = res.status;
      throw err;
    }
    if (json === null) throw new Error('服务器返回了无法识别的响应');
    return json;
  }

  /* ---------- DOM 骨架 ---------- */
  const pages = h('div', { class: 'pages' });
  const progress = h('div', {
    class: 'r-progress', role: 'progressbar', 'aria-label': '阅读进度',
    'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0',
  });
  const hint = h('div', { class: 'r-hint', role: 'status', 'aria-live': 'polite' });
  const indicator = h('span', null, '…');
  const drawerMask = h('div', { class: 'r-drawer-mask', onclick: () => toggleDrawer(false) });
  const drawerList = h('div', { class: 'list' });
  const idSuffix = String(photoId).replace(/\W/g, '') || 'current';
  const drawerTitleId = `reader-drawer-title-${idSuffix}`;
  const drawerId = `reader-drawer-${idSuffix}`;
  const toolbarId = `reader-toolbar-${idSuffix}`;
  const drawerCloseBtn = h('button', {
    class: 'icon-btn', type: 'button', title: '关闭章节目录', 'aria-label': '关闭章节目录',
    onclick: () => toggleDrawer(false),
  }, icon('arrow-left', 20));
  const drawer = h('aside', {
    id: drawerId, class: 'r-drawer', role: 'dialog', 'aria-modal': 'true',
    'aria-labelledby': drawerTitleId, 'aria-hidden': 'true',
  },
    h('div', { class: 'r-drawer-head' },
      h('h3', { id: drawerTitleId }, '章节目录'),
      drawerCloseBtn,
    ),
    drawerList,
  );
  drawer.inert = true;

  const modeBtn = h('button', {
    class: 'icon-btn', type: 'button', title: '切换阅读模式', 'aria-label': '切换阅读模式',
    onclick: switchMode,
  });
  const fitBtn = h('button', {
    class: 'icon-btn', type: 'button', title: '切换翻页适配', 'aria-label': '切换翻页适配',
    onclick: switchFit,
  });
  const settingsBtn = h('button', {
    class: 'icon-btn', type: 'button', title: '阅读设置', 'aria-label': '打开阅读设置',
    onclick: () => toggleSettings(true),
  }, icon('settings', 20));

  function refreshModeBtns() {
    modeBtn.replaceChildren(icon(state.mode === 'scroll' ? 'book-open' : 'book', 20));
    const labels = { scroll: '连续滚动', page: '向右翻页', pageReverse: '向左翻页', tap: '纯点击翻页' };
    modeBtn.title = `当前：${labels[state.mode] || labels.scroll}，点击切换模式`;
    modeBtn.setAttribute('aria-label', modeBtn.title);
    fitBtn.style.display = isPagedMode() ? '' : 'none';
    fitBtn.replaceChildren(icon(setting.pageFit === 'contain' ? 'scan' : 'move-horizontal', 20));
    fitBtn.title = setting.pageFit === 'contain' ? '切换到适应宽度' : '切换到完整显示';
    fitBtn.setAttribute('aria-label', fitBtn.title);
    container?.classList.toggle('rtl', isRtlMode());
    container?.classList.toggle('tap-only', state.mode === 'tap');
  }

  const backBtn = h('button', {
    class: 'icon-btn', type: 'button', title: '返回', 'aria-label': '退出阅读器', onclick: close,
  }, icon('arrow-left', 20));
  const titleEl = h('div', { class: 'title' }, '加载中…');
  const drawerBtn = h('button', {
    class: 'icon-btn', type: 'button', title: '章节目录', 'aria-label': '打开章节目录',
    'aria-controls': drawerId, 'aria-expanded': 'false', onclick: () => toggleDrawer(true),
  }, icon('list', 20));
  const readerTopbar = h('div', { id: toolbarId, class: 'r-topbar', 'aria-hidden': 'true' },
    backBtn, titleEl, drawerBtn, modeBtn, fitBtn, settingsBtn,
  );
  readerTopbar.inert = true;

  const centerBtn = h('button', {
    class: 'r-center', type: 'button', title: '隐藏工具栏', 'aria-label': '隐藏阅读工具栏',
    'aria-controls': toolbarId,
    onclick: () => setToolbar(false, true),
  }, indicator);
  const fabBtn = h('button', {
    class: 'r-fab', type: 'button', title: '显示工具栏', 'aria-label': '显示阅读工具栏',
    'aria-controls': toolbarId, 'aria-expanded': 'false',
    onclick: () => setToolbar(true, true),
  }, icon('menu', 22));
  const prevBtn = h('button', {
    class: 'r-page-nav r-page-prev', type: 'button', title: '左侧翻页', 'aria-label': '左侧翻页',
    onclick: () => goFromSide('left'),
  }, icon('arrow-left', 22));
  const nextBtn = h('button', {
    class: 'r-page-nav r-page-next', type: 'button', title: '右侧翻页', 'aria-label': '右侧翻页',
    onclick: () => goFromSide('right'),
  }, icon('arrow-left', 22));

  const settingsUI = createReaderSettings({
    idSuffix,
    getSnapshot: settingsSnapshot,
    onClose: () => toggleSettings(false),
    onMode: setMode,
    onSetting: changeReaderSetting,
    onZoom: (value) => setZoom(value),
    onPage: (idx) => jumpToPage(idx),
    onChapter: (delta) => navigateChapter(delta),
  });
  const brightnessLayer = h('div', { class: 'r-brightness-layer', 'aria-hidden': 'true' });

  const container = h('div', { id: 'reader' },
    progress,
    readerTopbar,
    pages,
    prevBtn, nextBtn,
    centerBtn,
    fabBtn,
    hint,
    h('div', { class: 'r-loading', role: 'status' }, h('div', { class: 'spinner-sm' }), h('p', null, '正在获取章节图片…')),
    drawerMask, drawer,
    settingsUI.mask, settingsUI.panel,
    brightnessLayer,
  );
  refreshModeBtns();
  applyReaderSettings();
  root.appendChild(container);
  if (typeof colorSchemeMedia?.addEventListener === 'function') {
    colorSchemeMedia.addEventListener('change', onColorSchemeChange);
  } else if (typeof colorSchemeMedia?.addListener === 'function') {
    colorSchemeMedia.addListener(onColorSchemeChange);
  }

  function dismissTutorial() {
    if (tutorialTimer) clearTimeout(tutorialTimer);
    tutorialTimer = null;
    if (!tutorialEl) return;
    const restoreFocus = tutorialEl.contains(document.activeElement);
    tutorialEl.remove();
    tutorialEl = null;
    if (restoreFocus && !state.destroyed) fabBtn.focus({ preventScroll: true });
  }

  function maybeShowReaderTutorial() {
    if (state.destroyed || tutorialEl || !state.images.length) return;
    try {
      if (localStorage.getItem(READER_TUTORIAL_KEY) === '1') return;
      // 记录“已经展示”而非等到完成，确保任何设备上都只自动出现一次。
      localStorage.setItem(READER_TUTORIAL_KEY, '1');
    } catch (_) {}

    const modeTip = state.mode === 'scroll'
      ? '上下滑动连续阅读；工具栏隐藏时，轻点上/下区域可快速滚动一屏。'
      : state.mode === 'pageReverse'
        ? '向左阅读：左右轻扫或轻点两侧翻页，桌面也可使用方向键。'
        : state.mode === 'tap'
          ? '轻点画面两侧翻页，中间区域用于显示或隐藏工具栏。'
          : '左右轻扫或轻点两侧翻页，桌面也可使用方向键。';
    const steps = [
      ['找到控制', '点右下角圆形按钮显示工具栏；再次点底部页码即可专注阅读。'],
      ['阅读与翻页', modeTip],
      ['缩放与设置', setting.supportZoom === false
        ? '点工具栏齿轮可切换模式、主题、线路与预加载，也能重新开启图片缩放。'
        : '翻页模式支持双指缩放、双击放大；点工具栏齿轮可随时调整主题、线路与预加载。'],
    ];
    let step = 0;
    const title = h('strong', { class: 'r-tutorial-title' });
    const copy = h('p', { class: 'r-tutorial-copy' });
    const next = h('button', { class: 'r-tutorial-next', type: 'button' });
    const skip = h('button', {
      class: 'r-tutorial-skip', type: 'button', onclick: dismissTutorial,
    }, '跳过');
    const paint = () => {
      title.textContent = `${steps[step][0]} · ${step + 1}/${steps.length}`;
      copy.textContent = steps[step][1];
      next.textContent = step === steps.length - 1 ? '知道了' : '下一步';
    };
    next.addEventListener('click', () => {
      if (step >= steps.length - 1) dismissTutorial();
      else { step++; paint(); }
    });
    tutorialEl = h('aside', {
      class: 'r-tutorial', role: 'dialog', 'aria-modal': 'false', 'aria-label': '首次阅读操作引导',
    },
      h('div', { class: 'r-tutorial-head' }, h('span', { 'aria-hidden': 'true' }, icon('book-open', 18)), title),
      copy,
      h('div', { class: 'r-tutorial-actions' }, skip, next),
    );
    paint();
    container.append(tutorialEl);
    tutorialTimer = setTimeout(() => {
      tutorialTimer = null;
      if (!state.destroyed && tutorialEl) next.focus({ preventScroll: true });
    }, 80);
  }

  function isPagedMode(mode = state.mode) {
    return mode === 'page' || mode === 'pageReverse' || mode === 'tap';
  }

  function isRtlMode() {
    return state.mode === 'pageReverse';
  }

  function settingsSnapshot() {
    return {
      mode: state.mode,
      theme: setting.theme,
      shunt: setting.shunt,
      prefetchCount: setting.prefetchCount,
      offline,
      sourceReady: state.images.length > 0,
      sourceRefreshPending,
      pageFit: setting.pageFit,
      tapMode: setting.tapMode,
      brightnessFollowSystem: setting.brightnessFollowSystem,
      brightness: setting.brightness,
      showPageNumber: setting.showPageNumber,
      keepAwake: setting.keepAwake,
      supportZoom: setting.supportZoom,
      readerToolbarAutoHide: setting.readerToolbarAutoHide,
      readMemoryOptEnabled: setting.readMemoryOptEnabled,
      readDecodeConcurrency: setting.readDecodeConcurrency,
      zoom: state.zoom,
      current: state.cur,
      total: state.images.length,
      hasPreviousChapter: state.curChapterIdx > 0,
      hasNextChapter: state.curChapterIdx >= 0 && state.curChapterIdx < state.chapters.length - 1,
    };
  }

  function applyReaderSettings() {
    if (state.destroyed) return;
    const brightness = Math.max(.2, Math.min(1, Number(setting.brightness) || 1));
    const follow = setting.brightnessFollowSystem !== false;
    const systemDark = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const lightTheme = setting.theme === 'light' || (setting.theme === 'auto' && !systemDark);
    brightnessLayer.style.opacity = follow ? '0' : String(1 - brightness);
    container.classList.toggle('theme-light', lightTheme);
    container.classList.toggle('hide-page-numbers', setting.showPageNumber === false);
    container.classList.toggle('zoom-enabled', setting.supportZoom !== false && isPagedMode());
    container.classList.toggle('progress-pinned', setting.readerToolbarAutoHide === false);
    container.classList.toggle('rtl', isRtlMode());
    container.classList.toggle('tap-only', state.mode === 'tap');
    settingsUI.refresh();
  }

  function changeReaderSetting(key, value) {
    if (state.destroyed) return;
    if (key === 'theme' && !['auto', 'light', 'dark'].includes(value)) return;
    if (key === 'shunt') {
      value = String(value);
      if (!['1', '2', '3', '4'].includes(value)) return;
    }
    if (key === 'prefetchCount') value = Math.max(1, Math.min(12, Number(value) || 3));
    const previous = setting[key];
    const patch = { [key]: value };
    if (key === 'brightness') patch.brightness = Math.max(.2, Math.min(1, Number(value) || 1));
    updateSetting(patch);
    if (key === 'pageFit') {
      container.classList.toggle('fit-width', setting.pageFit === 'width');
      if (isPagedMode()) showPage(state.cur);
      refreshModeBtns();
    }
    if (key === 'supportZoom' && value === false) resetZoom();
    if (key === 'readMemoryOptEnabled') trimRawCache();
    if (key === 'keepAwake') syncWakeLock(true);
    if (key === 'prefetchCount' && Number(previous) !== Number(value)) refreshPrefetchWindow();
    if (key === 'shunt' && String(previous) !== value && !offline && state.images.length) {
      refreshImageShunt(value);
    }
    applyReaderSettings();
    if (key === 'readerToolbarAutoHide') scheduleToolbarHide();
  }

  function setMode(mode) {
    if (state.destroyed || !['scroll', 'page', 'pageReverse', 'tap'].includes(mode)) return;
    if (mode === state.mode) {
      settingsUI.refresh();
      return;
    }
    flushHistory();
    state.mode = mode;
    updateSetting({ readMode: mode });
    resetZoom(false);
    render();
    refreshModeBtns();
    applyReaderSettings();
    markReaderActivity();
  }

  function jumpToPage(idx) {
    if (state.destroyed || !state.images.length) return;
    idx = Math.max(0, Math.min(state.images.length - 1, Number(idx) || 0));
    if (isPagedMode()) {
      showPage(idx);
    } else {
      state.cur = idx;
      pages.querySelector(`.slot[data-idx="${idx}"]`)?.scrollIntoView({ block: 'start' });
      updateIndicator();
      saveHistory();
    }
    settingsUI.refresh();
  }

  function chapterHref(chapter, start = null) {
    if (!chapter) return '';
    const params = new URLSearchParams();
    if (state.aid && !offline) params.set('aid', state.aid);
    if (start === 'last' || (start != null && Number(start) >= 0)) params.set('page', String(start));
    const suffix = params.toString();
    const base = offline
      ? `#/offline/${encodeURIComponent(state.aid)}/${encodeURIComponent(chapter.id)}`
      : `#/read/${chapter.id}`;
    return `${base}${suffix ? `?${suffix}` : ''}`;
  }

  function navigateChapter(delta, start) {
    const chapter = state.chapters[state.curChapterIdx + delta];
    if (!chapter) {
      showHint(delta < 0 ? '已经是第一章' : '已经是最后一章');
      return;
    }
    flushHistory();
    // 替换当前阅读路由，退出时不会逐章退回。
    location.replace(chapterHref(chapter, start ?? (delta < 0 ? 'last' : 0)));
  }

  function toggleSettings(on) {
    if (state.destroyed) return;
    const shouldRestoreFocus = !on && document.activeElement && settingsUI.panel.contains(document.activeElement);
    if (on) {
      if (drawer.classList.contains('on')) toggleDrawer(false);
      setToolbar(true);
      clearToolbarTimer();
      setReaderSurfaceInert(true);
      settingsUI.open();
    } else {
      settingsUI.close();
      setReaderSurfaceInert(false);
      scheduleToolbarHide();
      if (shouldRestoreFocus) settingsBtn.focus({ preventScroll: true });
    }
  }

  function clearToolbarTimer() {
    if (toolbarTimer) clearTimeout(toolbarTimer);
    toolbarTimer = null;
  }

  function scheduleToolbarHide() {
    clearToolbarTimer();
    if (setting.readerToolbarAutoHide === false || !container.classList.contains('toolbar-on')) return;
    if (drawer.classList.contains('on') || settingsUI.isOpen()) return;
    toolbarTimer = setTimeout(() => {
      toolbarTimer = null;
      if (!state.destroyed && !drawer.classList.contains('on') && !settingsUI.isOpen()) setToolbar(false);
    }, 4200);
  }

  function markReaderActivity(showProgress = true) {
    if (state.destroyed) return;
    if (showProgress) pulseProgress();
    if (container.classList.contains('toolbar-on')) scheduleToolbarHide();
  }

  function pulseProgress() {
    if (state.destroyed) return;
    container.classList.add('progress-active');
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = null;
    if (setting.readerToolbarAutoHide !== false) {
      progressTimer = setTimeout(() => {
        progressTimer = null;
        if (!state.destroyed) container.classList.remove('progress-active');
      }, 1600);
    }
  }

  async function syncWakeLock(userInitiated = false) {
    const enabled = setting.keepAwake !== false;
    if (!enabled || document.visibilityState !== 'visible') {
      if (wakeLock) {
        try { await wakeLock.release(); } catch (_) {}
        wakeLock = null;
      }
      return;
    }
    if (wakeLock || !navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') {
      if (userInitiated && !navigator.wakeLock) showHint('当前浏览器不支持屏幕常亮');
      return;
    }
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (state.destroyed || setting.keepAwake === false) {
        await lock.release().catch(() => {});
        return;
      }
      wakeLock = lock;
      lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; }, { once: true });
      if (userInitiated) showHint('已保持屏幕常亮');
    } catch (e) {
      if (userInitiated) showHint('无法启用屏幕常亮，请保持页面在前台');
    }
  }

  function visibilityHandler() {
    if (document.visibilityState === 'hidden') flushHistory();
    else syncWakeLock(false);
  }

  function pageHideHandler() {
    flushHistory();
  }

  document.addEventListener('visibilitychange', visibilityHandler);
  window.addEventListener('pagehide', pageHideHandler);
  syncWakeLock(false);

  function setToolbar(on, moveFocus = false) {
    if (state.destroyed) return;
    container.classList.toggle('toolbar-on', on);
    readerTopbar.inert = !on || drawer.classList.contains('on');
    readerTopbar.setAttribute('aria-hidden', String(!on));
    fabBtn.setAttribute('aria-expanded', String(on));
    if (on) {
      pulseProgress();
      scheduleToolbarHide();
    } else {
      clearToolbarTimer();
    }
    if (moveFocus) {
      queueMicrotask(() => {
        if (state.destroyed) return;
        (on ? backBtn : fabBtn).focus({ preventScroll: true });
      });
    }
  }

  function toggleDrawer(on) {
    if (state.destroyed) return;
    const shouldRestoreFocus = !on && document.activeElement && drawer.contains(document.activeElement);
    drawer.classList.toggle('on', on);
    drawerMask.classList.toggle('on', on);
    drawer.inert = !on;
    drawer.setAttribute('aria-hidden', String(!on));
    drawerBtn.setAttribute('aria-expanded', String(on));
    if (on) {
      if (settingsUI.isOpen()) toggleSettings(false);
      setToolbar(true);
      clearToolbarTimer();
      setReaderSurfaceInert(true);
      queueMicrotask(() => {
        if (state.destroyed || !drawer.classList.contains('on')) return;
        (drawerList.querySelector('.cur') || drawerCloseBtn).focus({ preventScroll: true });
      });
    } else {
      setReaderSurfaceInert(false);
      scheduleToolbarHide();
      if (shouldRestoreFocus) {
        drawerBtn.focus({ preventScroll: true });
      }
    }
  }

  function setReaderSurfaceInert(on) {
    pages.inert = on;
    centerBtn.inert = on;
    fabBtn.inert = on;
    prevBtn.inert = on;
    nextBtn.inert = on;
    readerTopbar.inert = on || !container.classList.contains('toolbar-on');
  }

  function close() {
    destroy();
    if (state.aid && history.length > 1) history.back();
    else location.hash = offline ? '#/downloads' : (state.aid ? `#/album/${state.aid}` : '#/');
  }

  function destroy() {
    if (state.destroyed) return; // 路由清理与手动 close 可能双重触发
    flushHistory();
    state.destroyed = true;
    sourceRefreshSeq++;
    imageController.abort();
    abortController.abort();
    body.classList.remove('reading', 'no-tab');
    disconnectScrollObserver();
    clearPageInteractions();
    pages.removeEventListener('click', pagesClickHandler);
    pages.removeEventListener('scroll', pagesScrollHandler);
    window.removeEventListener('keydown', keyHandler);
    window.removeEventListener('pagehide', pageHideHandler);
    document.removeEventListener('visibilitychange', visibilityHandler);
    if (typeof colorSchemeMedia?.removeEventListener === 'function') {
      colorSchemeMedia.removeEventListener('change', onColorSchemeChange);
    } else if (typeof colorSchemeMedia?.removeListener === 'function') {
      colorSchemeMedia.removeListener(onColorSchemeChange);
    }
    clearToolbarTimer();
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = null;
    if (wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
    if (scrollRaf) cancelAnimationFrame(scrollRaf);
    scrollRaf = 0;
    if (historyTimer) clearTimeout(historyTimer);
    historyTimer = null;
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = null;
    dismissTutorial();
    if (restoreTimer) clearTimeout(restoreTimer);
    restoreTimer = null;
    hint.classList.remove('show');
    decodeQueue.clear();
    for (const d of state.decoded.values()) URL.revokeObjectURL(d.url);
    for (const url of retiredObjectUrls) URL.revokeObjectURL(url);
    retiredObjectUrls.clear();
    state.decoded.clear();
    clearRawCache();
    state.dims.clear();
    container.remove();
  }

  function switchMode() {
    if (state.destroyed) return;
    const modes = ['scroll', 'page', 'pageReverse', 'tap'];
    setMode(modes[(modes.indexOf(state.mode) + 1) % modes.length]);
  }

  function switchFit() {
    if (state.destroyed) return;
    changeReaderSetting('pageFit', setting.pageFit === 'contain' ? 'width' : 'contain');
  }

  /* ---------- 数据加载 ---------- */
  async function init() {
    if (offline) {
      try {
        const [album, chapter, chapters, images] = await Promise.all([
          getOfflineAlbum(state.aid),
          getOfflineChapter(state.aid, state.photoId),
          listOfflineChapters(state.aid),
          listOfflineImages(state.aid, state.photoId, { includeBlob: false }),
        ]);
        if (!chapter || chapter.complete !== true) throw new Error('离线章节不存在或尚未下载完整');
        const expectedCount = Number(chapter.imageCount);
        if (!Number.isInteger(expectedCount) || expectedCount <= 0) throw new Error('离线章节页数无效，请重新下载');
        const imageSlots = Array(expectedCount).fill(null);
        let invalidImages = 0;
        for (const image of images) {
          const index = Number(image?.index);
          if (!Number.isInteger(index) || index < 0 || index >= expectedCount || imageSlots[index] || Number(image?.size || 0) <= 0) {
            invalidImages++;
            continue;
          }
          imageSlots[index] = image;
        }
        const missingImages = imageSlots.reduce((total, image) => total + (image ? 0 : 1), 0);
        if (missingImages || invalidImages || images.length !== expectedCount) {
          throw new Error(`离线缓存不完整（缺少 ${missingImages} 页，异常 ${invalidImages} 页），请在下载中心重试或执行完整性检查`);
        }
        state.albumName = album?.name || '';
        // 按持久化 index 放入定长数组，绝不让缺失的中间页导致后续页码前移。
        state.images = imageSlots;
        state.chapters = chapters.filter((item) => item.complete === true).map((item, index) => ({
          id: String(item.photoId), name: String(item.name || ''), sort: Number(item.sort) || index,
        })).sort((a, b) => a.sort - b.sort);
        state.curChapterIdx = state.chapters.findIndex((item) => item.id === state.photoId);
        if (state.curChapterIdx < 0) {
          state.chapters.unshift({ id: state.photoId, name: chapter.name || '当前章节', sort: -1 });
          state.curChapterIdx = 0;
        }
        renderDrawer();
        container.querySelector('.r-loading')?.remove();
        titleEl.textContent = state.albumName || currentChapterName() || `章节 ${state.photoId}`;
        render();
      } catch (e) {
        if (!state.destroyed) showFatal(e.message || '无法打开离线章节');
      }
      return;
    }
    const albumPromise = state.aid
      ? readerRequest(`/album?id=${encodeURIComponent(state.aid)}`).catch(() => null)
      : Promise.resolve(null);
    let data;
    const requestedShunt = ['1', '2', '3', '4'].includes(String(setting.shunt)) ? String(setting.shunt) : '1';
    try {
      data = await readerRequest(`/chapter?id=${encodeURIComponent(state.photoId)}&shunt=${encodeURIComponent(requestedShunt)}`);
    } catch (e) {
      if (state.destroyed || signal.aborted || e.name === 'AbortError') return;
      showFatal(e.message);
      return;
    }
    if (state.destroyed) return;
    const d = data && data.data && typeof data.data === 'object' && !Array.isArray(data.data)
      ? data.data : {};
    state.images = normalizeChapterImages(d.images);
    if (!state.images.length) {
      showFatal('章节没有返回可读取的安全图片，请稍后重试或切换线路');
      return;
    }
    state.scrambleId = d.scrambleId || 0;
    state.speed = d.speed || '';
    activeImageShunt = requestedShunt;

    const album = await albumPromise;
    if (state.destroyed) return;
    if (album && album.data && typeof album.data === 'object' && !Array.isArray(album.data)) {
      state.albumName = String(album.data.name || '');
      state.cover = imgSrc({
        id: state.aid,
        image: album.data.image,
        cover: album.data.cover,
        cover_url: album.data.cover_url,
        coverUrl: album.data.coverUrl,
      });
      const series = normalizeReaderSeries(album.data.series);
      if (series.length > 1 || (series.length === 1 && album.data.series_id && album.data.series_id !== '0')) {
        series.sort((a, b) => a.sort - b.sort);
        state.chapters = series;
        state.curChapterIdx = series.findIndex((c) => c.id === state.photoId);
        if (state.curChapterIdx < 0) {
          state.chapters = [{ id: state.photoId, name: '当前章节', sort: -1 }, ...series];
          state.curChapterIdx = 0;
        }
      } else {
        state.chapters = [{ id: state.photoId, name: album.data.name || '全一话' }];
        state.curChapterIdx = 0;
      }
      renderDrawer();
    } else if (state.aid) {
      state.chapters = [{ id: state.photoId, name: '当前章节' }];
      state.curChapterIdx = 0;
      renderDrawer();
    }

    container.querySelector('.r-loading')?.remove();
    titleEl.textContent = state.albumName || currentChapterName() || `章节 ${state.photoId}`;
    render();
  }

  function showFatal(msg) {
    if (state.destroyed) return;
    pages.replaceChildren(h('div', { style: 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center' },
      h('div', { class: 'error-box' },
        h('div', null, msg),
        h('button', { class: 'btn', onclick: () => location.reload() }, '重试'),
      )));
    container.querySelector('.r-loading')?.remove();
  }

  function renderDrawer() {
    drawerList.replaceChildren(
      ...state.chapters.map((c, i) =>
        h('button', {
          type: 'button',
          class: i === state.curChapterIdx ? 'cur' : '',
          'aria-current': i === state.curChapterIdx ? 'true' : null,
          onclick: () => {
            toggleDrawer(false);
            if (i !== state.curChapterIdx) {
              flushHistory();
              location.replace(chapterHref(c, 0));
            }
          },
        }, chapterLabel(c, i))
      )
    );
  }

  function chapterName(chapter, idx) {
    const name = String((chapter && chapter.name) || '').trim();
    return name || (idx >= 0 ? `第${idx + 1}章` : '');
  }

  function chapterLabel(chapter, idx) {
    const name = String((chapter && chapter.name) || '').trim();
    return name ? `${idx + 1}. ${name}` : `第${idx + 1}章`;
  }

  function currentChapterName() {
    return chapterName(state.chapters[state.curChapterIdx], state.curChapterIdx);
  }

  /* ---------- 解码调度 ---------- */

  function restartImagePipeline({ reuseDecoded = false } = {}) {
    imageController.abort();
    imageController = new AbortController();
    imageGeneration++;
    decodeQueue.clear();
    if (reuseDecoded) {
      // 仅调整预加载窗口时，已验证的图片仍然有效；给它们换代，避免当前页闪烁。
      for (const rec of state.decoded.values()) {
        if (rec.sourceVersion === imageSourceVersion) rec.generation = imageGeneration;
      }
      pages.querySelectorAll('.slot[data-idx]').forEach((slot) => {
        const rec = state.decoded.get(Number(slot.dataset.idx));
        if (rec?.sourceVersion === imageSourceVersion && slot.dataset.objectUrl === rec.url) {
          slot.dataset.generation = String(imageGeneration);
        }
      });
    } else {
      // 分流变更后 URL/解扰参数可能改变，原始响应绝不能跨线路复用。
      imageSourceVersion++;
      clearRawCache();
    }
  }

  function refreshPrefetchWindow() {
    if (state.destroyed || !state.images.length) return;
    restartImagePipeline({ reuseDecoded: true });
    const generation = imageGeneration;
    if (isPagedMode()) {
      ensureDecoded(state.cur).then((rec) => {
        if (rec && !state.destroyed && generation === imageGeneration && isPagedMode()) mountSlot(state.cur);
      });
    }
    prefetchAround(state.cur);
  }

  async function refreshImageShunt(shunt) {
    if (state.destroyed || offline || !state.images.length) return;
    const seq = ++sourceRefreshSeq;
    sourceRefreshPending = true;
    settingsUI.refresh();
    showHint(`正在切换到图片线路 ${shunt}…`);
    try {
      const data = await readerRequest(`/chapter?id=${encodeURIComponent(state.photoId)}&shunt=${encodeURIComponent(shunt)}`);
      if (state.destroyed || seq !== sourceRefreshSeq) return;
      const next = data && data.data && typeof data.data === 'object' && !Array.isArray(data.data)
        ? data.data : {};
      const nextImages = normalizeChapterImages(next.images);
      if (!nextImages.length) throw new Error('新线路没有返回有效图片');

      const previousTotal = state.images.length;
      restartImagePipeline({ reuseDecoded: false });
      state.images = nextImages;
      state.scrambleId = next.scrambleId || 0;
      state.speed = next.speed || '';
      state.cur = Math.max(0, Math.min(state.images.length - 1, state.cur));
      activeImageShunt = shunt;
      sourceRefreshPending = false;
      settingsUI.refresh();

      const generation = imageGeneration;
      if (state.images.length !== previousTotal) {
        // 页数异常变化时先在后台准备当前页，再重建槽位，避免把正在看的图先清空。
        const rec = await ensureDecoded(state.cur);
        if (state.destroyed || seq !== sourceRefreshSeq || generation !== imageGeneration) return;
        if (rec) render();
        else {
          showHint(`已切换到线路 ${shunt}，当前页加载失败，请重试`);
          return;
        }
      } else {
        if (isPagedMode()) {
          const current = state.cur;
          ensureDecoded(current).then((rec) => {
            if (rec && !state.destroyed && seq === sourceRefreshSeq
                && generation === imageGeneration && state.cur === current && isPagedMode()) mountSlot(current);
          });
        }
        prefetchAround(state.cur);
      }
      showHint(`图片线路已切换为 ${shunt}`);
    } catch (e) {
      if (state.destroyed || seq !== sourceRefreshSeq || e.name === 'AbortError') return;
      sourceRefreshPending = false;
      // 设置值必须与仍在显示的实际线路一致，失败时安全回退。
      updateSetting({ shunt: activeImageShunt });
      applyReaderSettings();
      showHint(`线路切换失败：${e.message || '无法连接'}`);
    }
  }

  function isRaw(idx) {
    if (offline) return true;
    const img = state.images[idx];
    if (!img) return true;
    return !needsScramble({
      photoId: Number(state.photoId),
      scrambleId: state.scrambleId,
      speed: state.speed,
      name: img.name,
    });
  }

  function srcOf(idx) {
    return chapterImgSrc(state.images[idx].url);
  }

  async function getRawBlob(idx, generation, imageSignal) {
    assertImageActive(generation, imageSignal);
    if (state.raws.has(idx)) {
      const b = state.raws.get(idx);
      state.raws.delete(idx);
      state.raws.set(idx, b); // LRU touch
      return b;
    }
    let blob;
    if (offline) {
      const stored = await getOfflineImage(state.aid, state.photoId, state.images[idx]?.index ?? idx);
      blob = stored?.blob;
      if (!(blob instanceof Blob) || !blob.size) throw new Error(`离线图片 ${idx + 1} 缺失或损坏`);
    } else {
      const res = await fetch(srcOf(idx), {
        headers: { 'X-JMW-Data-Source': selectedDataSource() },
        credentials: 'same-origin',
        signal: imageSignal,
      });
      if (!res.ok) throw new Error(`图片 ${idx + 1} 获取失败（${res.status}）`);
      const responseMime = String(res.headers?.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
      if (!SAFE_IMAGE_MIME.has(responseMime)) {
        throw new Error(`图片 ${idx + 1} 返回了不支持的内容类型`);
      }
      blob = await res.blob();
      if (!(blob instanceof Blob) || !blob.size) throw new Error(`图片 ${idx + 1} 返回了空内容`);
      const blobMime = String(blob.type || '').split(';', 1)[0].trim().toLowerCase();
      if (!SAFE_IMAGE_MIME.has(blobMime)) throw new Error(`图片 ${idx + 1} 返回了无效图片内容`);
    }
    assertImageActive(generation, imageSignal);
    cacheRaw(idx, blob);
    return blob;
  }

  /**
   * 当前页翻译采用“短等待、失败回退”策略：译图在首次挂载前返回，避免
   * 用户先看到原图又被迟到的译图替换。邻页由同一个解码/翻译 Promise 预取。
   */
  async function translatePageBlob(blob, idx, generation, sourceVersion, imageSignal) {
    if (!(blob instanceof Blob) || !blob.size) return null;
    const query = new URLSearchParams({
      aid: String(state.aid || ''),
      photoId: String(state.photoId || ''),
      pageIndex: String(idx),
      targetLang: 'zh-CN',
      pipeline: 'fast',
      waitMs: '1500',
    });
    let response;
    try {
      response = await fetch(`/api/translation/page?${query.toString()}`, {
        method: 'POST',
        headers: {
          'Content-Type': String(blob.type || 'image/webp').split(';', 1)[0] || 'image/webp',
          'X-JMW-Data-Source': selectedDataSource(),
        },
        body: blob,
        signal: imageSignal,
      });
      assertImageActive(generation, imageSignal);
      if (!response.ok || response.status === 202 || response.status === 429) {
        await response.arrayBuffer().catch(() => {});
        return null;
      }
      const contentType = String(response.headers.get('content-type') || '')
        .split(';', 1)[0].trim().toLowerCase();
      if (contentType !== 'image/webp') {
        await response.arrayBuffer().catch(() => {});
        return null;
      }
      const translated = await response.blob();
      assertImageActive(generation, imageSignal);
      return translated.size ? translated : null;
    } catch (error) {
      if (error?.name === 'AbortError' || imageSignal.aborted) throw error;
      // 翻译服务未配置、排队已满或单页失败都回退原图，不影响阅读器。
      return null;
    }
  }

  /** 同一页的并发请求共享同一个解码 Promise；完成后从队列移除 */
  function ensureDecoded(idx) {
    if (state.destroyed || signal.aborted) return Promise.resolve(null);
    const cached = state.decoded.get(idx);
    if (cached && cached.generation === imageGeneration && cached.sourceVersion === imageSourceVersion) {
      return Promise.resolve(cached);
    }
    if (decodeQueue.has(idx)) return decodeQueue.get(idx);
    const generation = imageGeneration;
    const sourceVersion = imageSourceVersion;
    const imageSignal = imageController.signal;
    let p;
    p = doDecode(idx, generation, sourceVersion, imageSignal).finally(() => {
      // 换线路后同一页可能已有新 Promise，旧任务结束时不能误删新任务。
      if (decodeQueue.get(idx) === p) decodeQueue.delete(idx);
    });
    decodeQueue.set(idx, p);
    return p;
  }

  function retireDecoded(rec) {
    if (!rec?.url) return;
    let mounted = false;
    pages.querySelectorAll('.slot[data-object-url]').forEach((slot) => {
      if (slot.dataset.objectUrl === rec.url) mounted = true;
    });
    if (mounted) retiredObjectUrls.add(rec.url);
    else URL.revokeObjectURL(rec.url);
  }

  async function doDecode(idx, generation, sourceVersion, imageSignal) {
    let acquired = false;
    try {
      assertImageActive(generation, imageSignal);
      // 限制完整的“取图 + 解扰/校验”任务，而不只是 Canvas 解扰阶段。
      // 否则一次预取可同时发出二十余个图片请求，挤满服务端图片代理槽位。
      while (activeDecodes >= decodeConcurrency()) {
        await waitForDecodeSlot(generation, imageSignal);
        assertImageActive(generation, imageSignal);
      }
      activeDecodes++;
      acquired = true;
      const img = state.images[idx];
      // 原图统一走 raws LRU：解扰页重看时也能复用已下载的 blob
      const blob = await getRawBlob(idx, generation, imageSignal);
      let displayBlob = blob;
      if (!isRaw(idx)) {
        const decoded = await decodeFromBlob(
          blob,
          Number(state.photoId),
          img.page,
          {
            memoryOptimized: setting.readMemoryOptEnabled === true,
            signal: imageSignal,
          },
        );
        assertImageActive(generation, imageSignal);
        displayBlob = decoded.blob;
        state.dims.set(idx, { width: decoded.width, height: decoded.height });
      }
      const translated = await translatePageBlob(displayBlob, idx, generation, sourceVersion, imageSignal);
      if (translated) displayBlob = translated;
      assertImageActive(generation, imageSignal);
      // 保留未解码原图的轻量路径；有译图时仅把最终 Blob 换成译图。
      let displayUrl;
      if (displayBlob === blob) {
        const url = URL.createObjectURL(blob);
        displayUrl = url;
      } else {
        displayUrl = URL.createObjectURL(displayBlob);
      }
      const url = displayUrl;
      const rec = { url, generation, sourceVersion };
      retireDecoded(state.decoded.get(idx));
      state.decoded.set(idx, rec);
      // 原图不为获取尺寸而预先完整解码；由最终挂载的 <img> 在 onload 后回填。
      // raws LRU 重用时保留先前已验证的尺寸，避免占位比例再次跳动。
      return rec;
    } catch (e) {
      if (!state.destroyed && !signal.aborted && !imageSignal.aborted
          && generation === imageGeneration && e.name !== 'AbortError') markError(idx, e.message);
      return null;
    } finally {
      if (acquired) activeDecodes--;
    }
  }

  function waitForDecodeSlot(generation, imageSignal) {
    if (signal.aborted || imageSignal.aborted || generation !== imageGeneration) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(done, 60);
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        imageSignal.removeEventListener('abort', onAbort);
        reject(abortError());
      };
      function done() {
        signal.removeEventListener('abort', onAbort);
        imageSignal.removeEventListener('abort', onAbort);
        resolve();
      }
      signal.addEventListener('abort', onAbort, { once: true });
      imageSignal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function decodeConcurrency() {
    return recommendedDecodeConcurrency({
      deviceMemory,
      memoryOptimized: setting.readMemoryOptEnabled === true,
      configured: setting.readDecodeConcurrency,
    });
  }

  function markError(idx, msg) {
    if (state.destroyed) return;
    const slot = pages.querySelector(`.slot[data-idx="${idx}"]`);
    if (!slot) return;
    const ph = slot.querySelector('.ph');
    const retry = offline ? h('button', {
      class: 'btn', style: 'font-size:12px;padding:5px 14px',
      onclick: async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          // 仅清除已经由 <img> 证明损坏的这一页；随后章节任务会按缺页断点修复。
          await deleteOfflineImage(state.aid, state.photoId, state.images[idx]?.index ?? idx);
          const { queueChapterDownload } = await import('./downloads.js');
          await queueChapterDownload(state.aid, state.photoId, { shunt: setting.shunt, concurrency: 3 });
          location.hash = '#/downloads';
        } catch (error) {
          button.disabled = false;
          showHint(error.message || '无法创建修复任务');
        }
      },
    }, '重新下载本章') : h('button', {
      class: 'btn', style: 'font-size:12px;padding:5px 14px',
      onclick: () => {
        const currentSlot = pages.querySelector(`.slot[data-idx="${idx}"]`);
        if (!currentSlot || state.destroyed) return;
        dropRaw(idx); // 解码失败时不要反复复用同一份损坏缓存。
        currentSlot.dataset.mounted = '0';
        currentSlot.replaceChildren(placeholderFor(idx));
        ensureDecoded(idx).then((rec) => { if (rec) mountSlot(idx); });
      },
    }, '重试');
    if (ph) ph.replaceChildren(
      h('div', { style: 'text-align:center;padding:30px 10px;color:#889' },
        h('div', null, `第 ${idx + 1} 页加载失败`),
        h('div', { style: 'font-size:11px;margin:4px 0 8px' }, msg || ''),
        retry,
      ));
  }

  function captureScrollAnchor() {
    if (state.mode !== 'scroll' || !pages.isConnected) return null;
    const anchor = pages.querySelector(`.slot[data-idx="${state.cur}"]`) || pages.querySelector('.slot');
    if (!anchor) return null;
    return { anchor, top: anchor.getBoundingClientRect().top };
  }

  function restoreScrollAnchor(snapshot) {
    if (!snapshot || state.mode !== 'scroll' || !snapshot.anchor.isConnected) return;
    const nextTop = snapshot.anchor.getBoundingClientRect().top;
    const delta = nextTop - snapshot.top;
    if (Math.abs(delta) > 0.5) pages.scrollTop += delta;
  }

  function clearReservedHeight(slot) {
    if (!slot) return;
    delete slot.dataset.reservedHeight;
    slot.style.removeProperty('min-height');
  }

  function mountSlot(idx) {
    const slot = pages.querySelector(`.slot[data-idx="${idx}"]`);
    if (!slot || state.destroyed) return;
    const rec = state.decoded.get(idx);
    if (!rec || rec.generation !== imageGeneration || rec.sourceVersion !== imageSourceVersion) return;
    if (slot.dataset.mounted === '1' && slot.dataset.generation === String(rec.generation)
        && slot.dataset.objectUrl === rec.url) return;
    const previousObjectUrl = slot.dataset.objectUrl || '';
    const scrollAnchor = captureScrollAnchor();
    // 保留占位高度直到最终 <img> onload，避免图片请求期间槽位塌陷导致滚动位置跳动。
    if (state.mode === 'scroll' && slot.offsetHeight > 0) {
      slot.style.minHeight = `${slot.offsetHeight}px`;
      slot.dataset.reservedHeight = '1';
    }
    slot.dataset.mounted = '1';
    slot.dataset.generation = String(rec.generation);
    slot.dataset.objectUrl = rec.url;
    const image = h('img', {
      src: rec.url, alt: `第${idx + 1}页`, draggable: 'false',
      onload: () => {
        const beforeResize = captureScrollAnchor();
        backfillReaderImageDimensions({
          image, slot, index: idx, record: rec, state,
          generation: imageGeneration, sourceVersion: imageSourceVersion,
        });
        if (slot.dataset.reservedHeight === '1') {
          clearReservedHeight(slot);
          restoreScrollAnchor(beforeResize || scrollAnchor);
        }
      },
      onerror: () => {
        // Blob 的 MIME 可能看似图片但内容已损坏；此时 <img> 才是最终校验点。
        // 只处理仍属于当前槽位的记录，避免快速翻页后的迟到 error 污染新页。
        if (state.destroyed || !slot.isConnected || slot.dataset.idx !== String(idx)
            || state.decoded.get(idx) !== rec) return;
        URL.revokeObjectURL(rec.url);
        state.decoded.delete(idx);
        dropRaw(idx);
        state.dims.delete(idx);
        slot.dataset.mounted = '0';
        delete slot.dataset.generation;
        delete slot.dataset.objectUrl;
        clearReservedHeight(slot);
        slot.replaceChildren(placeholderFor(idx));
        markError(idx, '图片数据损坏或浏览器无法解码');
      },
    });
    if (isPagedMode()) {
      const media = h('div', { class: 'r-page-media' }, image);
      slot.replaceChildren(h('div', { class: 'page-num' }, `${idx + 1}`), media);
      applyZoomTransform();
    } else {
      slot.replaceChildren(h('div', { class: 'page-num' }, `${idx + 1}`), image);
    }
    restoreScrollAnchor(scrollAnchor);
    if (previousObjectUrl && previousObjectUrl !== rec.url && retiredObjectUrls.delete(previousObjectUrl)) {
      URL.revokeObjectURL(previousObjectUrl);
    }
  }

  function updateIndicator() {
    indicator.textContent = state.images.length ? `${state.cur + 1} / ${state.images.length}` : '…';
    const leftDelta = isRtlMode() ? 1 : -1;
    const rightDelta = -leftDelta;
    const canMove = (delta) => {
      const target = state.cur + delta;
      if (target >= 0 && target < state.images.length) return true;
      return delta < 0 ? state.curChapterIdx > 0 : state.curChapterIdx < state.chapters.length - 1;
    };
    prevBtn.disabled = !canMove(leftDelta);
    nextBtn.disabled = !canMove(rightDelta);
    prevBtn.title = leftDelta < 0 ? '上一页' : '下一页';
    nextBtn.title = rightDelta < 0 ? '上一页' : '下一页';
    prevBtn.setAttribute('aria-label', prevBtn.title);
    nextBtn.setAttribute('aria-label', nextBtn.title);
    settingsUI.refresh();
  }

  function setProgress(value) {
    const percent = Math.max(0, Math.min(100, Number(value) || 0));
    progress.style.width = `${percent.toFixed(2)}%`;
    progress.setAttribute('aria-valuenow', String(Math.round(percent)));
    pulseProgress();
  }

  function showHint(msg) {
    if (state.destroyed) return;
    if (hintTimer) clearTimeout(hintTimer);
    hint.textContent = msg;
    hint.classList.add('show');
    hintTimer = setTimeout(() => {
      hintTimer = null;
      if (!state.destroyed) hint.classList.remove('show');
    }, 2200);
  }

  function prefetchAround(idx) {
    if (state.destroyed || signal.aborted) return;
    const n = Math.max(1, Math.min(12, Math.trunc(Number(setting.prefetchCount) || 3)));
    const start = Math.max(0, idx - n);
    const end = Math.min(state.images.length - 1, idx + n);
    const order = readerPrefetchOrder(idx, state.images.length, n);
    const generation = imageGeneration;
    const sourceVersion = imageSourceVersion;
    const sequence = ++prefetchSequence;
    const isActive = () => !state.destroyed && !signal.aborted && sequence === prefetchSequence
      && generation === imageGeneration && sourceVersion === imageSourceVersion && state.cur === idx;
    scheduleReaderPrefetch(order, ensureDecoded, (i) => {
      if (state.mode === 'scroll') mountSlot(i);
    }, isActive, evictLatePrefetchResult);
    // decoded/展示缓存严格限制在窗口内；raws 仍是独立的已下载 Blob LRU，
    // 用于回看时避免重复网络请求，不会占用图片解码与 DOM 展示缓存。
    for (const [k, v] of state.decoded) {
      if (k < start || k > end) evictDecoded(k, v);
    }
  }

  function evictDecoded(idx, rec) {
    if (!rec || state.decoded.get(idx) !== rec) return;
    URL.revokeObjectURL(rec.url);
    state.decoded.delete(idx);
    const slot = pages.querySelector(`.slot[data-idx="${idx}"]`);
    if (slot?.dataset.objectUrl === rec.url) {
      slot.dataset.mounted = '0';
      delete slot.dataset.generation;
      delete slot.dataset.objectUrl;
      clearReservedHeight(slot);
      slot.replaceChildren(placeholderFor(idx));
    }
  }

  function evictLatePrefetchResult(idx, rec) {
    // 已经发出的 fetch 无法可靠撤销而不影响同页复用；迟到结果仅在落到当前严格
    // 窗口之外时回收。仍在 [cur-n, cur+n] 内的结果可供新窗口直接复用。
    const radius = Math.max(1, Math.min(12, Math.trunc(Number(setting.prefetchCount) || 3)));
    if (idx < state.cur - radius || idx > state.cur + radius) evictDecoded(idx, rec);
  }

  function placeholderFor(idx) {
    const dims = state.dims.get(idx);
    const ratio = dims && dims.width ? `${dims.width} / ${dims.height}` : '3 / 4.3';
    return h('div', { class: 'ph', style: `aspect-ratio:${ratio}` },
      h('div', { style: 'display:flex;flex-direction:column;gap:8px;align-items:center' },
        h('div', { class: 'spinner-sm' }), `${idx + 1}`));
  }

  /* ---------- 滚动模式 ---------- */

  function disconnectScrollObserver() {
    if (scrollObserver) scrollObserver.disconnect();
    scrollObserver = null;
  }

  function renderScroll() {
    if (state.destroyed) return;
    clearPageInteractions();
    pageSlot = null;
    setProgress(0);
    container.classList.remove('paged', 'fit-width');
    pages.replaceChildren(...state.images.map((_, i) => {
      const slot = h('div', { class: 'slot', dataset: { idx: String(i), mounted: '0' } });
      slot.append(placeholderFor(i));
      return slot;
    }));
    // 统一通过 mountSlot 创建图片，确保从翻页模式切回滚动时，缓存 Blob
    // 仍带有损坏检测和可重试错误态，而不是留下永久破图。
    for (const index of state.decoded.keys()) mountSlot(index);

    disconnectScrollObserver();
    scrollObserver = new IntersectionObserver((entries) => {
      if (state.destroyed || state.mode !== 'scroll') return;
      const current = state.cur;
      const observed = filterReaderPrefetchWindow(entries.filter((entry) => entry.isIntersecting)
        .map((entry) => Number(entry.target.dataset.idx))
        .filter((index) => Number.isInteger(index)), current, state.images.length, setting.prefetchCount);
      if (!observed.length) return;
      const generation = imageGeneration;
      const sourceVersion = imageSourceVersion;
      // IntersectionObserver 也可能一次命中多页。复用同一条当前页任务做门闩，
      // 避免它绕开 prefetchAround 而让邻页抢占当前页的网络/解码槽位。
      ensureDecoded(current).then((rec) => {
        if (state.destroyed || state.mode !== 'scroll' || state.cur !== current
            || generation !== imageGeneration || sourceVersion !== imageSourceVersion) {
          if (rec) evictLatePrefetchResult(current, rec);
          return;
        }
        if (rec && observed.includes(current)) mountSlot(current);
        observed.filter((index) => index !== current).sort((a, b) => {
          const aNext = a > current;
          const bNext = b > current;
          if (aNext !== bNext) return aNext ? -1 : 1;
          return Math.abs(a - current) - Math.abs(b - current);
        }).forEach((index) => {
          ensureDecoded(index).then((nextRec) => {
            if (!nextRec) return;
            if (!state.destroyed && state.mode === 'scroll' && state.cur === current
                && generation === imageGeneration && sourceVersion === imageSourceVersion) mountSlot(index);
            else evictLatePrefetchResult(index, nextRec);
          });
        });
      });
    }, { root: pages, rootMargin: '1000px 0px' });
    pages.querySelectorAll('.slot').forEach((s) => scrollObserver.observe(s));

    // 章节尾
    if (state.images.length) {
      pages.append(h('div', { style: 'padding:30px 20px 60px;text-align:center;color:#667' },
        h('div', null, '本章完'),
        nextChapterLink(),
      ));
    }

    prefetchAround(state.cur);
    updateIndicator();
    // 第一页内退出滚动阅读器时也应留下“继续阅读”记录。
    saveHistory();
  }

  function nextChapterLink() {
    const next = state.chapters[state.curChapterIdx + 1];
    if (next) {
      return h('button', {
        class: 'btn primary', type: 'button',
        onclick: () => navigateChapter(1, 0),
      }, `下一章：${chapterName(next, state.curChapterIdx + 1)}`);
    }
    if (offline) {
      return h('button', {
        class: 'btn', type: 'button', style: 'color:#dde;background:#26272e;border-color:#333',
        onclick: () => { location.hash = '#/downloads'; },
      }, '返回下载中心');
    }
    return state.aid
      ? h('button', { class: 'btn', type: 'button', style: 'color:#dde;background:#26272e;border-color:#333', onclick: () => { location.hash = `#/album/${state.aid}`; } }, '返回详情')
      : null;
  }

  /* ---------- 翻页模式 ---------- */
  let pageSlot = null;
  let suppressClickUntil = 0;
  const activePointers = new Map();
  let pointerStart = null;
  let pinchStart = null;
  let gestureMoved = false;

  function clearPageInteractions() {
    pages.onpointerdown = null;
    pages.onpointermove = null;
    pages.onpointerup = null;
    pages.onpointercancel = null;
    pages.onwheel = null;
    pages.ondblclick = null;
    activePointers.clear();
    pointerStart = null;
    pinchStart = null;
    gestureMoved = false;
    suppressClickUntil = 0;
  }

  function renderPage() {
    if (state.destroyed) return;
    disconnectScrollObserver();
    if (restoreTimer) clearTimeout(restoreTimer);
    restoreTimer = null;
    if (scrollRaf) cancelAnimationFrame(scrollRaf);
    scrollRaf = 0;
    clearPageInteractions();
    container.classList.add('paged');
    container.classList.toggle('fit-width', setting.pageFit === 'width');
    container.classList.toggle('rtl', isRtlMode());
    container.classList.toggle('tap-only', state.mode === 'tap');
    container.classList.toggle('zoom-enabled', setting.supportZoom !== false);
    pageSlot = h('div', { class: 'slot', dataset: { mounted: '0' } });
    pages.replaceChildren(pageSlot);
    pages.scrollTop = 0;

    pages.onpointerdown = (e) => {
      if (state.destroyed || !isPagedMode()) return;
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
      if (activePointers.size === 1) {
        pointerStart = {
          x: e.clientX, y: e.clientY, t: performance.now(), type: e.pointerType,
          panX: state.panX, panY: state.panY,
        };
        gestureMoved = false;
      } else if (activePointers.size === 2 && setting.supportZoom !== false) {
        const [a, b] = [...activePointers.values()];
        pinchStart = {
          distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          zoom: state.zoom,
          centerX: (a.x + b.x) / 2,
          centerY: (a.y + b.y) / 2,
          panX: state.panX,
          panY: state.panY,
        };
        gestureMoved = true;
      }
      try { pages.setPointerCapture(e.pointerId); } catch (_) {}
    };
    pages.onpointermove = (e) => {
      if (!activePointers.has(e.pointerId) || state.destroyed || !isPagedMode()) return;
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
      if (activePointers.size >= 2 && pinchStart && setting.supportZoom !== false) {
        const [a, b] = [...activePointers.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const centerX = (a.x + b.x) / 2;
        const centerY = (a.y + b.y) / 2;
        state.panX = pinchStart.panX + centerX - pinchStart.centerX;
        state.panY = pinchStart.panY + centerY - pinchStart.centerY;
        setZoom(pinchStart.zoom * distance / pinchStart.distance, false);
        gestureMoved = true;
        e.preventDefault();
      } else if (activePointers.size === 1 && pointerStart && state.zoom > 1.01) {
        const dx = e.clientX - pointerStart.x;
        const dy = e.clientY - pointerStart.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) gestureMoved = true;
        state.panX = pointerStart.panX + dx;
        state.panY = pointerStart.panY + dy;
        clampPan();
        applyZoomTransform();
        e.preventDefault();
      }
    };
    const finishPointer = (e, cancelled = false) => {
      const hadPointer = activePointers.has(e.pointerId);
      const start = pointerStart;
      activePointers.delete(e.pointerId);
      if (!hadPointer) return;
      try { pages.releasePointerCapture(e.pointerId); } catch (_) {}
      if (activePointers.size) {
        if (activePointers.size < 2) pinchStart = null;
        return;
      }
      pinchStart = null;
      pointerStart = null;
      if (cancelled || !start || state.destroyed || !isPagedMode()) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      const dt = performance.now() - start.t;
      if (gestureMoved || state.zoom > 1.01) {
        suppressClickUntil = performance.now() + 500;
        return;
      }
      if (state.mode !== 'tap' && dt < 650 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.35) {
        suppressClickUntil = performance.now() + 650;
        goFromSide(dx < 0 ? 'right' : 'left');
        return;
      }
      if (Math.abs(dx) >= 12 || Math.abs(dy) >= 12) {
        // 纯点击模式明确忽略拖动；其余模式的非翻页拖动也不能合成为点击。
        suppressClickUntil = performance.now() + 500;
        return;
      }
      // 鼠标由 click 统一处理；这里只接管触摸/触控笔以抑制合成 click。
      if (start.type !== 'mouse' && dt < 450 && Math.abs(dx) < 12 && Math.abs(dy) < 12) {
        suppressClickUntil = performance.now() + 650;
        handleTap(e.clientX);
      }
    };
    pages.onpointerup = (e) => finishPointer(e, false);
    pages.onpointercancel = (e) => finishPointer(e, true);
    pages.onwheel = (e) => {
      if (!e.ctrlKey || setting.supportZoom === false) return;
      e.preventDefault();
      setZoom(state.zoom * Math.exp(-e.deltaY * .0025));
      markReaderActivity(false);
    };
    pages.ondblclick = (e) => {
      if (setting.supportZoom === false) return;
      const rect = pages.getBoundingClientRect();
      if (e.clientX < rect.left + rect.width / 3 || e.clientX > rect.left + rect.width * 2 / 3) return;
      e.preventDefault();
      suppressClickUntil = performance.now() + 500;
      setZoom(state.zoom > 1.05 ? 1 : 2.5);
    };

    showPage(state.cur);
    updateIndicator();
  }

  function clampPan() {
    if (state.zoom <= 1.01) {
      state.panX = 0;
      state.panY = 0;
      return;
    }
    const maxX = pages.clientWidth * (state.zoom - 1) / 2;
    const maxY = pages.clientHeight * (state.zoom - 1) / 2;
    state.panX = Math.max(-maxX, Math.min(maxX, state.panX));
    state.panY = Math.max(-maxY, Math.min(maxY, state.panY));
  }

  function applyZoomTransform() {
    if (!pageSlot) return;
    clampPan();
    const media = pageSlot.querySelector('.r-page-media');
    if (!media) return;
    media.style.transform = `translate3d(${state.panX}px,${state.panY}px,0) scale(${state.zoom})`;
    media.style.cursor = state.zoom > 1.01 ? 'grab' : '';
    container.classList.toggle('is-zoomed', state.zoom > 1.01);
  }

  function setZoom(value, refresh = true) {
    const enabled = setting.supportZoom !== false && isPagedMode();
    state.zoom = enabled ? Math.max(1, Math.min(4, Number(value) || 1)) : 1;
    if (state.zoom <= 1.01) {
      state.zoom = 1;
      state.panX = 0;
      state.panY = 0;
    }
    applyZoomTransform();
    if (refresh) settingsUI.refresh();
  }

  function resetZoom(refresh = true) {
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    applyZoomTransform();
    if (refresh) settingsUI.refresh();
  }

  function handleTap(clientX) {
    if (state.destroyed) return;
    const rect = pages.getBoundingClientRect();
    const zone = clientX < rect.left + rect.width / 3 ? 'left'
      : clientX > rect.left + rect.width * 2 / 3 ? 'right' : 'center';
    if (zone === 'center') {
      setToolbar(!container.classList.contains('toolbar-on'));
    } else if (!container.classList.contains('toolbar-on')) {
      goFromSide(zone);
    }
  }

  async function showPage(idx) {
    if (state.destroyed || !isPagedMode() || idx < 0 || idx >= state.images.length || !pageSlot) return;
    const targetSlot = pageSlot;
    if (idx !== state.cur) resetZoom(false);
    state.cur = idx;
    targetSlot.dataset.idx = String(idx);
    targetSlot.dataset.mounted = '0';
    // 先清除上一页；慢请求和失败请求都不能让旧图冒充新页。
    targetSlot.replaceChildren(placeholderFor(idx));
    updateIndicator();
    setProgress(((idx + 1) / state.images.length) * 100);
    saveHistory();

    // 等待解码（若该页已在预加载队列中，这里会复用同一个 Promise 而不是卡住）
    const rec = await ensureDecoded(idx);
    if (!rec || state.destroyed || !isPagedMode() || state.cur !== idx || pageSlot !== targetSlot) return;
    mountSlot(idx);
    prefetchAround(idx);
  }

  function goFromSide(side) {
    const delta = side === 'left' ? (isRtlMode() ? 1 : -1) : (isRtlMode() ? -1 : 1);
    goPage(state.cur + delta);
  }

  function goPage(idx) {
    if (state.destroyed) return;
    if (idx < 0) {
      if (state.curChapterIdx > 0) navigateChapter(-1, 'last');
      else showHint('已经是第一页了');
      return;
    }
    if (idx >= state.images.length) {
      if (state.curChapterIdx < state.chapters.length - 1) navigateChapter(1, 0);
      else showHint('已经是最后一页');
      return;
    }
    showPage(idx);
  }

  /* ---------- 通用 ---------- */

  function handleScrollTap(clientX, clientY) {
    const rect = pages.getBoundingClientRect();
    const sideMode = setting.tapMode === 'side';
    let direction = 0;
    if (sideMode) {
      if (clientX < rect.left + rect.width / 3) direction = -1;
      else if (clientX > rect.left + rect.width * 2 / 3) direction = 1;
    } else {
      if (clientY < rect.top + rect.height / 3) direction = -1;
      else if (clientY > rect.top + rect.height * 2 / 3) direction = 1;
    }
    if (!direction) {
      setToolbar(!container.classList.contains('toolbar-on'));
      return;
    }
    if (container.classList.contains('toolbar-on')) return;
    pages.scrollBy({ top: direction * pages.clientHeight * .86, behavior: 'smooth' });
    markReaderActivity();
  }

  // 全局事件只绑定一次（模式切换仅重建 pages 子节点，不会重复绑定）
  const pagesClickHandler = (e) => {
    if (state.destroyed || performance.now() < suppressClickUntil) return;
    if (e.target.closest('button, a, input, select, textarea')) return;
    if (isPagedMode()) handleTap(e.clientX);
    else handleScrollTap(e.clientX, e.clientY);
  };
  pages.addEventListener('click', pagesClickHandler);

  // 滚动进度：绑定一次，仅滚动模式下生效（翻页模式由 showPage 更新进度）
  const pagesScrollHandler = () => {
    if (state.destroyed || state.mode !== 'scroll' || scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      if (state.destroyed || state.mode !== 'scroll') return;
      const max = pages.scrollHeight - pages.clientHeight;
      const p = max > 0 ? pages.scrollTop / max : 0;
      setProgress(p * 100);
      const center = pages.scrollTop + pages.clientHeight / 2;
      let best = 0, bestDist = Infinity;
      let bestSlot = null;
      pages.querySelectorAll('.slot').forEach((s) => {
        const d = Math.abs(s.offsetTop + s.offsetHeight / 2 - center);
        if (d < bestDist) { bestDist = d; best = Number(s.dataset.idx); bestSlot = s; }
      });
      if (bestSlot && bestSlot.offsetHeight) {
        state.pageOffset = Math.max(0, Math.min(1, (center - bestSlot.offsetTop) / bestSlot.offsetHeight));
      }
      if (best !== state.cur) {
        state.cur = best;
        updateIndicator();
      }
      saveHistory();
      prefetchAround(state.cur);
    });
  };
  pages.addEventListener('scroll', pagesScrollHandler, { passive: true });

  const keyHandler = (e) => {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (tutorialEl) {
      if (e.key === 'Escape') {
        e.preventDefault();
        dismissTutorial();
      }
      return;
    }
    if (settingsUI.isOpen()) {
      if (e.key === 'Escape') {
        e.preventDefault();
        toggleSettings(false);
      }
      return;
    }
    if (drawer.classList.contains('on')) {
      if (e.key === 'Escape') {
        e.preventDefault();
        toggleDrawer(false);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 's') {
      e.preventDefault();
      toggleSettings(true);
      return;
    }
    if (isPagedMode()) {
      if (e.key === 'ArrowRight' || e.key === 'd') {
        e.preventDefault(); goFromSide('right');
      } else if (e.key === 'ArrowLeft' || e.key === 'a') {
        e.preventDefault(); goFromSide('left');
      } else if (e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault(); goPage(state.cur + 1);
      } else if (e.key === 'PageUp') {
        e.preventDefault(); goPage(state.cur - 1);
      } else if ((e.key === '+' || e.key === '=') && setting.supportZoom !== false) {
        e.preventDefault(); setZoom(state.zoom + .25);
      } else if (e.key === '-' && setting.supportZoom !== false) {
        e.preventDefault(); setZoom(state.zoom - .25);
      } else if (e.key === '0' && setting.supportZoom !== false) {
        e.preventDefault(); resetZoom();
      }
    }
  };
  window.addEventListener('keydown', keyHandler);

  function saveHistory() {
    if (state.destroyed || !state.images.length) return;
    historyPending = true;
    if (historyTimer) return;
    historyTimer = setTimeout(() => {
      historyTimer = null;
      flushHistory();
    }, 800);
  }

  function flushHistory() {
    if (historyTimer) clearTimeout(historyTimer);
    historyTimer = null;
    if (!historyPending) return;
    historyPending = false;
    try {
      writeReaderProgress();
      if (state.aid) {
        recordAlbumHistory({
          aid: state.aid,
          name: state.albumName || currentChapterName() || `漫画 ${state.aid}`,
          cover: state.cover,
          photoId: state.photoId,
          page: state.cur,
          total: state.images.length,
          offline,
        });
      }
    } catch (e) {
      console.warn('[reader] 阅读进度保存失败:', e.message);
    }
  }

  function progressKey() {
    return `${state.aid || 'chapter'}:${state.photoId}`;
  }

  function writeReaderProgress() {
    let all = {};
    try { all = JSON.parse(localStorage.getItem('jmw_reader_progress') || '{}') || {}; } catch (_) {}
    all[progressKey()] = {
      aid: state.aid,
      photoId: state.photoId,
      page: state.cur,
      pageOffset: state.pageOffset,
      total: state.images.length,
      mode: state.mode,
      ts: Date.now(),
    };
    const entries = Object.entries(all);
    if (entries.length > 200) {
      entries.sort((a, b) => Number(b[1]?.ts || 0) - Number(a[1]?.ts || 0));
      all = Object.fromEntries(entries.slice(0, 200));
    }
    localStorage.setItem('jmw_reader_progress', JSON.stringify(all));
  }

  function findSavedRec() {
    if (explicitStartPending) {
      explicitStartPending = false;
      const page = requestedPage === 'last'
        ? state.images.length - 1
        : Math.max(0, Math.min(state.images.length - 1, Number.parseInt(requestedPage, 10) || 0));
      return { page, pageOffset: 0, explicit: true };
    }
    try {
      const all = JSON.parse(localStorage.getItem('jmw_reader_progress') || '{}') || {};
      const rec = all[progressKey()];
      if (rec && Number(rec.page) >= 0 && Number(rec.page) < state.images.length) return rec;
    } catch (_) {}
    if (!state.aid) return null;
    let list;
    try {
      list = JSON.parse(localStorage.getItem('jmw_local_history') || '[]');
    } catch (_) {
      return null;
    }
    const rec = list.find((it) => String(it.aid) === String(state.aid) && String(it.photoId) === String(state.photoId));
    if (rec && Number(rec.page) >= 0 && Number(rec.page) < state.images.length) return rec;
    return null;
  }

  let firstRender = true;
  function render() {
    if (state.destroyed) return;
    // 仅首次渲染恢复上次阅读位置；显式 page 参数优先于本地记录。
    const saved = firstRender ? findSavedRec() : null;
    firstRender = false;
    if (isPagedMode()) {
      if (saved) state.cur = saved.page;
      renderPage();
      if (saved) showHint(`${saved.explicit ? '已跳转' : '已恢复'}到第 ${saved.page + 1} 页`);
    } else {
      if (saved) state.cur = saved.page;
      renderScroll();
      const restoreIdx = saved ? saved.page : state.cur;
      if (restoreIdx > 0 || (saved && saved.pageOffset)) scheduleScrollRestore(restoreIdx, saved?.pageOffset);
      if (saved) showHint(saved.explicit ? `已跳转到第 ${saved.page + 1} 页` : '已恢复上次阅读位置');
    }
    applyReaderSettings();
    maybeShowReaderTutorial();
  }

  function scheduleScrollRestore(idx, offset = .5) {
    if (restoreTimer) clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => {
      restoreTimer = null;
      if (state.destroyed || state.mode !== 'scroll') return;
      const slot = pages.querySelector(`.slot[data-idx="${idx}"]`);
      if (!slot) return;
      const parsedOffset = Number(offset);
      const safeOffset = Math.max(0, Math.min(1, Number.isFinite(parsedOffset) ? parsedOffset : .5));
      pages.scrollTop = Math.max(0, slot.offsetTop + slot.offsetHeight * safeOffset - pages.clientHeight / 2);
    }, 80);
  }

  init();

  return { destroy };
}
