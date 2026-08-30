// 本地存储：设置（对齐 jm-mobile 的 LocalSetting 项）+ 本地阅读历史 + 搜索历史

const KEY = {
  setting: 'jmw_setting',
  history: 'jmw_local_history',
  searchHistory: 'jmw_search_history',
};

const defaultSetting = {
  theme: 'auto',        // auto | light | dark
  shunt: '1',           // 图片分流 1-4
  readMode: 'scroll',   // scroll | page
  pageFit: 'contain',   // 翻页适配：contain | width
  prefetchCount: 3,     // 预加载数量
};

function readJSON(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v == null ? fallback : v;
  } catch (_) {
    return fallback;
  }
}

function writeJSON(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
}

export const setting = Object.assign({}, defaultSetting, readJSON(KEY.setting, {}));
const settingListeners = new Set();

export function updateSetting(patch) {
  Object.assign(setting, patch);
  writeJSON(KEY.setting, setting);
  applyTheme();
  settingListeners.forEach((fn) => fn(setting));
}

export function onSettingChange(fn) { settingListeners.add(fn); }

export function applyTheme() {
  document.documentElement.dataset.theme = setting.theme;
}

/* ---- 本地阅读历史 ---- */

export function getLocalHistory() {
  return readJSON(KEY.history, []);
}

export function recordLocalHistory(entry) {
  const list = getLocalHistory().filter((it) => !(it.aid === entry.aid && it.photoId === entry.photoId));
  list.unshift({ ...entry, ts: Date.now() });
  if (list.length > 200) list.length = 200;
  writeJSON(KEY.history, list);
}

export function recordAlbumHistory(entry) {
  // 只按专辑记录（详情页/继续阅读用）
  const list = getLocalHistory();
  const old = list.find((it) => it.aid === entry.aid);
  if (old) {
    if (entry.photoId) old.photoId = entry.photoId;
    if (entry.page != null) old.page = entry.page;
    if (entry.total != null) old.total = entry.total;
    old.ts = Date.now();
    writeJSON(KEY.history, list);
  } else {
    recordLocalHistory({ ...entry, ts: Date.now() });
  }
}

export function clearLocalHistory() {
  localStorage.removeItem(KEY.history);
}

/* ---- 搜索历史 ---- */

export function getSearchHistory() {
  return readJSON(KEY.searchHistory, []);
}

export function addSearchHistory(q) {
  q = (q || '').trim();
  if (!q) return;
  const list = getSearchHistory().filter((it) => it !== q);
  list.unshift(q);
  if (list.length > 12) list.length = 12;
  writeJSON(KEY.searchHistory, list);
}

export function clearSearchHistory() {
  localStorage.removeItem(KEY.searchHistory);
}
