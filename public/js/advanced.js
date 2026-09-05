// 高级功能：安全锁、备份、标签排除、主题调色、AI、DoH、日志与维护。
import { api } from './api.js';
import { h, toast, errorBox, loadingBox, shouldAutoFocusEditable } from './ui.js';
import { icon } from './icons.js';
import {
  setting, updateSetting, getPersonas, savePersonas, getAiSessions, saveAiSessions,
  exportLocalState, importLocalState, SETTING_STORAGE_KEY, syncSettingFromStorage,
} from './store.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const LOCK_KEY = 'jmw_lock_credential';
const BIO_KEY = 'jmw_webauthn_credential';
let runtimeInstalled = false;
let unlockedTasksDeferred = false;
let locked = false;
let lockOverlay = null;
let lastClipboardValue = '';
let autoSignInStarted = false;
let recoveryInProgress = false;
let storageReconcileTimer = null;
const lockBackgroundState = new Map();

function isolateLockBackground(on) {
  if (!on) {
    for (const [node, state] of lockBackgroundState) {
      node.inert = state.inert;
      if (state.ariaHidden == null) node.removeAttribute('aria-hidden');
      else node.setAttribute('aria-hidden', state.ariaHidden);
    }
    lockBackgroundState.clear();
    return;
  }
  for (const node of document.body.children) {
    if (node === lockOverlay || lockBackgroundState.has(node)) continue;
    lockBackgroundState.set(node, { inert: !!node.inert, ariaHidden: node.getAttribute('aria-hidden') });
    node.inert = true;
    node.setAttribute('aria-hidden', 'true');
  }
}

