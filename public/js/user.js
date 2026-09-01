// 用户与设置页面：登录 / 个人中心 / 签到 / 收藏 / 阅读历史 / 评论历史 / 本地记录 / 设置
import { api, imgSrc } from './api.js';
import { h, toast, comicCard, infiniteList, installPullToRefresh, errorBox, loadingBox } from './ui.js';
import {
  setting, updateSetting, getLocalHistory, clearLocalHistory, removeLocalHistory,
} from './store.js';
import { fmt, fmtTime } from './views.js';
import { icon } from './icons.js';
import { filterComics } from './content-filter.js';
import { chooseFolder, folderEntries } from './content-actions.js';

function isAbort(e) { return !!(e && e.name === 'AbortError'); }
function isInactive(ctx) {
  return !!(ctx && (ctx.signal?.aborted || (typeof ctx.isActive === 'function' && !ctx.isActive())));
}

/* ============================== 我的 / 登录 ============================== */

export function userView(root, ctx) {
  const page = h('div', { class: 'page user-page' });
  const content = h('div');
  page.append(content);
  root.append(page);
  let destroyed = false;
  let loadSeq = 0;
  let loadController = null;

  const load = async () => {
    const seq = ++loadSeq;
    loadController?.abort();
    const controller = new AbortController();
    loadController = controller;
    content.replaceChildren(profileSkeleton());
    try {
      const me = (await api.me(controller.signal)).user;
      if (destroyed || isInactive(ctx) || controller.signal.aborted || seq !== loadSeq) return;
      if (!me) renderLogin(content, ctx, load);
      else renderProfile(content, me, ctx, load);
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

function profileSkeleton() {
  const menuRows = Array.from({ length: 6 }, () => h('div', { 'aria-hidden': 'true' },
    h('div', { class: 'skeleton-line wide', style: 'width:58%;height:13px;margin:20px 16px' })));
  return h('div', { role: 'status', 'aria-label': '正在加载用户信息' },
    h('div', { class: 'card profile-card' },
      h('div', { class: 'profile-head' },
        h('div', { class: 'avatar skeleton-block', 'aria-hidden': 'true' }),
        h('div', { style: 'flex:1;min-width:0' },
          h('div', { class: 'skeleton-line wide' }),
          h('div', { class: 'skeleton-line short' }),
          h('div', { class: 'skeleton-line wide' })))),
    h('div', { class: 'stat-row' }, [1, 2, 3].map(() => h('div', { class: 'cell', 'aria-hidden': 'true' },
      h('div', { class: 'skeleton-line wide', style: 'margin:6px auto' }),
      h('div', { class: 'skeleton-line short', style: 'margin:8px auto 2px' })))),
    h('div', { class: 'menu-list' }, menuRows));
}

function renderLogin(page, ctx, reload) {
  const username = h('input', { class: 'input', placeholder: '用户名', autocomplete: 'username' });
  const password = h('input', { class: 'input', placeholder: '密码', type: 'password', autocomplete: 'current-password' });
  const submit = h('button', { class: 'btn primary block', type: 'submit' }, '登 录');

  const form = h('form', {
    class: 'card login-panel', style: 'max-width:380px;margin:8vh auto 0;padding:26px',
    onsubmit: async (e) => {
      e.preventDefault();
      if (!username.value.trim() || !password.value) return toast('请输入用户名和密码');
      submit.disabled = true;
      submit.textContent = '登录中…';
      try {
        await api.login(username.value.trim(), password.value);
        if (isInactive(ctx)) return;
        toast('登录成功');
        window.dispatchEvent(new CustomEvent('jmw-auth-changed'));
        await reload();
      } catch (err) {
        if (!isInactive(ctx) && !isAbort(err)) toast(err.message);
      } finally {
        if (!isInactive(ctx) && submit.isConnected) {
          submit.disabled = false;
          submit.textContent = '登 录';
        }
      }
    },
  },
    h('h2', { style: 'text-align:center;margin:4px 0 20px' }, '登录 JM 账号'),
    h('div', { class: 'field' }, h('label', null, '用户名'), username),
    h('div', { class: 'field' }, h('label', null, '密码'), password),
    submit,
    h('p', { style: 'font-size:12px;color:var(--text-2);text-align:center;margin-top:14px' },
      '使用 JM 官网账号登录，登录后可使用收藏、评论、签到等功能'),
  );

  page.replaceChildren(
    h('div', { class: 'empty login-intro', style: 'padding-top:8vh' },
      h('div', { class: 'big' }, icon('lock', 40)),
      h('h1', null, '你的阅读空间'),
      h('p', null, '登录后可同步收藏与阅读记录'),
    ),
    form,
  );
}

function renderProfile(page, me, ctx, reload) {
  const avatarSrc = me.photo
    ? (/^https?:/i.test(me.photo) ? `/api/img?u=${encodeURIComponent(me.photo)}` : `/api/img?path=${encodeURIComponent(me.photo.startsWith('/') ? me.photo : '/' + me.photo)}`)
    : '';
  const avatarFallback = (me.username || '友').slice(0, 1);
  const avatar = h('div', { class: 'avatar' }, avatarFallback);
  if (avatarSrc) {
    const image = h('img', { src: avatarSrc, alt: '', onerror: () => avatar.replaceChildren(avatarFallback) });
    avatar.replaceChildren(image);
  }
  const exp = Number(me.exp) || 0;
  const next = Number(me.nextLevelExp) || 1;
  const pct = Math.min(100, Math.round((Number(me.expPercent) || (exp / next) * 100)));

  page.replaceChildren(
    h('div', { class: 'card profile-card' },
      h('div', { class: 'profile-head' },
        avatar,
        h('div', { style: 'flex:1;min-width:0' },
          h('div', { class: 'profile-kicker' }, 'JM Web 会员'),
          h('div', { class: 'name' }, me.username || `用户 ${me.uid}`),
          h('div', { class: 'sub' }, `${me.level_name || ''} Lv.${me.level || 1}`,
            h('span', { class: 'ico-t', style: 'margin-left:8px' }, icon('coins', 13), ` ${me.coin || 0} 金币`)),
          h('div', { class: 'exp-bar' }, h('i', { style: `width:${pct}%` })),
          h('div', { class: 'sub' }, `经验 ${exp} / ${next}`),
        ),
      ),
    ),
    h('div', { class: 'stat-row' },
      statCell(`${me.album_favorites ?? 0}/${me.album_favorites_max ?? 0}`, '收藏容量'),
      statCell(icon('star', 18), '我的收藏', () => { location.hash = '#/favorites'; }),
      statCell(icon('history', 18), '阅读历史', () => { location.hash = '#/watch-history'; }),
    ),
    h('div', { class: 'menu-list' },
      menuItem('calendar-days', '每日签到', '#/signin'),
      menuItem('star', '我的收藏', '#/favorites'),
      menuItem('history', '阅读历史（云端）', '#/watch-history'),
      menuItem('smartphone', '本地阅读记录', '#/local-history'),
      menuItem('message-square', '我的评论', '#/my-comments'),
      menuItem('inbox', '下载与离线缓存', '#/downloads'),
      setting.showAiEntry ? menuItem('message-square', 'AI 对话', '#/ai') : null,
      menuItem('layout-grid', '完整功能中心', '#/advanced'),
      menuItem('settings', '设置', '#/settings'),
    ),
    h('button', {
      class: 'btn block', type: 'button', style: 'margin-top:10px',
      onclick: async (event) => {
        const btn = event.currentTarget;
        btn.disabled = true;
        btn.textContent = '退出中…';
        try {
          await api.logout();
          if (isInactive(ctx)) return;
          toast('已退出登录');
          window.dispatchEvent(new CustomEvent('jmw-auth-changed'));
          renderLogin(page, ctx, reload);
        } catch (e) {
          if (!isInactive(ctx) && !isAbort(e)) toast(e.message);
        } finally {
          if (!isInactive(ctx) && btn.isConnected) {
            btn.disabled = false;
            btn.textContent = '退出登录';
          }
        }
      },
    }, '退出登录'),
  );
}

function statCell(val, label, onclick) {
  return h('div', {
    class: 'cell',
    style: onclick ? 'cursor:pointer' : '',
    ...(onclick ? {
      role: 'button', tabindex: '0', 'aria-label': label, onclick,
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onclick(); } },
    } : {}),
  }, h('b', null, val), h('span', null, label));
}

function menuItem(ic, label, href) {
  return h('a', { href }, h('span', { class: 'ic' }, icon(ic, 19)), label, h('span', { class: 'arr' }, '›'));
}

/* ============================== 签到 ============================== */

export function signinView(root, ctx) {
  const page = h('div', { class: 'page signin-page', style: 'max-width:560px' });
  const content = h('div');
  page.append(content);
  root.append(page);
  let refreshSeq = 0;
  let destroyed = false;
  let loadController = null;

  async function load() {
    const seq = ++refreshSeq;
    loadController?.abort();
    const controller = new AbortController();
    loadController = controller;
    content.replaceChildren(signinSkeleton());
    let me;
    try {
      me = (await api.me(controller.signal)).user;
      if (destroyed || isInactive(ctx) || controller.signal.aborted || seq !== refreshSeq) return;
    } catch (e) {
      if (loadController === controller) loadController = null;
      if (destroyed || isInactive(ctx) || controller.signal.aborted || isAbort(e) || seq !== refreshSeq) return;
      content.replaceChildren(errorBox(e.message, load));
      return;
    }
    if (!me) {
      if (loadController === controller) loadController = null;
      location.hash = '#/user';
      return;
    }

    let data;
    try {
      const response = await api.daily(me.uid, controller.signal);
      if (!response || !response.data || typeof response.data !== 'object' || Array.isArray(response.data)) {
        throw new Error('签到数据格式异常');
      }
      data = response.data;
      if (destroyed || isInactive(ctx) || controller.signal.aborted || seq !== refreshSeq) return;
    } catch (e) {
      if (destroyed || isInactive(ctx) || controller.signal.aborted || isAbort(e) || seq !== refreshSeq) return;
      content.replaceChildren(errorBox(e.message, load));
      return;
    } finally {
      if (loadController === controller) loadController = null;
    }

    const flat = (Array.isArray(data.record) ? data.record : []).flat()
      .filter((item) => item && typeof item === 'object' && !Array.isArray(item));
    const todayIdx = Number(data.currentProgress) || 0;
    const isTodaySigned = flat[new Date().getDate() - 1]?.signed === true;
    const grid = h('div', { class: 'sign-grid' });
    flat.forEach((d, i) => {
      grid.append(h('div', { class: 'd' + (d.signed ? ' signed' : '') + (d.bonus ? ' bonus' : '') },
        h('b', null, d.signed ? icon('check', 16) : String(i + 1)),
        h('span', null, (d.date || '').slice(5)),
      ));
    });

    const btn = h('button', {
      class: 'btn primary block', type: 'button', disabled: isTodaySigned,
      onclick: async () => {
        if (isTodaySigned) return;
        btn.disabled = true;
        btn.textContent = '签到中…';
        try {
          const res = await api.dailyCheck(me.uid, data.daily_id);
          if (isInactive(ctx)) return;
          toast((res.data && res.data.msg) || '签到成功');
          await load();
        } catch (e) {
          if (!isInactive(ctx) && !isAbort(e)) {
            toast(e.message);
            btn.disabled = false;
            btn.textContent = '立即签到';
          }
        }
      },
    }, isTodaySigned ? '今日已签到' : '立即签到');

    content.replaceChildren(
      h('div', { class: 'list-head' }, h('h2', null, '每日签到')),
      h('div', { class: 'card', style: 'padding:16px' },
        h('div', { style: 'color:var(--text-2);font-size:13px' },
          `${data.event_name || '签到活动'} · 已连续签到 ${todayIdx} 天 · 连续 3 天 +${data.three_days_coin || 0} 金币`),
        grid,
        btn,
      ),
    );
  }

  const removePullRefresh = installPullToRefresh(page, load);
  load();
  return () => {
    if (destroyed) return;
    destroyed = true;
    refreshSeq++;
    loadController?.abort();
    loadController = null;
    removePullRefresh();
  };
}

function signinSkeleton() {
  const days = Array.from({ length: 35 }, () => h('div', {
    class: 'd skeleton-block', 'aria-hidden': 'true',
  }));
  return h('div', { role: 'status', 'aria-label': '正在加载签到信息' },
    h('div', { class: 'list-head' }, h('div', { class: 'skeleton-line wide', style: 'width:110px;height:18px' })),
    h('div', { class: 'card', style: 'padding:16px' },
      h('div', { class: 'skeleton-line wide' }),
      h('div', { class: 'sign-grid' }, days),
      h('div', { class: 'skeleton-block', style: 'height:42px;border-radius:10px' })));
}

/* ============================== 收藏 ============================== */

const FAV_ORDERS = [['mr', '收藏时间'], ['mp', '更新时间']];

export function favoritesView(root, params) {
  const o = params.get('o') || 'mr';
  const folderId = params.get('folder') || params.get('folder_id') || '0';
  const page = h('div', { class: 'page collect-page' });
  const scopeText = h('span', null, '正在确认收藏同步状态…');
  const scopeHint = h('div', { class: 'favorite-sync hint' }, icon('cloud', 14), scopeText);
  const folderWrap = h('nav', { class: 'chips favorite-folders', 'aria-label': '收藏夹' });
  const localSearch = h('input', {
    class: 'favorite-search-input', type: 'search', placeholder: '搜索名称、作者或标签',
    'aria-label': '搜索收藏',
  });
  const clearSearch = h('button', {
    class: 'favorite-search-clear', type: 'button', 'aria-label': '清除搜索', hidden: true,
    onclick: () => { localSearch.value = ''; clearSearch.hidden = true; filterCards(); localSearch.focus(); },
  }, icon('x', 15));
  const searchBox = h('label', { class: 'favorite-search' }, icon('search', 17), localSearch, clearSearch);
  const filterPanel = h('section', { class: 'favorite-filter-panel', hidden: true, 'aria-label': '高级筛选' });
  const filterToggle = h('button', {
    class: 'btn favorite-filter-toggle', type: 'button', 'aria-expanded': 'false',
    onclick: () => {
      const expanded = filterToggle.getAttribute('aria-expanded') !== 'true';
      filterToggle.setAttribute('aria-expanded', String(expanded));
      filterPanel.hidden = !expanded;
      filterToggle.classList.toggle('active', expanded);
    },
  }, icon('filter', 16), h('span', null, '筛选'), icon('chevron-down', 14));
  const manageBar = h('div', { class: 'favorite-manage' });
  const selectionBar = h('div', { class: 'favorite-selection-bar', role: 'status', 'aria-live': 'polite', hidden: true });
  const libraryMeta = h('span', { class: 'favorite-library-meta' }, '正在加载收藏…');
  const filterEmpty = h('div', { class: 'favorite-filter-empty', hidden: true },
    icon('search', 24), h('strong', null, '没有匹配的收藏'), h('span', null, '换个关键词或重置筛选条件试试'));
  const selected = new Set();
  const cards = new Map();
  const selectedTags = new Set();
  const selectedAuthors = new Set();
  const tagCounts = new Map();
  const authorCounts = new Map();
  let filterLogic = 'and';
  let list;
  let facetRenderQueued = false;
  let folders = [['0', '全部']];
  let sessionFolderIds = new Set();

  const orderSwitch = h('div', { class: 'favorite-order', role: 'group', 'aria-label': '收藏排序' },
    FAV_ORDERS.map(([v, l]) => h('a', {
      class: v === o ? 'active' : '', href: `#/favorites?o=${v}&folder=${encodeURIComponent(folderId)}`,
      'aria-current': v === o ? 'page' : null,
    }, l)));
  page.append(
    h('header', { class: 'favorite-header' },
      h('div', { class: 'favorite-title-block' },
        h('div', { class: 'favorite-kicker' }, icon('star', 13), '个人资料库'),
        h('h1', null, '我的收藏'),
        h('p', null, '整理想看的作品，快速回到下一次阅读。')),
      h('div', { class: 'favorite-header-mark', 'aria-hidden': 'true' }, icon('star', 30))),
    h('section', { class: 'favorite-workbench', 'aria-label': '收藏管理' },
      h('div', { class: 'favorite-folder-row' },
        h('div', { class: 'favorite-section-label' }, icon('folder', 15), h('span', null, '收藏夹')),
        folderWrap,
        manageBar),
      scopeHint,
      h('div', { class: 'favorite-toolbar' }, searchBox, orderSwitch, filterToggle),
      filterPanel),
    selectionBar,
    h('div', { class: 'favorite-library-head' },
      h('div', null, h('h2', null, '全部作品'), libraryMeta),
      h('button', {
        class: 'favorite-select-visible', type: 'button',
        onclick: () => {
          const visibleCards = [...cards.values()].filter((card) => !card.hidden);
          const shouldSelect = visibleCards.some((card) => !selected.has(card.dataset.favoriteId));
          visibleCards.forEach((card) => {
            const id = card.dataset.favoriteId;
            const box = card.querySelector('input[data-select]');
            if (!id || !box) return;
            box.checked = shouldSelect;
            card.classList.toggle('is-selected', shouldSelect);
            if (shouldSelect) selected.add(id); else selected.delete(id);
          });
          updateSelectionBar();
        },
      }, icon('check-square', 15), '选择当前'),
    ),
    filterEmpty,
  );
  root.append(page);

  function refreshRoute(nextFolder = folderId) {
    location.hash = `#/favorites?o=${encodeURIComponent(o)}&folder=${encodeURIComponent(nextFolder)}&_r=${Date.now()}`;
  }

  function renderFolders() {
    folderWrap.replaceChildren(...folders.map(([id, name]) => h('a', {
      class: 'chip' + (String(id) === String(folderId) ? ' active' : ''),
      href: `#/favorites?o=${encodeURIComponent(o)}&folder=${encodeURIComponent(id)}`,
      'aria-current': String(id) === String(folderId) ? 'page' : null,
    }, sessionFolderIds.has(String(id)) ? `${name}（本会话）` : name)));
    const currentName = folders.find(([id]) => id === String(folderId))?.[1] || '收藏夹';
    const libraryTitle = page.querySelector('.favorite-library-head h2');
    if (libraryTitle) libraryTitle.textContent = currentName === '全部' ? '全部作品' : currentName;
    const create = h('button', {
      class: 'favorite-folder-action primary', type: 'button', 'aria-label': '新建收藏夹', title: '新建收藏夹',
      onclick: async () => {
        const name = window.prompt('新收藏夹名称');
        if (!name || !name.trim()) return;
        try {
          const result = await api.favoriteFolder('add', '0', name.trim(), '');
          toast(result?.scope === 'cloud' ? '云端收藏夹已创建' : '收藏夹已创建（仅本会话）');
          refreshRoute('0');
        } catch (e) { if (!isAbort(e)) toast(e.message); }
      },
    }, icon('folder-plus', 16), h('span', null, '新建'));
    const rename = h('button', {
      class: 'favorite-folder-action', type: 'button', disabled: folderId === '0', 'aria-label': '重命名收藏夹', title: '重命名收藏夹',
      onclick: async () => {
        const name = window.prompt('重命名收藏夹', currentName);
        if (!name || !name.trim() || name.trim() === currentName) return;
        try {
          const result = await api.favoriteFolder('edit', folderId, name.trim(), '');
          toast(result?.scope === 'cloud' ? '云端收藏夹已重命名' : '收藏夹已重命名（仅本会话）');
          refreshRoute();
        } catch (e) { if (!isAbort(e)) toast(e.message); }
      },
    }, icon('edit-3', 15));
    const remove = h('button', {
      class: 'favorite-folder-action danger', type: 'button', disabled: folderId === '0', 'aria-label': '删除收藏夹', title: '删除收藏夹',
      onclick: async () => {
        if (!window.confirm(`删除“${currentName}”？其中漫画不会从总收藏中移除。`)) return;
        try {
          const result = await api.favoriteFolder('del', folderId, '', '');
          toast(result?.scope === 'cloud' ? '云端收藏夹已删除' : '收藏夹已删除（仅本会话）');
          refreshRoute('0');
        } catch (e) { if (!isAbort(e)) toast(e.message); }
      },
    }, icon('trash-2', 15));
    manageBar.replaceChildren(create, rename, remove);
  }

  function updateSelectionBar() {
    if (!selected.size) {
      selectionBar.hidden = true;
      selectionBar.replaceChildren();
      cards.forEach((card) => {
        card.classList.remove('is-selected');
        const box = card.querySelector('input[data-select]');
        if (box) box.checked = false;
      });
      return;
    }
    selectionBar.hidden = false;
    const move = h('button', {
      class: 'btn primary', type: 'button',
      onclick: async () => {
        const target = await chooseFolder(folders, `移动 ${selected.size} 项到…`, folderId);
        if (!target) return;
        move.disabled = true;
        let success = 0;
        let cloud = 0;
        let session = 0;
        const movedIds = [];
        for (const id of [...selected]) {
          try {
            const result = await api.favoriteFolder('move', target[0], '', id);
            if (result?.scope === 'cloud') cloud++; else session++;
            success++;
            movedIds.push(id);
          }
          catch (_) { /* 汇总提示，继续处理其他项 */ }
        }
        const scopeText = cloud && session
          ? `（云端 ${cloud}，仅本会话 ${session}）`
          : (cloud ? '（已同步云端）' : '（仅本会话）');
        toast(`已移动 ${success}/${selected.size} 项到 ${target[1]}${scopeText}`);
        if (folderId !== '0') {
          movedIds.forEach(dropFavoriteCard);
        }
        selected.clear();
        updateSelectionBar();
        filterCards();
      },
    }, icon('folder', 15), '移动到收藏夹');
    const unfavorite = h('button', {
      class: 'btn', type: 'button',
      onclick: async () => {
        if (!window.confirm(`取消收藏选中的 ${selected.size} 项？`)) return;
        unfavorite.disabled = true;
        let success = 0;
        for (const id of [...selected]) {
          try {
            await api.favorite(id);
            dropFavoriteCard(id);
            success++;
          } catch (_) { /* 汇总提示 */ }
        }
        selected.clear();
        toast(`已取消收藏 ${success} 项`);
        updateSelectionBar();
        filterCards();
      },
    }, icon('trash-2', 15), '取消收藏');
    selectionBar.replaceChildren(
      h('div', { class: 'favorite-selection-count' }, icon('check-square', 17), h('strong', null, `已选择 ${selected.size} 项`)),
      h('div', { class: 'favorite-selection-actions' }, move, unfavorite,
      h('button', {
        class: 'btn', type: 'button',
        onclick: () => {
          selected.clear();
          cards.forEach((card) => {
            const box = card.querySelector('input[data-select]');
            if (box) box.checked = false;
            card.classList.remove('is-selected');
          });
          updateSelectionBar();
        },
      }, '完成')));
  }

  function filterCards() {
    const query = localSearch.value.trim().toLocaleLowerCase();
    let visible = 0;
    cards.forEach((card) => {
      const meta = card._favoriteMeta || { tags: [], authors: [] };
      const chosen = [...selectedTags].map((value) => meta.tags.includes(value))
        .concat([...selectedAuthors].map((value) => meta.authors.includes(value)));
      const facetMatch = !chosen.length || (filterLogic === 'and' ? chosen.every(Boolean) : chosen.some(Boolean));
      card.hidden = !(facetMatch && (!query || card.dataset.search.includes(query)));
      if (!card.hidden) visible++;
    });
    clearSearch.hidden = !query;
    const hasFilters = !!query || selectedTags.size > 0 || selectedAuthors.size > 0;
    filterEmpty.hidden = !(hasFilters && cards.size > 0 && visible === 0);
    libraryMeta.textContent = hasFilters
      ? `${visible} 个匹配结果 · 已加载 ${cards.size} 部`
      : `已加载 ${cards.size} 部${cards.size ? ' · 向下滚动继续加载' : ''}`;
  }

  function facetChips(counts, selected, emptyText) {
    const rows = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'));
    if (!rows.length) return h('span', { class: 'hint' }, emptyText);
    return rows.map(([value, count]) => h('button', {
      class: `chip${selected.has(value) ? ' active' : ''}`, type: 'button',
      onclick: () => { if (selected.has(value)) selected.delete(value); else selected.add(value); renderFacets(); filterCards(); },
    }, `${value} (${count})`));
  }

  function renderFacets() {
    facetRenderQueued = false;
    const logic = h('select', { class: 'input', style: 'width:auto;min-width:100px' },
      h('option', { value: 'and', selected: filterLogic === 'and' }, '全部满足'),
      h('option', { value: 'or', selected: filterLogic === 'or' }, '任一满足'));
    logic.onchange = () => { filterLogic = logic.value; filterCards(); };
    filterPanel.replaceChildren(
      h('div', { class: 'favorite-filter-head' },
        h('div', null, h('strong', null, '精细筛选'), h('span', null, '组合标签和作者，快速缩小范围')),
        h('div', { class: 'favorite-filter-actions' }, logic,
          h('button', { class: 'btn', type: 'button', onclick: async (event) => {
            const button = event.currentTarget; button.disabled = true; button.textContent = '正在加载全部收藏…';
            try { await list?.loadAll(500); button.textContent = '已加载完整收藏'; }
            catch (_) { button.textContent = '加载全部后筛选'; }
            finally { button.disabled = false; renderFacets(); filterCards(); }
          } }, '加载全部'),
          h('button', { class: 'btn ghost', type: 'button', onclick: () => {
            selectedTags.clear(); selectedAuthors.clear(); localSearch.value = ''; renderFacets(); filterCards();
          } }, '重置'))),
      h('div', { class: 'favorite-facet' },
        h('div', { class: 'favorite-facet-label' }, '标签', h('span', null, '可多选')),
        h('div', { class: 'chips favorite-facet-chips' }, facetChips(tagCounts, selectedTags, '加载收藏后显示标签计数'))),
      h('div', { class: 'favorite-facet' },
        h('div', { class: 'favorite-facet-label' }, '作者', h('span', null, '可多选')),
        h('div', { class: 'chips favorite-facet-chips' }, facetChips(authorCounts, selectedAuthors, '加载收藏后显示作者计数'))),
      h('div', { class: 'favorite-filter-note' }, '筛选默认覆盖已加载内容；加载全部后可覆盖整个收藏库。'));
  }

  function scheduleFacetRender() {
    if (facetRenderQueued) return;
    facetRenderQueued = true;
    queueMicrotask(renderFacets);
  }

  function dropFavoriteCard(id) {
    const card = cards.get(String(id));
    if (!card) return;
    const meta = card._favoriteMeta || { tags: [], authors: [] };
    meta.tags.forEach((value) => {
      const next = (tagCounts.get(value) || 1) - 1;
      if (next > 0) tagCounts.set(value, next); else tagCounts.delete(value);
    });
    meta.authors.forEach((value) => {
      const next = (authorCounts.get(value) || 1) - 1;
      if (next > 0) authorCounts.set(value, next); else authorCounts.delete(value);
    });
    card.remove();
    cards.delete(String(id));
    scheduleFacetRender();
  }

  function decorateFavorite(item) {
    const id = String(item.id ?? item.aid ?? item.AID ?? '');
    const card = comicCard(item);
    card.dataset.favoriteCard = '1';
    card.dataset.favoriteId = id;
    const authors = (Array.isArray(item.author) ? item.author : [item.author]).map((x) => String(x || '').trim()).filter(Boolean);
    const tags = (Array.isArray(item.tags) ? item.tags : []).map((x) => String(x || '').trim()).filter(Boolean);
    card.dataset.search = [item.name, ...authors, ...tags].filter(Boolean).join(' ').toLocaleLowerCase();
    card._favoriteMeta = { authors, tags };
    const checkbox = h('input', {
      type: 'checkbox', 'data-select': '1', 'aria-label': `选择${item.name || id}`,
      class: 'favorite-card-check',
      onclick: (e) => e.stopPropagation(),
      onkeydown: (e) => e.stopPropagation(),
      onchange: (e) => {
        if (e.target.checked) selected.add(id); else selected.delete(id);
        card.classList.toggle('is-selected', e.target.checked);
        updateSelectionBar();
      },
    });
    card.append(checkbox);
    if (id && !cards.has(id)) {
      cards.set(id, card);
      tags.forEach((value) => tagCounts.set(value, (tagCounts.get(value) || 0) + 1));
      authors.forEach((value) => authorCounts.set(value, (authorCounts.get(value) || 0) + 1));
      scheduleFacetRender();
    }
    filterCards();
    return card;
  }

  localSearch.addEventListener('input', () => {
    filterCards();
  });
  renderFacets();
  renderFolders();
  let foldersHydrated = false;
  list = infiniteList(async (p, signal) => {
    const res = await api.favorites(o, p, folderId, signal);
    const d = res.data || {};
    if (!foldersHydrated) {
      foldersHydrated = true;
      sessionFolderIds = new Set((d.session_folder_ids || []).map(String));
      folders = folderEntries(d.folder_list).map(([id, name]) => [id, id === '0' ? '全部' : name]);
      scopeHint.classList.toggle('is-local', res.scope !== 'cloud');
      scopeHint.firstElementChild?.replaceWith(icon(res.scope === 'cloud' ? 'cloud' : 'cloud-off', 14));
      scopeText.textContent = res.scope === 'cloud'
        ? (sessionFolderIds.size
          ? '已连接云端；标注“本会话”的分组暂未同步'
          : '已同步至 JM 账号')
        : '收藏夹分组当前仅保存在本会话';
      renderFolders();
    }
    const source = filterComics(d.list || [], setting.blockedTagList || []);
    return {
      items: source.map(decorateFavorite),
      // 本地收藏夹映射按上游分页后过滤，当前页为空不代表后续页也为空。
      hasMore: Number(d.total) > p * 20 || Number(d.source_count) > 0,
    };
  }, {
    empty: () => h('div', { class: 'favorite-empty', style: { gridColumn: '1/-1' } },
      h('div', { class: 'favorite-empty-icon' }, icon('star', 28)),
      h('h3', null, '收藏夹还是空的'),
      h('p', null, '遇到喜欢的作品时点一下收藏，之后就能在这里继续阅读。'),
      h('a', { class: 'btn primary', href: '#/' }, '去首页看看', icon('arrow-right', 15))),
  });
  page.append(list.root);
  return list.destroy;
}

/* ============================== 云端阅读历史 ============================== */

export function watchHistoryView(root) {
  const page = h('div', { class: 'page history-page' });
  const loaded = new Map();
  const scopeHint = h('div', { class: 'hint', style: 'margin:0 2px 8px' },
    '登录后优先删除 JM 账号云端历史；云端不可用时只会在本会话隐藏。');
  const clearLoaded = h('button', {
    class: 'btn', type: 'button', disabled: true,
    onclick: async () => {
      if (!loaded.size || !window.confirm(`删除当前已加载的 ${loaded.size} 条账号历史？云端失败时将仅在本会话隐藏。`)) return;
      clearLoaded.disabled = true;
      let success = 0;
      let cloud = 0;
      let session = 0;
      for (const [id, card] of [...loaded]) {
        try {
          const result = await api.deleteHistory(id);
          if (result?.scope === 'cloud') cloud++; else session++;
          card.remove();
          loaded.delete(id);
          success++;
        } catch (_) { /* 继续删除其余项 */ }
      }
      const scopeText = cloud && session
        ? `（云端 ${cloud}，仅本会话隐藏 ${session}）`
        : (cloud ? '（已从云端删除）' : '（仅本会话隐藏）');
      toast(`已处理 ${success} 条历史${scopeText}`);
      clearLoaded.disabled = loaded.size === 0;
    },
  }, '清空已加载');
  page.append(
    h('div', { class: 'list-head' }, h('h2', null, '账号阅读历史')),
    scopeHint,
    h('div', { class: 'action-bar', style: 'margin:2px 0 10px' }, clearLoaded),
  );
  root.append(page);

  function decorateHistory(item) {
    const id = String(item.id ?? item.aid ?? item.AID ?? '');
    const card = comicCard(item);
    card.style.position = 'relative';
    const remove = h('button', {
      class: 'chip', type: 'button', title: '删除这条历史', 'aria-label': `删除${item.name || id}的历史`,
      style: 'position:absolute;z-index:3;right:7px;top:7px;padding:5px 7px;background:var(--card)',
      onclick: async (e) => {
        e.stopPropagation();
        if (!window.confirm(`删除“${item.name || id}”的账号阅读历史？云端失败时将仅在本会话隐藏。`)) return;
        remove.disabled = true;
        try {
          const result = await api.deleteHistory(id);
          card.remove();
          loaded.delete(id);
          clearLoaded.disabled = loaded.size === 0;
          toast(result?.scope === 'cloud' ? '历史记录已从云端删除' : '历史记录仅在本会话隐藏');
        } catch (err) {
          remove.disabled = false;
          if (!isAbort(err)) toast(err.message);
        }
      },
      onkeydown: (e) => e.stopPropagation(),
    }, icon('trash-2', 14));
    card.append(remove);
    if (id) loaded.set(id, card);
    clearLoaded.disabled = loaded.size === 0;
    return card;
  }

  const list = infiniteList(async (p, signal) => {
    const res = await api.history(p, signal);
    const d = res.data || {};
    if (p === 1) {
      scopeHint.textContent = res.scope === 'cloud'
        ? '正在显示 JM 账号云端历史；删除成功时会同步到账号。'
        : '当前未连接账号云端；删除操作只会在本会话隐藏记录。';
    }
    const source = filterComics(d.list || [], setting.blockedTagList || []);
    return {
      items: source.map(decorateHistory),
      hasMore: Number(d.total) > p * 20 || Number(d.source_count) > 0,
    };
  });
  page.append(list.root);
  return list.destroy;
}

/* ============================== 本地阅读记录 ============================== */

export function localHistoryView(root) {
  const page = h('div', { class: 'page history-page' });
  root.append(page);

  const render = () => {
    const hist = getLocalHistory();
    page.replaceChildren(h('div', { class: 'list-head' },
      h('h2', null, '本地阅读记录'),
      h('div', { style: 'font-size:12.5px;color:var(--text-2);margin:2px' }, '仅保存在本设备浏览器中，无需登录'),
    ));
    if (!hist.length) {
      page.append(h('div', { class: 'empty' }, h('div', { class: 'big' }, icon('smartphone', 40)), '还没有阅读记录'));
      return;
    }
    page.append(h('button', {
      class: 'btn', type: 'button', style: 'margin:4px 2px 10px',
      onclick: () => { clearLocalHistory(); render(); },
    }, '清空记录'));

    const list = h('div');
    hist.forEach((it) => {
      const photoId = String(it.photoId || it.aid || '');
      const aid = String(it.aid || '');
      const canOpen = /^\d+$/.test(photoId) && /^\d+$/.test(aid);
      const open = () => { if (canOpen) location.hash = it.offline ? `#/offline/${aid}/${photoId}` : `#/read/${photoId}?aid=${aid}`; };
      const item = h('div', {
        class: 'comment-item',
        style: canOpen ? 'cursor:pointer' : '',
        ...(canOpen ? { role: 'button', tabindex: '0', 'aria-label': `继续阅读${it.name || '漫画'}`, onclick: open } : { 'aria-disabled': 'true' }),
      },
        h('div', { class: 'avatar', style: 'border-radius:8px' },
          h('img', { loading: 'lazy', alt: it.name || '漫画封面', src: it.cover || `/api/img?path=${encodeURIComponent(`/media/albums/${aid}_3x4.jpg`)}` })),
        h('div', { class: 'body' },
          h('div', { class: 'name' }, it.name || `漫画 ${aid}`),
          h('div', { class: 'foot' },
            it.total ? `读到第 ${Number(it.page || 0) + 1} / ${it.total} 页 · ` : '',
            fmtTime(it.ts))),
        h('button', {
          class: 'icon-btn', type: 'button', title: '删除这条记录', 'aria-label': `删除${it.name || '漫画'}的本地阅读记录`,
          onclick: (event) => { event.stopPropagation(); removeLocalHistory(aid, photoId); render(); },
        }, icon('trash-2', 17)),
      );
      if (canOpen) item.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      list.append(item);
    });
    page.append(list);
  };

  render();
}

/* ============================== 我的评论 ============================== */

export function myCommentsView(root, params, ctx) {
  const page = h('div', { class: 'page' });
  const content = h('div');
  page.append(content);
  root.append(page);
  let destroyed = false;
  let obs = null;
  let requestController = null;
  let generation = 0;
  let pageIdx = 0;
  let loading = false;
  let finished = false;
  let uid = '';
  let listWrap = null;
  let sentinel = null;

  const buildCommentNodes = (list) => list.map((c) => {
    const aid = String(c.AID || c.aid || '');
    const canOpen = /^\d+$/.test(aid);
    const open = () => { if (canOpen) location.hash = `#/album/${aid}`; };
    const item = h('div', {
      class: 'comment-item', style: canOpen ? 'cursor:pointer' : '',
      ...(canOpen ? { role: 'button', tabindex: '0', 'aria-label': `查看${c.name || '漫画'}详情`, onclick: open } : { 'aria-disabled': 'true' }),
    },
      h('div', { class: 'body' },
        h('div', { class: 'name' }, `《${c.name || '漫画 ' + aid}》`),
        h('div', { class: 'content' }, c.content || ''),
        h('div', { class: 'foot' }, fmtTime(c.addtime))),
    );
    if (canOpen) item.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    return item;
  });

  const loadNext = async (seq = generation) => {
    if (destroyed || seq !== generation || loading || finished || !uid || isInactive(ctx)) return;
    loading = true;
    obs?.disconnect();
    const nextPage = pageIdx + 1;
    const controller = new AbortController();
    requestController = controller;
    let observeAgain = false;
    if (nextPage === 1) listWrap.replaceChildren(commentListSkeleton());
    else sentinel.replaceChildren(h('div', { class: 'loading-more' }, h('div', { class: 'spinner-sm' })));
    try {
      const res = await api.userComments(uid, nextPage, controller.signal);
      if (destroyed || seq !== generation || isInactive(ctx) || controller.signal.aborted) return;
      const d = res && res.data && typeof res.data === 'object' && !Array.isArray(res.data) ? res.data : {};
      const list = (Array.isArray(d.list) ? d.list : [])
        .filter((item) => item && typeof item === 'object' && !Array.isArray(item));
      if (nextPage === 1 && !list.length) {
        listWrap.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'big' }, icon('message-square', 40)), '还没有发表过评论'));
        sentinel.replaceChildren();
        finished = true;
        return;
      }
      const nodes = buildCommentNodes(list);
      if (nextPage === 1) listWrap.replaceChildren(...nodes);
      else listWrap.append(...nodes);
      // 只有完整追加成功后才推进页码；失败重试仍请求同一页，不会跳页或重复已有页。
      pageIdx = nextPage;
      sentinel.replaceChildren();
      if (list.length >= 20) observeAgain = true;
      else finished = true;
    } catch (e) {
      if (!destroyed && seq === generation && !isInactive(ctx) && !controller.signal.aborted && !isAbort(e)) {
        const retry = () => { if (!destroyed && seq === generation && !loading) loadNext(seq); };
        if (nextPage === 1) listWrap.replaceChildren(errorBox(e.message, retry));
        else sentinel.replaceChildren(errorBox(e.message, retry));
      }
    } finally {
      if (requestController === controller) requestController = null;
      if (seq === generation) {
        loading = false;
        if (observeAgain && !destroyed && !finished && !isInactive(ctx)) obs?.observe(sentinel);
      }
    }
  };

  const reload = async () => {
    const seq = ++generation;
    requestController?.abort();
    requestController = null;
    obs?.disconnect();
    obs = null;
    pageIdx = 0;
    loading = false;
    finished = false;
    uid = String(params.get('uid') || '');
    content.replaceChildren(
      h('div', { class: 'list-head' }, h('h2', null, '我的评论')),
      commentListSkeleton(),
    );

    if (!uid) {
      const controller = new AbortController();
      requestController = controller;
      try {
        const me = (await api.me(controller.signal)).user;
        if (destroyed || seq !== generation || isInactive(ctx) || controller.signal.aborted) return;
        if (!me) { location.hash = '#/user'; return; }
        uid = String(me.uid || '');
      } catch (e) {
        if (destroyed || seq !== generation || isInactive(ctx) || controller.signal.aborted || isAbort(e)) return;
        content.replaceChildren(errorBox(e.message, reload));
        return;
      } finally {
        if (requestController === controller) requestController = null;
      }
    }

    if (destroyed || seq !== generation || !uid || isInactive(ctx)) return;
    listWrap = h('div');
    sentinel = h('div');
    content.replaceChildren(h('div', { class: 'list-head' }, h('h2', null, '我的评论')), listWrap, sentinel);
    obs = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadNext(seq);
    }, { rootMargin: '300px' });
    await loadNext(seq);
  };

  const removePullRefresh = installPullToRefresh(page, reload);
  reload();

  return () => {
    if (destroyed) return;
    destroyed = true;
    generation++;
    if (obs) obs.disconnect();
    obs = null;
    if (requestController) requestController.abort();
    requestController = null;
    removePullRefresh();
  };
}

