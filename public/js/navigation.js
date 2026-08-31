// Hash 路由 history.state 约定与“原地替换 query”辅助函数。
// 独立模块可被 View 使用，避免从 app.js 反向导入造成循环依赖。

export const NAV_STATE_KEY = '__jmw_route_entry';

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
}
