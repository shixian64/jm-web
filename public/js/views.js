// 浏览类页面：首页 / 搜索 / 分类 / 每周必看 / 漫画详情
import { api, imgSrc } from './api.js';
import {
  h, toast, comicCard, comicSkeletons, infiniteList, installPullToRefresh, errorBox, loadingBox,
  installImageRetry,
  shouldAutoFocusEditable,
} from './ui.js';
import { setting, getLocalHistory, getSearchHistory, addSearchHistory, clearSearchHistory } from './store.js';
import { icon } from './icons.js';
import { replaceCurrentRouteHash } from './navigation.js';
import {
  buildSearchQuery, deserializeExcludedTags, filterComics, isComicBlocked,
  normalizeTags, parseSearchSyntax, searchContentWithoutExcludedTags, serializeExcludedTags,
} from './content-filter.js';
import { chooseFolder, copyText, folderEntries } from './content-actions.js';
import { getPreferenceRecommendations } from './recommend.js';

function isAbort(e) { return !!(e && e.name === 'AbortError'); }
function isInactive(ctx) {
  return !!(ctx && (ctx.signal?.aborted || (typeof ctx.isActive === 'function' && !ctx.isActive())));
}

/* ============================== 首页 ============================== */

const promoteFallback = new Map();

function displayBlockTitle(value, fallback = '推荐内容') {
  const title = String(value || '')
    .replace(/右滑看更多|滑看更多|看更多/g, '')
    .replace(/[→]+/g, '')
    .trim();
  return title || fallback;
}

function sectionHeading(title, more, eyebrow = '') {
  const copy = h('div', { class: 'section-title-copy' },
    eyebrow ? h('span', { class: 'eyebrow' }, eyebrow) : null,
    h('h2', null, title),
  );
  const action = typeof more === 'function'
    ? h('button', {
      class: 'more', type: 'button',
      onclick: more,
    }, '查看全部', icon('arrow-right', 15))
    : null;
  return h('div', { class: 'section-title' }, copy, action);
}

export function homeView(root, ctx) {
  const cleanups = [];
  let destroyed = false;
  let loadSeq = 0;
  let loadController = null;
  let removePullRefresh = null;
  const clearEffects = () => {
    for (const fn of cleanups.splice(0)) fn();
  };
  const dispose = () => {
    if (destroyed) return;
    destroyed = true;
    loadSeq++;
    loadController?.abort();
    loadController = null;
    removePullRefresh?.();
    removePullRefresh = null;
    clearEffects();
  };
  const page = h('div', { class: 'page home-page' });
  const content = h('div', { class: 'home-content' });
  page.append(content);

  const buildContinueStrip = () => {
    const strip = h('div', { class: 'hscroll continue-strip' });
    for (const it of getLocalHistory().slice(0, 6)) {
      const photoId = it.photoId || it.aid;
      if (!/^\d+$/.test(String(photoId || '')) || !/^\d+$/.test(String(it.aid || ''))) continue;
      const pageNo = Math.max(0, Number(it.page) || 0);
      const total = Math.max(0, Number(it.total) || 0);
      const progress = total ? Math.min(100, Math.round(((pageNo + 1) / total) * 100)) : 0;
      const continueHref = it.offline
        ? `#/offline/${it.aid}/${photoId}`
        : `#/read/${photoId}?aid=${it.aid}`;
      const continueCover = h('img', {
        loading: 'lazy', decoding: 'async', fetchpriority: 'low', alt: it.name || '漫画封面',
      });
      const continueCoverHost = h('div', { class: 'cover' }, continueCover,
        h('span', { class: 'cover-action', 'aria-hidden': 'true' }, icon('play', 14)));
      installImageRetry(continueCover, imgSrc(it), { lazy: true });
      strip.append(h('div', {
        class: 'comic-card continue-card',
        role: 'button',
        tabindex: '0',
        'aria-label': `继续阅读${it.name || '漫画'}`,
        onclick: () => { location.hash = continueHref; },
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); location.hash = continueHref; } },
      },
        continueCoverHost,
        h('div', { class: 'card-copy' },
          h('div', { class: 'name' }, it.name || `漫画 ${it.aid}`),
          h('div', { class: 'card-meta' }, total ? `第 ${pageNo + 1} / ${total} 页` : '继续阅读'),
          total ? h('div', { class: 'continue-progress' }, h('i', { style: `width:${progress}%` })) : null,
        ),
      ));
    }
    return strip;
  };

  const showLoading = () => {
    content.replaceChildren();
    if (getLocalHistory().length) {
      content.append(sectionHeading('继续阅读', null, '最近打开'), buildContinueStrip());
    }
    content.append(h('div', { class: 'grid home-loading-grid', 'aria-label': '正在加载首页内容' }, comicSkeletons()));
  };

  async function loadHome() {
    const seq = ++loadSeq;
    loadController?.abort();
    const controller = new AbortController();
    loadController = controller;
    clearEffects();
    showLoading();
    try {
      const res = await api.home(controller.signal);
      if (destroyed || isInactive(ctx) || controller.signal.aborted || seq !== loadSeq) return;
      const homeBlockedTags = normalizeTags([
        ...(setting.blockedTagList || []),
        ...(setting.homeExcludedTags || []),
      ]);
      const blocks = (res.data || [])
        .map((b) => ({ ...b, content: filterComics(b.content || [], homeBlockedTags) }))
        .filter((b) => b.content.length);
      content.replaceChildren();

      if (getLocalHistory().length) {
        content.append(sectionHeading('继续阅读', null, '最近打开'), buildContinueStrip());
      }

      const firstBlock = blocks[0];
      const firstIsSwiper = !!(firstBlock && firstBlock.content.length > 2 && firstBlock.type !== 'record');
      // 首屏优先展示内容。
      if (firstIsSwiper) {
        content.append(
          sectionHeading(displayBlockTitle(firstBlock.title, '连载更新'), () => gotoBlockFilter(firstBlock), '精选更新'),
          buildSwiper(firstBlock.content, cleanups, firstBlock.title),
        );
      }

      if (setting.preferenceRecommendEnabled) {
        const preferenceHost = h('section', { class: 'preference-recommend', 'aria-live': 'polite' },
          h('div', { class: 'loading-more' }, h('div', { class: 'spinner-sm' }), '正在根据收藏生成推荐…'));
        content.append(preferenceHost);
        const existingIds = new Set(blocks.flatMap((block) => block.content || [])
          .map((item) => String(item?.id ?? item?.aid ?? item?.AID ?? '')).filter(Boolean));
        void getPreferenceRecommendations({
          source: setting.recommendSource === 'network' ? 'network' : 'builtin',
          maxResults: 20,
          signal: controller.signal,
        }).then((recommendation) => {
          if (destroyed || isInactive(ctx) || controller.signal.aborted || seq !== loadSeq) return;
          const recommended = filterComics(recommendation.items || [], homeBlockedTags)
            .filter((item) => {
              const id = String(item?.id ?? item?.aid ?? item?.AID ?? '');
              if (!id || existingIds.has(id)) return false;
              existingIds.add(id); return true;
            });
          if (!recommended.length) {
            preferenceHost.replaceChildren(h('div', { class: 'hint', style: 'padding:8px 2px' },
              '暂时没有可用的偏好推荐；收藏更多带标签的漫画后会自动更新。'));
            return;
          }
          const strip = h('div', { class: 'hscroll' });
          recommended.forEach((item) => strip.append(comicCard(item)));
          preferenceHost.replaceChildren(...[
            sectionHeading('猜你喜欢', () => {
              const tag = recommendation.tags?.[0];
              location.hash = tag ? `#/search?q=${encodeURIComponent('+' + tag)}&o=mr` : '#/favorites';
            }, recommendation.source === 'network' ? '账号网络推荐' : '基于收藏标签'),
            recommendation.tags?.length
              ? h('div', { class: 'hint', style: 'margin:-5px 2px 8px' }, `偏好：${recommendation.tags.slice(0, 5).join(' · ')}`)
              : null,
            strip,
          ].filter(Boolean));
        }).catch((error) => {
          if (destroyed || isInactive(ctx) || controller.signal.aborted || isAbort(error) || seq !== loadSeq) return;
          preferenceHost.replaceChildren(h('div', { class: 'hint', style: 'padding:8px 2px' },
            error?.status === 401 ? '登录后可根据收藏生成偏好推荐。' : `偏好推荐暂不可用：${error.message}`));
        });
      }

      blocks.forEach((block, bi) => {
        const isSwiper = bi === 0 && block.content.length > 2 && block.type !== 'record';
        if (isSwiper) return;
        content.append(sectionHeading(displayBlockTitle(block.title), () => gotoBlockFilter(block), bi === 0 ? '最新内容' : '为你推荐'));
        const strip = h('div', { class: 'hscroll' });
        block.content.forEach((it) => strip.append(comicCard(it)));
        content.append(strip);
      });
    } catch (e) {
      if (destroyed || isInactive(ctx) || controller.signal.aborted || isAbort(e) || seq !== loadSeq) return;
      clearEffects();
      content.replaceChildren(errorBox(e.message, loadHome));
    }
  }

  root.append(page);
  removePullRefresh = installPullToRefresh(page, loadHome);
  loadHome();

  // 离开首页时清理轮播定时器，避免在已脱离 DOM 的节点上空转
  return dispose;
}

