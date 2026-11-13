'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const css = fs.readdirSync(path.join(root, 'public', 'css'))
  .filter((name) => name.endsWith('.css')).sort()
  .map((name) => fs.readFileSync(path.join(root, 'public', 'css', name), 'utf8'))
  .join('\n');
const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

function rulesUsing(variable) {
  const rules = [];
  const matcher = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = matcher.exec(cssWithoutComments))) {
    if (match[2].includes(`var(${variable}`)) {
      rules.push({ selector: match[1].trim(), declarations: match[2] });
    }
  }
  return rules;
}

function assertRule(pattern, message) {
  assert.match(cssWithoutComments, pattern, message);
}

// 自定义列数为 0 时 store.js 会移除变量。裸 var() 在 computed-value 阶段
// 失效并不会回退到前面的响应式声明，而会把属性重置为初始值；因此所有
// 自定义列规则必须由对应 fixed-* class 隔离。
const fixedGridContracts = [
  ['--home-grid-columns', '.fixed-home-grid'],
  ['--collect-grid-columns', '.fixed-collect-grid'],
  ['--download-grid-columns', '.fixed-download-grid'],
  ['--history-grid-columns', '.fixed-history-grid'],
  ['--search-grid-columns', '.fixed-search-grid'],
];

for (const [variable, className] of fixedGridContracts) {
  const matchingRules = rulesUsing(variable);
  assert.ok(matchingRules.length > 0, `${variable} 必须存在受控的固定列 CSS 规则`);
  for (const rule of matchingRules) {
    assert.ok(
      rule.selector.includes(className),
      `${variable} 不得由未受 ${className} 保护的高优先级规则覆盖：${rule.selector}`,
    );
  }
}

// 默认布局仍须有不依赖 CSS 自定义列变量的移动优先规则。
assertRule(
  /\.grid\s*\{[^}]*grid-template-columns\s*:\s*repeat\(2\s*,\s*minmax\(0\s*,\s*1fr\)\)/,
  '默认漫画网格必须保留两列移动端基线',
);
assertRule(
  /\.hscroll\s+\.comic-card\s*\{[^}]*\bwidth\s*:\s*\d+(?:\.\d+)?px[^}]*\bflex(?:-basis|\s*:)[^}]*\d+(?:\.\d+)?px/,
  '默认首页横条卡片必须有不依赖 --home-grid-columns 的确定尺寸',
);

assertRule(
  /#reader\s+\.icon-btn\.r-favorites-back\s*\{[^}]*width\s*:\s*auto[^}]*flex-shrink\s*:\s*0[^}]*white-space\s*:\s*nowrap/,
  '返回收藏按钮应自适应文本宽度并保持触控目标不被压缩',
);

assert(css.indexOf('#reader .icon-btn.r-favorites-back') < css.indexOf('@media (hover: hover)'),
  '返回收藏基础样式不得仅存在于鼠标 hover 规则内，触屏也必须生效');

// 页面根级禁止产生横向滚动；真正需要横滑的组件必须保留自己的滚动容器。
assertRule(
  /html\s*,\s*body\s*,\s*#app\s*,\s*#main\s*\{[^}]*max-width\s*:\s*100%[^}]*overflow-x\s*:\s*clip/,
  '页面根级必须限制为视口宽度并裁剪意外横向溢出',
);
for (const selector of ['\\.hscroll', '\\.chips']) {
  assertRule(
    new RegExp(`${selector}\\s*\\{[^}]*overflow-x\\s*:\\s*auto`),
    `${selector.replace('\\', '')} 必须继续作为显式横向滚动容器`,
  );
}

// 首页漫画封面与上游 _3x4 资源保持一致；图片只裁切内容，不得撑破卡片。
assertRule(
  /\.comic-card\s+\.cover\s*\{[^}]*width\s*:\s*100%[^}]*aspect-ratio\s*:\s*3\s*\/\s*4[^}]*overflow\s*:\s*hidden/,
  '漫画封面容器必须是 100% 宽、3:4 且裁剪溢出',
);
assertRule(
  /\.comic-card\s+\.cover\s+img\s*\{[^}]*width\s*:\s*100%[^}]*height\s*:\s*100%[^}]*object-fit\s*:\s*cover/,
  '漫画封面图片必须填满 3:4 容器并使用 object-fit: cover',
);

