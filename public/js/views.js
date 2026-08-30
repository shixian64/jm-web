// 浏览类页面：首页 / 搜索 / 分类 / 每周必看 / 漫画详情
import { api, imgSrc } from './api.js';
import { h, toast, comicCard, infiniteList, errorBox, loadingBox } from './ui.js';
import { getLocalHistory, getSearchHistory, addSearchHistory, clearSearchHistory } from './store.js';
import { icon } from './icons.js';

function isAbort(e) { return !!(e && e.name === 'AbortError'); }
function isInactive(ctx) {
  return !!(ctx && (ctx.signal?.aborted || (typeof ctx.isActive === 'function' && !ctx.isActive())));
}

/* ============================== 首页 ============================== */

const promoteFallback = new Map();

export function homeView(root, ctx) {
  const cleanups = [];
  let destroyed = false;
  let loadSeq = 0;
  const clearEffects = () => {
    for (const fn of cleanups.splice(0)) fn();
  };
  const dispose = () => {
    if (destroyed) return;
    destroyed = true;
    loadSeq++;
    clearEffects();
  };
  const page = h('div', { class: 'page' });

  const buildContinueStrip = () => {
    const strip = h('div', { class: 'hscroll' });
    for (const it of getLocalHistory().slice(0, 6)) {
      const photoId = it.photoId || it.aid;
      if (!/^\d+$/.test(String(photoId || '')) || !/^\d+$/.test(String(it.aid || ''))) continue;
      strip.append(h('div', {
        class: 'comic-card',
        role: 'button',
        tabindex: '0',
        'aria-label': `继续阅读${it.name || '漫画'}`,
        onclick: () => { location.hash = `#/read/${photoId}?aid=${it.aid}`; },
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); location.hash = `#/read/${photoId}?aid=${it.aid}`; } },
      },
        h('div', { class: 'cover' }, h('img', { loading: 'lazy', src: it.cover || `/api/img?path=${encodeURIComponent(`/media/albums/${it.aid}_3x4.jpg`)}` })),
        h('div', { class: 'name' }, it.name || `漫画 ${it.aid}`),
      ));
    }
    return strip;
  };

  const showLoading = () => {
    page.replaceChildren();
    if (getLocalHistory().length) {
      page.append(h('div', { class: 'section-title' }, '继续阅读'), buildContinueStrip());
    }
    page.append(loadingBox());
  };

  async function loadHome() {
    const seq = ++loadSeq;
    clearEffects();
    showLoading();
    try {
      const res = await api.home(ctx && ctx.signal);
      if (destroyed || isInactive(ctx) || seq !== loadSeq) return;
      const blocks = (res.data || []).filter((b) => b.content && b.content.length);
      page.replaceChildren();

      if (getLocalHistory().length) {
        page.append(h('div', { class: 'section-title' }, '继续阅读'), buildContinueStrip());
      }

      // 快捷入口
      page.append(h('div', { class: 'entries' },
        entry('search', '搜索', '#/search'),
        entry('layout-grid', '分类', '#/category'),
        entry('calendar-days', '每周必看', '#/week'),
        entry('star', '收藏', '#/favorites'),
        entry('history', '阅读历史', '#/watch-history'),
        entry('smartphone', '本地记录', '#/local-history'),
      ));

      blocks.forEach((block, bi) => {
        const isSwiper = bi === 0 && block.content.length > 2 && block.type !== 'record';
        if (isSwiper) {
          page.append(h('div', { class: 'section-title' }, block.title || '推荐'));
          page.append(buildSwiper(block.content, cleanups));
        } else {
          page.append(h('div', { class: 'section-title' },
            block.title || '推荐',
            h('a', { class: 'more', role: 'button', tabindex: '0', onclick: () => gotoBlockFilter(block), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); gotoBlockFilter(block); } } }, '更多 ›'),
          ));
          const strip = h('div', { class: 'hscroll' });
          block.content.forEach((it) => strip.append(comicCard(it)));
          page.append(strip);
        }
      });
    } catch (e) {
      if (destroyed || isInactive(ctx) || isAbort(e) || seq !== loadSeq) return;
      clearEffects();
      page.replaceChildren(errorBox(e.message, loadHome));
    }
  }

  root.append(page);
  loadHome();

  // 离开首页时清理轮播定时器，避免在已脱离 DOM 的节点上空转
  return dispose;
}

