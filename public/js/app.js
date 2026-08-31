// 应用外壳与路由：顶栏（桌面导航）/ 底部 Tab（手机）/ 各页面挂载
import { applyTheme, setting } from './store.js';
import { api } from './api.js';
import { h, toast } from './ui.js';
import { icon } from './icons.js';
import { homeView, searchView, categoryView, categoryListView, promoteListView, weekView, albumView } from './views.js';
import { mountReader } from './reader.js';
import { downloadsView } from './download-view.js';
import { registerOfflineWorker } from './offline.js';
import {
  advancedHubView, blockedTagsView, paletteView, securityView, backupView, personasView,
  aiView, networkView, logsView, extractCodeView, cacheView, aboutView, installAdvancedRuntime, isLocalAppLocked,
} from './advanced.js';
import {
  userView, signinView, favoritesView, watchHistoryView, localHistoryView, myCommentsView, settingsView,
} from './user.js';

applyTheme();

const app = document.getElementById('app');
const main = h('main', { id: 'main', tabindex: '-1' });
const skipLink = h('a', {
  class: 'skip-link', href: '#main',
  onclick: (e) => { e.preventDefault(); main.focus({ preventScroll: false }); },
}, '跳到主要内容');

/* ---------- 顶栏 ---------- */
const avatarMini = h('a', { id: 'avatar-mini', href: '#/user', title: '我的', 'aria-label': '打开我的页面' }, icon('user', 16));
const searchInput = h('input', {
  class: 'input', placeholder: '搜索漫画…',
  onkeydown: (e) => {
    if (e.key === 'Enter') {
      const v = searchInput.value.trim();
      if (v) location.hash = `#/search?q=${encodeURIComponent(v)}&o=mr`;
    }
  },
});

const topbar = h('div', { id: 'topbar' },
  h('a', { class: 'logo', href: '#/', 'aria-label': 'JM Web 首页' },
    h('span', { class: 'logo-mark' }, 'JM'),
    h('span', { class: 'logo-word' }, 'Web'),
  ),
  h('nav', { class: 'nav-links', 'aria-label': '主导航' },
    navLink('#/', '首页'),
    navLink('#/category', '分类'),
    navLink('#/week', '每周必看'),
    navLink('#/favorites', '收藏'),
    navLink('#/user', '我的'),
  ),
  h('div', { class: 'top-search' }, h('span', { class: 'search-leading', 'aria-hidden': 'true' }, icon('search', 17)), searchInput),
  h('div', { class: 'spacer' }),
  h('button', { class: 'icon-btn mobile-search', title: '搜索', 'aria-label': '打开搜索', onclick: () => { location.hash = '#/search'; } }, icon('search', 19)),
  h('button', { class: 'icon-btn', title: '设置', 'aria-label': '打开设置', onclick: () => { location.hash = '#/settings'; } }, icon('settings', 20)),
  avatarMini,
);

/* ---------- 底部 Tab（手机） ---------- */
const tabbar = h('nav', { id: 'tabbar', 'aria-label': '移动导航' },
  tab('#/', 'house', '首页'),
  tab('#/category', 'layout-grid', '分类'),
  tab('#/week', 'calendar-days', '每周'),
  tab('#/user', 'user', '我的'),
);

