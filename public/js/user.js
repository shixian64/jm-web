// 用户与设置页面：登录 / 个人中心 / 签到 / 收藏 / 阅读历史 / 评论历史 / 本地记录 / 设置
import { api, imgSrc } from './api.js';
import { h, toast, comicCard, infiniteList, errorBox, loadingBox } from './ui.js';
import {
  setting, updateSetting, getLocalHistory, clearLocalHistory,
} from './store.js';
import { fmt, fmtTime } from './views.js';
import { icon } from './icons.js';

function isAbort(e) { return !!(e && e.name === 'AbortError'); }
function isInactive(ctx) {
  return !!(ctx && (ctx.signal?.aborted || (typeof ctx.isActive === 'function' && !ctx.isActive())));
}

/* ============================== 我的 / 登录 ============================== */

export async function userView(root, ctx) {
  const page = h('div', { class: 'page' });
  root.append(page);
  await refreshUserPage(page, ctx);
}

async function refreshUserPage(page, ctx) {
  page.replaceChildren(loadingBox());
  let me;
  try {
    me = (await api.me(ctx && ctx.signal)).user;
    if (isInactive(ctx)) return;
  } catch (e) {
    if (isInactive(ctx) || isAbort(e)) return;
    page.replaceChildren(errorBox(e.message));
    return;
  }
  if (!me) return renderLogin(page, ctx);
  renderProfile(page, me, ctx);
}