function gotoBlockFilter(block) {
  const type = String(block.type || '');
  if (type === 'promote') {
    const id = String(block.id || block.filter_val || '');
    if (id) {
      promoteFallback.set(id, { title: block.title || '首页推荐', content: block.content || [] });
      location.hash = `#/promote/list?id=${encodeURIComponent(id)}&title=${encodeURIComponent(block.title || '首页推荐')}`;
      return;
    }
  }
  if (type === 'category_id') {
    const category = block.slug || block.filter_val || '';
    if (category) {
      location.hash = `#/category/list?c=${encodeURIComponent(category)}&o=mr&title=${encodeURIComponent(block.title || '分类更新')}`;
      return;
    }
  }
  if (type === 'filter' && block.filter_val) {
    location.hash = `#/category/list?c=${encodeURIComponent(block.filter_val)}&o=mr&title=${encodeURIComponent(block.title || '分类更新')}`;
    return;
  }
  // not_in_category_id 及无专用列表接口的区块退化为站内搜索，不再把数字误当作漫画 ID。
  location.hash = `#/search?q=${encodeURIComponent(block.slug || block.title || '')}&o=mr`;
}

export function buildSwiper(items, cleanups = [], contextTitle = '') {
  const swiper = h('div', { class: 'swiper', 'aria-label': '精选内容轮播' });
  const featuredItems = items.slice(0, 6);
  const slideImages = featuredItems.map((item) => imgSrc(item));
  const slides = featuredItems.map((it, i) => {
    const id = String((it && (it.id ?? it.aid ?? it.AID)) || '');
    const canOpen = /^\d+$/.test(id);
    const open = () => { if (canOpen) location.hash = `#/album/${id}`; };
    const category = String(it?.category_sub?.title || it?.category?.title || '').trim();
    const author = String(it?.author || '').trim();
    const title = String(it?.name || '精选漫画');
    const s = h('div', {
      class: 'slide' + (i === 0 ? ' on' : ''),
      'aria-roledescription': 'slide',
      'aria-hidden': i === 0 ? 'false' : 'true',
      'aria-label': `${i + 1} / ${Math.min(items.length, 6)}：${title}`,
      ...(canOpen ? {
        role: 'button', tabindex: i === 0 ? '0' : '-1', 'aria-label': `查看${it.name || '漫画'}详情`,
        onclick: open,
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } },
      } : { 'aria-disabled': 'true' }),
    },
      h('div', { class: 'slide-content' },
        h('span', { class: 'slide-kicker' }, category || contextTitle || '精选'),
        h('h2', null, title),
        author ? h('p', null, '作者 · ', author) : null,
        h('span', { class: 'slide-cta' }, '查看详情', icon('arrow-right', 14)),
      ),
    );
    return s;
  });
  // 背景图不会受 <img loading="lazy"> 控制。只给实际需要显示的 slide
  // 写入 background-image，避免首页初次渲染时 6 张大图同时回源。
  const loadSlideBackground = (index) => {
    const slide = slides[index];
    if (!slide || slide.dataset.backgroundReady === 'true') return;
    const source = slideImages[index];
    if (source) slide.style.backgroundImage = `url("${source}")`;
    slide.dataset.backgroundReady = 'true';
  };
  loadSlideBackground(0);
  const dots = h('div', { class: 'dots' }, slides.map((_, i) => h('i', { class: i === 0 ? 'on' : '' })));
  const prev = h('button', { class: 'swiper-arrow prev', type: 'button', 'aria-label': '上一张精选内容' }, icon('arrow-left', 17));
  const next = h('button', { class: 'swiper-arrow next', type: 'button', 'aria-label': '下一张精选内容' }, icon('arrow-right', 17));
  const controls = h('div', { class: 'swiper-controls' }, prev, dots, next);
  swiper.append(...slides, controls);
  let cur = 0;
  const show = (nextIndex) => {
    const next = (nextIndex + slides.length) % slides.length;
    // 目标图先进入加载队列再切换可见态；状态切换后仅预取它的下一张。
    loadSlideBackground(next);
    slides.forEach((slide, i) => {
      const active = i === next;
      slide.classList.toggle('on', active);
      slide.setAttribute('aria-hidden', String(!active));
      if (slide.getAttribute('role') === 'button') slide.tabIndex = active ? 0 : -1;
      dots.children[i].classList.toggle('on', active);
    });
    cur = next;
    loadSlideBackground((next + 1) % slides.length);
  };
  prev.addEventListener('click', (e) => { e.stopPropagation(); show(cur - 1); });
  next.addEventListener('click', (e) => { e.stopPropagation(); show(cur + 1); });
  dots.querySelectorAll('i').forEach((dot, i) => dot.addEventListener('click', (e) => { e.stopPropagation(); show(i); }));
  let timer = setInterval(() => show(cur + 1), 5000);
  const pause = () => { clearInterval(timer); timer = null; };
  const resume = () => {
    if (!timer && !swiper.matches(':hover') && !swiper.contains(document.activeElement)) {
      timer = setInterval(() => show(cur + 1), 5000);
    }
  };
  swiper.addEventListener('mouseenter', pause);
  swiper.addEventListener('mouseleave', resume);
  swiper.addEventListener('focusin', pause);
  const resumeAfterFocus = (e) => { if (!swiper.contains(e.relatedTarget)) resume(); };
  swiper.addEventListener('focusout', resumeAfterFocus);
  cleanups.push(() => {
    clearInterval(timer);
    swiper.removeEventListener('mouseenter', pause);
    swiper.removeEventListener('mouseleave', resume);
    swiper.removeEventListener('focusin', pause);
    swiper.removeEventListener('focusout', resumeAfterFocus);
  });
  return swiper;
}