/* ---------- 路由 ---------- */
const routes = [
  { re: /^\/$/, view: (r, _m, _q, ctx) => homeView(r, ctx) },
  { re: /^\/search\/?$/, view: (r, _m, q, ctx) => searchView(r, q, ctx) },
  { re: /^\/category\/list\/?$/, view: (r, _m, q, ctx) => categoryListView(r, q, ctx) },
  { re: /^\/promote\/list\/?$/, view: (r, _m, q, ctx) => promoteListView(r, q, ctx) },
  { re: /^\/category\/?$/, view: (r, _m, _q, ctx) => categoryView(r, ctx) },
  { re: /^\/week\/?$/, view: (r, _m, q, ctx) => weekView(r, q, ctx) },
  { re: /^\/album\/(\d+)\/?$/, view: (r, m, _q, ctx) => albumView(r, m[1], ctx) },
  { re: /^\/downloads\/?$/, view: (r) => downloadsView(r) },
  { re: /^\/offline\/(\d+)\/(\d+)\/?$/, view: (r, m, q) => {
    const params = new URLSearchParams(q);
    params.set('aid', m[1]);
    const inst = mountReader(r, m[2], params, { offline: true });
    return () => inst && inst.destroy();
  } },
  {
    re: /^\/read\/(\d+)\/?$/,
    view: (r, m, q) => {
      const inst = mountReader(r, m[1], q);
      return () => inst && inst.destroy();
    },
  },
  { re: /^\/user\/?$/, view: (r, _m, _q, ctx) => userView(r, ctx) },
  { re: /^\/signin\/?$/, view: (r, _m, _q, ctx) => signinView(r, ctx) },
  { re: /^\/favorites\/?$/, view: (r, _m, q, ctx) => favoritesView(r, q, ctx) },
  { re: /^\/watch-history\/?$/, view: (r, _m, _q, ctx) => watchHistoryView(r, ctx) },
  { re: /^\/local-history\/?$/, view: (r, _m, _q, ctx) => localHistoryView(r, ctx) },
  { re: /^\/my-comments\/?$/, view: (r, _m, q, ctx) => myCommentsView(r, q, ctx) },
  { re: /^\/advanced\/?$/, view: (r) => advancedHubView(r) },
  { re: /^\/blocked-tags\/?$/, view: (r) => blockedTagsView(r) },
  { re: /^\/palette\/?$/, view: (r) => paletteView(r) },
  { re: /^\/security\/?$/, view: (r) => securityView(r) },
  { re: /^\/backup\/?$/, view: (r) => backupView(r) },
  { re: /^\/personas\/?$/, view: (r) => personasView(r) },
  { re: /^\/ai\/?$/, view: (r, m, q, ctx) => aiView(r, m, q, ctx) },
  { re: /^\/network\/?$/, view: (r, m, q, ctx) => networkView(r, m, q, ctx) },
  { re: /^\/logs\/?$/, view: (r, m, q, ctx) => logsView(r, m, q, ctx) },
  { re: /^\/extract\/?$/, view: (r) => extractCodeView(r) },
  { re: /^\/cache\/?$/, view: (r) => cacheView(r) },
  { re: /^\/about\/?$/, view: (r, m, q, ctx) => aboutView(r, m, q, ctx) },
  { re: /^\/settings\/?$/, view: (r, _m, _q, ctx) => settingsView(r, ctx) },
];

let currentCleanup = null;
let renderGeneration = 0;

function mountShell() {
  app.replaceChildren(skipLink, topbar, main, tabbar);
}

function navLink(href, label) {
  return h('a', { href, dataset: { nav: href } }, label);
}

function tab(href, ic, label) {
  return h('a', { href, dataset: { nav: href } },
    h('span', { class: 'ti' }, icon(ic, 22)), label);
}

function render() {
  const generation = ++renderGeneration;
  if (typeof currentCleanup === 'function') currentCleanup();
  currentCleanup = null;
  document.body.classList.remove('no-tab');

  const hash = location.hash || '#/';
  const path = hash.replace(/^#/, '').split('?')[0] || '/';
  const queryStr = hash.includes('?') ? hash.slice(hash.indexOf('?')) : '';
  const search = new URLSearchParams(queryStr);

  for (const route of routes) {
    const m = path.match(route.re);
    if (m) {
      main.replaceChildren();
      mountShell();
      // 阅读器为全屏固定层，隐藏底部 Tab
      const fullScreenView = route.re.source.includes('read') || path.startsWith('/offline/');
      document.body.classList.toggle('no-tab', fullScreenView);
      const controller = new AbortController();
      let viewCleanup = null;
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        controller.abort();
        if (typeof viewCleanup === 'function') {
          try { viewCleanup(); } catch (e) { console.warn('[route] cleanup 失败:', e); }
          viewCleanup = null;
        }
      };
      const ctx = {
        signal: controller.signal,
        isActive: () => !disposed && generation === renderGeneration,
      };
      currentCleanup = dispose;

      try {
        const result = route.view(main, m, search, ctx);
        if (result && typeof result.then === 'function') {
          result.then((cleanup) => {
            if (typeof cleanup !== 'function') return;
            // async View 可能在路由离开后才返回 cleanup，此时立即执行。
            if (disposed || generation !== renderGeneration) cleanup();
            else viewCleanup = cleanup;
          }).catch((e) => {
            if (!ctx.isActive() || (e && e.name === 'AbortError')) return;
            console.error('[route] view 失败:', e);
          });
        } else if (typeof result === 'function') {
          viewCleanup = result;
        }
      } catch (e) {
        dispose();
        if (currentCleanup === dispose) currentCleanup = null;
        main.replaceChildren(h('div', { class: 'error-box' }, e.message || '页面加载失败'));
      }
      highlightNav(path);
      if (!fullScreenView) {
        requestAnimationFrame(() => {
          if (!ctx.isActive()) return;
          window.scrollTo({ top: 0, behavior: 'auto' });
          main.focus({ preventScroll: true });
        });
      }
      return;
    }
  }
  // 404
  main.replaceChildren(
    h('div', { class: 'empty', style: 'padding-top:30vh' },
      h('div', { class: 'big' }, icon('search', 42)), '页面不存在',
      h('p', null, h('a', { href: '#/', style: 'color:var(--primary)' }, '返回首页'))));
  mountShell();
  highlightNav(path);
}

