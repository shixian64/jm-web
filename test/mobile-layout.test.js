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