/* ============================== 搜索 ============================== */

const ORDERS = [
  ['mr', '最新'], ['mv', '最多收藏'], ['mp', '最多图片'], ['tf', '最多爱心'],
];

const CATEGORY_ORDERS = [
  ['', '最新'], ['tf', '最多爱心'], ['mv', '总排行'],
  ['mv_m', '月排行'], ['mv_w', '周排行'], ['mv_t', '日排行'],
];

export function searchView(root, params, ctx) {
  const rawQuery = params.get('q') || '';
  const parsedQuery = parseSearchSyntax(rawQuery);
  const q = searchContentWithoutExcludedTags(rawQuery);
  const o = params.get('o') || 'mr';
  let excludedTags = normalizeTags([
    ...parsedQuery.excludes,
    ...deserializeExcludedTags(params.get('exclude')),
  ]);
  const page = h('div', { class: 'page search-page' });
  // 手机端进入/恢复空搜索页时不由脚本打开编辑会话，避免 iOS WebKit
  // 持续显示“粘贴”菜单；用户主动点输入框后仍可正常输入。
  let autoFocusPending = (!ctx || ctx.navigationType !== 'history') && shouldAutoFocusEditable();

  const navigateSearch = (value, nextExcluded = excludedTags, order = o) => {
    const parsed = parseSearchSyntax(value);
    const visible = searchContentWithoutExcludedTags(value);
    const excluded = normalizeTags([...nextExcluded, ...parsed.excludes]);
    if (!visible) return;
    location.hash = searchHref(visible, order, excluded);
  };

  if (!q) {
    const renderLanding = () => {
      const searchBar = buildSearchBar('', (v) => navigateSearch(v, excludedTags, 'mr'));
      page.replaceChildren(searchBar);
      if (autoFocusPending) {
        autoFocusPending = false;
        requestAnimationFrame(() => {
          if (searchBar.isConnected && !ctx?.signal?.aborted) searchBar.searchInput?.focus({ preventScroll: true });
        });
      }
      page.append(buildSearchExclusionEditor(excludedTags, (tags) => {
        excludedTags = tags;
        renderLanding();
      }));
      const hist = getSearchHistory();
      if (!hist.length) return;
      const clear = () => { clearSearchHistory(); renderLanding(); };
      page.append(h('div', { class: 'section-title' },
        '搜索历史',
        h('button', { class: 'more', type: 'button', style: 'border:0;background:none;padding:0;cursor:pointer', onclick: clear }, '清空')));
      const tags = h('div', { class: 'history-tags' });
      hist.forEach((t) => tags.append(h('a', { class: 'chip', href: searchHref(t, 'mr', excludedTags) }, t)));
      page.append(tags);
    };
    root.append(page);
    renderLanding();
    return;
  }

  addSearchHistory(q);
  page.append(buildSearchBar(q, (v) => navigateSearch(v)));
  page.append(buildSearchExclusionEditor(excludedTags, (tags) => {
    location.hash = searchHref(q, o, tags);
  }));
  const chips = h('div', { class: 'chips' },
    ORDERS.map(([val, label]) =>
      h('a', { class: 'chip' + (val === o ? ' active' : ''), href: searchHref(q, val, excludedTags) }, label)));
  page.append(chips);
  page.append(h('div', { class: 'result-count' },
    `“${q}” 的搜索结果`,
    excludedTags.length ? ` · 已排除 ${excludedTags.length} 个标签` : ''));
  root.append(page);

  const allExcludedTags = normalizeTags([...(setting.blockedTagList || []), ...excludedTags]);

  const list = infiniteList(async (p, signal) => {
    const res = await api.search(buildSearchQuery(q, allExcludedTags), o, p, signal);
    const data = res.data || {};
    if (data.redirect_aid && p === 1) {
      // 数字 ID 也要尊重排除标签；详情请求失败时保持原有直达行为。
      let blocked = false;
      if (allExcludedTags.length) {
        try {
          const detail = await api.album(data.redirect_aid, signal);
          blocked = isComicBlocked(detail.data || {}, allExcludedTags);
        } catch (e) {
          if (isAbort(e)) throw e;
        }
      }
      if (blocked) toast('该漫画命中排除标签，已隐藏');
      else location.hash = `#/album/${data.redirect_aid}`;
      return { items: [], hasMore: false };
    }
    const source = data.content || [];
    return {
      items: filterComics(source, allExcludedTags).map(comicCard),
      hasMore: source.length >= 20,
    };
  });
  page.append(list.root);
  return list.destroy;
}

function buildSearchBar(value, onSubmit) {
  const input = h('input', { class: 'input', placeholder: '搜索漫画 / 作者 / 标签 / ID，可用 -标签 排除', value });
  const form = h('form', { class: 'search-form', onsubmit: (e) => { e.preventDefault(); onSubmit(input.value.trim()); } },
    input,
    h('button', { class: 'btn primary', type: 'submit' }, '搜索'));
  const bar = h('div', { class: 'search-bar' }, form);
  bar.searchInput = input;
  return bar;
}

function searchHref(q, order, excludedTags) {
  const encodedExcluded = serializeExcludedTags(excludedTags);
  return `#/search?q=${encodeURIComponent(q)}&o=${encodeURIComponent(order || 'mr')}`
    + (encodedExcluded ? `&exclude=${encodeURIComponent(encodedExcluded)}` : '');
}

