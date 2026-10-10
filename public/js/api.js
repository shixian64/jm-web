// 后端 API 封装：所有业务请求都走自部署的 /api/*（签名/解密/会话由服务端处理）
import { setting, onSettingChange } from './store.js';
import { createNavigationCache, navigationAbortError } from './navigation-cache.js';

export function selectedDataSource() {
  return ['builtin', 'network', 'mixed'].includes(setting.dataSource) ? setting.dataSource : 'builtin';
}

const navigationCache = createNavigationCache();
const CACHE_SYNC_KEY = 'jmw_navigation_cache_invalidation';
let lastIdentity;
let identityEpoch = 0;
let lastSource = selectedDataSource();

function invalidateNavigation(kind = 'all', id = '', { remote = false, abortFlights = true } = {}) {
  if (['all', 'auth', 'unauthorized', 'source', 'host'].includes(kind)) identityEpoch++;
  const matches = (key) => kind === 'all' || kind === 'auth' || kind === 'unauthorized'
    || kind === 'source' || kind === 'host'
    || (kind === 'favorites' && (key.startsWith('favorites:') || key.startsWith('favorite-state:')
      || (id && key === albumCacheKey(id))))
    || (kind === 'album' && key === albumCacheKey(id));
  navigationCache.invalidate(matches, kind, { abortFlights });
  if (!remote && typeof window !== 'undefined') {
    // 只广播失效通知，不存储账号、收藏、章节数据或 Cookie。
    try { localStorage.setItem(CACHE_SYNC_KEY, JSON.stringify({ kind, id, nonce: `${Date.now()}-${Math.random()}` })); } catch (_) {}
  }
  if (kind === 'auth' && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('jmw-auth-changed'));
  }
}

function albumCacheKey(id) { return `album:${JSON.stringify([selectedDataSource(), String(id)])}`; }

onSettingChange(() => {
  const source = selectedDataSource();
  if (source !== lastSource) { lastSource = source; invalidateNavigation('source'); }
});
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== CACHE_SYNC_KEY || !event.newValue) return;
    try {
      const message = JSON.parse(event.newValue);
      if (!['all', 'auth', 'unauthorized', 'source', 'host', 'favorites', 'album'].includes(message.kind)) return;
      if (message.kind === 'auth' || message.kind === 'unauthorized') lastIdentity = undefined;
      invalidateNavigation(message.kind, typeof message.id === 'string' ? message.id : '', { remote: true });
    } catch (_) {}
  });
}

// 收藏缓存按完整分页快照保存，绝不把新第一页拼到旧的后续页上。
export const navigationState = {
  token: navigationCache.token,
  subscribe: navigationCache.subscribe,
  key: (o, folder) => `favorites:${JSON.stringify([selectedDataSource(), o, String(folder)])}`,
  get: (key, maxAge = 30 * 60_000) => navigationCache.get(key, maxAge),
  save: (key, value, options) => navigationCache.put(key, value, options),
  load: navigationCache.load,
  invalidateFavorites: () => invalidateNavigation('favorites'),
};

async function mutation(path, opts, kind, id = '') {
  try { return await request(path, opts); }
  finally { invalidateNavigation(kind, String(id)); }
}

async function changeAuth(path, opts) {
  // 开始变更就隔离旧在途请求；成功后的失效也不依赖页面仍处于活动路由。
  invalidateNavigation('all');
  const value = await request(path, opts);
  lastIdentity = path === '/logout' ? null : identityOf(value?.data);
  invalidateNavigation('auth');
  return value;
}

function identityOf(user) {
  if (!user) return null;
  return String(user.id ?? user.uid ?? user.user_id ?? user.username ?? 'authenticated');
}

