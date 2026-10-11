// Hash 路由 history.state 约定与“原地替换 query”辅助函数。
// 独立模块可被 View 使用，避免从 app.js 反向导入造成循环依赖。

export const NAV_STATE_KEY = '__jmw_route_entry';

// 仅记录本标签页实际访问过的路由，不猜测 history.length 或写入业务数据。
// 章节切换保留 entry ID，因而返回距离不会随连续阅读增长。
const routeTrail = [];
let routeTrailIndex = -1;
const isComicRoute = (key) => /^#\/(?:album|read)\/\d+\/?(?:\?|$)/.test(key);
const isFavoritesRoute = (key) => /^#\/favorites\/?(?:\?|$)/.test(key);

export function rememberRouteEntry(entry) {
  if (!entry || !Number.isSafeInteger(entry.id) || typeof entry.key !== 'string') return;
  const index = routeTrail.findIndex((item) => item.id === entry.id);
  if (index >= 0) {
    routeTrail[index] = { id: entry.id, key: entry.key };
    routeTrailIndex = index;
  } else {
    routeTrail.splice(routeTrailIndex + 1);
    routeTrail.push({ id: entry.id, key: entry.key });
    if (routeTrail.length > 120) routeTrail.shift();
    routeTrailIndex = routeTrail.length - 1;
  }
}

export function clearRouteTrail() {
  routeTrail.length = 0;
  routeTrailIndex = -1;
}

export function favoritesReturnTarget() {
  const current = routeTrail[routeTrailIndex];
  const marker = typeof history !== 'undefined' ? history.state?.[NAV_STATE_KEY] : null;
  if (!current || !isComicRoute(current.key) || marker?.id !== current.id
      || marker.key !== hashRouteKey() || current.key !== marker.key) return null;
  for (let index = routeTrailIndex - 1; index >= 0; index--) {
    const entry = routeTrail[index];
    if (isFavoritesRoute(entry.key)) return { ...entry, delta: index - routeTrailIndex };
    // 从首页、搜索、我的等其他入口进入时，不能借用更早的收藏来源。
    if (!isComicRoute(entry.key)) break;
  }
  return null;
}

export function returnToFavorites() {
  const target = favoritesReturnTarget();
  if (!target) return false;
  try { history.go(target.delta); return true; } catch (_) { return false; }
}

export function hashRouteKey(hash = location.hash) {
  const value = String(hash || '#/');
  return value.startsWith('#') ? value : `#${value}`;
}

/**
 * 替换当前 Hash URL 而不创建 history entry，同时保留并更新路由 marker。
 * 适用于同一 View 内只同步筛选 query 的场景；直接 replaceState(null, ...)
 * 会让返回/前进无法识别该 entry。
 */
export function replaceCurrentRouteHash(hash) {
  const key = hashRouteKey(hash);
  const base = history.state && typeof history.state === 'object' ? history.state : {};
  const previous = base[NAV_STATE_KEY];
  const id = previous && Number.isSafeInteger(previous.id)
    ? previous.id : Math.floor(Date.now() + Math.random() * 1000);
  history.replaceState({ ...base, [NAV_STATE_KEY]: { id, key } }, '', key);
  // 筛选 query 原地变化时也更新来源 URL，但不新增历史项。
  if (routeTrail.some((entry) => entry.id === id)) rememberRouteEntry({ id, key });
}

/** 替换并立即渲染路由；用于章节切换和阅读器的兜底退出。 */
export function replaceRouteHash(hash) {
  replaceCurrentRouteHash(hash);
  window.dispatchEvent(new Event('hashchange'));
}