function buildSearchExclusionEditor(excludedTags, onChange) {
  const tags = normalizeTags(excludedTags);
  const wrap = h('div', { class: 'card', style: 'padding:12px 14px;margin:8px 0 12px' });
  const head = h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' },
    h('strong', { style: 'font-size:13px;flex:1' }, '排除标签'),
    h('button', {
      class: 'btn', type: 'button', style: 'min-height:32px;padding:5px 10px',
      onclick: () => {
        const value = window.prompt('输入要排除的标签');
        if (value != null && value.trim()) onChange(normalizeTags([...tags, value]));
      },
    }, '＋ 添加'),
    tags.length ? h('button', {
      class: 'btn', type: 'button', style: 'min-height:32px;padding:5px 10px',
      onclick: () => onChange([]),
    }, '清空') : null,
  );
  wrap.append(head);
  if (tags.length) {
    const selected = h('div', { class: 'chips', style: 'margin-top:9px;flex-wrap:wrap' });
    tags.forEach((tag) => selected.append(h('button', {
      class: 'chip active', type: 'button', title: `移除 ${tag}`,
      onclick: () => onChange(tags.filter((item) => item.toLocaleLowerCase() !== tag.toLocaleLowerCase())),
    }, `${tag} ×`)));
    wrap.append(selected);
  }
  const templates = (setting.blockedTagTemplateList || [])
    .map((template, index) => ({
      name: String(template?.name || `排除模板 ${index + 1}`),
      tags: normalizeTags(template?.tagList || template?.tags || []),
    }))
    .filter((template) => template.tags.length);
  if (templates.length) {
    const row = h('div', { class: 'chips', style: 'margin-top:8px' },
      h('span', { style: 'font-size:12px;color:var(--text-2);padding:7px 2px' }, '模板'));
    templates.forEach((template) => row.append(h('button', {
      class: 'chip', type: 'button', title: template.tags.join('、'),
      onclick: () => onChange(normalizeTags([...tags, ...template.tags])),
    }, template.name)));
    wrap.append(row);
  }
  const globalBlocked = normalizeTags(setting.blockedTagList || []);
  if (globalBlocked.length) wrap.append(h('div', {
    style: 'font-size:11.5px;color:var(--text-2);margin-top:7px',
  }, `另有 ${globalBlocked.length} 个全局屏蔽标签始终生效`));
  return wrap;
}

/* ============================== 分类 ============================== */

export function categoryView(root, ctx) {
  const page = h('div', { class: 'page category-page' });
  const content = h('div');
  page.append(content);
  root.append(page);
  let destroyed = false;
  let loadSeq = 0;
  let loadController = null;

  const showSkeleton = () => {
    const tiles = Array.from({ length: 8 }, () => h('div', {
      class: 'category-tile', 'aria-hidden': 'true', style: 'min-height:54px',
    },
    h('span', { class: 'skeleton-block', style: 'width:34px;height:34px;border-radius:11px;flex:none' }),
    h('span', { class: 'skeleton-line wide', style: 'width:58%;margin:0' })));
    content.replaceChildren(
      h('div', { class: 'list-head', 'aria-label': '正在加载分类' },
        h('div', { class: 'skeleton-line wide', style: 'width:120px;height:18px' })),
      h('div', { class: 'category-grid' }, tiles),
    );
  };

  const load = async () => {
    const seq = ++loadSeq;
    loadController?.abort();
    const controller = new AbortController();
    loadController = controller;
    showSkeleton();
    try {
      const res = await api.categories(controller.signal);
      if (destroyed || isInactive(ctx) || controller.signal.aborted || seq !== loadSeq) return;
      const data = res.data || {};
      content.replaceChildren();

      content.append(h('div', { class: 'list-head' }, h('h2', null, '分类浏览')));
      content.append(sectionHeading('排行榜', null, '按热度浏览'));
      content.append(h('div', { class: 'chips', style: 'flex-wrap:wrap' },
        CATEGORY_ORDERS.map(([order, label]) => h('a', {
          class: 'chip', href: `#/category/list?c=&o=${encodeURIComponent(order)}&title=${encodeURIComponent(label)}`,
        }, label))));

      const cats = data.categories || [];
      if (cats.length) {
        content.append(sectionHeading('主分类', null, '按类型浏览'));
        const categoryGrid = h('div', { class: 'category-grid' });
        const categoryIcons = ['layout-grid', 'book-open', 'star', 'calendar-days', 'smartphone', 'search'];
        cats.forEach((c, index) => {
          const href = c.type === 'slug' || String(c.id) === '0'
            ? `#/category/list?c=${encodeURIComponent(c.slug)}&o=`
            : `#/search?q=${encodeURIComponent(c.name)}&o=mr`;
          categoryGrid.append(h('a', { class: 'category-tile', href },
            h('span', { class: 'category-icon' }, icon(categoryIcons[index % categoryIcons.length], 19)),
            h('span', { class: 'category-name' }, c.name),
            c.total_albums ? h('span', { style: 'font-size:11px;color:var(--text-2)' }, c.total_albums) : null,
            h('span', { class: 'category-arrow', 'aria-hidden': 'true' }, icon('arrow-up-right', 14)),
          ));
        });
        content.append(categoryGrid);

        // 上游把子分类挂在主分类对象下，组合 slug 以“主_子”请求筛选接口。
        cats.forEach((category) => {
          const children = category.sub_categories || category.subCategories || [];
          if (!children.length || !(category.type === 'slug' || String(category.id) === '0')) return;
          const row = h('div', { class: 'chips', style: 'flex-wrap:wrap;margin-bottom:10px' });
          row.append(h('a', {
            class: 'chip',
            href: `#/category/list?c=${encodeURIComponent(category.slug || '')}&o=&title=${encodeURIComponent(category.name || '分类')}`,
          }, '全部'));
          children.forEach((child) => {
            const childSlug = String(child.slug || '').trim();
            const combined = [category.slug, childSlug].filter(Boolean).join('_');
            row.append(h('a', {
              class: 'chip',
              href: `#/category/list?c=${encodeURIComponent(combined)}&o=&title=${encodeURIComponent(`${category.name || ''} · ${child.name || childSlug}`)}`,
            }, child.name || childSlug));
          });
          content.append(sectionHeading(category.name || '子分类', null, '细分类型'), row);
        });
      }

      const tagList = (data.blocks || []).flatMap((b) => b.content || []);
      if (tagList.length) {
        content.append(sectionHeading('热门标签', null, '快速筛选'));
        const chips = h('div', { class: 'chips tag-cloud', style: 'flex-wrap:wrap' });
        tagList.forEach((t) => chips.append(h('a', { class: 'chip', href: `#/search?q=${encodeURIComponent(t)}&o=mr` }, t)));
        content.append(chips);
      }
    } catch (e) {
      if (destroyed || isInactive(ctx) || controller.signal.aborted || isAbort(e) || seq !== loadSeq) return;
      content.replaceChildren(errorBox(e.message, load));
    } finally {
      if (loadController === controller) loadController = null;
    }
  };

  const removePullRefresh = installPullToRefresh(page, load);
  load();
  return () => {
    if (destroyed) return;
    destroyed = true;
    loadSeq++;
    loadController?.abort();
    loadController = null;
    removePullRefresh();
  };
}

export function categoryListView(root, params) {
  const c = params.get('c') || '';
  const o = params.has('o') ? (params.get('o') || '') : '';
  const title = params.get('title') || '';
  const page = h('div', { class: 'page search-page' });

  if (title) page.append(h('div', { class: 'list-head' }, h('h2', null, title)));
  const chips = h('div', { class: 'chips' },
    CATEGORY_ORDERS.map(([val, label]) =>
      h('a', { class: 'chip' + (val === o ? ' active' : ''), href: `#/category/list?c=${encodeURIComponent(c)}&o=${val}${title ? `&title=${encodeURIComponent(title)}` : ''}` }, label)));
  page.append(chips);
  root.append(page);

  const list = infiniteList(async (p, signal) => {
    const res = await api.categoryFilter(c, o, p, signal);
    const data = res.data || {};
    const source = data.content || [];
    return {
      items: filterComics(source, setting.blockedTagList || []).map(comicCard),
      hasMore: source.length >= 20,
    };
  });
  page.append(list.root);
  return list.destroy;
}