function commentListSkeleton(count = 4) {
  return h('div', { role: 'status', 'aria-label': '正在加载评论' },
    Array.from({ length: count }, () => h('div', { class: 'comment-item', 'aria-hidden': 'true' },
      h('div', { class: 'body' },
        h('div', { class: 'skeleton-line short' }),
        h('div', { class: 'skeleton-line wide', style: 'height:13px;margin-top:12px' }),
        h('div', { class: 'skeleton-line short' })))));
}

/* ============================== 设置 ============================== */

export async function settingsView(root, ctx) {
  const page = h('div', { class: 'page settings-page', style: 'max-width:620px' });
  page.append(h('div', { class: 'list-head' }, h('h2', null, '设置')));
  root.append(page);

  let cfg;
  try {
    cfg = await api.config(ctx && ctx.signal);
    if (isInactive(ctx)) return;
  } catch (e) {
    if (isInactive(ctx) || isAbort(e)) return;
    page.append(errorBox(e.message));
    return;
  }

  /* 主题 */
  const themeSel = selectRow('主题外观', [['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']], setting.theme,
    (v) => updateSetting({ theme: v }));

  /* 阅读模式 */
  const modeSel = selectRow('默认阅读模式', [
    ['scroll', '连续滚动'], ['page', '向右翻页'], ['pageReverse', '向左翻页（RTL）'], ['tap', '纯点击翻页'],
  ], setting.readMode,
    (v) => updateSetting({ readMode: v }));

  /* 翻页适配 */
  const fitSel = selectRow('翻页适配方式', [['contain', '完整显示'], ['width', '适配宽度']], setting.pageFit,
    (v) => updateSetting({ pageFit: v }));

  /* 预加载 */
  const preSel = selectRow('阅读预加载数量', [['1', '1 页'], ['3', '3 页'], ['5', '5 页'], ['8', '8 页']], String(setting.prefetchCount),
    (v) => updateSetting({ prefetchCount: Number(v) }));

  /* 图片分流 */
  const shuntSel = selectRow('图片分流线路', [['1', '线路 1'], ['2', '线路 2'], ['3', '线路 3'], ['4', '线路 4']], String(setting.shunt),
    (v) => updateSetting({ shunt: v }));

  /* API 域名（保存到本浏览器会话，不影响其他访客；环境变量锁定时不可改） */
  const hostOptions = [
    ['', '自动（默认线路）'],
    ...(Array.isArray(cfg.apiHosts) ? cfg.apiHosts : []).map((hh) => [hh, hh.replace(/^https?:\/\/(www\.)?/, '')]),
  ];
  const hostSel = h('select', { class: 'input', disabled: !!cfg.apiHostLocked },
    hostOptions.map(([v, l]) => h('option', { value: v, selected: v === cfg.currentApiHost }, l)));
  hostSel.addEventListener('change', async () => {
    hostSel.disabled = true;
    try {
      await api.setApiHost(hostSel.value, ctx && ctx.signal);
      if (isInactive(ctx)) return;
      toast(hostSel.value ? 'API 域名已切换（仅本浏览器生效）' : '已恢复自动线路');
    } catch (e) {
      if (!isInactive(ctx) && !isAbort(e)) toast(e.message);
    } finally {
      if (!isInactive(ctx)) hostSel.disabled = !!cfg.apiHostLocked;
    }
  });

  page.append(
    h('div', { class: 'setting-group' },
      h('div', { class: 'setting-item setting-section-title' }, h('div', { class: 'lab' }, '功能入口')),
      h('div', { class: 'setting-item', style: 'display:flex;gap:8px;flex-wrap:wrap' },
        h('a', { class: 'btn', href: '#/advanced' }, icon('layout-grid', 16), '完整功能中心'),
        h('a', { class: 'btn', href: '#/downloads' }, icon('inbox', 16), '下载与离线缓存'),
        h('a', { class: 'btn', href: '#/ai' }, icon('message-square', 16), 'AI 对话')),
    ),
    h('div', { class: 'setting-group' },
      h('div', { class: 'setting-item setting-section-title' }, h('div', { class: 'lab' }, '外观')),
      h('div', { class: 'setting-item' }, themeSel),
    ),
    h('div', { class: 'setting-group' },
      h('div', { class: 'setting-item' }, h('div', { class: 'lab' }, '阅读'), modeSel, fitSel, preSel)),
    h('div', { class: 'setting-group' },
      h('div', { class: 'setting-item' }, h('div', { class: 'lab' }, '网络'), shuntSel,
        h('div', { class: 'setting-row', style: 'margin-top:12px' },
          h('div', null, h('div', { class: 'lab', style: 'margin-bottom:0' }, 'API 域名')),
          hostSel),
        h('div', { class: 'hint' }, cfg.apiHostLocked
          ? 'API 域名已由服务器环境变量 JM_API_BASE 固定'
          : '切换仅对本浏览器生效；接口请求失败时会自动尝试其他域名')),
    ),
  );

  // 清除本地数据
  page.append(h('div', { class: 'setting-group' },
    h('button', {
      class: 'setting-item btn ghost', style: 'width:100%;border:none;text-align:left;color:var(--danger)',
      onclick: () => { clearLocalHistory(); toast('本地阅读记录已清空'); },
    }, icon('trash-2', 16), ' 清空本地阅读记录'),
  ));

  page.append(h('div', { style: 'text-align:center;color:var(--text-2);font-size:12px;padding:20px 0' },
    `JM Web · 协议参照 jmcomic-next / jm-mobile（API v${cfg.apiVersion}）`, h('br'),
    '仅供学习研究，请在 24 小时内自觉评估使用风险'));
}

function selectRow(label, options, current, onChange) {
  const sel = h('select', { class: 'input' },
    options.map(([v, l]) => h('option', { value: v, selected: v === current }, l)));
  sel.addEventListener('change', () => onChange(sel.value));
  return h('div', { class: 'setting-row' },
    h('div', null, h('div', { class: 'lab', style: 'margin-bottom:0' }, label)),
    sel);
}