function isAbort(error) { return !!(error && error.name === 'AbortError'); }
function hasSecureCrypto() {
  return !!(globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function'
    && globalThis.crypto.subtle && typeof globalThis.crypto.subtle.importKey === 'function');
}
function requireSecureCrypto() {
  if (!hasSecureCrypto()) {
    throw new Error('当前连接无法使用浏览器安全加密，请改用 HTTPS（localhost 除外）后重试');
  }
  return globalThis.crypto;
}
function randomBytes(size = 16) {
  const out = new Uint8Array(size);
  requireSecureCrypto().getRandomValues(out);
  return out;
}
function toB64(bytes) {
  const input = new Uint8Array(bytes); let binary = '';
  for (let i = 0; i < input.length; i += 0x8000) binary += String.fromCharCode(...input.subarray(i, i + 0x8000));
  return btoa(binary);
}
function fromB64(value) { return Uint8Array.from(atob(value), (x) => x.charCodeAt(0)); }
function strictB64(value, label, { min = 0, max = Infinity, exact = 0 } = {}) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(max * 4 / 3) + 8
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label}格式错误`);
  }
  let bytes;
  try { bytes = fromB64(value); } catch (_) { throw new Error(`${label}格式错误`); }
  if ((exact && bytes.length !== exact) || bytes.length < min || bytes.length > max) {
    throw new Error(`${label}长度错误`);
  }
  return bytes;
}
function uid() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

async function jsonRequest(path, options = {}) {
  const response = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let data = null;
  try { data = await response.json(); } catch (_) {}
  if (!response.ok) {
    const error = new Error(data?.error || `请求失败（${response.status}）`);
    error.status = response.status;
    error.needAuth = data?.needAuth === true;
    throw error;
  }
  return data;
}

function isViewInactive(ctx) {
  return !!(ctx && (ctx.signal?.aborted || (typeof ctx.isActive === 'function' && !ctx.isActive())));
}

function operationalErrorMessage(error, fallback = '运维操作失败') {
  if (Number(error?.status) === 401) return '需要先通过站点访问口令验证。';
  if (Number(error?.status) === 403) return '当前连接没有站点管理员权限；容器或反向代理部署请配置 ACCESS_PASSWORD。';
  if (isAbort(error)) return '';
  return error?.message || fallback;
}

function safeUpdateUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com'
        || url.username || url.password || url.pathname === '/') return '';
    return url.href;
  } catch (_) {
    return '';
  }
}

function pageTitle(title, subtitle = '') {
  return h('div', { class: 'list-head' }, h('h2', null, title), subtitle ? h('p', { class: 'hint' }, subtitle) : null);
}

function groupTitle(title) {
  return h('div', { class: 'setting-item setting-section-title' }, h('div', { class: 'lab' }, title));
}

function menuLink(label, href, description = '') {
  return h('a', { class: 'setting-item advanced-link', href },
    h('div', null, h('div', { class: 'lab' }, label), description ? h('div', { class: 'hint' }, description) : null),
    h('span', { class: 'arr', 'aria-hidden': 'true' }, '›'));
}

function toggleRow(label, key, description = '') {
  const input = h('input', { type: 'checkbox', checked: !!setting[key] });
  input.addEventListener('change', () => updateSetting({ [key]: input.checked }));
  return h('label', { class: 'setting-row toggle-row' },
    h('div', null, h('div', { class: 'lab' }, label), description ? h('div', { class: 'hint' }, description) : null), input);
}

export function advancedHubView(root) {
  const recommendToggle = h('input', { type: 'checkbox', checked: !!setting.preferenceRecommendEnabled });
  const recommendSource = h('select', { class: 'input', disabled: !setting.preferenceRecommendEnabled },
    h('option', { value: 'builtin', selected: setting.recommendSource !== 'network' }, '收藏标签（内置搜索）'),
    h('option', { value: 'network', selected: setting.recommendSource === 'network' }, '账号网络首页'));
  recommendToggle.onchange = () => {
    updateSetting({ preferenceRecommendEnabled: recommendToggle.checked });
    recommendSource.disabled = !recommendToggle.checked;
  };
  recommendSource.onchange = () => updateSetting({ recommendSource: recommendSource.value === 'network' ? 'network' : 'builtin' });
  const page = h('div', { class: 'page settings-page advanced-hub-page', style: 'max-width:720px' },
    pageTitle('完整功能中心', 'Web 等价实现集中在这里；设备专属能力会使用浏览器标准 API。'),
    h('div', { class: 'setting-group' },
      groupTitle('内容与智能'),
      menuLink('缓存与离线下载', '#/downloads', '后台任务、离线阅读、导出与缓存清理'),
      menuLink('AI 对话', '#/ai', '多会话、人格、流式回答、联网搜索'),
      menuLink('人格面具', '#/personas', '设置 AI 的名称、职业、性格与输出格式'),
    ),
    h('div', { class: 'setting-group' },
      groupTitle('个性化与隐私'),
      menuLink('标签排除', '#/blocked-tags', '搜索排除模板与首页内容过滤'),
      menuLink('调色板与布局', '#/palette', '预设/自定义颜色与各页面网格列数'),
      menuLink('应用锁与隐私', '#/security', 'PIN、图案、设备生物识别及隐私模式'),
      menuLink('数据备份与恢复', '#/backup', 'JSON 或 AES-GCM 加密备份'),
    ),
    h('div', { class: 'setting-group' },
      groupTitle('连接与维护'),
      menuLink('网络与 DoH', '#/network', 'DNS over HTTPS、线路测速与数据源状态'),
      menuLink('缓存维护', '#/cache', '空间统计、完整性检查和清理'),
      menuLink('提取漫画编码', '#/extract', '从剪贴板或文本中识别 JM 编号'),
      menuLink('运行日志', '#/logs', '查看服务器最近请求和错误'),
      menuLink('更新与关于', '#/about', '版本、健康状态与更新检查'),
    ),
    h('div', { class: 'setting-group' },
      groupTitle('自动化与入口'),
      h('div', { class: 'setting-item' }, toggleRow('自动签到', 'autoSignInEnabled', '已登录时启动后检查当天状态并自动签到。')),
      h('div', { class: 'setting-item' }, toggleRow('剪贴板编号检测', 'clipboardAutoDetectEnabled', '粘贴文本时识别 JM 编号；不会在进入页面或切回前台时主动读取系统剪贴板。')),
      h('div', { class: 'setting-item' }, toggleRow('在“我的”显示 AI 入口', 'showAiEntry')),
      h('div', { class: 'setting-item' }, h('label', { class: 'setting-row toggle-row' },
        h('div', null, h('div', { class: 'lab' }, '首页偏好推荐'),
          h('div', { class: 'hint' }, '登录后从有限收藏样本生成；关闭时不发起额外请求。')), recommendToggle),
        h('label', { class: 'setting-row', style: 'margin-top:10px' }, h('span', { class: 'hint' }, '推荐来源'), recommendSource)),
    ),
  );
  root.append(page);
}

/* ------------------------------ 标签排除 ------------------------------ */

function tagEditor(title, key, description) {
  const wrap = h('div', { class: 'setting-item tag-editor' });
  const input = h('input', { class: 'input', placeholder: '输入标签，回车添加' });
  const chips = h('div', { class: 'chips' });
  const render = () => {
    chips.replaceChildren(...(Array.isArray(setting[key]) ? setting[key] : []).map((tag) => h('button', {
      class: 'chip', type: 'button', title: '点击删除', onclick: () => {
        updateSetting({ [key]: setting[key].filter((x) => x !== tag) }); render();
      },
    }, tag, ' ×')));
  };
  const add = () => {
    const value = input.value.trim();
    if (!value) return;
    const next = [...new Set([...(Array.isArray(setting[key]) ? setting[key] : []), value])].slice(0, 100);
    updateSetting({ [key]: next }); input.value = ''; render();
  };
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } });
  wrap.append(h('div', { class: 'lab' }, title), h('div', { class: 'hint' }, description),
    h('div', { class: 'setting-inline-form' }, input, h('button', { class: 'btn', onclick: add }, '添加')), chips);
  render();
  return wrap;
}

export function blockedTagsView(root) {
  const page = h('div', { class: 'page settings-page', style: 'max-width:720px' },
    pageTitle('标签排除'),
    h('div', { class: 'setting-group' }, tagEditor('全局排除标签', 'blockedTagList', '搜索和列表默认隐藏这些标签的漫画。')),
    h('div', { class: 'setting-group' }, tagEditor('首页排除标签', 'homeExcludedTags', '仅过滤首页推荐。')),
  );
  const templates = h('div', { class: 'setting-group' });
  const renderTemplates = () => {
    templates.replaceChildren(h('div', { class: 'setting-item' }, h('div', { class: 'lab' }, '排除模板')));
    const list = Array.isArray(setting.blockedTagTemplateList) ? setting.blockedTagTemplateList : [];
    list.forEach((item, index) => templates.append(h('div', { class: 'setting-item setting-row' },
      h('div', null, h('div', { class: 'lab' }, item.name || `模板 ${index + 1}`), h('div', { class: 'hint' }, (item.tags || []).join('、'))),
      h('button', { class: 'btn ghost', onclick: () => { updateSetting({ blockedTagTemplateList: list.filter((_, i) => i !== index) }); renderTemplates(); } }, '删除'))));
    const name = h('input', { class: 'input', placeholder: '模板名' });
    const tags = h('input', { class: 'input', placeholder: '标签，用逗号分隔' });
    templates.append(h('div', { class: 'setting-item' }, h('div', { style: 'display:grid;gap:8px' }, name, tags,
      h('button', { class: 'btn', onclick: () => {
        const item = { name: name.value.trim(), tags: tags.value.split(/[,，、]/).map((x) => x.trim()).filter(Boolean) };
        if (!item.name || !item.tags.length) return toast('请输入模板名和标签');
        updateSetting({ blockedTagTemplateList: [...list, item].slice(0, 30) }); renderTemplates();
      } }, '保存模板'))));
  };
  renderTemplates();
  page.append(templates);
  root.append(page);
}

/* ------------------------------ 调色板 ------------------------------ */

export function paletteView(root) {
  const page = h('div', { class: 'page settings-page', style: 'max-width:720px' }, pageTitle('调色板与布局'));
  const presets = [['default', '默认'], ['ocean', '海洋'], ['sunset', '日落'], ['forest', '森林'], ['lavender', '薰衣草'], ['custom', '自定义']];
  const preset = h('select', { class: 'input' }, presets.map(([value, label]) => h('option', { value, selected: setting.palette === value }, label)));
  preset.onchange = () => updateSetting({ palette: preset.value });
  const colorWrap = h('div', { class: 'setting-item palette-colors' });
  const renderColors = () => {
    const current = setting.customColors || {};
    colorWrap.replaceChildren(h('div', { class: 'lab' }, '自定义四色'), ...[
      ['primary', '主色'], ['secondary', '辅助色'], ['tertiary', '第三色'], ['error', '错误色'],
    ].map(([key, label]) => {
      const input = h('input', { type: 'color', value: current[key] || '#e5588a' });
      input.oninput = () => updateSetting({ palette: 'custom', customColors: { ...(setting.customColors || {}), [key]: input.value } });
      return h('label', { class: 'setting-row' }, label, input);
    }));
  };
  renderColors();
  page.append(h('div', { class: 'setting-group' }, h('div', { class: 'setting-item setting-row' }, h('div', { class: 'lab' }, '配色预设'), preset), colorWrap));
  const grid = h('div', { class: 'setting-group' }, h('div', { class: 'setting-item' }, h('div', { class: 'lab' }, '网格列数'), h('div', { class: 'hint' }, '0 表示响应式自适应。')));
  for (const [key, label] of [['homeGridColumns', '首页'], ['collectGridColumns', '收藏'], ['downloadGridColumns', '缓存'], ['historyGridColumns', '历史'], ['searchGridColumns', '搜索']]) {
    const input = h('input', { class: 'input', type: 'number', min: 0, max: 6, value: Number(setting[key]) || 0 });
    input.onchange = () => updateSetting({ [key]: Math.max(0, Math.min(6, Number(input.value) || 0)) });
    grid.append(h('label', { class: 'setting-item setting-row' }, label, input));
  }
  grid.append(h('div', { class: 'setting-item' }, toggleRow('隐私伪装模式', 'privacyMode', '隐藏页面标题中的 JM 标识，并在窗口失焦时遮罩。')));
  page.append(grid);
  root.append(page);
}

/* ------------------------------ 本地应用锁 ------------------------------ */

async function deriveSecret(secret, salt, iterations = 180000) {
  const secure = requireSecureCrypto();
  const material = await secure.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits']);
  return secure.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, 256);
}

function readLockCredentials() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(LOCK_KEY) || 'null'); } catch (_) { return {}; }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
  if (saved.version === 2 && saved.credentials && typeof saved.credentials === 'object') {
    return Object.fromEntries(['pin', 'pattern']
      .filter((type) => saved.credentials[type] && typeof saved.credentials[type] === 'object')
      .map((type) => [type, saved.credentials[type]]));
  }
  // v1 只保存一个凭据；读取时兼容，下一次保存任一方式后自动升级为 v2。
  return ['pin', 'pattern'].includes(saved.type) ? { [saved.type]: saved } : {};
}

function hasLockCredential(type = '') {
  const credentials = readLockCredentials();
  return type ? !!credentials[type] : Object.keys(credentials).length > 0;
}

function configuredLockMethods() {
  const methods = Object.keys(readLockCredentials()).filter((type) => ['pin', 'pattern'].includes(type));
  if (setting.appLockUseBiometric && localStorage.getItem(BIO_KEY)) methods.push('biometric');
  return methods;
}

function clearLocalLockCredentials() {
  localStorage.removeItem(LOCK_KEY);
  localStorage.removeItem(BIO_KEY);
  updateSetting({
    appLockEnabled: false,
    appLockUseBiometric: false,
    appLockRequiredMethods: [],
    appLockUnlockRule: 'any',
  });
}

function releaseLocalLock({ notify = true } = {}) {
  const wasLocked = locked || !!lockOverlay;
  locked = false;
  isolateLockBackground(false);
  lockOverlay?.remove();
  lockOverlay = null;
  if (notify && wasLocked) window.dispatchEvent(new CustomEvent('jmw-local-unlocked'));
}

function setRecoveryStatus(button, message, isError = false) {
  const card = button?.closest?.('.local-lock-card') || lockOverlay?.querySelector('.local-lock-card');
  if (!card) return;
  let status = card.querySelector('.local-lock-recovery-status');
  if (!status) {
    status = h('div', { class: 'hint local-lock-recovery-status', role: 'status', 'aria-live': 'polite' });
    card.append(status);
  }
  status.textContent = message || '';
  status.style.color = isError ? 'var(--danger)' : '';
}

/**
 * 锁屏上的灾难恢复必须是破坏性的“退出并清机”，不能退化成删除凭据后
 * 直接进入应用。所有外部清理成功前始终保留当前锁屏；失败时也不 reload。
 */
async function recoverLocalLock(event) {
  if (recoveryInProgress) return false;
  const phrase = '清除本机全部数据';
  const typed = prompt(
    `这是灾难恢复操作：会退出 JM 账号，并永久删除当前浏览器的全部 JM Web 设置、历史、AI 会话、下载任务和离线正文。\n\n请输入“${phrase}”确认：`,
  );
  const button = event?.currentTarget || null;
  if (typed == null) return false;
  if (typed.trim() !== phrase) {
    setRecoveryStatus(button, `确认短语不匹配；未清除任何数据，请完整输入“${phrase}”。`, true);
    return false;
  }

  recoveryInProgress = true;
  const controls = [...(lockOverlay?.querySelectorAll('button, input') || [])];
  const disabledState = controls.map((control) => control.disabled);
  controls.forEach((control) => { control.disabled = true; });
  if (button) button.textContent = '正在退出并清除本机数据…';
  setRecoveryStatus(button, '正在退出账号并清除离线数据，请勿关闭页面…');
  try {
    // 必须先得到服务端明确成功响应；离线或退出失败时不能绕过本地锁。
    await api.logout();
    const { downloads } = await import('./downloads.js');
    if (!downloads || typeof downloads.clearAll !== 'function') throw new Error('离线清理组件不可用');
    const cleared = await downloads.clearAll();
    if (cleared !== true) throw new Error('离线数据正在被其他清理操作占用，请稍后重试');

    const localKeys = () => {
      const keys = [];
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (key?.startsWith('jmw_')) keys.push(key);
      }
      return keys;
    };
    let keys = localKeys();
    // 最后才移除锁配置；即使前面的普通数据删除意外失败，刷新后仍会保持锁定。
    const lockKeys = new Set([LOCK_KEY, BIO_KEY, SETTING_STORAGE_KEY]);
    for (const key of keys.filter((item) => !lockKeys.has(item))) localStorage.removeItem(key);
    // 另一标签可能恰好在第一轮快照之后写入普通数据；锁配置移除前再收口一次。
    keys = localKeys();
    for (const key of keys.filter((item) => !lockKeys.has(item))) localStorage.removeItem(key);
    for (const key of [LOCK_KEY, BIO_KEY, SETTING_STORAGE_KEY]) localStorage.removeItem(key);
    const remaining = localKeys();
    if (remaining.length) throw new Error('部分本机数据无法删除');

    setRecoveryStatus(button, '清理完成，正在重新载入…');
    location.reload();
    return true;
  } catch (error) {
    // locked/overlay 均保持原状；用户仍须用有效凭据解锁或重新执行灾难恢复。
    setRecoveryStatus(button, `灾难恢复失败，应用仍保持锁定：${error.message || '未知错误'}`, true);
    controls.forEach((control, index) => { control.disabled = disabledState[index]; });
    if (button) button.textContent = '清除本机全部数据、退出账号并重新开始';
    recoveryInProgress = false;
    return false;
  }
}

async function saveLockSecret(secret, type) {
  if (!['pin', 'pattern'].includes(type)) throw new Error('锁定方式不受支持');
  if (secret.length < 4 || secret.length > 128) throw new Error('凭据长度必须为 4–128 位');
  const salt = randomBytes(16);
  const hash = await deriveSecret(secret, salt);
  const credentials = readLockCredentials();
  credentials[type] = { type, salt: toB64(salt), hash: toB64(hash), iterations: 180000 };
  localStorage.setItem(LOCK_KEY, JSON.stringify({ version: 2, credentials }));
}

async function verifyLockSecret(secret, type) {
  const saved = readLockCredentials()[type];
  const iterations = Number(saved?.iterations);
  if (!saved) return false;
  if (saved.type !== type || !['pin', 'pattern'].includes(type) || !Number.isInteger(iterations)
      || iterations < 10000 || iterations > 1000000) {
    throw new Error('本地锁凭据已损坏，请清除后重新设置');
  }
  const salt = strictB64(saved.salt, '锁凭据盐值', { min: 8, max: 64 });
  const expected = strictB64(saved.hash, '锁凭据摘要', { exact: 32 });
  const actual = new Uint8Array(await deriveSecret(secret, salt, iterations));
  if (actual.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < actual.length; i++) mismatch |= actual[i] ^ expected[i];
  return mismatch === 0;
}

async function registerBiometric() {
  requireSecureCrypto();
  if (!window.PublicKeyCredential || !navigator.credentials?.create) throw new Error('当前浏览器或连接不支持设备验证，请确认已使用 HTTPS');
  const credential = await navigator.credentials.create({ publicKey: {
    challenge: randomBytes(32), rp: { name: 'JM Web' }, user: { id: randomBytes(16), name: 'local-user', displayName: '本地用户' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' }, timeout: 60000,
  } });
  if (!credential) throw new Error('设备验证注册失败');
  localStorage.setItem(BIO_KEY, toB64(credential.rawId));
}

async function verifyBiometric() {
  const value = localStorage.getItem(BIO_KEY);
  if (!value || !navigator.credentials?.get) return false;
  const credentialId = strictB64(value, '设备凭据', { min: 8, max: 1024 });
  const credential = await navigator.credentials.get({ publicKey: {
    challenge: randomBytes(32), allowCredentials: [{ type: 'public-key', id: credentialId }],
    userVerification: 'required', timeout: 60000,
  } });
  return !!credential;
}

function patternPad(onDone) {
  const selected = [];
  const label = h('div', { class: 'hint' }, '依次点击至少 4 个点');
  const grid = h('div', { class: 'pattern-grid' });
  const refresh = () => { label.textContent = selected.length ? `图案：${selected.map((x) => x + 1).join(' → ')}` : '依次点击至少 4 个点'; };
  for (let i = 0; i < 9; i++) grid.append(h('button', { class: 'pattern-dot', type: 'button', onclick: (event) => {
    if (selected.includes(i)) return;
    selected.push(i); event.currentTarget.classList.add('on'); refresh();
  } }, String(i + 1)));
  return h('div', null, grid, label, h('div', { class: 'setting-actions' },
    h('button', { class: 'btn', onclick: () => { selected.length = 0; grid.querySelectorAll('.on').forEach((x) => x.classList.remove('on')); refresh(); } }, '重置'),
    h('button', { class: 'btn primary', onclick: () => selected.length >= 4 ? onDone(selected.join('')) : toast('至少连接 4 个点') }, '确认图案')));
}

export function securityView(root) {
  const page = h('div', { class: 'page settings-page', style: 'max-width:680px' }, pageTitle('应用锁与隐私'));
  const password = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: '设置 4–128 位 PIN 或口令' });
  const methodStatus = h('div', { class: 'hint' });
  const requiredWrap = h('div', { class: 'setting-item' });
  const enabledToggle = h('input', { type: 'checkbox', checked: !!setting.appLockEnabled });
  const refreshMethods = () => {
    const configured = configuredLockMethods();
    const labels = { pin: 'PIN / 口令', pattern: '图案', biometric: '设备验证' };
    methodStatus.textContent = configured.length ? `已配置：${configured.map((item) => labels[item]).join('、')}` : '尚未配置锁定凭据';
    const selected = new Set(Array.isArray(setting.appLockRequiredMethods) ? setting.appLockRequiredMethods : []);
    if (!selected.size) configured.forEach((method) => selected.add(method));
    const checks = configured.map((method) => {
      const input = h('input', { type: 'checkbox', checked: selected.has(method) });
      input.onchange = () => {
        const next = new Set(Array.isArray(setting.appLockRequiredMethods) && setting.appLockRequiredMethods.length
          ? setting.appLockRequiredMethods : configured);
        if (input.checked) next.add(method); else next.delete(method);
        if (setting.appLockUnlockRule === 'required' && !next.size) {
          input.checked = true; toast('全部验证规则至少需要一种方式'); return;
        }
        updateSetting({ appLockRequiredMethods: [...next].filter((item) => configured.includes(item)) });
      };
      return h('label', { class: 'chip' }, input, labels[method]);
    });
    requiredWrap.replaceChildren(
      h('div', { class: 'lab' }, '全部验证时需要通过'),
      h('div', { class: 'hint', style: 'margin-bottom:8px' }, 'PIN、图案和设备验证可以同时保留；选择“全部选中方式”时逐项验证。'),
      h('div', { class: 'chips' }, checks.length ? checks : h('span', { class: 'hint' }, '请先配置凭据')),
    );
  };
  const credentialGroup = h('div', { class: 'setting-group' }, h('div', { class: 'setting-item' },
    h('div', { class: 'lab' }, hasLockCredential('pin') ? '更换 PIN / 口令' : '设置 PIN / 口令'), password,
    h('button', { class: 'btn', style: 'margin-top:8px', onclick: async () => {
      try {
        await saveLockSecret(password.value, 'pin');
        updateSetting({ appLockEnabled: true, appLockMode: 'pin' });
        enabledToggle.checked = true; password.value = ''; refreshMethods();
        toast(hasLockCredential('pattern') ? 'PIN 已保存，并保留已有图案' : 'PIN 应用锁已启用');
      }
      catch (error) { toast(error.message); }
    } }, '保存并启用')));
  const patternGroup = h('div', { class: 'setting-group' }, h('div', { class: 'setting-item' },
    h('div', { class: 'lab' }, hasLockCredential('pattern') ? '更换图案锁' : '设置图案锁'), patternPad(async (secret) => {
      try {
        await saveLockSecret(secret, 'pattern'); updateSetting({ appLockEnabled: true, appLockMode: 'pattern' });
        enabledToggle.checked = true; refreshMethods();
        toast(hasLockCredential('pin') ? '图案已保存，并保留已有 PIN' : '图案锁已启用');
      } catch (error) { toast(error.message); }
    })));
  const biometric = h('button', { class: 'btn', onclick: async () => {
    try { await registerBiometric(); updateSetting({ appLockUseBiometric: true }); biometricToggle.checked = true; refreshMethods(); toast('设备生物识别已注册'); }
    catch (error) { toast(error.message); }
  } }, '注册设备生物识别');
  const rule = h('select', { class: 'input' },
    h('option', { value: 'any', selected: setting.appLockUnlockRule !== 'required' }, '任一方式通过'),
    h('option', { value: 'required', selected: setting.appLockUnlockRule === 'required' }, '全部选中方式都通过'));
  rule.onchange = () => {
    const methods = configuredLockMethods();
    if (rule.value === 'required' && !methods.length) {
      rule.value = 'any'; toast('请先配置至少一种锁定凭据'); return;
    }
    const patch = { appLockUnlockRule: rule.value };
    if (rule.value === 'required' && !(Array.isArray(setting.appLockRequiredMethods) && setting.appLockRequiredMethods.some((item) => methods.includes(item)))) {
      patch.appLockRequiredMethods = methods;
    }
    updateSetting(patch); refreshMethods();
  };
  enabledToggle.addEventListener('change', () => {
    if (enabledToggle.checked && !hasLockCredential()) {
      enabledToggle.checked = false;
      updateSetting({ appLockEnabled: false });
      password.focus();
      toast('请先保存 PIN、口令或图案，再启用应用锁');
      return;
    }
    updateSetting({ appLockEnabled: enabledToggle.checked });
  });
  const biometricToggle = h('input', { type: 'checkbox', checked: !!setting.appLockUseBiometric });
  biometricToggle.onchange = () => {
    if (biometricToggle.checked && !localStorage.getItem(BIO_KEY)) {
      biometricToggle.checked = false; toast('请先注册设备验证'); return;
    }
    updateSetting({ appLockUseBiometric: biometricToggle.checked }); refreshMethods();
  };
  const enabledRow = h('label', { class: 'setting-row toggle-row' },
    h('div', null, h('div', { class: 'lab' }, '启用应用锁'),
      h('div', { class: 'hint' }, '访问口令是服务器级保护；这里是当前浏览器的个人锁。')),
    enabledToggle);
  const options = h('div', { class: 'setting-group' },
    h('div', { class: 'setting-item' }, enabledRow, methodStatus),
    h('div', { class: 'setting-item' }, toggleRow('离开页面后重新锁定', 'appLockOnHidden')),
    h('div', { class: 'setting-item' }, h('label', { class: 'setting-row toggle-row' },
      h('div', null, h('div', { class: 'lab' }, '启用设备生物识别'), h('div', { class: 'hint' }, '需要先在本浏览器注册设备验证。')), biometricToggle)),
    h('div', { class: 'setting-item setting-row' }, h('div', { class: 'lab' }, '解锁规则'), rule),
    requiredWrap,
    h('div', { class: 'setting-item' }, toggleRow('隐私伪装模式', 'privacyMode', '失焦时遮盖内容并使用中性页面标题。')),
    h('div', { class: 'setting-item' }, biometric),
    h('button', { class: 'setting-item btn ghost', style: 'color:var(--danger);width:100%;text-align:left', onclick: () => {
      clearLocalLockCredentials();
      enabledToggle.checked = false; biometricToggle.checked = false; rule.value = 'any'; refreshMethods(); toast('应用锁凭据已清除');
    } }, '清除所有锁定凭据'));
  refreshMethods();
  const cryptoWarning = hasSecureCrypto() ? null : h('div', {
    class: 'error-box', role: 'status',
  }, '当前连接没有可用的 Web Crypto。应用锁和加密备份需要 HTTPS（localhost 除外）。');
  page.append(...[cryptoWarning, credentialGroup, patternGroup, options].filter(Boolean));
  root.append(page);
}

async function showLockGate({ forceRecovery = false } = {}) {
  if (!setting.appLockEnabled || lockOverlay) return;
  const credentials = readLockCredentials();
  if (!Object.keys(credentials).length) {
    const hasUnreadableCredential = localStorage.getItem(LOCK_KEY) != null;
    if (!hasUnreadableCredential && !forceRecovery) {
      // 旧设置可能留下“已启用但没有凭据”的假锁状态，不能继续向用户声称受保护。
      locked = false;
      updateSetting({ appLockEnabled: false, appLockRequiredMethods: [] });
      return;
    }
    locked = true;
    lockOverlay = h('div', {
      class: 'local-lock-overlay', role: 'dialog', 'aria-modal': 'true',
      'aria-labelledby': 'local-lock-recovery-title',
    },
      h('div', { class: 'card local-lock-card' }, icon('lock', 36),
        h('h2', { id: 'local-lock-recovery-title' }, '应用锁凭据已损坏'),
        h('div', { class: 'hint' }, '无法读取当前浏览器保存的锁凭据。灾难恢复会退出账号并永久清除当前浏览器的全部 JM Web 数据。'),
        h('button', { class: 'btn ghost block', type: 'button', style: 'color:var(--danger)', onclick: recoverLocalLock }, '清除本机全部数据、退出账号并重新开始')));
    document.body.append(lockOverlay);
    isolateLockBackground(true);
    queueMicrotask(() => lockOverlay?.querySelector('button')?.focus());
    return;
  }
  locked = true;
  const biometricConfigured = !!(setting.appLockUseBiometric && localStorage.getItem(BIO_KEY));
  const biometricReady = !!(biometricConfigured && navigator.credentials?.get);
  const configured = [...Object.keys(credentials), ...(biometricConfigured ? ['biometric'] : [])];
  const selectedRequired = (Array.isArray(setting.appLockRequiredMethods) ? setting.appLockRequiredMethods : [])
    .filter((method) => configured.includes(method));
  const required = setting.appLockUnlockRule === 'required'
    ? (selectedRequired.length ? selectedRequired : configured)
    : [];
  const visible = setting.appLockUnlockRule === 'required' ? required : configured;
  const unavailable = required.filter((method) => method === 'biometric' && !biometricReady);
  const pinInput = visible.includes('pin')
    ? h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: '输入 PIN 或口令' }) : null;
  const lockStatus = h('div', { class: 'hint', role: 'status', 'aria-live': 'polite' });
  const passed = new Set();
  let unlocking = false;
  const setLockStatus = (message, isError = false) => {
    lockStatus.textContent = message || '';
    lockStatus.style.color = isError ? 'var(--danger)' : '';
  };
  const finishIfAllowed = () => {
    const allowed = setting.appLockUnlockRule === 'required'
      ? required.length > 0 && required.every((method) => passed.has(method))
      : passed.size > 0;
    if (!allowed) return false;
    releaseLocalLock();
    return true;
  };
  const pendingText = () => {
    const labels = { pin: 'PIN / 口令', pattern: '图案', biometric: '设备验证' };
    const pending = required.filter((method) => !passed.has(method));
    return pending.length ? `已通过当前步骤，还需：${pending.map((item) => labels[item]).join('、')}` : '';
  };
  const unlock = async (type, secretValue) => {
    if (unlocking) return;
    unlocking = true;
    lockOverlay?.setAttribute('aria-busy', 'true');
    setLockStatus('正在验证…');
    try {
      const secret = type === 'pin' ? pinInput?.value || '' : String(secretValue || '');
      if (!(await verifyLockSecret(secret, type))) {
        if (type === 'pin' && pinInput) { pinInput.value = ''; pinInput.focus(); }
        setLockStatus('解锁凭据错误，请重试', true);
        return;
      }
      passed.add(type);
      if (type === 'pin' && pinInput) pinInput.value = '';
      if (!finishIfAllowed()) setLockStatus(pendingText());
    } catch (error) {
      setLockStatus(`无法验证凭据：${error.message || '浏览器加密功能不可用'}`, true);
    } finally {
      unlocking = false;
      lockOverlay?.removeAttribute('aria-busy');
    }
  };
  const methodControls = h('div', { class: 'lock-method-controls' });
  if (pinInput) methodControls.append(
    h('div', { class: 'lock-method' }, h('div', { class: 'lab' }, 'PIN / 口令'), pinInput,
      h('button', { class: 'btn primary block', onclick: () => unlock('pin') }, '验证 PIN / 口令')),
  );
  if (visible.includes('pattern')) methodControls.append(
    h('div', { class: 'lock-method' }, h('div', { class: 'lab' }, '图案'), patternPad((secret) => unlock('pattern', secret))),
  );
  if (visible.includes('biometric')) methodControls.append(h('button', {
    class: 'btn block', disabled: !biometricReady, onclick: async () => {
      if (unlocking) return;
      unlocking = true; lockOverlay?.setAttribute('aria-busy', 'true'); setLockStatus('正在等待设备验证…');
      try {
        if (await verifyBiometric()) {
          passed.add('biometric');
          if (!finishIfAllowed()) setLockStatus(pendingText());
        } else setLockStatus('设备验证未通过，请重试', true);
      } catch (error) { setLockStatus(error.message || '设备验证失败', true); }
      finally { unlocking = false; lockOverlay?.removeAttribute('aria-busy'); }
    },
  }, biometricReady ? '使用设备生物识别' : '设备生物识别当前不可用'));
  lockOverlay = h('div', {
    class: 'local-lock-overlay', role: 'dialog', 'aria-modal': 'true', tabindex: '-1',
    'aria-labelledby': 'local-lock-title',
  },
    h('div', { class: 'card local-lock-card' }, icon('lock', 36),
      h('h2', { id: 'local-lock-title' }, 'JM Web 已锁定'),
      setting.appLockUnlockRule === 'required'
        ? h('div', { class: 'hint' }, `需要完成 ${required.length} 种已选验证方式。`) : h('div', { class: 'hint' }, '任选一种已配置方式即可解锁。'),
      unavailable.length ? h('div', { class: 'hint', style: 'color:var(--danger)' }, '所需设备验证当前不可用；为避免降低锁定强度，不会自动切换为任一方式。') : null,
      methodControls,
      lockStatus,
      h('button', { class: 'btn ghost block', type: 'button', style: 'color:var(--danger)', onclick: recoverLocalLock },
        '无法解锁？清除本机全部数据并退出账号')));
  pinInput?.addEventListener('keydown', (event) => { if (event.key === 'Enter') unlock('pin'); });
  document.body.append(lockOverlay);
  isolateLockBackground(true);
  lockOverlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...lockOverlay.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (document.activeElement === lockOverlay || focusable.length === 1
        || (event.shiftKey && document.activeElement === first)
        || (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  });
  const desktopFocusTarget = pinInput || lockOverlay.querySelector('.pattern-dot')
    || lockOverlay.querySelector('button:not(:disabled)') || lockOverlay;
  const initialFocusTarget = shouldAutoFocusEditable() ? desktopFocusTarget : lockOverlay;
  queueMicrotask(() => initialFocusTarget?.focus({ preventScroll: true }));
}

export function isLocalAppLocked() { return locked; }

/* ------------------------------ 备份恢复 ------------------------------ */

async function encryptBackup(value, password) {
  const salt = randomBytes(16); const iv = randomBytes(12); const iterations = 210000;
  const secure = requireSecureCrypto();
  const material = await secure.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await secure.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const body = await secure.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value)));
  return { encrypted: true, kdf: 'PBKDF2-SHA256', iterations, salt: toB64(salt), iv: toB64(iv), data: toB64(body) };
}

async function decryptBackup(value, password) {
  if (!value.encrypted) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.encrypted !== true
      || value.kdf !== 'PBKDF2-SHA256') throw new Error('加密备份格式不受支持');
  const iterations = Number(value.iterations);
  if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 1000000) {
    throw new Error('加密备份迭代参数不合法');
  }
  const salt = strictB64(value.salt, '备份盐值', { exact: 16 });
  const iv = strictB64(value.iv, '备份 IV', { exact: 12 });
  const ciphertext = strictB64(value.data, '备份密文', { min: 16, max: 16 * 1024 * 1024 });
  const secure = requireSecureCrypto();
  try {
    const material = await secure.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    const key = await secure.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const body = await secure.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    const payload = JSON.parse(dec.decode(body));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid payload');
    return payload;
  } catch (_) {
    throw new Error('备份口令错误或文件已损坏');
  }
}

function downloadJson(value, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = h('a', { href: url, download: name }); document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function rebuildOfflineDownloads(requests) {
  const list = Array.isArray(requests) ? requests.slice(0, 1000) : [];
  if (!list.length) return { queued: 0, failed: 0 };
  const { downloads } = await import('./downloads.js');
  await downloads.ready;
  let queued = 0; let failed = 0;
  for (const request of list) {
    const aid = String(request?.aid || '').trim();
    if (!/^\d{1,24}$/.test(aid)) { failed++; continue; }
    let chapterIds = null;
    if (request.chapterIds != null) {
      if (!Array.isArray(request.chapterIds)) { failed++; continue; }
      chapterIds = [...new Set(request.chapterIds.map((id) => String(id || '').trim())
        .filter((id) => /^\d{1,24}$/.test(id)))].slice(0, 10_000);
      if (!chapterIds.length) { failed++; continue; }
    }
    try {
      await downloads.enqueueAlbum(aid, {
        chapterIds,
        name: String(request.name || '').slice(0, 300),
        shunt: setting.shunt,
        concurrency: 3,
      });
      queued++;
    } catch (_) { failed++; }
  }
  return { queued, failed };
}

export function backupView(root) {
  const page = h('div', { class: 'page settings-page', style: 'max-width:680px' }, pageTitle('备份与恢复'));
  const password = h('input', { class: 'input', type: 'password', placeholder: '可选：备份加密口令', autocomplete: 'new-password' });
  const file = h('input', { class: 'input', type: 'file', accept: 'application/json,.json' });
  const rebuildQueue = h('input', { type: 'checkbox', checked: true });
  const restoreStatus = h('div', { class: 'hint', role: 'status', 'aria-live': 'polite' });
  page.append(h('div', { class: 'setting-group' }, h('div', { class: 'setting-item' },
    h('div', { class: 'lab' }, '导出本地数据'), h('div', { class: 'hint' }, '包含设置、阅读/搜索历史、AI 会话、人格及离线缓存元数据；不会导出 JM 登录 Cookie、应用锁凭据或 WebAuthn 标识。'), password,
    h('button', { class: 'btn primary', style: 'margin-top:10px', onclick: async () => {
      try {
        let offline = null;
        try { offline = await (await import('./offline.js')).exportOfflineMetadata?.(); } catch (_) {}
        const payload = { format: 'jmw-backup', version: 2, createdAt: new Date().toISOString(), local: exportLocalState(), offline };
        const output = password.value ? await encryptBackup(payload, password.value) : payload;
        downloadJson(output, `jm-web-backup-${new Date().toISOString().slice(0, 10)}.json`);
      } catch (error) { toast('导出失败：' + error.message); }
    } }, '导出备份'))),
    h('div', { class: 'setting-group' }, h('div', { class: 'setting-item' },
      h('div', { class: 'lab' }, '恢复备份'),
      h('div', { class: 'hint' }, '备份不包含图片正文；可根据原有整本/选章记录重新建立下载队列。'), file,
      h('label', { class: 'setting-row toggle-row restore-option' },
        h('div', null, h('div', { class: 'lab' }, '自动重建下载任务'),
          h('div', { class: 'hint' }, '恢复离线目录后，按原有整本或选章记录重新加入队列。')),
        rebuildQueue),
      h('button', { class: 'btn', style: 'margin-top:10px', onclick: async (event) => {
        const button = event.currentTarget;
        try {
          if (!file.files?.[0]) throw new Error('请选择备份文件');
          if (file.files[0].size > 20 * 1024 * 1024) throw new Error('备份文件过大');
          button.disabled = true;
          restoreStatus.textContent = '正在验证并恢复备份…';
          let payload = JSON.parse(await file.files[0].text());
          if (payload.encrypted) {
            const pass = prompt('请输入备份加密口令');
            if (pass == null) { restoreStatus.textContent = '已取消恢复'; return; }
            payload = await decryptBackup(payload, pass);
          }
          if (payload.format !== 'jmw-backup' || !payload.local) throw new Error('不是有效的 JM Web 备份');
          let offlineResult = { albums: 0, chapters: 0, restoreRequests: [] };
          if (payload.offline) offlineResult = await (await import('./offline.js')).importOfflineMetadata(payload.offline);
          importLocalState(payload.local);
          syncSettingFromStorage(localStorage.getItem(SETTING_STORAGE_KEY));
          let queueResult = { queued: 0, failed: 0 };
          const requests = offlineResult.restoreRequests || [];
          if (rebuildQueue.checked && requests.length) {
            const accepted = confirm(`备份记录了 ${requests.length} 部漫画。恢复后将重新加入下载队列并开始续传，是否继续？`);
            if (accepted) {
              restoreStatus.textContent = `正在重建 ${requests.length} 个下载任务…`;
              queueResult = await rebuildOfflineDownloads(requests);
            }
          }
          const queueMessage = queueResult.queued || queueResult.failed
            ? `，已重建 ${queueResult.queued} 个下载任务${queueResult.failed ? `，${queueResult.failed} 个失败` : ''}` : '';
          restoreStatus.textContent = `恢复完成：${offlineResult.albums} 本、${offlineResult.chapters} 章元数据${queueMessage}。`;
          toast('恢复完成，正在刷新'); setTimeout(() => location.reload(), 1200);
        } catch (error) {
          restoreStatus.textContent = '恢复失败：' + error.message;
          toast('恢复失败：' + error.message);
        } finally {
          if (button.isConnected) button.disabled = false;
        }
      } }, '恢复并刷新'), restoreStatus)));
  root.append(page);
}

/* ------------------------------ 人格与 AI ------------------------------ */

export function personasView(root) {
  const page = h('div', { class: 'page settings-page', style: 'max-width:760px' }, pageTitle('人格面具'));
  const listWrap = h('div', { class: 'setting-group' });
  const formWrap = h('div', { class: 'setting-group' });
  let editingId = '';
  const fields = {};
  for (const [key, label, placeholder] of [
    ['name', '名称', '例如：小澪'], ['occupation', '职业', '漫画研究助手'], ['age', '年龄', '可留空'],
    ['personality', '性格', '耐心、直接、幽默'], ['format', '输出格式', '简洁要点'], ['prompt', '自定义提示', '额外行为约束'],
  ]) fields[key] = key === 'prompt' ? h('textarea', { class: 'input', rows: 4, placeholder }) : h('input', { class: 'input', placeholder });
  const formTitle = h('div', { class: 'lab' }, '新建人格');
  const saveButton = h('button', { class: 'btn primary' }, '保存人格');
  const cancelButton = h('button', { class: 'btn ghost', hidden: true }, '取消编辑');

  const resetForm = () => {
    editingId = '';
    Object.values(fields).forEach((input) => { input.value = ''; });
    formTitle.textContent = '新建人格';
    saveButton.textContent = '保存人格';
    cancelButton.hidden = true;
  };
  const editPersona = (item) => {
    editingId = item.id;
    for (const [key, input] of Object.entries(fields)) input.value = item[key] || '';
    formTitle.textContent = `编辑人格：${item.name}`;
    saveButton.textContent = '保存修改';
    cancelButton.hidden = false;
    formWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    fields.name.focus();
  };
  const render = () => {
    const list = getPersonas();
    listWrap.replaceChildren(groupTitle('已保存人格'),
      ...(!list.length ? [h('div', { class: 'setting-empty' },
        h('strong', null, '还没有自定义人格'), h('span', null, '创建后可在 AI 对话中随时切换。'))] : []),
      ...list.map((item) => h('div', { class: 'setting-item setting-row' },
        h('div', null, h('div', { class: 'lab' }, item.name), h('div', { class: 'hint' }, `${item.occupation || '未设置职业'} · ${item.personality || '默认性格'}`)),
        h('div', { class: 'persona-actions' },
          h('button', { class: 'btn ghost', onclick: () => editPersona(item) }, '编辑'),
          h('button', { class: 'btn ghost', onclick: () => {
            if (!confirm(`删除人格“${item.name}”？已绑定的对话会回退到默认人格。`)) return;
            savePersonas(list.filter((x) => x.id !== item.id));
            if (editingId === item.id) resetForm();
            render();
          } }, '删除')))));
  };
  saveButton.onclick = () => {
    if (!fields.name.value.trim()) return toast('请输入人格名称');
    const list = getPersonas();
    const old = list.find((item) => item.id === editingId);
    const item = { ...(old || {}), id: old?.id || uid(), createdAt: old?.createdAt || Date.now(), updatedAt: Date.now() };
    for (const [key, input] of Object.entries(fields)) item[key] = input.value.trim();
    const next = old ? list.map((entry) => entry.id === old.id ? item : entry) : [...list, item].slice(-30);
    savePersonas(next); resetForm(); render(); toast(old ? '人格已更新' : '人格已保存');
  };
  cancelButton.onclick = resetForm;
  formWrap.append(h('div', { class: 'setting-item' }, formTitle,
    h('div', { class: 'persona-form-grid' }, ...Object.entries(fields).map(([key, input]) => h('label', {
      class: `field ${['format', 'prompt'].includes(key) ? 'persona-field-wide' : ''}`.trim(),
    }, key === 'name' ? '名称' : ({ occupation: '职业', age: '年龄', personality: '性格', format: '输出格式', prompt: '自定义提示' }[key]), input))),
    h('div', { class: 'persona-actions' }, saveButton, cancelButton)));
  render(); page.append(listWrap, formWrap); root.append(page);
}

function systemPrompt(persona, thinkMode, style = '') {
  const parts = ['你是 JM Web 内的阅读与漫画研究助手。不要声称看到了用户未提供的内容。'];
  if (persona) parts.push(`你的人格：名字=${persona.name}; 职业=${persona.occupation || '助手'}; 年龄=${persona.age || '未设'}; 性格=${persona.personality || '自然'}; 输出格式=${persona.format || '清晰'}。${persona.prompt || ''}`);
  if (thinkMode) parts.push('请先在内部充分分析，但不要输出隐藏推理过程；只输出结论和必要依据。');
  if (style) parts.push(style);
  return parts.join('\n');
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || '').trim(), location.href);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch (_) { return ''; }
}

function appendPlainText(parent, value) {
  const lines = String(value || '').replace(/\\([\\`*_[\]()#+.!~>-])/g, '$1').split('\n');
  lines.forEach((line, index) => {
    if (index) parent.append(h('br'));
    parent.append(document.createTextNode(line));
  });
}