/* ============================== 首页推广列表 ============================== */

export function promoteListView(root, params) {
  const id = params.get('id') || '';
  const fallback = promoteFallback.get(id);
  const title = params.get('title') || (fallback && fallback.title) || '首页推荐';
  const page = h('div', { class: 'page' }, h('div', { class: 'list-head' }, h('h2', null, title)));
  root.append(page);

  if (!id) {
    page.append(errorBox('缺少推荐分类 ID'));
    return;
  }

  let fallbackUsed = false;
  const list = infiniteList(async (p, signal) => {
    try {
      const res = await api.promoteList(id, p, signal);
      const data = res.data || {};
      const content = data.content || data.list || [];
      const total = Number(data.total) || 0;
      return {
        items: content.map(comicCard),
        hasMore: total ? p * 20 < total : content.length >= 20,
      };
    } catch (e) {
      // 旧版后端尚无 promote_list 时，至少展示首页已取得的这一组内容。
      if (!fallbackUsed && p === 1 && fallback && fallback.content.length && !isAbort(e)) {
        fallbackUsed = true;
        toast('完整列表暂不可用，已显示首页缓存内容');
        return { items: fallback.content.map(comicCard), hasMore: false };
      }
      throw e;
    }
  });
  page.append(list.root);
  return list.destroy;
}

/* ============================== 每周必看 ============================== */

function chipButton(label, active, onclick) {
  return h('button', {
    class: 'chip' + (active ? ' active' : ''),
    type: 'button',
    'aria-pressed': active ? 'true' : 'false',
    onclick,
  }, label);
}

export function weekView(root, params, ctx) {
  const page = h('div', { class: 'page' });
  const content = h('div', null, loadingBox());
  page.append(content);
  root.append(page);
  let destroyed = false;
  let loadController = null;
  let loadSeq = 0;
  let reloadCurrent = null;
  const removePullRefresh = installPullToRefresh(page, () => reloadCurrent?.() || Promise.resolve());

  const dispose = () => {
    if (destroyed) return;
    destroyed = true;
    removePullRefresh();
    if (loadController) loadController.abort();
    loadController = null;
  };

  (async () => {
    try {
      const res = await api.week(ctx && ctx.signal);
      if (destroyed || isInactive(ctx)) return;
      const data = res.data || {};
      const categories = data.categories || [];
      const types = data.type || [];
      let curCat = String(params.get('id') || categories[0]?.id || '');
      let curType = String(params.get('type') || types[0]?.id || '');
      if (!categories.some((c) => String(c.id) === curCat)) curCat = String(categories[0]?.id || '');
      if (!types.some((t) => String(t.id) === curType)) curType = String(types[0]?.id || '');

      const periodSelect = h('select', { class: 'input', 'aria-label': '选择周榜期数' },
        categories.map((c, i) => h('option', {
          value: String(c.id), selected: String(c.id) === curCat,
        }, weekLabel(c, i))));
      const typeChips = h('div', { class: 'chips' });
      const listWrap = h('div');
      const pagerWrap = h('div');

      content.replaceChildren(
        h('div', { class: 'list-head' }, h('h2', null, '每周必看')),
        h('div', { class: 'setting-row', style: 'margin-bottom:10px' },
          h('label', { for: 'week-period', style: 'font-size:13px;color:var(--text-2)' }, '期数'),
          periodSelect),
        typeChips,
        listWrap,
        pagerWrap,
      );
      periodSelect.id = 'week-period';

      function renderTypes() {
        typeChips.replaceChildren(...types.map((t) =>
          chipButton(t.title || t.name || String(t.id), String(t.id) === curType, () => {
            curType = String(t.id);
            renderTypes();
            load(1);
          })));
      }

      periodSelect.addEventListener('change', () => {
        curCat = periodSelect.value;
        load(1);
      });

      async function load(p = 1) {
        if (destroyed || isInactive(ctx)) return;
        const seq = ++loadSeq;
        if (loadController) loadController.abort();
        const controller = new AbortController();
        loadController = controller;
        listWrap.replaceChildren(h('div', { class: 'grid', 'aria-label': '正在加载每周必看' }, comicSkeletons()));
        pagerWrap.replaceChildren();
        replaceCurrentRouteHash(`#/week?id=${encodeURIComponent(curCat)}&type=${encodeURIComponent(curType)}`);
        try {
          const r = await api.weekFilter(curCat, curType, p, controller.signal);
          if (destroyed || isInactive(ctx) || controller.signal.aborted || seq !== loadSeq) return;
          const d = r.data || {};
          const items = d.list || [];
          if (!items.length) {
            listWrap.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'big' }, icon('calendar-days', 40)), '该期暂无内容'));
            return;
          }
          listWrap.replaceChildren(h('div', { class: 'grid' }, items.map(comicCard)));
          const total = Number(d.total) || 0;
          const pages = Math.max(1, Math.ceil(total / 20));
          if (pages > 1) {
            const { pager } = await import('./ui.js');
            if (destroyed || isInactive(ctx) || controller.signal.aborted || seq !== loadSeq) return;
            pagerWrap.replaceChildren(pager({
              page: p,
              total: pages,
              onChange: (np) => {
                load(np);
                listWrap.scrollIntoView({ block: 'start', behavior: 'smooth' });
              },
            }));
          }
        } catch (e) {
          if (destroyed || isInactive(ctx) || controller.signal.aborted || isAbort(e) || seq !== loadSeq) return;
          listWrap.replaceChildren(errorBox(e.message, () => load(p)));
        } finally {
          if (loadController === controller) loadController = null;
        }
      }

      renderTypes();
      reloadCurrent = () => load(1);
      load(1);
    } catch (e) {
      if (destroyed || isInactive(ctx) || isAbort(e)) return;
      content.replaceChildren(errorBox(e.message));
    }
  })();

  return dispose;
}

function weekLabel(c, index) {
  const title = String(c.title || '').trim();
  const time = String(c.time || '').trim();
  return title || time || (c.id != null && String(c.id) ? `第 ${c.id} 期` : `第 ${index + 1} 期`);
}

/* ============================== 漫画详情 ============================== */

