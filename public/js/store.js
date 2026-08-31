// 本地存储：设置（对齐 jm-mobile 的 LocalSetting 项）+ 本地阅读历史 + 搜索历史

const KEY = {
  setting: 'jmw_setting',
  history: 'jmw_local_history',
  searchHistory: 'jmw_search_history',
  personas: 'jmw_personas',
  aiSessions: 'jmw_ai_sessions',
};
export const SETTING_STORAGE_KEY = KEY.setting;
const LOCAL_SECRET_KEYS = new Set(['jmw_lock_credential', 'jmw_webauthn_credential']);

const defaultSetting = {
  theme: 'auto',        // auto | light | dark
  palette: 'default',   // default | ocean | sunset | forest | lavender | custom
  customColors: { primary: '#e5588a', secondary: '#7c6ee6', tertiary: '#3f9e8f', error: '#c93f55' },
  shunt: '1',           // 图片分流 1-4
  readMode: 'scroll',   // scroll | page | pageReverse | tap
  pageFit: 'contain',   // 翻页适配：contain | width
  prefetchCount: 3,     // 预加载数量
  brightnessFollowSystem: true,
  brightness: 1,
  showPageNumber: true,
  keepAwake: false,
  supportZoom: true,
  readerToolbarAutoHide: true,
  tapMode: 'default',
  readMemoryOptEnabled: false,
  readDecodeConcurrency: 2,
  blockedTagList: [],
  blockedTagTemplateList: [],
  homeExcludedTags: [],
  autoSignInEnabled: false,
  clipboardAutoDetectEnabled: false,
  showAiEntry: false,
  aiSearchProvider: 'auto',
  aiSearchDepth: 'basic',
  aiSearchResultCount: 5,
  aiAutoSearch: true,
  aiSearxngLanguage: 'zh-CN',
  aiSearxngCategories: 'general',
  dataSource: 'builtin',
  preferenceRecommendEnabled: false,
  recommendSource: 'builtin', // builtin：收藏标签本地计算；network：账号网络首页
  cacheIntegrityCheckMode: 'off', // off | partial | full
  appLockEnabled: false,
  appLockMode: 'pin',
  appLockUnlockRule: 'any',
  appLockRequiredMethods: [],
  appLockUseBiometric: false,
  appLockOnHidden: true,
  privacyMode: false,
  onboardingCompleted: false,
  nsfwWarningDismissed: false,
  homeGridColumns: 0,
  collectGridColumns: 0,
  downloadGridColumns: 0,
  historyGridColumns: 0,
  searchGridColumns: 0,
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

/**
 * 应用其他标签页通过 StorageEvent 写入的设置，不回写 localStorage，避免
 * 多标签之间形成写入回环。键被删除时回到默认值；损坏的跨标签写入则
 * 保留当前内存设置，避免意外关闭已经生效的应用锁。
 */
export function syncSettingFromStorage(serializedValue) {
  let restored = {};
  if (serializedValue != null) {
    try {
      const parsed = JSON.parse(serializedValue);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      restored = parsed;
    } catch (_) { return false; }
  }
  const known = {};
  for (const key of Object.keys(defaultSetting)) {
    if (Object.prototype.hasOwnProperty.call(restored, key)) known[key] = restored[key];
  }
  for (const key of Object.keys(setting)) delete setting[key];
  Object.assign(setting, defaultSetting, known);
  applyTheme();
  settingListeners.forEach((fn) => fn(setting));
  return true;
}

export function onSettingChange(fn) { settingListeners.add(fn); }

export function applyTheme() {
  document.documentElement.dataset.theme = setting.theme;
  document.documentElement.dataset.palette = setting.palette || 'default';
  const palette = {
    ocean: ['#2d7ff0', '#12a9a0', '#4772ca', '#d4475e'],
    sunset: ['#e45b42', '#d88b24', '#a64f86', '#c43e52'],
    forest: ['#2f875e', '#6d8b35', '#39716e', '#be4351'],
    lavender: ['#7c64d5', '#a3569a', '#5b77c8', '#c3425a'],
  }[setting.palette];
  const colors = setting.palette === 'custom' ? setting.customColors : palette && {
    primary: palette[0], secondary: palette[1], tertiary: palette[2], error: palette[3],
  };
  for (const [key, css] of Object.entries({ primary: '--primary', secondary: '--secondary', tertiary: '--tertiary', error: '--danger' })) {
    if (colors && /^#[0-9a-f]{6}$/i.test(colors[key] || '')) document.documentElement.style.setProperty(css, colors[key]);
    else document.documentElement.style.removeProperty(css);
  }
  for (const [key, css] of Object.entries({
    homeGridColumns: '--home-grid-columns', collectGridColumns: '--collect-grid-columns',
    downloadGridColumns: '--download-grid-columns', historyGridColumns: '--history-grid-columns',
    searchGridColumns: '--search-grid-columns',
  })) {
    const value = Math.max(0, Math.min(6, Number(setting[key]) || 0));
    if (value) document.documentElement.style.setProperty(css, String(value));
    else document.documentElement.style.removeProperty(css);
  }
  document.documentElement.classList.toggle('privacy-mode', !!setting.privacyMode);
  document.documentElement.classList.toggle('fixed-download-grid', Number(setting.downloadGridColumns) > 0);
  document.title = setting.privacyMode ? '阅读空间' : 'JM Web';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const prefersDark = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = setting.theme === 'dark' || (setting.theme === 'auto' && prefersDark);
  meta.setAttribute('content', dark ? '#0c0e13' : '#f5f6f8');
}

export function getPersonas() { return readJSON(KEY.personas, []); }
export function savePersonas(value) { writeJSON(KEY.personas, Array.isArray(value) ? value : []); }
export function getAiSessions() { return readJSON(KEY.aiSessions, []); }
export function saveAiSessions(value) { writeJSON(KEY.aiSessions, Array.isArray(value) ? value : []); }

export function exportLocalState() {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith('jmw_') || LOCAL_SECRET_KEYS.has(key)) continue;
    let value = localStorage.getItem(key);
    if (key === KEY.setting) {
      try {
        value = JSON.stringify({
          ...JSON.parse(value),
          appLockEnabled: false,
          appLockUseBiometric: false,
          appLockUnlockRule: 'any',
          appLockRequiredMethods: [],
        });
      } catch (_) {}
    }
    out[key] = value;
  }
  return out;
}