/**
 * 小型 Markdown 行内解析器。所有节点均由 DOM API 创建，链接协议使用白名单；
 * 即使模型返回 HTML、事件属性或 javascript: URL，也只会作为文本显示。
 */
function appendMarkdownInline(parent, value, depth = 0) {
  const source = String(value || '');
  if (!source || depth > 8) { appendPlainText(parent, source); return; }
  const token = /(`+)([\s\S]*?)\1|!\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)|\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*([^*\n]+?)\*|_([^_\n]+?)_|<(https?:\/\/[^\s<>]+)>/gi;
  let cursor = 0;
  for (const match of source.matchAll(token)) {
    if (match.index > cursor) appendPlainText(parent, source.slice(cursor, match.index));
    if (match[1]) {
      parent.append(h('code', null, match[2]));
    } else if (match[3] != null) {
      const href = safeHttpUrl(match[4]);
      if (href) parent.append(h('a', { href, target: '_blank', rel: 'noopener noreferrer nofollow', class: 'ai-md-image-link' }, `图片：${match[3] || href}`));
      else appendPlainText(parent, `![${match[3]}](${match[4]})`);
    } else if (match[5] != null) {
      const href = safeHttpUrl(match[6]);
      if (href) {
        const link = h('a', { href, target: '_blank', rel: 'noopener noreferrer nofollow' });
        appendMarkdownInline(link, match[5], depth + 1); parent.append(link);
      } else appendMarkdownInline(parent, match[5], depth + 1);
    } else if (match[7] != null || match[8] != null) {
      const strong = h('strong'); appendMarkdownInline(strong, match[7] ?? match[8], depth + 1); parent.append(strong);
    } else if (match[9] != null) {
      const del = h('del'); appendMarkdownInline(del, match[9], depth + 1); parent.append(del);
    } else if (match[10] != null || match[11] != null) {
      const em = h('em'); appendMarkdownInline(em, match[10] ?? match[11], depth + 1); parent.append(em);
    } else if (match[12]) {
      const href = safeHttpUrl(match[12]);
      parent.append(h('a', { href, target: '_blank', rel: 'noopener noreferrer nofollow' }, match[12]));
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) appendPlainText(parent, source.slice(cursor));
}

function tableCells(line) {
  let value = String(line || '').trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|')) value = value.slice(0, -1);
  return value.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function markdownBlockStart(lines, index) {
  const line = lines[index] || '';
  return /^\s*$/.test(line) || /^ {0,3}(?:```|~~~)/.test(line) || /^ {0,3}#{1,6}\s+/.test(line)
    || /^\s*(?:[-+*]\s+|\d+[.)]\s+|>\s?)/.test(line) || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)
    || (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] || ''));
}