export async function albumView(root, id, ctx) {
  const page = h('div', { class: 'page-wide' });
  page.append(loadingBox());
  root.append(page);

  let data;
  try {
    const res = await api.album(id, ctx && ctx.signal);
    if (isInactive(ctx)) return;
    data = res && res.data;
  } catch (e) {
    if (isInactive(ctx) || isAbort(e)) return;
    page.replaceChildren(errorBox(e.message));
    return;
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    page.replaceChildren(errorBox('详情数据格式异常，请稍后重试'));
    return;
  }

  // 上游 author 可能为数组或字符串
  const safeText = (value, fallback = '') => (typeof value === 'string' || typeof value === 'number'
    ? String(value).trim() : fallback);
  const authors = (Array.isArray(data.author) ? data.author : [data.author]).map((item) => safeText(item)).filter(Boolean);
  const category = safeText(data.category_sub?.title || data.category?.title
    || (typeof data.category === 'string' ? data.category : ''));
  const albumName = safeText(data.name) || `漫画 ${id}`;
  const description = safeText(data.description);
  const tags = [...(Array.isArray(data.tags) ? data.tags : []),
    ...(Array.isArray(data.actors) ? data.actors : []),
    ...(Array.isArray(data.works) ? data.works : [])].map((item) => safeText(item)).filter(Boolean);
  const series = (Array.isArray(data.series) ? data.series : [])
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .slice().sort((a, b) => Number(a.sort) - Number(b.sort));
  const relatedList = (Array.isArray(data.related_list) ? data.related_list : [])
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item));

  const coverSrc = imgSrc({
    id,
    image: data.image,
    cover: data.cover,
    cover_url: data.cover_url,
    coverUrl: data.coverUrl,
  });
  const hero = h('div', { class: 'album-hero' },
    h('div', { class: 'bg', style: { backgroundImage: `url("${coverSrc}")` } }),
    h('div', { class: 'wrap' },
      (() => {
        const coverImage = h('img', { alt: albumName || '封面', fetchpriority: 'high' });
        const coverHost = h('div', { class: 'cover' }, coverImage);
        installImageRetry(coverImage, coverSrc, { maxRetries: 2 });
        return coverHost;
      })(),
      h('div', { class: 'info' },
        h('div', { class: 'hero-kicker' }, category || '漫画详情'),
        h('h1', null, albumName),
        authors.length ? h('div', { class: 'meta' }, '作者：', authors.join(' / ')) : null,
        h('div', { class: 'meta', style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' },
          h('span', null, `JM${id}`),
          h('button', {
            class: 'chip', type: 'button', title: '复制 JM 号',
            onclick: async () => {
              try { await copyText(`JM${id}`); toast(`已复制 JM${id}`); }
              catch (e) { toast(e.message); }
            },
          }, '复制 JM 号')),
        h('div', { class: 'stats' },
          h('span', null, icon('eye', 14), fmt(data.total_views), ' 阅读'),
          h('span', null, icon('heart', 14), fmt(data.likes), ' 爱心'),
          h('span', null, icon('message-square', 14), fmt(data.comment_total), ' 评论'),
        ),
      ),
    ),
  );

  const body = h('div', { class: 'album-body' });

  // 操作按钮
  const likeBtn = h('button', { class: 'btn like', onclick: onLike });
  const favBtn = h('button', { class: 'btn fav', onclick: onFav });
  function renderLikeBtn() {
    likeBtn.classList.toggle('on', !!data.liked);
    likeBtn.replaceChildren(icon('heart', 16), `爱心 (${fmt(data.likes)})`);
  }
  function renderFavBtn() {
    favBtn.classList.toggle('on', !!data.is_favorite);
    favBtn.replaceChildren(icon('star', 16), data.is_favorite ? '已收藏' : '收藏');
  }
  renderLikeBtn();
  renderFavBtn();
  const readBtn = h('button', {
    class: 'btn primary',
    onclick: () => {
      const first = series.length ? series[0] : null;
      const photoId = /^\d+$/.test(String(first && first.id || '')) ? first.id : id;
      location.hash = `#/read/${photoId}?aid=${id}`;
    },
  }, icon('play', 15), '开始阅读');
  const downloadBtn = h('button', {
    class: 'btn',
    onclick: async () => {
      if (downloadBtn.disabled) return;
      downloadBtn.disabled = true;
      downloadBtn.textContent = '正在创建缓存任务…';
      try {
        const { queueAlbumDownload } = await import('./downloads.js');
        await queueAlbumDownload(id, { album: data, shunt: setting.shunt, concurrency: 3 });
        toast('已加入离线下载队列');
        location.hash = '#/downloads';
      } catch (error) {
        toast(error.message || '创建下载任务失败');
      } finally {
        if (downloadBtn.isConnected) {
          downloadBtn.disabled = false;
          downloadBtn.replaceChildren(icon('inbox', 16), '离线缓存');
        }
      }
    },
  }, icon('inbox', 16), '离线缓存');

  // 本地历史：继续阅读
  const localRec = getLocalHistory().find((it) => String(it.aid) === String(id));
  if (localRec && localRec.photoId && (localRec.photoId !== String(id) || localRec.page > 0)) {
    body.append(h('button', {
      class: 'btn block', style: 'margin-bottom:10px',
      onclick: () => { location.hash = `#/read/${localRec.photoId}?aid=${id}`; },
    }, icon('history', 16), `继续阅读：${localRec.name || ''} 第 ${Number(localRec.page || 0) + 1} 页`));
  }

  body.append(h('div', { class: 'action-bar' }, readBtn, downloadBtn, favBtn, likeBtn));

  // 简介
  if (description) {
    const desc = h('div', { class: 'desc clamp' }, description);
    let expanded = false;
    const toggle = h('div', {
      class: 'desc-toggle', role: 'button', tabindex: '0',
      onclick: () => {
        expanded = !expanded;
        desc.classList.toggle('clamp', !expanded);
        toggle.textContent = expanded ? '收起' : '展开全部';
      },
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle.click(); } },
    }, '展开全部');
    body.append(h('div', { class: 'section-title', style: 'margin-top:16px' }, '简介'), desc, toggle);
  }

  // 标签
  if (tags.length) {
    const tagLine = h('div', { class: 'tag-line' });
    tags.forEach((t) => tagLine.append(h('a', {
      class: 'tag',
      href: `#/search?q=${encodeURIComponent(t)}&o=mr`,
    }, t)));
    body.append(h('div', { class: 'section-title', style: 'margin-top:16px' }, '标签'), tagLine);
  }

  // 章节
  const seriesId = safeText(data.series_id);
  if (series.length > 1 || (seriesId && seriesId !== '0')) {
    const selectable = series.filter((chapter) => /^\d+$/.test(String((chapter && chapter.id) || '')));
    const selected = new Set();
    const selectionText = h('span', { class: 'hint chapter-selection-count', 'aria-live': 'polite' }, '未选择章节');
    const queueSelected = h('button', { class: 'btn', disabled: true }, icon('inbox', 15), '下载所选');
    const checkboxes = [];
    const refreshSelection = () => {
      selectionText.textContent = selected.size ? `已选择 ${selected.size} / ${selectable.length} 章` : '未选择章节';
      queueSelected.disabled = selected.size === 0;
    };
    queueSelected.onclick = async () => {
      if (!selected.size || queueSelected.disabled) return;
      queueSelected.disabled = true;
      try {
        const { queueAlbumDownload } = await import('./downloads.js');
        await queueAlbumDownload(id, {
          album: data,
          chapterIds: [...selected],
          shunt: setting.shunt,
          concurrency: 3,
        });
        toast(`已将 ${selected.size} 章加入离线下载队列`);
        location.hash = '#/downloads';
      } catch (error) {
        toast(error.message || '创建章节下载任务失败');
      } finally {
        if (queueSelected.isConnected) refreshSelection();
      }
    };
    const selectAll = h('button', { class: 'btn ghost', type: 'button', onclick: () => {
      const allSelected = selected.size === selectable.length;
      selected.clear();
      if (!allSelected) selectable.forEach((chapter) => selected.add(String(chapter.id)));
      checkboxes.forEach((input) => { input.checked = selected.has(input.value); });
      refreshSelection();
    } }, '全选 / 取消');
    body.append(
      h('div', { class: 'section-title chapter-section-title', style: 'margin-top:16px' },
        h('span', null, `章节 (${series.length})`),
        h('div', { class: 'chapter-download-tools' }, selectionText, selectAll, queueSelected)),
    );
    const chapterList = h('div', { class: 'chapter-list' });
    series.forEach((s, i) => {
      const chapterId = String((s && s.id) || '');
      if (!/^\d+$/.test(chapterId)) {
        chapterList.append(h('span', { class: 'chapter-item', 'aria-disabled': 'true' }, chapterName(s, i)));
        return;
      }
      const checkbox = h('input', {
        type: 'checkbox', value: chapterId,
        'aria-label': `选择下载 ${chapterName(s, i)}`,
        onchange: () => {
          if (checkbox.checked) selected.add(chapterId); else selected.delete(chapterId);
          refreshSelection();
        },
      });
      checkboxes.push(checkbox);
      chapterList.append(h('div', { class: 'chapter-download-row' },
        h('a', { class: 'chapter-item', href: `#/read/${chapterId}?aid=${id}` }, chapterName(s, i)),
        h('label', { class: 'chapter-download-check', title: '选择离线下载' }, checkbox, h('span', null, '下载'))));
    });
    body.append(chapterList);
  }

  // 相关推荐
  if (relatedList.length) {
    body.append(h('div', { class: 'section-title', style: 'margin-top:16px' }, '相关推荐'));
    const strip = h('div', { class: 'hscroll' });
    relatedList.forEach((it) => strip.append(comicCard(it)));
    body.append(strip);
  }

  // 评论
  body.append(h('div', { class: 'section-title', style: 'margin-top:16px' }, `评论 (${fmt(data.comment_total)})`));
  const composerWrap = h('div', { class: 'comment-composer' });
  const commentWrap = h('div');
  body.append(composerWrap, commentWrap);
  const commentsCtl = buildComments(commentWrap, id, ctx);
  buildComposer(composerWrap, id, () => commentsCtl.reload(), ctx);

  page.append(hero, body);
  page.querySelector('.spinner')?.closest('.empty')?.remove();

  async function onLike() {
    if (likeBtn.disabled) return;
    likeBtn.disabled = true;
    likeBtn.setAttribute('aria-busy', 'true');
    try {
      const res = await api.like(id);
      if (isInactive(ctx)) return;
      const d = res.data || {};
      data.liked = d.liked ?? !data.liked;
      if (typeof d.total_likes === 'number') data.likes = d.total_likes;
      renderLikeBtn();
      toast(data.liked ? '已点赞' : '已取消点赞');
    } catch (e) {
      if (!isInactive(ctx) && !isAbort(e)) toast(e.message);
    } finally {
      if (!isInactive(ctx)) {
        likeBtn.disabled = false;
        likeBtn.removeAttribute('aria-busy');
      }
    }
  }

  async function onFav() {
    if (favBtn.disabled) return;
    favBtn.disabled = true;
    favBtn.setAttribute('aria-busy', 'true');
    try {
      let selectedFolder = ['0', '默认收藏夹'];
      if (!data.is_favorite) {
        try {
          const favoritePage = await api.favorites('mr', 1, 0, ctx && ctx.signal);
          if (isInactive(ctx)) return;
          const entries = folderEntries(favoritePage.data?.folder_list);
          if (entries.length > 1) {
            const choice = await chooseFolder(entries, '收藏到…');
            if (!choice || isInactive(ctx)) return;
            selectedFolder = choice;
          }
        } catch (e) {
          if (isAbort(e)) throw e;
          // 老后端没有收藏夹元数据时仍可收藏到默认目录。
        }
      }
      const res = await api.favorite(id);
      if (isInactive(ctx)) return;
      const d = res.data || {};
      data.is_favorite = d.is_favorite ?? !data.is_favorite;
      renderFavBtn();
      if (data.is_favorite && selectedFolder[0] !== '0') {
        await api.favoriteFolder('move', selectedFolder[0], '', id);
        if (isInactive(ctx)) return;
      }
      toast(data.is_favorite && selectedFolder[0] !== '0'
        ? `已收藏到 ${selectedFolder[1]}`
        : (d.msg || (data.is_favorite ? '收藏成功' : '已取消收藏')));
    } catch (e) {
      if (!isInactive(ctx) && !isAbort(e)) toast(e.message);
    } finally {
      if (!isInactive(ctx)) {
        favBtn.disabled = false;
        favBtn.removeAttribute('aria-busy');
      }
    }
  }
}

