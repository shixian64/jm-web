// 后端 API 封装：所有业务请求都走自部署的 /api/*（签名/解密/会话由服务端处理）
import { setting } from './store.js';

export function selectedDataSource() {
  return ['builtin', 'network', 'mixed'].includes(setting.dataSource) ? setting.dataSource : 'builtin';
}

async function request(path, opts = {}) {
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
    throw err;
  }
  return json;
}

export const api = {
  config: (signal) => request('/config', { signal }),
  setApiHost: (apiHost, signal) => request('/config/api-host', { method: 'POST', body: JSON.stringify({ apiHost }), signal }),
  auth: (password) => request('/auth', { method: 'POST', body: JSON.stringify({ password }) }),

  me: (signal) => request('/me', { signal }),
  login: (username, password) => request('/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request('/logout', { method: 'POST' }),
  daily: (userId, signal) => request(`/daily?user_id=${userId}`, { signal }),
  dailyCheck: (userId, dailyId) => request('/daily_chk', { method: 'POST', body: JSON.stringify({ user_id: userId, daily_id: dailyId }) }),

  home: (signal) => request('/home', { signal }),
  promoteList: (id, page, signal) => request(`/promote_list?id=${encodeURIComponent(id)}&page=${page}`, { signal }),
  album: (id, signal) => request(`/album?id=${id}`, { signal }),
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
  like: (id) => request(`/like?id=${id}`, { method: 'POST' }),
  favorite: (aid) => request(`/favorite?aid=${aid}`, { method: 'POST' }),
  favorites: (o, page, folderId = 0, signal) => request(`/favorites?o=${o}&page=${page}&folder_id=${folderId}`, { signal }),
  favoriteFolder: (type, folderId = '', folderName = '', aid = '') =>
    request('/favorite_folder', {
      method: 'POST',
      body: JSON.stringify({ type, folder_id: folderId, folder_name: folderName, aid }),
    }),
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