function renderMarkdown(target, value) {
  const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n');
  const fragment = document.createDocumentFragment();
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = /^ {0,3}(```+|~~~+)\s*([\w-]*)[^\n]*$/.exec(line);
    if (fence) {
      const marker = fence[1][0]; const size = fence[1].length; const content = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^ {0,3}${marker}{${size},}\\s*$`).test(lines[index])) content.push(lines[index++]);
      if (index < lines.length) index += 1;
      const code = h('code', null, content.join('\n'));
      if (fence[2]) code.className = `language-${fence[2].toLowerCase()}`;
      fragment.append(h('pre', null, code)); continue;
    }
    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const node = h(`h${heading[1].length}`); appendMarkdownInline(node, heading[2]); fragment.append(node); index += 1; continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { fragment.append(h('hr')); index += 1; continue; }
    if (/^\s*>\s?/.test(line)) {
      const quoted = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) quoted.push(lines[index++].replace(/^\s*>\s?/, ''));
      const quote = h('blockquote'); renderMarkdown(quote, quoted.join('\n')); fragment.append(quote); continue;
    }
    const listMatch = /^\s*([-+*]|\d+[.)])\s+(.+)$/.exec(line);
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[1]); const list = h(ordered ? 'ol' : 'ul');
      if (ordered) list.start = Math.max(1, parseInt(listMatch[1], 10) || 1);
      while (index < lines.length) {
        const itemMatch = /^\s*([-+*]|\d+[.)])\s+(.+)$/.exec(lines[index]);
        if (!itemMatch || /^\d/.test(itemMatch[1]) !== ordered) break;
        let content = itemMatch[2]; const item = h('li');
        const task = /^\[([ xX])\]\s+/.exec(content);
        if (task) { item.append(h('input', { type: 'checkbox', disabled: true, checked: task[1].toLowerCase() === 'x' })); content = content.slice(task[0].length); }
        appendMarkdownInline(item, content); list.append(item); index += 1;
      }
      fragment.append(list); continue;
    }
    if (line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1] || '')) {
      const headers = tableCells(line); const table = h('table'); const thead = h('thead'); const headRow = h('tr');
      headers.forEach((cell) => { const th = h('th'); appendMarkdownInline(th, cell); headRow.append(th); });
      thead.append(headRow); table.append(thead); index += 2; const tbody = h('tbody');
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        const row = h('tr'); const cells = tableCells(lines[index++]);
        headers.forEach((_, cellIndex) => { const td = h('td'); appendMarkdownInline(td, cells[cellIndex] || ''); row.append(td); });
        tbody.append(row);
      }
      table.append(tbody); const wrap = h('div', { class: 'ai-md-table-wrap' }, table); fragment.append(wrap); continue;
    }
    const paragraph = [];
    while (index < lines.length && lines[index].trim() && (paragraph.length === 0 || !markdownBlockStart(lines, index))) paragraph.push(lines[index++]);
    if (!paragraph.length) { paragraph.push(lines[index++]); }
    const node = h('p'); appendMarkdownInline(node, paragraph.join('\n')); fragment.append(node);
  }
  target.replaceChildren(fragment);
  target.classList.add('ai-markdown');
}