function entry(ic, label, href) {
  return h('a', { href }, h('span', { class: 'ic' }, icon(ic, 22)), label);
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

function buildSwiper(items, cleanups = []) {
  const swiper = h('div', { class: 'swiper' });
  const slides = items.slice(0, 6).map((it, i) => {
    const id = String((it && (it.id ?? it.aid)) || '');
    const canOpen = /^\d+$/.test(id);
    const open = () => { if (canOpen) location.hash = `#/album/${id}`; };
    const s = h('div', {
      class: 'slide' + (i === 0 ? ' on' : ''),
      style: { backgroundImage: `url("${imgSrc(it)}")` },
      ...(canOpen ? {
        role: 'button', tabindex: '0', 'aria-label': `查看${it.name || '漫画'}详情`,
        onclick: open,
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } },
      } : { 'aria-disabled': 'true' }),
    }, h('div', { class: 'label' }, (it && it.name) || ''));
    return s;
  });
  const dots = h('div', { class: 'dots' }, slides.map((_, i) => h('i', { class: i === 0 ? 'on' : '' })));
  swiper.append(...slides, dots);
  let cur = 0;
  const timer = setInterval(() => {
    slides[cur].classList.remove('on');
    dots.children[cur].classList.remove('on');
    cur = (cur + 1) % slides.length;
    slides[cur].classList.add('on');
    dots.children[cur].classList.add('on');
  }, 4000);
  cleanups.push(() => clearInterval(timer));
  return swiper;
}

/* ============================== 搜索 ============================== */

const ORDERS = [
  ['mr', '最新'], ['mv', '最多收藏'], ['mp', '最多图片'], ['tf', '最多爱心'],
];

export function searchView(root, params) {
  const q = params.get('q') || '';
  const o = params.get('o') || 'mr';
  const page = h('div', { class: 'page' });

  if (!q) {
    const renderLanding = () => {
      page.replaceChildren(buildSearchBar('', (v) => { if (v) location.hash = `#/search?q=${encodeURIComponent(v)}&o=mr`; }));
      const hist = getSearchHistory();
      if (!hist.length) return;
      const clear = () => { clearSearchHistory(); renderLanding(); };
      page.append(h('div', { class: 'section-title' },
        '搜索历史',
        h('button', { class: 'more', type: 'button', style: 'border:0;background:none;padding:0;cursor:pointer', onclick: clear }, '清空')));
      const tags = h('div', { class: 'history-tags' });
      hist.forEach((t) => tags.append(h('a', { class: 'chip', href: `#/search?q=${encodeURIComponent(t)}&o=mr` }, t)));
      page.append(tags);
    };
    root.append(page);
    renderLanding();
    return;
  }

  addSearchHistory(q);
  page.append(buildSearchBar(q, (v) => { location.hash = `#/search?q=${encodeURIComponent(v)}&o=${o}`; }));
  const chips = h('div', { class: 'chips' },
    ORDERS.map(([val, label]) =>
      h('a', { class: 'chip' + (val === o ? ' active' : ''), href: `#/search?q=${encodeURIComponent(q)}&o=${val}` }, label)));
  page.append(chips);
  page.append(h('div', { class: 'result-count' }, `“${q}” 的搜索结果`));
  root.append(page);

  const list = infiniteList(async (p, signal) => {
    const res = await api.search(q, o, p, signal);
    const data = res.data || {};
    if (data.redirect_aid && p === 1) {
      // 搜索数字 ID 时上游直接指向漫画
      location.hash = `#/album/${data.redirect_aid}`;
      return { items: [], hasMore: false };
    }
    return {
      items: (data.content || []).map(comicCard),
      hasMore: (data.content || []).length >= 20,
    };
  });
  page.append(list.root);
  return list.destroy;
}