export function importLocalState(data, options = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('备份数据格式错误');
  const allowed = Array.isArray(options.keys) ? new Set(options.keys) : null;
  for (const [key, value] of Object.entries(data)) {
    if (allowed && !allowed.has(key)) continue;
    if (!key.startsWith('jmw_') || LOCAL_SECRET_KEYS.has(key) || typeof value !== 'string' || value.length > 10 * 1024 * 1024) continue;
    if (key === KEY.setting) {
      try {
        const restored = JSON.parse(value);
        localStorage.setItem(key, JSON.stringify({
          ...restored,
          appLockEnabled: false,
          appLockUseBiometric: false,
          appLockUnlockRule: 'any',
          appLockRequiredMethods: [],
        }));
      } catch (_) {}
    } else localStorage.setItem(key, value);
  }
}

export function comicTags(item) {
  const raw = [item?.tags, item?.tag, item?.author, item?.category, item?.category_sub?.title]
    .flat(Infinity).filter(Boolean).map((x) => typeof x === 'object' ? (x.name || x.title || '') : String(x));
  return raw.flatMap((x) => x.split(/[\s,，、/|]+/)).map((x) => x.trim().toLowerCase()).filter(Boolean);
}

export function isComicBlocked(item, home = false) {
  const blocked = [...(Array.isArray(setting.blockedTagList) ? setting.blockedTagList : []),
    ...(home && Array.isArray(setting.homeExcludedTags) ? setting.homeExcludedTags : [])]
    .map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  if (!blocked.length) return false;
  const tags = comicTags(item);
  return blocked.some((x) => tags.includes(x));
}

/* ---- 本地阅读历史 ---- */

export function getLocalHistory() {
  return readJSON(KEY.history, []);
}

export function recordLocalHistory(entry) {
  const list = getLocalHistory().filter((it) => !(String(it.aid || '') === String(entry.aid || '')
    && String(it.photoId || '') === String(entry.photoId || '')));
  list.unshift({ ...entry, ts: Date.now() });
  if (list.length > 200) list.length = 200;
  writeJSON(KEY.history, list);
}

export function recordAlbumHistory(entry) {
  // 只按专辑记录（详情页/继续阅读用）
  const aid = String(entry.aid || '');
  const list = getLocalHistory();
  const old = list.find((it) => String(it.aid || '') === aid) || {};
  const next = { ...old, ...entry, aid: entry.aid, ts: Date.now() };
  const rest = list.filter((it) => String(it.aid || '') !== aid);
  rest.unshift(next);
  if (rest.length > 200) rest.length = 200;
  writeJSON(KEY.history, rest);
}

export function clearLocalHistory() {
  localStorage.removeItem(KEY.history);
}

export function removeLocalHistory(aid, photoId) {
  const albumId = String(aid || '');
  const chapterId = photoId == null ? null : String(photoId || '');
  const list = getLocalHistory().filter((item) => {
    if (String(item.aid || '') !== albumId) return true;
    return chapterId != null && String(item.photoId || '') !== chapterId;
  });
  writeJSON(KEY.history, list);
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