function searchResultCard(search) {
  if (!search) return null;
  const status = search.status === 'searching' ? `正在联网搜索：${search.query || ''}`
    : search.status === 'failed' ? `搜索失败：${search.message || '未知错误'}`
      : `联网搜索完成${search.provider ? ` · ${search.provider}` : ''}（${search.results?.length || 0} 条引用）`;
  const card = h('div', { class: `ai-search-card ${search.status || ''}` }, h('div', { class: 'ai-search-status' }, status));
  if (Array.isArray(search.results) && search.results.length) {
    const list = h('ol', { class: 'ai-citations' });
    search.results.slice(0, 10).forEach((result) => {
      const href = safeHttpUrl(result?.url); const title = String(result?.title || href || '搜索结果').slice(0, 500);
      const heading = href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer nofollow' }, title) : h('span', null, title);
      list.append(h('li', null, heading, result?.content ? h('div', { class: 'hint' }, String(result.content).slice(0, 500)) : null));
    });
    card.append(list);
  }
  return card;
}

function messageNode(message, actions = {}) {
  const body = h('div', { class: 'ai-message-body' });
  if (message.content) {
    if (message.role === 'assistant') renderMarkdown(body, message.content);
    else body.textContent = message.content;
  } else if (message.streaming) body.append(h('span', { class: 'ai-streaming-placeholder', 'aria-label': '正在生成' }, '…'));
  const tools = h('div', { class: 'ai-message-tools' });
  if (actions.branchCount > 1) tools.append(h('span', { class: 'ai-branch-tools' },
    h('button', { class: 'btn ghost', disabled: !actions.previousBranch, onclick: actions.previousBranch, title: '上一个分支', 'aria-label': '上一个分支' }, '‹'),
    h('span', null, `${actions.activeBranch + 1}/${actions.branchCount}`),
    h('button', { class: 'btn ghost', disabled: !actions.nextBranch, onclick: actions.nextBranch, title: '下一个分支', 'aria-label': '下一个分支' }, '›')));
  if (actions.edit) tools.append(h('button', { class: 'btn ghost', onclick: actions.edit }, '编辑'));
  if (actions.copy) tools.append(h('button', { class: 'btn ghost', onclick: actions.copy }, '复制'));
  if (actions.retry) tools.append(h('button', { class: 'btn ghost', onclick: actions.retry }, '重新生成'));
  return h('div', { class: `ai-message ${message.role}` }, h('div', { class: 'ai-role' }, message.role === 'user' ? '你' : 'AI'), searchResultCard(message.search), body, tools);
}

async function streamChat(messages, options, onDelta, signal) {
  const response = await fetch('/api/ai/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ messages, persona: options.persona || null, think: !!options.think, searchContext: options.searchContext || '' }),
  });
  if (!response.ok) {
    let data = null; try { data = await response.json(); } catch (_) {}
    throw new Error(data?.error || `AI 请求失败（${response.status}）`);
  }
  if (!response.body) throw new Error('浏览器不支持流式响应');
  const reader = response.body.getReader(); let buffer = '';
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buffer += dec.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const text = line.slice(5).trim(); if (!text || text === '[DONE]') continue;
      try {
        const json = JSON.parse(text);
        const delta = json.choices?.[0]?.delta?.content ?? json.delta ?? '';
        if (delta) onDelta(delta);
      } catch (_) {}
    }
  }
}

const AI_SEARCH_PROVIDERS = [
  ['auto', '自动'], ['tavily', 'Tavily'], ['duckduckgo', 'DuckDuckGo'], ['bing', 'Bing CN'],
  ['sogou', 'Sogou'], ['baidu', 'Baidu'], ['searxng', 'SearXNG'],
];
const AI_AUTO_SEARCH_KEYWORDS = [
  '最新', '今天', '现在', '目前', '当前', '近期', '最近', '新闻', '时讯', '时事',
  '2024', '2025', '2026', '2027', '价格', '股价', '汇率', '金价', '油价', '行情',
  '版本', '发布', '更新', '升级', 'release', '政策', '法规', '法案', '新规',
  '比赛', '赛果', '比分', '战报', '战绩', '天气', '气温', '降水', '职位', '任职',
  '担任', '辞去', '逝世', '去世', '出生', '票房', '收视率', '排名', '榜单', '公告', '通知', '声明', '公报',
];

function aiSearchOptions() {
  const providers = AI_SEARCH_PROVIDERS.map(([id]) => id);
  return {
    provider: providers.includes(setting.aiSearchProvider) ? setting.aiSearchProvider : 'auto',
    depth: setting.aiSearchDepth === 'advanced' ? 'advanced' : 'basic',
    resultCount: Math.max(1, Math.min(10, Number(setting.aiSearchResultCount) || 5)),
    autoSearch: setting.aiAutoSearch !== false,
    searxngLanguage: String(setting.aiSearxngLanguage || 'zh-CN').trim() || 'zh-CN',
    searxngCategories: String(setting.aiSearxngCategories || 'general').trim() || 'general',
  };
}

function shouldAutoSearch(text) {
  if (!aiSearchOptions().autoSearch) return false;
  const normalized = String(text || '').trim().toLowerCase();
  return normalized ? AI_AUTO_SEARCH_KEYWORDS.some((keyword) => normalized.includes(keyword)) : false;
}

function cloneMessages(messages) {
  try { return JSON.parse(JSON.stringify(Array.isArray(messages) ? messages : [])); }
  catch (_) { return []; }
}

function normalizeMessages(messages, depth = 0) {
  if (!Array.isArray(messages) || depth > 12) return [];
  return messages.map((raw) => {
    const item = raw && typeof raw === 'object' ? raw : {};
    const branches = Array.isArray(item.branches) ? item.branches.slice(0, 30).map((branch) => ({
      content: String(branch?.content || ''),
      followingMessages: normalizeMessages(branch?.followingMessages, depth + 1),
    })) : [];
    const activeBranchIndex = branches.length ? Math.max(0, Math.min(branches.length - 1, Number(item.activeBranchIndex) || 0)) : 0;
    return {
      ...item,
      id: String(item.id || uid()),
      role: ['user', 'assistant', 'system'].includes(item.role) ? item.role : 'user',
      content: String(item.content || ''),
      createdAt: Number(item.createdAt) || Date.now(),
      branches,
      activeBranchIndex,
      streaming: false,
    };
  });
}

function syncActiveBranches(messages) {
  const synced = normalizeMessages(messages);
  for (let index = synced.length - 1; index >= 0; index -= 1) {
    const message = synced[index];
    if (message.role !== 'user' || !message.branches.length) continue;
    const active = Math.max(0, Math.min(message.branches.length - 1, Number(message.activeBranchIndex) || 0));
    message.activeBranchIndex = active;
    message.branches = message.branches.map((branch, branchIndex) => branchIndex === active ? {
      ...branch,
      content: message.content,
      followingMessages: cloneMessages(synced.slice(index + 1)),
    } : branch);
  }
  return synced;
}

function newAiSession(personaId = '') {
  return { id: uid(), title: '新对话', messages: [], createdAt: Date.now(), updatedAt: Date.now(), personaId: String(personaId || '') };
}

function normalizeSession(raw) {
  const session = raw && typeof raw === 'object' ? raw : {};
  return {
    ...session,
    id: String(session.id || uid()),
    title: String(session.title || '新对话'),
    messages: normalizeMessages(session.messages),
    createdAt: Number(session.createdAt) || Date.now(),
    updatedAt: Number(session.updatedAt) || Number(session.createdAt) || Date.now(),
    personaId: String(session.personaId || ''),
    deepThinkingEnabled: !!session.deepThinkingEnabled,
    webSearchEnabled: !!session.webSearchEnabled,
  };
}

