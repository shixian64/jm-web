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

/** 封面/头像等静态图地址：API 的 image 字段可能是绝对地址、//xx、/path 或文件名 */
export function imgSrc(item) {
  // 上游字段并非始终稳定：异常对象/数字不能直接调用 startsWith，
  // 否则任一列表卡片都会在渲染阶段中断。只接受字符串图片字段，
  // ID 回退也限制为十进制编号，避免把任意对象拼进代理路径。
  const rawImage = item && typeof item === 'object' ? item.image : '';
  const img = typeof rawImage === 'string' ? rawImage.trim() : '';
  if (/^https?:\/\//i.test(img)) return '/api/img?u=' + encodeURIComponent(img);
  if (img.startsWith('//')) return '/api/img?u=' + encodeURIComponent('https:' + img);
  if (img.startsWith('/media/')) return '/api/img?path=' + encodeURIComponent(img);
  if (/^[\w.-]+\.(jpg|jpeg|png|webp|gif)$/i.test(img)) {
    return '/api/img?path=' + encodeURIComponent('/media/albums/' + img);
  }
  // 详情接口可能不带 image：使用规范封面路径
  const rawId = item && typeof item === 'object' ? (item.id ?? item.aid) : '';
  const id = /^\d{1,12}$/.test(String(rawId ?? '').trim()) ? String(rawId).trim() : '';
  return id ? `/api/img?path=${encodeURIComponent(`/media/albums/${id}_3x4.jpg`)}` : '';
}

export function chapterImgSrc(url) {
  const value = typeof url === 'string' ? url.trim() : '';
  return value ? '/api/img?u=' + encodeURIComponent(value) : '';
}