function highlightNav(path) {
  const active = path === '/' ? '#/'
    : path.startsWith('/category') ? '#/category'
    : path.startsWith('/week') ? '#/week'
    : (path.startsWith('/user') || path.startsWith('/favorites') || path.startsWith('/settings')
      || path.startsWith('/signin') || path.startsWith('/watch-history')
      || path.startsWith('/my-comments') || path.startsWith('/local-history') || path.startsWith('/downloads')
      || path.startsWith('/advanced') || path.startsWith('/blocked-tags') || path.startsWith('/palette')
      || path.startsWith('/security') || path.startsWith('/backup') || path.startsWith('/personas')
      || path.startsWith('/ai') || path.startsWith('/network') || path.startsWith('/logs')
      || path.startsWith('/extract') || path.startsWith('/cache') || path.startsWith('/about')) ? '#/user'
    : null;
  document.querySelectorAll('#topbar .nav-links a, #tabbar a').forEach((a) => {
    const isActive = a.dataset.nav === active;
    a.classList.toggle('active', isActive);
    if (isActive) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

/* ---------- 启动 ---------- */
async function boot() {
  mountShell();
  installAdvancedRuntime();
  if (isLocalAppLocked()) {
    await new Promise((resolve) => window.addEventListener('jmw-local-unlocked', resolve, { once: true }));
  }
  render();

  window.addEventListener('hashchange', render);

  // 访问口令保护：/api/me 返回 401 说明服务器开启了口令且本机未验证
  try {
    const res = await fetch('/api/me');
    if (res.status === 401) {
      const { passwordGate } = await import('./gate.js');
      // 首次渲染可能已经收到 401 并展示错误态；验证口令后重新加载当前路由。
      passwordGate(() => {
        render();
        refreshAvatar();
        installAdvancedRuntime();
        registerOfflineWorker().catch((error) => console.warn('[offline] Service Worker 注册失败:', error.message));
      });
      return;
    }
  } catch (e) {
    console.warn('[boot] 访问保护检查失败:', e && e.message);
  }

  refreshAvatar();
  installAdvancedRuntime();
  registerOfflineWorker().catch((error) => console.warn('[offline] Service Worker 注册失败:', error.message));
}

let avatarRefreshSeq = 0;
async function refreshAvatar() {
  const seq = ++avatarRefreshSeq;
  try {
    const me = (await api.me()).user;
    if (seq !== avatarRefreshSeq) return;
    if (me) {
      const src = me.photo
        ? (/^https?:/i.test(me.photo) ? `/api/img?u=${encodeURIComponent(me.photo)}` : `/api/img?path=${encodeURIComponent(me.photo.startsWith('/') ? me.photo : '/' + me.photo)}`)
        : '';
      const fallback = (me.username || '友').slice(0, 1);
      if (src) {
        const avatar = h('img', { src, alt: '', onerror: () => avatarMini.replaceChildren(fallback) });
        avatarMini.replaceChildren(avatar);
      } else avatarMini.replaceChildren(fallback);
    } else avatarMini.replaceChildren(icon('user', 16));
  } catch (_) {}
}

window.addEventListener('jmw-auth-changed', refreshAvatar);

boot();