function renderLogin(page, ctx) {
  const username = h('input', { class: 'input', placeholder: '用户名', autocomplete: 'username' });
  const password = h('input', { class: 'input', placeholder: '密码', type: 'password', autocomplete: 'current-password' });
  const submit = h('button', { class: 'btn primary block', type: 'submit' }, '登 录');

  const form = h('form', {
    class: 'card', style: 'max-width:380px;margin:8vh auto 0;padding:26px',
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
        await refreshUserPage(page, ctx);
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
    h('div', { class: 'empty', style: 'padding-top:8vh' }, h('div', { class: 'big' }, icon('lock', 40)), '登录后可同步收藏与阅读记录'),
    form,
  );
}

function renderProfile(page, me, ctx) {
  const avatarSrc = me.photo
    ? (/^https?:/i.test(me.photo) ? `/api/img?u=${encodeURIComponent(me.photo)}` : `/api/img?path=${encodeURIComponent(me.photo.startsWith('/') ? me.photo : '/' + me.photo)}`)
    : '';
  const exp = Number(me.exp) || 0;
  const next = Number(me.nextLevelExp) || 1;
  const pct = Math.min(100, Math.round((Number(me.expPercent) || (exp / next) * 100)));

  page.replaceChildren(
    h('div', { class: 'card' },
      h('div', { class: 'profile-head' },
        h('div', { class: 'avatar' }, avatarSrc ? h('img', { src: avatarSrc }) : (me.username || '友').slice(0, 1)),
        h('div', { style: 'flex:1;min-width:0' },
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
          renderLogin(page, ctx);
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
  const page = h('div', { class: 'page', style: 'max-width:560px' });
  root.append(page);
  let refreshSeq = 0;

  async function load() {
    const seq = ++refreshSeq;
    page.replaceChildren(loadingBox());
    let me;
    try {
      me = (await api.me(ctx && ctx.signal)).user;
      if (isInactive(ctx) || seq !== refreshSeq) return;
    } catch (e) {
      if (isInactive(ctx) || isAbort(e) || seq !== refreshSeq) return;
      page.replaceChildren(errorBox(e.message, load));
      return;
    }
    if (!me) { location.hash = '#/user'; return; }

    let data;
    try {
      data = (await api.daily(me.uid, ctx && ctx.signal)).data;
      if (isInactive(ctx) || seq !== refreshSeq) return;
    } catch (e) {
      if (isInactive(ctx) || isAbort(e) || seq !== refreshSeq) return;
      page.replaceChildren(errorBox(e.message, load));
      return;
    }

    const flat = (data.record || []).flat();
    const todayIdx = Number(data.currentProgress) || 0;
    const grid = h('div', { class: 'sign-grid' });
    flat.forEach((d, i) => {
      grid.append(h('div', { class: 'd' + (d.signed ? ' signed' : '') + (d.bonus ? ' bonus' : '') },
        h('b', null, d.signed ? icon('check', 16) : String(i + 1)),
        h('span', null, (d.date || '').slice(5)),
      ));
    });

    const btn = h('button', {
      class: 'btn primary block', type: 'button',
      onclick: async () => {
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
    }, '立即签到');

    page.replaceChildren(
      h('div', { class: 'list-head' }, h('h2', null, '每日签到')),
      h('div', { class: 'card', style: 'padding:16px' },
        h('div', { style: 'color:var(--text-2);font-size:13px' },
          `${data.event_name || '签到活动'} · 已连续签到 ${todayIdx} 天 · 连续 3 天 +${data.three_days_coin || 0} 金币`),
        grid,
        btn,
      ),
    );
  }

  load();
}

/* ============================== 收藏 ============================== */

const FAV_ORDERS = [['mr', '收藏时间'], ['mp', '更新时间']];

export function favoritesView(root, params) {
  const o = params.get('o') || 'mr';
  const page = h('div', { class: 'page' });
  page.append(
    h('div', { class: 'list-head' }, h('h2', null, '我的收藏')),
    h('div', { class: 'chips' }, FAV_ORDERS.map(([v, l]) =>
      h('a', { class: 'chip' + (v === o ? ' active' : ''), href: `#/favorites?o=${v}` }, l))),
  );
  root.append(page);
  const list = infiniteList(async (p, signal) => {
    const res = await api.favorites(o, p, 0, signal);
    const d = res.data || {};
    return {
      items: (d.list || []).map(comicCard),
      hasMore: (d.list || []).length > 0 && Number(d.total) > p * 20,
    };
  });
  page.append(list.root);
  return list.destroy;
}

/* ============================== 云端阅读历史 ============================== */

export function watchHistoryView(root) {
  const page = h('div', { class: 'page' });
  page.append(h('div', { class: 'list-head' }, h('h2', null, '阅读历史（云端）')));
  root.append(page);
  const list = infiniteList(async (p, signal) => {
    const res = await api.history(p, signal);
    const d = res.data || {};
    return {
      items: (d.list || []).map(comicCard),
      hasMore: (d.list || []).length > 0,
    };
  });
  page.append(list.root);
  return list.destroy;
}

/* ============================== 本地阅读记录 ============================== */

export function localHistoryView(root) {
  const page = h('div', { class: 'page' });
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
      const open = () => { if (canOpen) location.hash = `#/read/${photoId}?aid=${aid}`; };
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
  page.append(loadingBox());
  root.append(page);
  let destroyed = false;
  let obs = null;
  let requestController = null;

  (async () => {
    let uid = params.get('uid');
    if (!uid) {
      try {
        const me = (await api.me(ctx && ctx.signal)).user;
        if (destroyed || isInactive(ctx)) return;
        if (!me) { location.hash = '#/user'; return; }
        uid = me.uid;
      } catch (e) {
        if (destroyed || isInactive(ctx) || isAbort(e)) return;
        page.replaceChildren(errorBox(e.message));
        return;
      }
    }

    page.replaceChildren(h('div', { class: 'list-head' }, h('h2', null, '我的评论')));
    let pageIdx = 0;
    let loading = false;
    const listWrap = h('div');
    const sentinel = h('div');
    page.append(listWrap, sentinel);

    obs = new IntersectionObserver(async (es) => {
      if (destroyed || loading || !es.some((e) => e.isIntersecting)) return;
      loading = true;
      pageIdx++;
      obs.disconnect();
      const controller = new AbortController();
      requestController = controller;
      try {
        const res = await api.userComments(uid, pageIdx, controller.signal);
        if (destroyed || isInactive(ctx) || controller.signal.aborted) return;
        const d = res.data || {};
        const list = d.list || [];
        if (pageIdx === 1 && !list.length) {
          listWrap.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'big' }, icon('message-square', 40)), '还没有发表过评论'));
          return;
        }
        listWrap.append(...list.map((c) => {
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
        }));
        if (list.length >= 20 && !destroyed) obs.observe(sentinel);
      } catch (e) {
        if (!destroyed && !isInactive(ctx) && !controller.signal.aborted && !isAbort(e)) listWrap.append(errorBox(e.message));
      } finally {
        if (requestController === controller) requestController = null;
        loading = false;
      }
    }, { rootMargin: '300px' });
    obs.observe(sentinel);
  })();

  return () => {
    if (destroyed) return;
    destroyed = true;
    if (obs) obs.disconnect();
    obs = null;
    if (requestController) requestController.abort();
    requestController = null;
  };
}

/* ============================== 设置 ============================== */

export async function settingsView(root, ctx) {
  const page = h('div', { class: 'page', style: 'max-width:620px' });
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
  const modeSel = selectRow('默认阅读模式', [['scroll', '连续滚动'], ['page', '单页翻页']], setting.readMode,
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
    h('div', { class: 'setting-group' }, themeSel),
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