export async function aiView(root, _m, _q, ctx) {
  const page = h('div', { class: 'page ai-page' }); root.append(page);
  let cfg;
  try { cfg = await jsonRequest('/ai/config', { signal: ctx?.signal }); }
  catch (error) { page.append(errorBox(error.message)); return; }
  const sessions = getAiSessions().map(normalizeSession);
  let current = sessions[0] || newAiSession();
  if (!sessions.length) sessions.push(current);
  saveAiSessions(sessions);
  let controller = null;
  const sidebar = h('aside', { class: 'ai-sidebar' }); const conversation = h('div', { class: 'ai-conversation' });
  const input = h('textarea', { class: 'input ai-input', rows: 3, placeholder: cfg.enabled ? '输入消息…' : '服务器未配置 AI_API_KEY' });
  const personaSel = h('select', { class: 'input' }, h('option', { value: '' }, '默认人格'), ...getPersonas().map((p) => h('option', { value: p.id }, p.name)));
  const think = h('input', { type: 'checkbox' }); const web = h('input', { type: 'checkbox', disabled: !cfg.searchEnabled });
  const send = h('button', { class: 'btn primary', disabled: !cfg.enabled }, '发送');
  const stop = h('button', { class: 'btn', disabled: true }, '停止');
  const providerSel = h('select', { class: 'input' }, ...AI_SEARCH_PROVIDERS.map(([id, label]) => {
    const unavailable = (id === 'tavily' && cfg.tavilyAvailable === false)
      || (id === 'searxng' && cfg.searxngConfigured === false);
    return h('option', { value: id, disabled: unavailable }, unavailable ? `${label}（服务器未配置）` : label);
  }));
  const depthSel = h('select', { class: 'input' }, h('option', { value: 'basic' }, '基础'), h('option', { value: 'advanced' }, '深度'));
  const resultCount = h('input', { class: 'input', type: 'number', min: 1, max: 10, step: 1 });
  const autoSearch = h('input', { type: 'checkbox' });
  const searxngLanguage = h('input', { class: 'input', placeholder: 'zh-CN' });
  const searxngCategories = h('input', { class: 'input', placeholder: 'general' });
  const searxngFields = h('div', { class: 'ai-searxng-fields' },
    h('div', { class: 'hint ai-searxng-status' }, cfg.searxngConfigured
      ? 'SearXNG 地址已由服务器管理员配置' : '服务器未配置 SearXNG 地址'),
    h('label', { class: 'field' }, '语言', searxngLanguage),
    h('label', { class: 'field' }, '分类（逗号分隔）', searxngCategories));
  const searchSettingsPanel = h('details', { class: 'ai-search-settings' },
    h('summary', null, '搜索设置'),
    h('div', { class: 'ai-search-settings-grid' },
      h('label', { class: 'field' }, '提供方', providerSel),
      h('label', { class: 'field' }, '搜索深度', depthSel),
      h('label', { class: 'field' }, '结果条数', resultCount),
      h('label', { class: 'setting-row compact' }, h('span', null, '按关键词自动搜索'), autoSearch),
      searxngFields,
      h('div', { class: 'hint ai-search-hint' }, '手动联网始终搜索；自动搜索仅在问题包含“最新、今天、价格、天气、版本”等时触发。')));
  const syncSearchControls = () => {
    const options = aiSearchOptions();
    const provider = options.provider === 'searxng' && cfg.searxngConfigured === false ? 'auto' : options.provider;
    providerSel.value = provider; depthSel.value = options.depth; resultCount.value = String(options.resultCount);
    autoSearch.checked = options.autoSearch;
    searxngLanguage.value = options.searxngLanguage; searxngCategories.value = options.searxngCategories;
    searxngFields.hidden = !['auto', 'searxng'].includes(provider);
  };
  providerSel.onchange = () => { updateSetting({ aiSearchProvider: providerSel.value }); syncSearchControls(); };
  depthSel.onchange = () => updateSetting({ aiSearchDepth: depthSel.value === 'advanced' ? 'advanced' : 'basic' });
  resultCount.onchange = () => { const value = Math.max(1, Math.min(10, Number(resultCount.value) || 5)); resultCount.value = String(value); updateSetting({ aiSearchResultCount: value }); };
  autoSearch.onchange = () => updateSetting({ aiAutoSearch: autoSearch.checked });
  searxngLanguage.onchange = () => updateSetting({ aiSearxngLanguage: searxngLanguage.value.trim() || 'zh-CN' });
  searxngCategories.onchange = () => updateSetting({ aiSearxngCategories: searxngCategories.value.trim() || 'general' });
  syncSearchControls();

  const persist = () => {
    current.messages = syncActiveBranches(current.messages);
    current.updatedAt = Date.now();
    const all = getAiSessions().map(normalizeSession).filter((item) => item.id !== current.id);
    saveAiSessions([current, ...all].slice(0, 50));
  };
  const renderSidebar = () => sidebar.replaceChildren(
    h('div', { class: 'ai-sidebar-head' },
      h('div', { class: 'ai-sidebar-title' }, h('span', { class: 'ai-spark' }, '✦'), h('span', null, 'AI 对话')),
      h('span', { class: 'ai-sidebar-count' }, `${sessions.length} 个对话`)),
    h('button', { class: 'btn primary block ai-new-session', disabled: !!controller, onclick: () => {
      if (controller) return; persist(); current = newAiSession(personaSel.value); persist(); renderAll(); input.focus();
    } }, '新建对话'),
    ...[current, ...getAiSessions().map(normalizeSession).filter((session) => session.id !== current.id)].map((session) => h('div', { class: `ai-session ${session.id === current.id ? 'on' : ''}` },
      h('button', { disabled: !!controller, onclick: () => { if (controller || session.id === current.id) return; persist(); current = normalizeSession(session); renderAll(); } }, session.title || '对话'),
      h('button', { title: '删除', 'aria-label': `删除${session.title || '对话'}`, disabled: !!controller, onclick: () => {
        if (controller) return;
        const remaining = getAiSessions().map(normalizeSession).filter((item) => item.id !== session.id);
        saveAiSessions(remaining);
        if (current.id === session.id) current = remaining[0] || newAiSession(personaSel.value);
        persist(); renderAll();
      } }, '×'))));
  const regenerate = async (style = '') => {
    if (controller) return;
    if (current.messages.at(-1)?.role === 'assistant') current.messages.pop();
    persist(); renderMessages();
    await generate(style);
  };
  const switchBranch = (messageIndex, targetIndex) => {
    if (controller) return;
    current.messages = syncActiveBranches(current.messages);
    const message = current.messages[messageIndex];
    if (!message?.branches?.[targetIndex]) return;
    const target = message.branches[targetIndex];
    const switched = { ...message, content: target.content, activeBranchIndex: targetIndex };
    current.messages = [...current.messages.slice(0, messageIndex), switched, ...cloneMessages(target.followingMessages)];
    persist(); renderAll();
  };
  const editUserMessage = async (messageIndex) => {
    if (controller) return;
    current.messages = syncActiveBranches(current.messages);
    const message = current.messages[messageIndex];
    if (!message || message.role !== 'user') return;
    const value = prompt('编辑消息（将保留原回复为可切换分支）', message.content);
    if (value == null || !value.trim() || value.trim() === message.content) return;
    const following = cloneMessages(current.messages.slice(messageIndex + 1));
    const branches = message.branches.length ? cloneMessages(message.branches) : [{ content: message.content, followingMessages: following }];
    const nextBranch = branches.length;
    const edited = { ...message, content: value.trim(), branches: [...branches, { content: value.trim(), followingMessages: [] }], activeBranchIndex: nextBranch };
    current.messages = [...current.messages.slice(0, messageIndex), edited];
    persist(); renderAll(); await generate();
  };
  const renderMessages = () => {
    const messages = current.messages.map((message, index) => messageNode(message, {
      edit: message.role === 'user' && !controller ? () => editUserMessage(index) : null,
      copy: async () => { try { await navigator.clipboard?.writeText(message.content || ''); toast('已复制'); } catch (_) { toast('复制失败'); } },
      retry: message.role === 'assistant' && index === current.messages.length - 1 && !controller ? () => regenerate() : null,
      branchCount: message.role === 'user' ? message.branches?.length || 0 : 0,
      activeBranch: Number(message.activeBranchIndex) || 0,
      previousBranch: message.role === 'user' && !controller && Number(message.activeBranchIndex) > 0 ? () => switchBranch(index, Number(message.activeBranchIndex) - 1) : null,
      nextBranch: message.role === 'user' && !controller && Number(message.activeBranchIndex) < (message.branches?.length || 0) - 1 ? () => switchBranch(index, Number(message.activeBranchIndex) + 1) : null,
    }));
    conversation.replaceChildren(...(messages.length ? messages : [h('div', { class: 'ai-empty-state' },
      h('span', { class: 'ai-empty-kicker' }, cfg.enabled ? 'NEW CONVERSATION' : 'SETUP REQUIRED'),
      h('h2', null, cfg.enabled ? '从一个问题开始' : 'AI 服务尚未配置'),
      h('p', null, cfg.enabled
        ? '可以讨论漫画、整理阅读线索，或在开启联网搜索后查询最新资料。'
        : '请在服务器配置 AI_API_KEY；完成后刷新本页即可开始对话。'),
    )]));
    conversation.scrollTop = conversation.scrollHeight;
  };
  const generate = async (style = '') => {
    if (!cfg.enabled || controller || !current.messages.some((x) => x.role === 'user')) return;
    controller = new AbortController(); send.disabled = true; stop.disabled = false;
    const assistant = { id: uid(), role: 'assistant', content: '', createdAt: Date.now(), streaming: true, branches: [], activeBranchIndex: 0 }; current.messages.push(assistant); renderAll();
    let searchContext = '';
    try {
      const query = [...current.messages].reverse().find((x) => x.role === 'user')?.content || '';
      if (cfg.searchEnabled && (web.checked || shouldAutoSearch(query))) {
        const options = aiSearchOptions(); assistant.search = { status: 'searching', query, results: [] }; renderMessages();
        try {
          const result = await jsonRequest('/ai/search', {
            method: 'POST', signal: controller.signal,
            body: JSON.stringify({ query, ...options }),
          });
          const results = Array.isArray(result.results) ? result.results : [];
          assistant.search = { status: 'done', query, provider: result.provider || options.provider, results };
          searchContext = results.map((item, itemIndex) => `[${itemIndex + 1}] ${item.title}\n${item.url}\n${item.content}`).join('\n\n');
          renderMessages();
        } catch (error) {
          if (isAbort(error)) throw error;
          assistant.search = { status: 'failed', query, message: error.message, results: [] }; renderMessages();
        }
      }
      const persona = getPersonas().find((item) => item.id === current.personaId);
      const outbound = [{ role: 'system', content: systemPrompt(persona, think.checked, style) }, ...current.messages.slice(0, -1).map(({ role, content }) => ({ role, content }))];
      await streamChat(outbound, { persona, think: think.checked, searchContext }, (delta) => { assistant.content += delta; renderMessages(); }, controller.signal);
      assistant.streaming = false; persist(); renderMessages();
    } catch (error) {
      assistant.streaming = false;
      if (!isAbort(error)) { assistant.content ||= `请求失败：${error.message}`; persist(); renderMessages(); }
      else if (!assistant.content) { current.messages.pop(); persist(); renderMessages(); }
      else { persist(); renderMessages(); }
    } finally { controller = null; send.disabled = !cfg.enabled; stop.disabled = true; renderAll(); }
  };
  send.onclick = async () => {
    const value = input.value.trim(); if (!value || controller) return;
    current.messages.push({ id: uid(), role: 'user', content: value, createdAt: Date.now(), branches: [], activeBranchIndex: 0 }); if (current.title === '新对话') current.title = value.slice(0, 24);
    input.value = ''; persist(); renderAll(); await generate();
  };
  stop.onclick = () => controller?.abort();
  input.onkeydown = (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send.click(); } };
  personaSel.onchange = () => { current.personaId = personaSel.value; persist(); renderSidebar(); };
  think.onchange = () => { current.deepThinkingEnabled = think.checked; persist(); };
  web.onchange = () => { current.webSearchEnabled = web.checked; persist(); };
  const renderAll = () => {
    personaSel.value = getPersonas().some((item) => item.id === current.personaId) ? current.personaId : '';
    think.checked = !!current.deepThinkingEnabled; web.checked = !!current.webSearchEnabled;
    renderSidebar(); renderMessages();
  };
  page.append(sidebar, h('section', { class: 'ai-main' },
    h('div', { class: 'ai-toolbar' },
      h('div', { class: 'ai-toolbar-title' }, h('span', { class: 'ai-toolbar-dot' }), h('div', null, h('strong', null, '智能助手'), h('small', null, cfg.enabled ? '在线 · 随时为你整理思路' : '等待配置 AI 服务'))),
      h('div', { class: 'ai-toolbar-controls' }, personaSel,
      h('label', { class: 'ai-toolbar-toggle' }, think, h('span', null, '深度思考')),
      h('label', { class: 'ai-toolbar-toggle' }, web, h('span', null, '联网搜索')),
      h('button', { class: 'btn ghost', onclick: () => regenerate('回答更详细，并给出分点依据。') }, '更详细'),
      h('button', { class: 'btn ghost', onclick: () => regenerate('回答更精简，只保留结论。') }, '更精简'), searchSettingsPanel)),
    conversation, h('div', { class: 'ai-composer' },
      h('div', { class: 'ai-composer-inner' },
        h('div', { class: 'ai-input-label' }, h('span', null, '消息'), h('span', null, 'Enter 发送 · Shift + Enter 换行')),
        input,
        h('div', { class: 'ai-composer-actions' }, h('span', { class: 'ai-composer-hint' }, '内容会保存在本地对话记录中'), send, stop))
    )));
  renderAll();
  return () => controller?.abort();
}