async function request(path, opts = {}) {
  const requestEpoch = identityEpoch;
  let res;
  try {
    const { signal: callerSignal, ...fetchOpts } = opts;
    const hasAbortSignal = typeof AbortSignal !== 'undefined';
    const timeoutSignal = hasAbortSignal && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(60000) : null;
    const signal = callerSignal && timeoutSignal && hasAbortSignal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : (callerSignal || timeoutSignal || undefined);
    res = await fetch('/api' + path, {
      headers: { 'Content-Type': 'application/json', 'X-JMW-Data-Source': selectedDataSource() },
      ...fetchOpts,
      // 服务端全部域名轮询预算 35s，此处留足余量；路由切换时也可主动取消。
      signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new Error('网络错误：' + (e.name === 'TimeoutError' ? '请求超时' : e.message));
  }
  let json = null;
  try { json = await res.json(); } catch (_) {}
  if (!res.ok) {
    const err = new Error((json && json.error) || `请求失败（${res.status}）`);
    err.status = res.status;
    err.needAuth = json && json.needAuth;
    if (res.status === 401 && requestEpoch === identityEpoch) {
      // 保留当前请求的 401 错误，不用自己的 abort 将它遮成 AbortError。
      // needAuth 401 = 站点访问门禁失效：只派发重新验证事件，由应用单实例
      // 拉起 gate；其余 401 = JM 登录失效：清旧账号 UI（头像等）。只有此前
      // 确实处于登录态时才派发 jmw-auth-changed，避免 me→401→通知→me 循环。
      const wasIdentified = lastIdentity !== null && lastIdentity !== undefined;
      lastIdentity = null;
      invalidateNavigation('unauthorized', '', { abortFlights: false });
      if (typeof window !== 'undefined') {
        if (json && json.needAuth) window.dispatchEvent(new CustomEvent('jmw-access-required'));
        else if (wasIdentified) window.dispatchEvent(new CustomEvent('jmw-auth-changed'));
      }
    }
    throw err;
  }
  return json;
}

export const api = {
  config: (signal) => request('/config', { signal }),
  setApiHost: (apiHost, signal) => mutation('/config/api-host', { method: 'POST', body: JSON.stringify({ apiHost }), signal }, 'host'),
  auth: async (password) => {
    const value = await request('/auth', { method: 'POST', body: JSON.stringify({ password }) });
    // 门禁验证成功即切换认证世代：验证前发出的旧请求迟到返回 needAuth 401
    // 时（requestEpoch 已过期）不再派发 jmw-access-required，gate 不会重开。
    // 同时清除验证前积累的未授权缓存状态。
    invalidateNavigation('all');
    return value;
  },

  me: async (signal) => {
    const token = identityEpoch;
    const value = await request('/me', { signal });
    if (token !== identityEpoch) throw navigationAbortError();
    const identity = identityOf(value?.user);
    const changed = lastIdentity !== undefined && identity !== lastIdentity;
    lastIdentity = identity;
    if (changed) invalidateNavigation('auth');
    return value;
  },
  login: (username, password) => changeAuth('/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => changeAuth('/logout', { method: 'POST' }),
  daily: (userId, signal) => request(`/daily?user_id=${userId}`, { signal }),
  dailyCheck: (userId, dailyId) => request('/daily_chk', { method: 'POST', body: JSON.stringify({ user_id: userId, daily_id: dailyId }) }),

  home: (signal) => request('/home', { signal }),
  promoteList: (id, page, signal) => request(`/promote_list?id=${encodeURIComponent(id)}&page=${page}`, { signal }),
  album: (id, signal) => request(`/album?id=${id}`, { signal }),
  cachedAlbum: (id, signal, options = {}) => navigationCache.read(
    albumCacheKey(id), (sharedSignal) => request(`/album?id=${id}`, { signal: sharedSignal }),
    { ...options, signal, validate: (value) => value?.data && typeof value.data === 'object' && !Array.isArray(value.data) },
  ),
  chapter: (id, shunt, signal) => request(`/chapter?id=${id}&shunt=${shunt || 1}`, { signal }),
  chapterAi: (aid, photoId, signal) => request(`/chapter-ai?aid=${encodeURIComponent(aid)}${photoId ? `&photoId=${encodeURIComponent(photoId)}` : ''}`, { signal }),
  search: (q, o, page, signal) => request(`/search?q=${encodeURIComponent(q)}&o=${o}&page=${page}`, { signal }),
  categories: (signal) => request('/categories', { signal }),
  categoryFilter: (c, o, page, signal) => request(`/categories_filter?c=${encodeURIComponent(c)}&o=${o}&page=${page}`, { signal }),
  week: (signal) => request('/week', { signal }),
  weekFilter: (id, type, page, signal) => request(`/week_filter?id=${id}&type=${type}&page=${page}`, { signal }),
  comments: (aid, page, signal) => request(`/comments?aid=${aid}&page=${page}`, { signal }),
  userComments: (uid, page, signal) => request(`/user_comments?uid=${uid}&page=${page}`, { signal }),
  comment: (aid, content, status, commentId) =>
    request('/comment', { method: 'POST', body: JSON.stringify({ aid, content, status, comment_id: commentId }) }),
  commentVote: (commentId, voteType = 'up') =>
    request('/comment_vote', { method: 'POST', body: JSON.stringify({ comment_id: commentId, vote_type: voteType }) }),
  like: (id) => mutation(`/like?id=${id}`, { method: 'POST' }, 'album', id),
  favorite: (aid) => mutation(`/favorite?aid=${aid}`, { method: 'POST' }, 'favorites', aid),
  favorites: (o, page, folderId = 0, signal) => request(`/favorites?o=${o}&page=${page}&folder_id=${folderId}`, { signal }),
  favoriteFolder: (type, folderId = '', folderName = '', aid = '') =>
    mutation('/favorite_folder', {
      method: 'POST',
      body: JSON.stringify({ type, folder_id: folderId, folder_name: folderName, aid }),
    }, 'favorites', aid),
  history: (page, signal) => request(`/history?page=${page}`, { signal }),
  deleteHistory: (id) => request('/history/delete', { method: 'POST', body: JSON.stringify({ id }) }),
};

// /forum 的固定分页大小与收藏/历史接口不同。上游当前每页返回 10 条，
// total 则是评论总数；不要复用用户列表的 20 条分页常量。
export const COMMENT_PAGE_SIZE = 10;

const COMMENT_HIDDEN_ELEMENT_RE = /<(script|style|template|noscript|iframe|object|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const COMMENT_BLOCK_END_RE = /<\/(?:address|article|aside|blockquote|div|dl|fieldset|figcaption|figure|footer|form|h[1-6]|header|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\s*>/gi;
const COMMENT_ENTITY_MAP = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
});

function decodeCommentEntities(value) {
  return value
    .replace(/&#(?:x([0-9a-f]{1,6})|([0-9]{1,7}));/gi, (_match, hex, decimal) => {
      const point = Number.parseInt(hex || decimal, hex ? 16 : 10);
      if (!Number.isInteger(point) || point <= 0 || point > 0x10ffff ||
          (point >= 0xd800 && point <= 0xdfff)) return '\ufffd';
      return String.fromCodePoint(point);
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi,
      (_match, name) => COMMENT_ENTITY_MAP[name.toLowerCase()]);
}

function commentImageAlt(attributes) {
  const match = String(attributes || '').match(
    /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i,
  );
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : '';
}

/**
 * 将上游评论 HTML 转成可安全放入 textContent 的正文。
 *
 * /forum 会用带 style 的 div 包装正文，并用 img 表示表情。这里不把任何
 * 上游字符串交给 innerHTML：块级标签转成换行，表情保留 alt 文本，其余
 * 标签和可执行/可加载的元素全部丢弃，最后只返回普通字符串。
 */
export function commentContentText(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = String(value)
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(COMMENT_HIDDEN_ELEMENT_RE, '')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<hr\b[^>]*>/gi, '\n')
    .replace(/<img\b([^>]*)>/gi, (_match, attributes) => commentImageAlt(attributes))
    .replace(COMMENT_BLOCK_END_RE, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeCommentEntities(text)
    .replace(/\u0000/g, '\ufffd')
    .replace(/[\t\f\v ]+\n/g, '\n')
    .replace(/\n[\t\f\v ]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** API 当前以 1 表示普通评论、2 表示官网默认隐藏的剧透评论。 */
export function isCommentSpoiler(value) {
  if (value === true) return true;
  const flag = String(value ?? '').trim().toLowerCase();
  return flag === '2' || flag === 'true';
}

/** 将 /forum 返回的头像文件名补齐到图片代理允许的 /media/users/ 路径。 */
export function commentAvatarSrc(value) {
  if (typeof value !== 'string') return '';
  const photo = value.trim();
  if (!photo) return '';
  if (/^https?:\/\//i.test(photo)) return '/api/img?u=' + encodeURIComponent(photo);
  if (photo.startsWith('//')) return '/api/img?u=' + encodeURIComponent('https:' + photo);
  if (photo.startsWith('/media/')) {
    return '/api/img?path=' + encodeURIComponent(photo.split('#', 1)[0]);
  }
  if (photo.startsWith('media/')) {
    return '/api/img?path=' + encodeURIComponent('/' + photo.split('#', 1)[0]);
  }
  const relative = photo.replace(/^\/+/, '');
  if (!/^[a-z0-9][\w.-]*\.(?:jpe?g|png|webp|gif)(?:[?#].*)?$/i.test(relative)) return '';
  const filename = relative.split(/[?#]/, 1)[0];
  return '/api/img?path=' + encodeURIComponent(`/media/users/${filename}`);
}

export function commentPageCount(total) {
  const count = Number(total);
  return Number.isFinite(count) && count > 0 ? Math.ceil(count / COMMENT_PAGE_SIZE) : 0;
}

/** 短页可靠地表示末页；满页时再用 total 判断是否继续请求。 */
export function commentPageHasMore({ total, page, itemCount } = {}) {
  const count = Number(itemCount);
  if (!Number.isFinite(count) || count <= 0 || count < COMMENT_PAGE_SIZE) return false;
  const currentPage = Math.max(1, Math.floor(Number(page) || 1));
  const knownTotal = total === null || total === undefined || String(total).trim() === ''
    ? NaN : Number(total);
  if (Number.isFinite(knownTotal) && knownTotal >= 0) {
    return knownTotal > currentPage * COMMENT_PAGE_SIZE;
  }
  return true;
}

/** 封面/头像等静态图地址：兼容上游常见的 image/cover 字段和多种地址格式。 */
export function imgSrc(item) {
  // 上游字段并非始终稳定：异常对象/数字不能直接调用 startsWith，
  // 否则任一列表卡片都会在渲染阶段中断。只接受字符串图片字段，
  // ID 回退也限制为十进制编号，避免把任意对象拼进代理路径。
  const rawImage = item && typeof item === 'object'
    ? [item.image, item.cover, item.cover_url, item.coverUrl]
      .find((value) => typeof value === 'string' && value.trim())
    : '';
  const img = typeof rawImage === 'string' ? rawImage.trim() : '';
  if (/^https?:\/\//i.test(img)) return '/api/img?u=' + encodeURIComponent(img);
  if (img.startsWith('//')) return '/api/img?u=' + encodeURIComponent('https:' + img);
  // 本地阅读记录可能已经保存过服务端代理地址，直接复用以保留其
  // 精确资源路径；它仍是同源 /api/img，会继续经过后端白名单校验。
  if (img.startsWith('/api/img?')) return img;
  if (img.startsWith('/media/')) return '/api/img?path=' + encodeURIComponent(img);
  if (/^[\w.-]+\.(jpg|jpeg|png|webp|gif)$/i.test(img)) {
    return '/api/img?path=' + encodeURIComponent('/media/albums/' + img);
  }
  // 详情接口可能不带 image：使用规范封面路径
  const rawId = item && typeof item === 'object' ? (item.id ?? item.aid ?? item.AID) : '';
  const id = /^\d{1,12}$/.test(String(rawId ?? '').trim()) ? String(rawId).trim() : '';
  return id ? `/api/img?path=${encodeURIComponent(`/media/albums/${id}_3x4.jpg`)}` : '';
}

export function chapterImgSrc(url) {
  const value = typeof url === 'string' ? url.trim() : '';
  return value ? '/api/img?u=' + encodeURIComponent(value) : '';
}