function buildSearchBar(value, onSubmit) {
  const input = h('input', { class: 'input', placeholder: '搜索漫画 / 作者 / 标签 / ID', value });
  const form = h('form', { class: 'search-form', onsubmit: (e) => { e.preventDefault(); onSubmit(input.value.trim()); } },
    input,
    h('button', { class: 'btn primary', type: 'submit' }, '搜索'));
  return h('div', { class: 'search-bar' }, form);
}

/* ============================== 分类 ============================== */

export async function categoryView(root, ctx) {
  const page = h('div', { class: 'page' });
  page.append(loadingBox());
  root.append(page);
  try {
    const res = await api.categories(ctx && ctx.signal);
    if (isInactive(ctx)) return;
    const data = res.data || {};
    page.replaceChildren();

    page.append(h('div', { class: 'list-head' }, h('h2', null, '分类浏览')));

    const cats = data.categories || [];
    if (cats.length) {
      page.append(h('div', { class: 'section-title' }, '主分类'));
      const chips = h('div', { class: 'chips' });
      cats.forEach((c) => {
        if (c.type === 'slug' || String(c.id) === '0') {
          chips.append(h('a', { class: 'chip', href: `#/category/list?c=${encodeURIComponent(c.slug)}&o=mr` }, c.name));
        } else {
          chips.append(h('a', { class: 'chip', href: `#/search?q=${encodeURIComponent(c.name)}&o=mr` }, c.name));
        }
      });
      page.append(chips);
    }

    const tagList = (data.blocks || []).flatMap((b) => b.content || []);
    if (tagList.length) {
      page.append(h('div', { class: 'section-title' }, '热门标签'));
      const chips = h('div', { class: 'chips', style: 'flex-wrap:wrap' });
      tagList.forEach((t) => chips.append(h('a', { class: 'chip', href: `#/search?q=${encodeURIComponent(t)}&o=mr` }, t)));
      page.append(chips);
    }
  } catch (e) {
    if (isInactive(ctx) || isAbort(e)) return;
    page.replaceChildren(errorBox(e.message));
  }
}