/* ------------------------------ 网络、日志、维护 ------------------------------ */

export async function networkView(root, _m, _q, ctx) {
  const page = h('div', { class: 'page settings-page', style: 'max-width:720px' }, pageTitle('网络与 DoH'), loadingBox()); root.append(page);
  const [dohResult, configResult] = await Promise.allSettled([
    jsonRequest('/doh', { signal: ctx?.signal }),
    api.config(ctx?.signal),
  ]);
  if (isViewInactive(ctx)) return;

  const sections = [];
  if (dohResult.status === 'fulfilled' && dohResult.value && typeof dohResult.value === 'object'
      && dohResult.value.restricted !== true) {
    const data = dohResult.value;
    const providers = Array.isArray(data.providers)
      ? data.providers.filter((item) => item && typeof item.id === 'string') : [];
    const select = h('select', { class: 'input', disabled: !providers.length }, providers.map((item) => h('option', {
      value: item.id, selected: data.current === item.id,
    }, item.name || item.id)));
    const status = h('div', { class: 'hint' }, data.enabled ? `已启用 ${data.current}` : '当前使用系统 DNS');
    const customName = h('input', { class: 'input', value: data.customName || '', placeholder: '自定义服务名称（可选）' });
    const customUrl = h('input', { class: 'input', type: 'url', value: data.customUrl || '', placeholder: 'https://example.com/dns-query' });
    const autoStart = h('input', { type: 'checkbox', checked: !!data.autoStart });
    const preferIpv6 = h('input', { type: 'checkbox', checked: !!data.preferIpv6 });
    const customFields = h('div', { class: 'doh-custom-fields', hidden: select.value !== 'custom' }, customName, customUrl);
    select.onchange = () => { customFields.hidden = select.value !== 'custom'; };
    const dohPayload = (extra = {}) => ({
      provider: select.value,
      customName: customName.value.trim(),
      customUrl: customUrl.value.trim(),
      autoStart: autoStart.checked,
      preferIpv6: preferIpv6.checked,
      ...extra,
    });
    const saveDoh = (extra = {}) => jsonRequest('/doh', {
      method: 'POST', body: JSON.stringify(dohPayload(extra)), signal: ctx?.signal,
    });
    const actionButtons = [];
    const setBusy = (busy) => actionButtons.forEach((button) => { if (button.isConnected) button.disabled = busy; });
    const runDohAction = async (button, action, success) => {
      setBusy(true);
      try {
        const result = await action();
        if (!isViewInactive(ctx)) success(result);
      } catch (error) {
        if (!isViewInactive(ctx) && !isAbort(error)) toast(operationalErrorMessage(error, 'DoH 设置失败'));
      } finally {
        if (!isViewInactive(ctx) && button.isConnected) setBusy(false);
      }
    };
    const enableButton = h('button', { class: 'btn primary' }, '保存并启用');
    const disableButton = h('button', { class: 'btn' }, '关闭');
    const testButton = h('button', { class: 'btn' }, '保存并测速');
    actionButtons.push(enableButton, disableButton, testButton);
    enableButton.onclick = () => runDohAction(enableButton, () => saveDoh({ enabled: true }), () => {
      status.textContent = `已启用 ${select.value}`;
      toast('DoH 设置已保存');
    });
    disableButton.onclick = () => runDohAction(disableButton, () => saveDoh({ enabled: false }), () => {
      status.textContent = '当前使用系统 DNS';
      toast('DoH 已关闭，配置已保留');
    });
    testButton.onclick = () => runDohAction(testButton, async () => {
      await saveDoh();
      const out = await jsonRequest(`/doh/test?provider=${encodeURIComponent(select.value)}`, { signal: ctx?.signal });
      const addresses = Array.isArray(out?.addresses) ? out.addresses.map(String).filter(Boolean) : [];
      if (!addresses.length) throw new Error('测速未返回有效地址');
      return { addresses, ms: Number(out.ms) || 0 };
    }, (result) => toast(`解析成功：${result.addresses.join(', ')} · ${result.ms}ms`));
    sections.push(h('div', { class: 'setting-group' },
      h('div', { class: 'setting-item setting-row' }, h('div', null, h('div', { class: 'lab' }, 'DNS over HTTPS'), status), select),
      h('div', { class: 'setting-item' }, customFields),
      h('label', { class: 'setting-item setting-row toggle-row' }, h('div', null, h('div', { class: 'lab' }, '服务启动时自动恢复'), h('div', { class: 'hint' }, '关闭时本次仍可手动启用；重启 Node 服务后不会自动开启。')), autoStart),
      h('label', { class: 'setting-item setting-row toggle-row' }, h('div', null, h('div', { class: 'lab' }, '优先尝试 IPv6'), h('div', { class: 'hint' }, '开启后先查询 AAAA，再回退 A；没有可用 IPv6 路由时建议关闭。')), preferIpv6),
      h('div', { class: 'setting-item' }, h('div', { class: 'setting-actions' }, ...actionButtons),
        h('div', { class: 'hint' }, data.certificatePolicy || 'DoH TLS 使用 Node.js 运行时证书库。浏览器无法切换 Android 的“设备 CA”策略。'))));
  } else {
    const restricted = dohResult.status === 'fulfilled' && dohResult.value?.restricted === true;
    const error = dohResult.status === 'rejected' ? dohResult.reason : new Error('DoH 设置响应格式异常');
    sections.push(h('div', { class: 'setting-group' },
      groupTitle('DNS over HTTPS'),
      h('div', { class: 'setting-item' },
        h('div', { class: 'lab' }, restricted ? 'DoH 设置仅限站点管理员' : 'DoH 运维设置不可用'),
        h('div', { class: 'hint' }, restricted
          ? '当前页面仅显示普通数据源配置。容器或反向代理部署请配置 ACCESS_PASSWORD 后再管理 DoH。'
          : operationalErrorMessage(error, '无法读取 DoH 设置')))));
  }

  if (configResult.status === 'fulfilled' && configResult.value && typeof configResult.value === 'object') {
    const config = configResult.value;
    sections.push(h('div', { class: 'setting-group' },
      h('div', { class: 'setting-item' }, h('div', { class: 'lab' }, '数据源'),
        h('div', { class: 'hint' }, '这里会实际改变服务端请求的上游池：内置直连使用随版本维护的域名；网络单线路使用 JM_API_BASE 或当前线路；混合模式会先请求网络线路，再回退内置域名。账号会话随当前源保持。'),
        h('select', { class: 'input', onchange: (event) => { updateSetting({ dataSource: event.target.value }); toast('数据源已切换，后续请求立即生效'); } },
          h('option', { value: 'builtin', selected: setting.dataSource === 'builtin' }, `内置直连（${config.dataSources?.builtin?.hosts || 0} 条线路）`),
          h('option', { value: 'network', selected: setting.dataSource === 'network' }, config.dataSources?.network?.configured ? '网络 API（JM_API_BASE）' : '网络 API（当前单线路）'),
          h('option', { value: 'mixed', selected: setting.dataSource === 'mixed' }, `混合故障切换（${config.dataSources?.mixed?.hosts || 0} 条线路）`)),
        h('div', { class: 'hint' }, 'Web 无法在浏览器进程中嵌入 Android 的 Java 客户端；“内置直连”由同协议的 Node 适配器完成，包含签名、AES 解密、Cookie 与域名故障切换。'))));
  } else {
    const error = configResult.status === 'rejected' ? configResult.reason : new Error('数据源响应格式异常');
    sections.push(h('div', { class: 'setting-group' }, groupTitle('数据源'),
      h('div', { class: 'setting-item' }, h('div', { class: 'hint' }, error?.message || '无法读取数据源配置'))));
  }
  page.replaceChildren(pageTitle('网络与 DoH'), ...sections);
}

export async function logsView(root, _m, query, ctx) {
  const page = h('div', { class: 'page', style: 'max-width:980px' }, pageTitle('运行日志'), loadingBox()); root.append(page);
  try {
    const data = await jsonRequest(`/logs?limit=${Math.max(20, Math.min(500, Number(query.get('limit')) || 200))}`, { signal: ctx?.signal });
    if (isViewInactive(ctx)) return;
    const logs = Array.isArray(data?.logs) ? data.logs : [];
    const pre = h('pre', { class: 'log-viewer' }, logs
      .filter((item) => item && typeof item === 'object')
      .map((item) => `${String(item.time || '')} [${String(item.level || 'info')}] ${String(item.message || '')}`)
      .join('\n'));
    const copyButton = h('button', { class: 'btn' }, '复制');
    const clearButton = h('button', { class: 'btn' }, '清空');
    copyButton.onclick = async () => {
      copyButton.disabled = true;
      try {
        if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('当前浏览器不支持剪贴板写入');
        await navigator.clipboard.writeText(pre.textContent || '');
        if (!isViewInactive(ctx)) toast('日志已复制');
      } catch (error) {
        if (!isViewInactive(ctx)) toast(error?.message || '复制失败，请手动选择日志');
      } finally {
        if (!isViewInactive(ctx) && copyButton.isConnected) copyButton.disabled = false;
      }
    };
    clearButton.onclick = async () => {
      clearButton.disabled = true;
      try {
        await jsonRequest('/logs', { method: 'DELETE', signal: ctx?.signal });
        if (!isViewInactive(ctx)) {
          pre.textContent = '';
          toast('运行日志已清空');
        }
      } catch (error) {
        if (!isViewInactive(ctx) && !isAbort(error)) toast(operationalErrorMessage(error, '清空日志失败'));
      } finally {
        if (!isViewInactive(ctx) && clearButton.isConnected) clearButton.disabled = false;
      }
    };
    page.replaceChildren(pageTitle('运行日志'), h('div', { class: 'setting-actions log-actions' },
      copyButton, clearButton), pre);
  } catch (error) {
    if (!isViewInactive(ctx) && !isAbort(error)) {
      page.replaceChildren(pageTitle('运行日志'), errorBox(operationalErrorMessage(error, '无法读取运行日志')));
    }
  }
}

export function extractCodeView(root) {
  const page = h('div', { class: 'page settings-page', style: 'max-width:680px' }, pageTitle('提取漫画编码'));
  const input = h('textarea', { class: 'input', rows: 8, placeholder: '粘贴包含 JM123456、album/123456 或普通数字的文字' });
  const result = h('div', { class: 'setting-group' });
  const extract = () => {
    const ids = [...new Set([...input.value.matchAll(/(?:JM\s*|album\/|photo\/)?(\d{3,10})/gi)].map((x) => x[1]))].slice(0, 50);
    result.replaceChildren(...ids.map((id) => h('a', { class: 'setting-item advanced-link', href: `#/album/${id}` }, `JM${id}`, h('span', { class: 'arr' }, '打开 ›'))));
    if (!ids.length) result.append(h('div', { class: 'empty' }, '没有识别到漫画编号'));
  };
  page.append(input, h('div', { class: 'setting-actions extract-actions' },
    h('button', { class: 'btn primary', onclick: extract }, '提取'),
    h('button', { class: 'btn', onclick: async () => { try { input.value = await navigator.clipboard.readText(); extract(); } catch (_) { toast('无法读取剪贴板，请手动粘贴'); } } }, '读取剪贴板')),
  result); root.append(page);
}

