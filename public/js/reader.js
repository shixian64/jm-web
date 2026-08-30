// 阅读器：连续滚动 / 翻页双模式，Canvas 解扰，预加载，章节抽屉
// 协议与还原算法对齐 jm-mobile 的 ComicReadViewModel + ComicPicImageState
import { chapterImgSrc, imgSrc } from './api.js';
import { setting, recordAlbumHistory } from './store.js';
import { needsScramble, decodeFromBlob } from './descramble.js';
import { h, toast } from './ui.js';
import { icon } from './icons.js';

const RAW_CACHE_LIMIT = 24;

export function mountReader(root, photoId, query) {
  const aid = query.get('aid') || '';
  const body = document.body;
  body.classList.add('reading', 'no-tab');
  const abortController = new AbortController();
  const { signal } = abortController;

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
    mode: setting.readMode === 'page' ? 'page' : 'scroll',
    cur: 0,
    decoded: new Map(),  // idx -> { url, width, height }
    raws: new Map(),     // idx -> blob（原始图缓存，LRU，解扰与原图共用）
    dims: new Map(),     // idx -> {width, height}
    destroyed: false,
  };

  const decodeQueue = new Map(); // idx -> 进行中的解码 Promise（并发去重 + 复用）
  let activeDecodes = 0;
  let scrollObserver = null;
  let scrollRaf = 0;
  let historyTimer = null;
  let historyPending = false;
  let hintTimer = null;
  let restoreTimer = null;

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

  async function readerRequest(path) {
    let res;
    try {
      res = await fetch('/api' + path, {
        headers: { 'Content-Type': 'application/json' },
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

  function refreshModeBtns() {
    modeBtn.replaceChildren(icon(state.mode === 'scroll' ? 'book-open' : 'book', 20));
    modeBtn.title = state.mode === 'scroll' ? '切换到翻页模式' : '切换到滚动模式';
    modeBtn.setAttribute('aria-label', modeBtn.title);
    fitBtn.style.display = state.mode === 'page' ? '' : 'none';
    fitBtn.replaceChildren(icon(setting.pageFit === 'contain' ? 'scan' : 'move-horizontal', 20));
    fitBtn.title = setting.pageFit === 'contain' ? '切换到适应宽度' : '切换到完整显示';
    fitBtn.setAttribute('aria-label', fitBtn.title);
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
    backBtn, titleEl, drawerBtn, modeBtn, fitBtn,
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
    class: 'r-page-nav r-page-prev', type: 'button', title: '上一页', 'aria-label': '上一页',
    onclick: () => goPage(state.cur - 1),
  }, icon('arrow-left', 22));
  const nextBtn = h('button', {
    class: 'r-page-nav r-page-next', type: 'button', title: '下一页', 'aria-label': '下一页',
    onclick: () => goPage(state.cur + 1),
  }, icon('arrow-left', 22));

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
  );
  refreshModeBtns();
  root.appendChild(container);

  function setToolbar(on, moveFocus = false) {
    if (state.destroyed) return;
    container.classList.toggle('toolbar-on', on);
    readerTopbar.inert = !on || drawer.classList.contains('on');
    readerTopbar.setAttribute('aria-hidden', String(!on));
    fabBtn.setAttribute('aria-expanded', String(on));
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
      setToolbar(true);
      setReaderSurfaceInert(true);
      queueMicrotask(() => {
        if (state.destroyed || !drawer.classList.contains('on')) return;
        (drawerList.querySelector('.cur') || drawerCloseBtn).focus({ preventScroll: true });
      });
    } else {
      setReaderSurfaceInert(false);
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
    else location.hash = state.aid ? `#/album/${state.aid}` : '#/';
  }

  function destroy() {
    if (state.destroyed) return; // 路由清理与手动 close 可能双重触发
    flushHistory();
    state.destroyed = true;
    abortController.abort();
    body.classList.remove('reading', 'no-tab');
    disconnectScrollObserver();
    clearPageInteractions();
    pages.removeEventListener('click', pagesClickHandler);
    pages.removeEventListener('scroll', pagesScrollHandler);
    window.removeEventListener('keydown', keyHandler);
    if (scrollRaf) cancelAnimationFrame(scrollRaf);
    scrollRaf = 0;
    if (historyTimer) clearTimeout(historyTimer);
    historyTimer = null;
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = null;
    if (restoreTimer) clearTimeout(restoreTimer);
    restoreTimer = null;
    hint.classList.remove('show');
    decodeQueue.clear();
    for (const d of state.decoded.values()) URL.revokeObjectURL(d.url);
    state.decoded.clear();
    state.raws.clear();
    state.dims.clear();
    container.remove();
  }

  function switchMode() {
    if (state.destroyed) return;
    state.mode = state.mode === 'scroll' ? 'page' : 'scroll';
    setting.readMode = state.mode;
    localStorage.setItem('jmw_setting', JSON.stringify({ ...setting }));
    render();
    refreshModeBtns();
  }

  function switchFit() {
    if (state.destroyed) return;
    setting.pageFit = setting.pageFit === 'contain' ? 'width' : 'contain';
    localStorage.setItem('jmw_setting', JSON.stringify({ ...setting }));
    container.classList.toggle('fit-width', setting.pageFit === 'width');
    if (state.mode === 'page') showPage(state.cur);
    refreshModeBtns();
  }

  /* ---------- 数据加载 ---------- */
  async function init() {
    const albumPromise = state.aid
      ? readerRequest(`/album?id=${encodeURIComponent(state.aid)}`).catch(() => null)
      : Promise.resolve(null);
    let data;
    try {
      data = await readerRequest(`/chapter?id=${encodeURIComponent(state.photoId)}&shunt=${encodeURIComponent(setting.shunt || 1)}`);
    } catch (e) {
      if (state.destroyed || signal.aborted || e.name === 'AbortError') return;
      showFatal(e.message);
      return;
    }
    if (state.destroyed) return;
    const d = data.data || {};
    state.images = d.images || [];
    state.scrambleId = d.scrambleId || 0;
    state.speed = d.speed || '';

    const album = await albumPromise;
    if (state.destroyed) return;
    if (album && album.data) {
      state.albumName = album.data.name || '';
      state.cover = imgSrc({ id: state.aid, image: album.data.image });
      const series = (album.data.series || []).map((s) => ({
        id: String(s.id), name: String(s.name || '').trim(), sort: Number(s.sort) || 0,
      }));
      if (series.length > 1 || (series.length === 1 && album.data.series_id && album.data.series_id !== '0')) {
        series.sort((a, b) => a.sort - b.sort);
        state.chapters = series;
        state.curChapterIdx = series.findIndex((c) => c.id === state.photoId);
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
              location.hash = `#/read/${c.id}?aid=${state.aid}`;
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

  function isRaw(idx) {
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

  async function getRawBlob(idx) {
    assertActive();
    if (state.raws.has(idx)) {
      const b = state.raws.get(idx);
      state.raws.delete(idx);
      state.raws.set(idx, b); // LRU touch
      return b;
    }
    const res = await fetch(srcOf(idx), { signal });
    if (!res.ok) throw new Error(`图片 ${idx + 1} 获取失败（${res.status}）`);
    const blob = await res.blob();
    assertActive();
    state.raws.set(idx, blob);
    while (state.raws.size > RAW_CACHE_LIMIT) {
      const firstKey = state.raws.keys().next().value;
      state.raws.delete(firstKey);
    }
    return blob;
  }

  /** 同一页的并发请求共享同一个解码 Promise；完成后从队列移除 */
  function ensureDecoded(idx) {
    if (state.destroyed || signal.aborted) return Promise.resolve(null);
    if (state.decoded.has(idx)) return Promise.resolve(state.decoded.get(idx));
    if (decodeQueue.has(idx)) return decodeQueue.get(idx);
    const p = doDecode(idx).finally(() => decodeQueue.delete(idx));
    decodeQueue.set(idx, p);
    return p;
  }

  async function doDecode(idx) {
    try {
      assertActive();
      const img = state.images[idx];
      // 原图统一走 raws LRU：解扰页重看时也能复用已下载的 blob
      const blob = await getRawBlob(idx);
      if (!isRaw(idx)) {
        // 有并发上限的解扰
        while (activeDecodes >= 2) {
          await waitForDecodeSlot();
          assertActive();
        }
        activeDecodes++;
        try {
          const { blob: out, width, height } = await decodeFromBlob(blob, Number(state.photoId), img.page);
          assertActive();
          const url = URL.createObjectURL(out);
          const rec = { url, width, height };
          state.decoded.set(idx, rec);
          state.dims.set(idx, { width, height });
          return rec;
        } finally {
          activeDecodes--;
        }
      }
      const bmp = await createImageBitmap(blob).catch(() => null);
      const dims = bmp ? { width: bmp.width, height: bmp.height } : null;
      bmp?.close();
      assertActive();
      const url = URL.createObjectURL(blob);
      const rec = { url, ...dims };
      state.decoded.set(idx, rec);
      state.dims.set(idx, dims || {});
      return rec;
    } catch (e) {
      if (!state.destroyed && !signal.aborted && e.name !== 'AbortError') markError(idx, e.message);
      return null;
    }
  }

  function waitForDecodeSlot() {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(done, 60);
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(abortError());
      };
      function done() {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function markError(idx, msg) {
    if (state.destroyed) return;
    const slot = pages.querySelector(`.slot[data-idx="${idx}"]`);
    if (!slot) return;
    const ph = slot.querySelector('.ph');
    if (ph) ph.replaceChildren(
      h('div', { style: 'text-align:center;padding:30px 10px;color:#889' },
        h('div', null, `第 ${idx + 1} 页加载失败`),
        h('div', { style: 'font-size:11px;margin:4px 0 8px' }, msg || ''),
        h('button', {
          class: 'btn', style: 'font-size:12px;padding:5px 14px',
          onclick: () => { ensureDecoded(idx).then((rec) => { if (rec) mountSlot(idx); }); },
        }, '重试'),
      ));
  }

  function mountSlot(idx) {
    const slot = pages.querySelector(`.slot[data-idx="${idx}"]`);
    if (!slot || state.destroyed) return;
    const rec = state.decoded.get(idx);
    if (!rec) return;
    if (slot.dataset.mounted === '1') return;
    slot.dataset.mounted = '1';
    slot.replaceChildren(
      h('div', { class: 'page-num' }, `${idx + 1}`),
      h('img', { src: rec.url, alt: `第${idx + 1}页` }),
    );
  }

  function updateIndicator() {
    indicator.textContent = state.images.length ? `${state.cur + 1} / ${state.images.length}` : '…';
    prevBtn.disabled = state.cur <= 0;
  }

  function setProgress(value) {
    const percent = Math.max(0, Math.min(100, Number(value) || 0));
    progress.style.width = `${percent.toFixed(2)}%`;
    progress.setAttribute('aria-valuenow', String(Math.round(percent)));
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
    const n = setting.prefetchCount;
    const start = Math.max(0, idx - n - 2);
    const end = Math.min(state.images.length - 1, idx + n + 2);
    for (let i = start; i <= end; i++) {
      ensureDecoded(i).then((rec) => {
        if (!state.destroyed && rec && state.mode === 'scroll') mountSlot(i);
      });
    }
    // 回收窗口外的解码结果
    for (const [k, v] of state.decoded) {
      if (k < start - 4 || k > end + 4) {
        URL.revokeObjectURL(v.url);
        state.decoded.delete(k);
        const slot = pages.querySelector(`.slot[data-idx="${k}"]`);
        if (slot) {
          slot.dataset.mounted = '0';
          slot.replaceChildren(placeholderFor(k));
        }
      }
    }
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
      const rec = state.decoded.get(i);
      const slot = h('div', { class: 'slot', dataset: { idx: String(i), mounted: '0' } });
      if (rec) {
        slot.dataset.mounted = '1';
        slot.append(h('div', { class: 'page-num' }, `${i + 1}`), h('img', { src: rec.url }));
      } else {
        slot.append(placeholderFor(i));
      }
      return slot;
    }));

    disconnectScrollObserver();
    scrollObserver = new IntersectionObserver((entries) => {
      if (state.destroyed || state.mode !== 'scroll') return;
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const idx = Number(e.target.dataset.idx);
        ensureDecoded(idx).then((rec) => {
          if (!state.destroyed && state.mode === 'scroll' && rec) mountSlot(idx);
        });
      }
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
  }

  function nextChapterLink() {
    const next = state.chapters[state.curChapterIdx + 1];
    if (next) {
      return h('button', {
        class: 'btn primary', type: 'button',
        onclick: () => { location.hash = `#/read/${next.id}?aid=${state.aid}`; },
      }, `下一章：${chapterName(next, state.curChapterIdx + 1)}`);
    }
    return state.aid
      ? h('button', { class: 'btn', type: 'button', style: 'color:#dde;background:#26272e;border-color:#333', onclick: () => { location.hash = `#/album/${state.aid}`; } }, '返回详情')
      : null;
  }

  /* ---------- 翻页模式 ---------- */
  let pageSlot = null;
  let suppressClickUntil = 0;

  function clearPageInteractions() {
    pages.ontouchstart = null;
    pages.ontouchend = null;
    pages.ontouchcancel = null;
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
    pageSlot = h('div', { class: 'slot' });
    pages.replaceChildren(pageSlot);
    pages.scrollTop = 0;

    let touchX = 0, touchY = 0, touchT = 0;
    pages.ontouchstart = (e) => {
      if (e.touches.length !== 1) { touchT = 0; return; }
      touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; touchT = Date.now();
    };
    pages.ontouchend = (e) => {
      if (!touchT || !e.changedTouches.length || state.destroyed || state.mode !== 'page') return;
      const dx = e.changedTouches[0].clientX - touchX;
      const dy = e.changedTouches[0].clientY - touchY;
      const dt = Date.now() - touchT;
      if (dt < 600 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        e.preventDefault(); // 抑制后续合成 click，避免手势与点击双重触发
        suppressClickUntil = performance.now() + 700;
        dx < 0 ? goPage(state.cur + 1) : goPage(state.cur - 1);
        return;
      }
      if (dt < 400 && Math.abs(dx) < 12 && Math.abs(dy) < 12) {
        e.preventDefault();
        suppressClickUntil = performance.now() + 700;
        handleTap(e.changedTouches[0].clientX);
      }
    };
    pages.ontouchcancel = () => { touchT = 0; };

    showPage(state.cur);
    updateIndicator();
  }

  function handleTap(clientX) {
    if (state.destroyed) return;
    const w = window.innerWidth;
    const zone = clientX < w / 3 ? 'left' : clientX > (w * 2) / 3 ? 'right' : 'center';
    if (zone === 'center') {
      setToolbar(!container.classList.contains('toolbar-on'));
    } else if (!container.classList.contains('toolbar-on')) {
      goPage(zone === 'left' ? state.cur - 1 : state.cur + 1);
    }
  }

  async function showPage(idx) {
    if (state.destroyed || state.mode !== 'page' || idx < 0 || idx >= state.images.length || !pageSlot) return;
    const targetSlot = pageSlot;
    state.cur = idx;
    updateIndicator();
    setProgress(((idx + 1) / state.images.length) * 100);
    saveHistory();

    // 等待解码（若该页已在预加载队列中，这里会复用同一个 Promise 而不是卡住）
    const rec = await ensureDecoded(idx);
    if (!rec || state.destroyed || state.mode !== 'page' || state.cur !== idx || pageSlot !== targetSlot) return;
    targetSlot.replaceChildren(h('img', { src: rec.url, alt: `第${idx + 1}页` }));
    prefetchAround(idx);
  }

  function goPage(idx) {
    if (state.destroyed) return;
    if (idx < 0) { toast('已经是第一页了'); return; }
    if (idx >= state.images.length) {
      const next = state.chapters[state.curChapterIdx + 1];
      if (next) location.hash = `#/read/${next.id}?aid=${state.aid}`;
      else toast('已经是最后一页');
      return;
    }
    showPage(idx);
  }

  /* ---------- 通用 ---------- */

  // 全局事件只绑定一次（模式切换仅重建 pages 子节点，不会重复绑定）
  const pagesClickHandler = (e) => {
    if (state.destroyed || performance.now() < suppressClickUntil) return;
    if (e.target.closest('button, a, input, select, textarea')) return;
    if (state.mode === 'page') handleTap(e.clientX);
    else setToolbar(!container.classList.contains('toolbar-on'));
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
      pages.querySelectorAll('.slot').forEach((s) => {
        const d = Math.abs(s.offsetTop + s.offsetHeight / 2 - center);
        if (d < bestDist) { bestDist = d; best = Number(s.dataset.idx); }
      });
      if (best !== state.cur) {
        state.cur = best;
        updateIndicator();
        saveHistory();
      }
      prefetchAround(state.cur);
    });
  };
  pages.addEventListener('scroll', pagesScrollHandler, { passive: true });

  const keyHandler = (e) => {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (drawer.classList.contains('on')) {
      if (e.key === 'Escape') {
        e.preventDefault();
        toggleDrawer(false);
      }
      return;
    }
    if (state.mode === 'page') {
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === 'd') {
        e.preventDefault(); goPage(state.cur + 1);
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'a') {
        e.preventDefault(); goPage(state.cur - 1);
      } else if (e.key === 'Escape') {
        e.preventDefault(); close();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  window.addEventListener('keydown', keyHandler);

  function saveHistory() {
    if (!state.aid || state.destroyed) return;
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
    if (!historyPending || !state.aid) return;
    historyPending = false;
    try {
      recordAlbumHistory({
        aid: state.aid,
        name: state.albumName || currentChapterName() || `漫画 ${state.aid}`,
        cover: state.cover,
        photoId: state.photoId,
        page: state.cur,
        total: state.images.length,
      });
    } catch (e) {
      console.warn('[reader] 阅读进度保存失败:', e.message);
    }
  }

  function findSavedRec() {
    if (!state.aid) return null;
    let list;
    try {
      list = JSON.parse(localStorage.getItem('jmw_local_history') || '[]');
    } catch (_) {
      return null;
    }
    const rec = list.find((it) => String(it.aid) === String(state.aid) && String(it.photoId) === String(state.photoId));
    if (rec && rec.page > 2 && rec.page < state.images.length - 1) return rec;
    return null;
  }

  let firstRender = true;
  function render() {
    if (state.destroyed) return;
    // 仅首次渲染恢复上次阅读位置（本地历史），两种阅读模式均支持
    const saved = firstRender ? findSavedRec() : null;
    firstRender = false;
    if (state.mode === 'page') {
      if (saved) state.cur = saved.page;
      renderPage();
      if (saved) showHint(`已恢复到第 ${saved.page + 1} 页`);
    } else {
      if (saved) state.cur = saved.page;
      renderScroll();
      const restoreIdx = saved ? saved.page : state.cur;
      if (restoreIdx > 0) scheduleScrollRestore(restoreIdx);
      if (saved) showHint('已恢复上次阅读位置');
    }
  }

  function scheduleScrollRestore(idx) {
    if (restoreTimer) clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => {
      restoreTimer = null;
      if (state.destroyed || state.mode !== 'scroll') return;
      pages.querySelector(`.slot[data-idx="${idx}"]`)?.scrollIntoView({ block: 'start' });
    }, 60);
  }

  init();

  return { destroy };
}