function chapterName(chapter, index) {
  const name = String((chapter && chapter.name) || '').trim();
  if (name) return name;
  const sort = Number(chapter && chapter.sort);
  return `第 ${Number.isFinite(sort) && sort > 0 ? sort : index + 1} 章`;
}

/** 评论发表框（登录后可见；未登录提示去登录） */
function buildComposer(wrap, aid, reload, ctx) {
  api.me(ctx && ctx.signal).then((me) => {
    if (isInactive(ctx)) return;
    if (!me.user) {
      wrap.append(h('div', { class: 'card', style: 'padding:14px;text-align:center;color:var(--text-2);font-size:13.5px' },
        '登录后即可发表评论 ', h('a', { href: '#/user', style: 'color:var(--primary)' }, '去登录 ›')));
      return;
    }
    const ta = h('textarea', { class: 'input', rows: 3, placeholder: '发表评论…（支持换行）' });
    const spoiler = h('input', { type: 'checkbox', id: 'spoiler-chk' });
    const btn = h('button', { class: 'btn primary', type: 'submit' }, '发表');
    const form = h('form', {
      class: 'card', style: 'padding:14px',
      onsubmit: async (e) => {
        e.preventDefault();
        const content = ta.value.trim();
        if (!content) return toast('请输入评论内容');
        btn.disabled = true;
        btn.textContent = '发表中…';
        try {
          await api.comment(aid, content, spoiler.checked ? '1' : '0');
          if (isInactive(ctx)) return;
          toast('评论已发表');
          ta.value = '';
          reload();
        } catch (err) {
          if (!isInactive(ctx) && !isAbort(err)) toast(err.message);
        } finally {
          if (!isInactive(ctx)) {
            btn.disabled = false;
            btn.textContent = '发表';
          }
        }
      },
    },
      ta,
      h('div', { style: 'display:flex;align-items:center;gap:10px;margin-top:10px' },
        h('label', { for: 'spoiler-chk', style: 'display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-2);cursor:pointer;flex:1' },
          spoiler, '标记为剧透（默认折叠）'),
        btn),
    );
    wrap.append(form);
  }).catch((e) => { if (!isAbort(e)) { /* 查询登录态失败时静默隐藏发表框 */ } });
}