export function categoryListView(root, params) {
  const c = params.get('c') || '';
  const o = params.get('o') || 'mr';
  const title = params.get('title') || '';
  const page = h('div', { class: 'page' });

  if (title) page.append(h('div', { class: 'list-head' }, h('h2', null, title)));
  const chips = h('div', { class: 'chips' },
    ORDERS.map(([val, label]) =>
      h('a', { class: 'chip' + (val === o ? ' active' : ''), href: `#/category/list?c=${encodeURIComponent(c)}&o=${val}${title ? `&title=${encodeURIComponent(title)}` : ''}` }, label)));
  page.append(chips);
  root.append(page);

  const list = infiniteList(async (p, signal) => {
    const res = await api.categoryFilter(c, o, p, signal);
    const data = res.data || {};
    return {
      items: (data.content || []).map(comicCard),
      hasMore: (data.content || []).length >= 20,
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
  page.append(loadingBox());
  root.append(page);
  let destroyed = false;
  let loadController = null;
  let loadSeq = 0;

  const dispose = () => {
    if (destroyed) return;
    destroyed = true;
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

      page.replaceChildren(
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
        listWrap.replaceChildren(loadingBox());
        pagerWrap.replaceChildren();
        history.replaceState(null, '', `#/week?id=${encodeURIComponent(curCat)}&type=${encodeURIComponent(curType)}`);
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
      load(1);
    } catch (e) {
      if (destroyed || isInactive(ctx) || isAbort(e)) return;
      page.replaceChildren(errorBox(e.message));
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
    data = res.data;
  } catch (e) {
    if (isInactive(ctx) || isAbort(e)) return;
    page.replaceChildren(errorBox(e.message));
    return;
  }

  // 上游 author 可能为数组或字符串
  const authors = Array.isArray(data.author) ? data.author : (data.author ? [String(data.author)] : []);

  const coverSrc = imgSrc({ id, image: data.image });
  const hero = h('div', { class: 'album-hero' },
    h('div', { class: 'bg', style: { backgroundImage: `url("${coverSrc}")` } }),
    h('div', { class: 'wrap' },
      h('div', { class: 'cover' }, h('img', { src: coverSrc, alt: data.name || '封面' })),
      h('div', { class: 'info' },
        h('h1', null, data.name || `漫画 ${id}`),
        authors.length ? h('div', { class: 'meta' }, '作者：', authors.join(' / ')) : null,
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
      const chapters = data.series || [];
      const first = chapters.length ? chapters.reduce((a, b) => (Number(a.sort) <= Number(b.sort) ? a : b)) : null;
      const photoId = /^\d+$/.test(String(first && first.id || '')) ? first.id : id;
      location.hash = `#/read/${photoId}?aid=${id}`;
    },
  }, icon('play', 15), '开始阅读');

  // 本地历史：继续阅读
  const localRec = getLocalHistory().find((it) => String(it.aid) === String(id));
  if (localRec && localRec.photoId && (localRec.photoId !== String(id) || localRec.page > 0)) {
    body.append(h('button', {
      class: 'btn block', style: 'margin-bottom:10px',
      onclick: () => { location.hash = `#/read/${localRec.photoId}?aid=${id}`; },
    }, icon('history', 16), `继续阅读：${localRec.name || ''} 第 ${Number(localRec.page || 0) + 1} 页`));
  }

  body.append(h('div', { class: 'action-bar' }, readBtn, favBtn, likeBtn));

  // 简介
  if (data.description) {
    const desc = h('div', { class: 'desc clamp' }, data.description);
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
  const tags = [...(data.tags || []), ...(data.actors || []), ...(data.works || [])];
  if (tags.length) {
    const tagLine = h('div', { class: 'tag-line' });
    tags.forEach((t) => tagLine.append(h('a', {
      class: 'tag',
      href: `#/search?q=${encodeURIComponent(t)}&o=mr`,
    }, t)));
    body.append(h('div', { class: 'section-title', style: 'margin-top:16px' }, '标签'), tagLine);
  }

  // 章节
  const series = (data.series || []).slice().sort((a, b) => Number(a.sort) - Number(b.sort));
  if (series.length > 1 || (data.series_id && data.series_id !== '0')) {
    body.append(h('div', { class: 'section-title', style: 'margin-top:16px' }, `章节 (${series.length})`));
    const chapterList = h('div', { class: 'chapter-list' });
    series.forEach((s, i) => {
      const chapterId = String((s && s.id) || '');
      chapterList.append(/^\d+$/.test(chapterId)
        ? h('a', { class: 'chapter-item', href: `#/read/${chapterId}?aid=${id}` }, chapterName(s, i))
        : h('span', { class: 'chapter-item', 'aria-disabled': 'true' }, chapterName(s, i)));
    });
    body.append(chapterList);
  }

  // 相关推荐
  if (data.related_list && data.related_list.length) {
    body.append(h('div', { class: 'section-title', style: 'margin-top:16px' }, '相关推荐'));
    const strip = h('div', { class: 'hscroll' });
    data.related_list.forEach((it) => strip.append(comicCard(it)));
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
      const res = await api.favorite(id);
      if (isInactive(ctx)) return;
      const d = res.data || {};
      data.is_favorite = d.is_favorite ?? !data.is_favorite;
      renderFavBtn();
      toast(d.msg || (data.is_favorite ? '收藏成功' : '已取消收藏'));
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
      listWrap.replaceChildren(...list.map(commentItem));
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

function commentItem(c) {
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
  const el = h('div', { class: 'comment-item' },
    h('div', { class: 'avatar' }, avatarSrc ? h('img', { loading: 'lazy', src: avatarSrc, alt: '' }) : (c.nickname || c.username || '友').slice(0, 1)),
    h('div', { class: 'body' },
      h('div', { class: 'head' },
        h('span', { class: 'name' }, c.nickname || c.username || '匿名'),
        h('span', { class: 'time' }, fmtTime(c.addtime)),
      ),
      content,
      h('div', { class: 'foot' }, icon('thumbs-up', 13), c.likes || 0),
    ),
  );
  return el;
}

export function fmt(n) {
  n = Number(n) || 0;
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n);
}

export function fmtTime(t) {
  if (!t) return '';
  const d = new Date(String(t).replace(/-/g, '/'));
  if (isNaN(d)) return String(t);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return d.toLocaleDateString('zh-CN');
}