export async function cacheView(root) {
  const page = h('div', { class: 'page settings-page', style: 'max-width:720px' }, pageTitle('缓存维护'), loadingBox()); root.append(page);
  const render = async () => {
    let estimate = {}; try { estimate = await navigator.storage?.estimate?.() || {}; } catch (_) {}
    const fmt = (n) => `${((Number(n) || 0) / 1024 / 1024).toFixed(1)} MiB`;
    const integrityMode = h('select', { class: 'input' },
      h('option', { value: 'off', selected: setting.cacheIntegrityCheckMode === 'off' }, '关闭（默认）'),
      h('option', { value: 'partial', selected: setting.cacheIntegrityCheckMode === 'partial' }, '部分：资料、封面与章节配置'),
      h('option', { value: 'full', selected: setting.cacheIntegrityCheckMode === 'full' }, '完全：再检查每一页图片'));
    integrityMode.onchange = () => updateSetting({ cacheIntegrityCheckMode: integrityMode.value });
    page.replaceChildren(pageTitle('缓存维护'), h('div', { class: 'setting-group' },
      h('div', { class: 'setting-item' }, h('div', { class: 'lab' }, '浏览器存储'), h('div', { class: 'hint' }, `已用 ${fmt(estimate.usage)} / 配额 ${fmt(estimate.quota)}`)),
      h('label', { class: 'setting-item setting-row' }, h('div', null, h('div', { class: 'lab' }, '进入下载中心时自动检查'), h('div', { class: 'hint' }, '部分检查较快；完全检查会逐页读取 IndexedDB Blob。')), integrityMode),
      h('button', { class: 'setting-item btn ghost', onclick: async () => { try { const mod = await import('./offline.js'); const result = await mod.checkOfflineIntegrity?.({ mode: 'full' }); toast(result?.message || '完整性检查完成'); } catch (error) { toast(error.message); } } }, '立即执行完全检查'),
      h('button', { class: 'setting-item btn ghost', onclick: async () => { const keys = await caches.keys(); await Promise.all(keys.map((x) => caches.delete(x))); toast('图片与静态缓存已清理'); render(); } }, '清理 Cache Storage'),
      h('button', { class: 'setting-item btn ghost', style: 'color:var(--danger)', onclick: async () => { if (!confirm('删除全部离线漫画并停止所有下载任务？')) return; try { await (await import('./downloads.js')).downloads.clearAll(); toast('下载任务与离线漫画已删除'); render(); } catch (error) { toast(error.message); } } }, '删除全部离线漫画')));
  };
  render();
}

export async function aboutView(root, _m, _q, ctx) {
  const page = h('div', { class: 'page settings-page', style: 'max-width:720px' }, pageTitle('更新与关于'), loadingBox()); root.append(page);
  try {
    const healthRequest = async () => {
      const response = await fetch('/healthz', { signal: ctx?.signal });
      if (!response.ok) {
        const error = new Error(`健康检查失败（${response.status}）`);
        error.status = response.status;
        throw error;
      }
      let value;
      try { value = await response.json(); } catch (_) { throw new Error('健康检查返回了无法识别的数据'); }
      if (!value || typeof value !== 'object' || typeof value.ok !== 'boolean') {
        throw new Error('健康检查响应格式异常');
      }
      return value;
    };
    const [health, update] = await Promise.all([healthRequest(), jsonRequest('/update', { signal: ctx?.signal })]);
    if (isViewInactive(ctx)) return;
    if (!update || typeof update !== 'object' || Array.isArray(update)) throw new Error('更新检查响应格式异常');
    const currentVersion = typeof update.currentVersion === 'string' ? update.currentVersion : '1.0.0';
    const latestVersion = typeof update.latestVersion === 'string' ? update.latestVersion : currentVersion;
    const updateMessage = typeof update.message === 'string' ? update.message : '';
    const updateAvailable = update.available === true;
    const updateUrl = updateAvailable ? safeUpdateUrl(update.url) : '';
    page.replaceChildren(pageTitle('更新与关于'), h('div', { class: 'setting-group' },
      h('div', { class: 'setting-item' }, h('div', { class: 'lab' }, `JM Web ${currentVersion}`), h('div', { class: 'hint' }, health.ok ? '服务运行正常' : '服务状态异常')),
      h('div', { class: 'setting-item' }, h('div', { class: 'lab' }, updateAvailable ? `发现新版本 ${latestVersion}` : '当前已是最新版本'), h('div', { class: 'hint' }, updateMessage)),
      updateUrl ? h('a', { class: 'setting-item advanced-link', href: updateUrl, target: '_blank', rel: 'noopener noreferrer' }, '查看更新', h('span', { class: 'arr' }, '↗')) : null,
      h('div', { class: 'setting-item' }, h('div', { class: 'hint' }, '参照 jmcomic-next 与 jm-mobile 的公开协议和用户体验，以响应式 Web/PWA 方式重新实现。'))));
  } catch (error) {
    if (!isViewInactive(ctx) && !isAbort(error)) {
      page.replaceChildren(pageTitle('更新与关于'), errorBox(error?.message || '无法读取版本与健康状态'));
    }
  }
}

/* ------------------------------ 启动任务 ------------------------------ */

async function autoSignIn() {
  if (!setting.autoSignInEnabled || locked || autoSignInStarted) return;
  autoSignInStarted = true;
  try {
    const me = (await api.me()).user; if (!me || locked) return;
    const daily = (await api.daily(me.uid)).data;
    const records = Array.isArray(daily?.record) ? daily.record.flat() : [];
    const today = records[new Date().getDate() - 1];
    const signed = today?.signed === true || today?.signed === 1 || today?.signed === '1'
      || String(today?.signed).toLowerCase() === 'true';
    if (!locked && daily?.daily_id && !signed) await api.dailyCheck(me.uid, daily.daily_id);
  } catch (_) {}
}

export function clipboardAlbumIdFromText(value) {
  if (typeof value !== 'string') return '';
  const match = /(?:JM\s*|album\/|photo\/)(\d{3,10})/i.exec(value);
  return match ? match[1] : '';
}

function handleClipboardPaste(event) {
  // iOS 会把启动、focus 或 visibilitychange 中的 Clipboard.readText 视为
  // 被动读取，并持续展示“粘贴/允许粘贴”系统浮层。这里只处理用户真实触发
  // 的 paste 事件；“提取漫画编码”页的显式按钮仍可按用户手势读取剪贴板。
  if (locked || !setting.clipboardAutoDetectEnabled || document.visibilityState !== 'visible'
      || document.getElementById('password-gate-input')) return;
  // 全局粘贴检测不得读取登录、应用锁或备份口令。先检查目标，再访问
  // clipboardData，确保敏感字段内容不会进入模块状态或被误识别为漫画编号。
  try {
    if (event?.target?.closest?.('input[type="password"], [data-clipboard-private="true"]')) return;
  } catch (_) { return; }
  let value = '';
  try { value = event?.clipboardData?.getData('text/plain') || ''; } catch (_) { return; }
  if (!value || value === lastClipboardValue) return;
  lastClipboardValue = value;
  const id = clipboardAlbumIdFromText(value); if (!id) return;
  const notice = h('div', { class: 'clipboard-notice' }, `检测到 JM${id}`,
    h('button', { class: 'btn primary', onclick: () => { notice.remove(); location.hash = `#/album/${id}`; } }, '打开'),
    h('button', { class: 'btn', onclick: () => notice.remove() }, '忽略'));
  document.body.append(notice); setTimeout(() => notice.remove(), 12000);
}

function showOnboarding() {
  if (setting.onboardingCompleted) return;
  let step = 0;
  const modal = h('div', { class: 'onboarding-overlay' });
  const card = h('div', { class: 'card onboarding-card' });
  const pages = [
    ['欢迎使用 JM Web', '这是面向桌面与移动浏览器的完整阅读、收藏、离线与工具空间。'],
    ['内容提示', '服务返回的内容可能不适合未成年人或公共场合。继续即表示你已了解并会遵守所在地规则。'],
    ['选择偏好', '你可以稍后在设置中修改主题、阅读模式、过滤标签、应用锁和备份。'],
  ];
  const render = () => {
    const [title, text] = pages[step];
    card.replaceChildren(...[h('h2', null, title), h('p', null, text),
      step === 2 ? h('div', null, toggleRow('自动签到', 'autoSignInEnabled'), toggleRow('剪贴板编号检测', 'clipboardAutoDetectEnabled'), toggleRow('显示 AI 入口', 'showAiEntry')) : null,
      h('div', { style: 'display:flex;justify-content:flex-end;gap:8px;margin-top:18px' },
        step ? h('button', { class: 'btn', onclick: () => { step--; render(); } }, '上一步') : null,
        h('button', { class: 'btn primary', onclick: () => { if (step < pages.length - 1) { step++; render(); } else { updateSetting({ onboardingCompleted: true, nsfwWarningDismissed: true }); modal.remove(); if (!unlockedTasksDeferred) runUnlockedTasks(); } } }, step === pages.length - 1 ? '开始使用' : '继续')),
    ].filter(Boolean));
  };
  modal.append(card); document.body.append(modal); render();
}

function lockSettingSignature(value = setting) {
  const required = Array.isArray(value.appLockRequiredMethods)
    ? [...new Set(value.appLockRequiredMethods.map(String))].sort()
    : [];
  return JSON.stringify({
    enabled: !!value.appLockEnabled,
    mode: String(value.appLockMode || ''),
    rule: value.appLockUnlockRule === 'required' ? 'required' : 'any',
    required,
    biometric: !!value.appLockUseBiometric,
  });
}

function cancelStorageReconcile() {
  if (storageReconcileTimer) clearTimeout(storageReconcileTimer);
  storageReconcileTimer = null;
}

function remountLockAfterExternalChange(forceRecovery = false) {
  cancelStorageReconcile();
  if (!setting.appLockEnabled) {
    releaseLocalLock();
    return;
  }
  // 已显示的面板仍绑定旧的凭据/验证规则，必须完整重建，不能让旧验证结果
  // 解锁刚刚在另一标签页更新过的新配置。
  locked = true;
  isolateLockBackground(false);
  lockOverlay?.remove();
  lockOverlay = null;
  void showLockGate({ forceRecovery });
}

function scheduleStorageReconcile(forceRecovery, delay = 0) {
  cancelStorageReconcile();
  storageReconcileTimer = setTimeout(() => {
    storageReconcileTimer = null;
    remountLockAfterExternalChange(forceRecovery);
  }, delay);
}

function handleLockStorageEvent(event) {
  if (event.storageArea && event.storageArea !== localStorage) return;
  if (recoveryInProgress) return;
  if (event.key === SETTING_STORAGE_KEY) {
    const before = lockSettingSignature();
    const wasEnabled = !!setting.appLockEnabled;
    syncSettingFromStorage(event.newValue);
    const after = lockSettingSignature();
    cancelStorageReconcile();
    if (!setting.appLockEnabled) {
      releaseLocalLock();
      // 灾难恢复会移除整个设置键；其他已打开标签也应丢弃内存中的旧会话/UI。
      if (event.newValue == null && wasEnabled) setTimeout(() => location.reload(), 80);
      return;
    }
    if (!wasEnabled || before !== after) {
      scheduleStorageReconcile(!hasLockCredential(), 0);
    }
    return;
  }
  if (event.key !== LOCK_KEY && event.key !== BIO_KEY) return;
  // 凭据与设置通常由另一标签页在同一操作中连续写入。直接读取最终设置值，
  // 不依赖两个 StorageEvent 的投递先后顺序。
  syncSettingFromStorage(localStorage.getItem(SETTING_STORAGE_KEY));
  if (!setting.appLockEnabled) {
    cancelStorageReconcile();
    releaseLocalLock();
    return;
  }
  // 清除凭据和随后写入 appLockEnabled=false 是同一同步操作。给删除事件一个
  // 很短的合并窗口，避免另一标签页在正常禁用时闪出“凭据损坏”；若没有
  // 后续设置事件，则按安全失败处理并保持灾难恢复锁屏。
  scheduleStorageReconcile(true, event.newValue == null ? 80 : 0);
}

function installAdvancedRuntimeListeners() {
  if (runtimeInstalled) return;
  runtimeInstalled = true;
  window.addEventListener('jmw-local-unlocked', () => {
    if (!unlockedTasksDeferred) runUnlockedTasks();
  });
  window.addEventListener('storage', handleLockStorageEvent);
  syncSettingFromStorage(localStorage.getItem(SETTING_STORAGE_KEY));
  showOnboarding();
  if (setting.appLockEnabled) showLockGate();
  document.addEventListener('paste', handleClipboardPaste);
  window.addEventListener('blur', () => { if (setting.privacyMode) document.documentElement.classList.add('window-blurred'); });
  window.addEventListener('focus', () => document.documentElement.classList.remove('window-blurred'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && setting.appLockEnabled && setting.appLockOnHidden) locked = true;
    if (document.visibilityState === 'visible') {
      if (locked) showLockGate();
    }
  });
}

// 首屏先安装本地锁及隐私监听器，但在站点访问门禁确认前不运行自动签到等 API 任务。
export function prepareAdvancedRuntime() {
  unlockedTasksDeferred = true;
  installAdvancedRuntimeListeners();
}

export function installAdvancedRuntime() {
  unlockedTasksDeferred = false;
  installAdvancedRuntimeListeners();
  runUnlockedTasks();
}

function runUnlockedTasks() {
  if (locked) return;
  autoSignIn();
}