function buildComments(wrap, aid, ctx) {
  const listWrap = h('div');
  const pagerWrap = h('div');
  wrap.append(listWrap, pagerWrap);
  let loadSeq = 0;

  const load = async (p) => {
    const seq = ++loadSeq;
    listWrap.replaceChildren(loadingBox());
    pagerWrap.replaceChildren();
    try {
      const res = await api.comments(aid, p, ctx && ctx.signal);
      if (isInactive(ctx) || seq !== loadSeq) return;
      const d = res.data || {};
      const list = d.list || [];
      if (!list.length) {
        listWrap.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'big' }, icon('message-square', 40)), '还没有评论'));
        return;
      }
      listWrap.replaceChildren(...list.map((comment) => commentItem(comment, {
        aid, reload: () => load(p), ctx, depth: 0,
      })));
      const pages = Math.ceil(Number(d.total) / 20);
      if (pages > 1) {
        const { pager } = await import('./ui.js');
        if (isInactive(ctx) || seq !== loadSeq) return;
        pagerWrap.append(pager({ page: p, total: pages, onChange: (np) => { load(np); listWrap.scrollIntoView({ block: 'start', behavior: 'smooth' }); } }));
      }
    } catch (e) {
      if (isInactive(ctx) || isAbort(e) || seq !== loadSeq) return;
      listWrap.replaceChildren(errorBox(e.message, () => load(p)));
    }
  };
  load(1);
  return { reload: () => load(1) };
}

function commentItem(c, options = {}) {
  const { aid = '', reload = () => {}, ctx, depth = 0 } = options;
  const content = h('div', { class: 'content' + (c.spoiler === '1' || c.spoiler === 1 ? ' spoiler' : '') }, c.content || '');
  if (content.classList.contains('spoiler')) {
    const reveal = () => {
      content.classList.remove('spoiler');
      content.removeAttribute('role');
      content.removeAttribute('tabindex');
      content.setAttribute('aria-expanded', 'true');
    };
    content.setAttribute('role', 'button');
    content.setAttribute('tabindex', '0');
    content.setAttribute('aria-label', '显示剧透内容');
    content.setAttribute('aria-expanded', 'false');
    content.addEventListener('click', reveal);
    content.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); reveal(); } });
    content.title = '点击显示剧透内容';
  }
  const avatarSrc = c.photo
    ? (/^https?:/i.test(c.photo) ? `/api/img?u=${encodeURIComponent(c.photo)}` : `/api/img?path=${encodeURIComponent(c.photo.startsWith('/') ? c.photo : '/' + c.photo)}`)
    : '';
  const cid = String(c.CID ?? c.cid ?? c.id ?? '');
  let likeCount = Number(c.likes) || 0;
  let voted = false;
  const likeBtn = h('button', {
    type: 'button', class: 'more',
    style: 'border:0;background:none;color:inherit;padding:2px 4px;display:inline-flex;align-items:center;gap:4px;cursor:pointer',
    disabled: !cid,
    onclick: async () => {
      if (!cid || voted || likeBtn.disabled) return;
      likeBtn.disabled = true;
      try {
        await api.commentVote(cid, 'up');
        if (isInactive(ctx)) return;
        voted = true;
        likeCount += 1;
        likeBtn.replaceChildren(icon('thumbs-up', 13), String(likeCount));
        likeBtn.classList.add('active');
        toast('评论点赞成功');
      } catch (e) {
        if (!isInactive(ctx) && !isAbort(e)) toast(e.message);
        if (!voted) likeBtn.disabled = false;
      }
    },
  }, icon('thumbs-up', 13), String(likeCount));
  const replyHost = h('div');
  const replyBtn = h('button', {
    type: 'button', class: 'more',
    style: 'border:0;background:none;color:inherit;padding:2px 4px;cursor:pointer',
    disabled: !cid || !aid,
    onclick: () => toggleReplyComposer(replyHost, { aid, cid, nickname: c.nickname || c.username, reload, ctx }),
  }, '回复');
  const replies = c.replys || c.replies || c.children || [];
  const body = h('div', { class: 'body' },
    h('div', { class: 'head' },
      h('span', { class: 'name' }, c.nickname || c.username || '匿名'),
      h('span', { class: 'time' }, fmtTime(c.addtime)),
    ),
    content,
    h('div', { class: 'foot' }, likeBtn, replyBtn),
    replyHost,
  );
  if (replies.length && depth < 4) {
    const repliesWrap = h('div', {
      style: 'margin-top:7px;margin-left:2px;padding-left:10px;border-left:2px solid var(--line)',
    });
    replies.forEach((reply) => repliesWrap.append(commentItem(reply, {
      aid, reload, ctx, depth: depth + 1,
    })));
    body.append(repliesWrap);
  }
  const el = h('div', {
    class: 'comment-item',
    ...(depth ? { style: 'padding-top:10px;padding-bottom:10px' } : {}),
  },
    h('div', { class: 'avatar' }, avatarSrc ? h('img', { loading: 'lazy', src: avatarSrc, alt: '' }) : (c.nickname || c.username || '友').slice(0, 1)),
    body,
  );
  return el;
}

function toggleReplyComposer(host, { aid, cid, nickname, reload, ctx }) {
  if (host.childElementCount) {
    host.replaceChildren();
    return;
  }
  const ta = h('textarea', {
    class: 'input', rows: 2, maxlength: '1000',
    placeholder: `回复 ${nickname || '这条评论'}…`,
  });
  const spoiler = h('input', { type: 'checkbox' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, '发送回复');
  const form = h('form', {
    class: 'card', style: 'padding:10px;margin-top:8px',
    onsubmit: async (e) => {
      e.preventDefault();
      const value = ta.value.trim();
      if (!value) return toast('请输入回复内容');
      submit.disabled = true;
      submit.textContent = '发送中…';
      try {
        await api.comment(aid, value, spoiler.checked ? '1' : '0', cid);
        if (isInactive(ctx)) return;
        toast('回复已发表');
        host.replaceChildren();
        reload();
      } catch (err) {
        if (!isInactive(ctx) && !isAbort(err)) toast(err.message);
      } finally {
        if (!isInactive(ctx)) {
          submit.disabled = false;
          submit.textContent = '发送回复';
        }
      }
    },
  },
    ta,
    h('div', { style: 'display:flex;align-items:center;gap:8px;margin-top:8px' },
      h('label', { style: 'display:flex;align-items:center;gap:5px;font-size:12px;color:var(--text-2);flex:1' }, spoiler, '剧透'),
      h('button', { class: 'btn', type: 'button', onclick: () => host.replaceChildren() }, '取消'),
      submit,
    ),
  );
  host.append(form);
  ta.focus();
}

export function fmt(n) {
  n = Number(n) || 0;
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n);
}

export function fmtTime(t) {
  if (!t) return '';
  const raw = String(t).trim();
  let d;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
    const value = Number(raw);
    // 上游偶尔返回秒级时间戳；本地阅读记录使用 Date.now() 的毫秒值。
    d = new Date(Math.abs(value) < 1e12 ? value * 1000 : value);
  } else {
    d = new Date(raw.replace(/-/g, '/'));
  }
  if (Number.isNaN(d.getTime())) return String(t);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 0) return d.toLocaleDateString('zh-CN');
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return d.toLocaleDateString('zh-CN');
}