// 顶栏与主内容必须计入 safe-area-inset-top，避免全屏/PWA 刘海屏遮挡。
assertRule(
  /--safe-top\s*:\s*env\(\s*safe-area-inset-top/,
  '根变量必须声明 safe-area-inset-top 兜底',
);
assertRule(
  /#topbar\s*\{[^}]*height\s*:\s*var\(--topbar-total-h\)[^}]*padding\s*:\s*var\(--safe-top\)/,
  '顶栏高度与内边距必须计入顶部安全区',
);
assertRule(
  /#main\s*\{[^}]*padding-top\s*:\s*var\(--topbar-total-h\)/,
  '主内容顶部内边距必须与含安全区的顶栏高度对齐',
);

// 调色板衍生色必须动态跟随 --primary / --secondary，避免切换蓝/绿/紫主题后残留粉底。
assertRule(
  /--primary-weak\s*:\s*color-mix\(\s*in\s+srgb\s*,\s*var\(--primary\)/,
  '--primary-weak 必须由 --primary 动态混合生成',
);
assertRule(
  /--accent\s*:\s*var\(--secondary\)/,
  '--accent 必须接入调色板的 --secondary 变量',
);

// 触屏输入框字号 >= 16px，阻止 iOS Safari 聚焦自动放大页面。
assertRule(
  /@media\s*\(pointer\s*:\s*coarse\)[^{]*\{[\s\S]*?\.input[^{]*\{[^}]*font-size\s*:\s*16px/,
  '触屏设备输入框必须使用 16px 字号防止浏览器自动缩放',
);

// 移动端 AI 会话侧栏必须支持抽屉展开，不能彻底隐藏历史会话。
assertRule(
  /\.ai-page\.sidebar-open\s+\.ai-sidebar\s*\{[^}]*visibility\s*:\s*visible/,
  '移动端 AI 页面必须提供可展开的会话抽屉样式',
);

// 全站前端禁止使用阻塞且破坏移动端体验的原生 alert / confirm / prompt。
for (const name of fs.readdirSync(path.join(root, 'public', 'js')).filter((item) => item.endsWith('.js'))) {
  const jsSource = fs.readFileSync(path.join(root, 'public', 'js', name), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(
    !/\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/.test(jsSource),
    `${name} 不得调用原生阻塞弹窗 alert/confirm/prompt`,
  );
}

const uiSource = fs.readFileSync(path.join(root, 'public', 'js', 'ui.js'), 'utf8');
assert.match(
  uiSource,
  /if\s*\(isEditable\s*&&\s*!shouldAutoFocusEditable\(\)\)\s*return\s+panel/,
  'openModal / promptDialog 必须在移动端把初始焦点回退到非 editable 的对话框面板',
);
assert.match(
  uiSource,
  /clipboardPrivate\s*:\s*'true'/,
  'promptDialog 敏感输入必须标记 data-clipboard-private 防止剪贴板嗅探',
);
assert.match(
  uiSource,
  /if\s*\(event\.key\s*===\s*'Tab'\)/,
  'openModal 必须拦截 Tab 键将键盘焦点限制在活动对话框内',
);

// 遮罩层级不变量：应用锁 < 模态框 < Toast < 隐私失焦伪装，确保应用锁灾难恢复弹窗与提示不被锁屏层遮挡。
function extractZIndex(pattern, label) {
  const matched = css.match(pattern);
  assert.ok(matched, `缺少 ${label} 的 z-index 声明`);
  return Number(matched[1]);
}
const lockZ = extractZIndex(/\.local-lock-overlay[^{]*\{[^}]*z-index\s*:\s*(\d+)/, '应用锁遮罩');
const modalZ = extractZIndex(/\.jmw-modal-backdrop\s*\{[^}]*z-index\s*:\s*(\d+)/, '模态弹窗遮罩');
const toastZ = extractZIndex(/\.toast\s*\{[^}]*z-index\s*:\s*(\d+)/, 'Toast 提示');
const privacyZ = extractZIndex(/\.privacy-mode\.window-blurred\s+body::after\s*\{[^}]*z-index\s*:\s*(\d+)/, '隐私伪装遮罩');
assert.ok(lockZ < modalZ, '模态框 z-index 必须高于应用锁遮罩，否则灾难恢复输入框会被锁屏挡住');
assert.ok(modalZ < toastZ, 'Toast z-index 必须高于模态框与锁屏遮罩');
assert.ok(toastZ < privacyZ, '隐私失焦遮罩 z-index 必须高于普通弹窗与提示');

// 全屏遮罩（模态框、应用锁、首次引导）在手机矮屏/横屏下必须自身可滚动并用 margin: auto 居中卡片，防止顶部内容裁切。
assertRule(
  /\.jmw-modal-backdrop\s*\{[^}]*display\s*:\s*flex[^}]*overflow-y\s*:\s*auto/,
  '模态遮罩必须支持纵向滚动防止矮屏裁切',
);
assertRule(
  /\.jmw-modal\s*\{[^}]*margin\s*:\s*auto/,
  '模态卡片必须使用 margin: auto 兼顾居中与安全滚动',
);
assertRule(
  /\.local-lock-overlay\s*,\s*\.onboarding-overlay\s*\{[^}]*display\s*:\s*flex[^}]*overflow-y\s*:\s*auto/,
  '应用锁与引导遮罩必须支持纵向滚动防止 PIN+手势双启用或横屏时裁切解锁控件',
);
assertRule(
  /\.local-lock-card\s*,\s*\.onboarding-card\s*\{[^}]*margin\s*:\s*auto/,
  '应用锁与引导卡片必须使用 margin: auto 兼顾居中与安全滚动',
);

// AI 页面在移动端包含 position: fixed 会话抽屉，禁止在 .ai-page 上驻留带 transform 的 forwards/both 动画。
assertRule(
  /\.page:not\(\.page-wide\):not\(\.ai-page\)\s*\{\s*animation\s*:\s*page-in\s+[\d.]+s\s+ease-out\s*;\s*\}/,
  '.page 入场动画必须排除 .ai-page 且不得使用 both/forwards 残留 transform 包含块',
);

// 历史记录卡片内嵌角标删除按钮必须具备定位锚点并阻止外层 <a> 默认跳转。
assertRule(
  /\.comic-card\.has-corner-action\s*\{\s*position\s*:\s*relative\s*;\s*\}/,
  '带角标操作的漫画卡片必须声明 position: relative',
);
const userSource = fs.readFileSync(path.join(root, 'public', 'js', 'user.js'), 'utf8');
assert.match(
  userSource,
  /class:\s*'card-corner-btn'[\s\S]*?onclick:\s*async\s*\(e\)\s*=>\s*\{\s*e\.preventDefault\(\);\s*e\.stopPropagation\(\);/,
  '历史卡片角标删除按钮必须同时调用 preventDefault 与 stopPropagation，防止触发外层链接跳转',
);

class FakeStyle {
  constructor() { this.values = new Map(); }
  setProperty(name, value) { this.values.set(name, String(value)); }
  removeProperty(name) { this.values.delete(name); }
  getPropertyValue(name) { return this.values.get(name) || ''; }
}

class FakeClassList {
  constructor() { this.values = new Set(); }
  toggle(name, force) {
    const enabled = force === undefined ? !this.values.has(name) : !!force;
    if (enabled) this.values.add(name); else this.values.delete(name);
    return enabled;
  }
  contains(name) { return this.values.has(name); }
}

(async () => {
  const style = new FakeStyle();
  const classList = new FakeClassList();
  global.localStorage = {
    length: 0,
    getItem: () => null,
    setItem() {},
    removeItem() {},
    key: () => null,
  };
  global.document = {
    documentElement: { dataset: {}, style, classList },
    querySelector: () => null,
    title: '',
  };
  global.window = { matchMedia: () => ({ matches: false }) };

  const storeUrl = `${pathToFileURL(path.join(root, 'public', 'js', 'store.js')).href}?mobile-layout=${Date.now()}`;
  const { setting, applyTheme } = await import(storeUrl);
  const keyByVariable = {
    '--home-grid-columns': 'homeGridColumns',
    '--collect-grid-columns': 'collectGridColumns',
    '--download-grid-columns': 'downloadGridColumns',
    '--history-grid-columns': 'historyGridColumns',
    '--search-grid-columns': 'searchGridColumns',
  };

  for (const [variable, className] of fixedGridContracts) {
    const key = keyByVariable[variable];
    const domClassName = className.slice(1);
    for (const value of [1, 3, 6]) {
      setting[key] = value;
      applyTheme();
      assert.strictEqual(style.getPropertyValue(variable), String(value), `${key}=${value} 必须写入 CSS 变量`);
      assert.ok(classList.contains(domClassName), `${key}=${value} 必须开启 ${className}`);
    }
    for (const value of [0, -1, 7, 1.5, NaN, null, 'invalid']) {
      setting[key] = value;
      applyTheme();
      assert.strictEqual(style.getPropertyValue(variable), '', `${key}=${String(value)} 必须移除 CSS 变量`);
      assert.ok(!classList.contains(domClassName), `${key}=${String(value)} 不得开启 ${className}`);
    }
  }

  delete global.window;
  delete global.document;
  delete global.localStorage;
  console.log('mobile responsive layout checks pass');
})().catch((error) => {
  delete global.window;
  delete global.document;
  delete global.localStorage;
  console.error(error);
  process.exitCode = 1;
});
