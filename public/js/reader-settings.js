// 阅读中的设置面板。仅负责 DOM 与事件转发，阅读状态仍由 reader.js 统一管理。
import { h } from './ui.js';
import { icon } from './icons.js';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function switchRow(label, description, input) {
  return h('label', { class: 'r-setting-row r-switch-row' },
    h('span', { class: 'r-setting-copy' },
      h('span', { class: 'r-setting-label' }, label),
      description ? h('span', { class: 'r-setting-desc' }, description) : null,
    ),
    input,
  );
}

function rangeRow(label, input, value) {
  return h('div', { class: 'r-setting-row r-range-row' },
    h('div', { class: 'r-setting-range-head' },
      h('span', { class: 'r-setting-label' }, label),
      value,
    ),
    input,
  );
}

/**
 * @param {{
 *   idSuffix: string,
 *   getSnapshot: () => object,
 *   onClose: () => void,
 *   onMode: (value:string) => void,
 *   onSetting: (key:string, value:any) => void,
 *   onZoom: (value:number) => void,
 *   onPage: (value:number) => void,
 *   onChapter: (delta:number) => void,
 * }} options
 */
export function createReaderSettings(options) {
  const titleId = `reader-settings-title-${options.idSuffix}`;
  const mask = h('div', {
    class: 'r-settings-mask',
    onclick: () => options.onClose(),
  });
  const closeBtn = h('button', {
    class: 'icon-btn', type: 'button', title: '关闭阅读设置', 'aria-label': '关闭阅读设置',
    onclick: () => options.onClose(),
  }, icon('arrow-left', 20));

  const modeButtons = new Map();
  const modeGroup = h('div', { class: 'r-mode-grid', role: 'radiogroup', 'aria-label': '阅读模式' });
  [
    ['scroll', '连续滚动', '上下浏览'],
    ['page', '向右翻页', '支持滑动'],
    ['pageReverse', '向左翻页', 'RTL 日漫'],
    ['tap', '纯点击', '禁用滑页'],
  ].forEach(([value, label, sub]) => {
    const button = h('button', {
      type: 'button', class: 'r-mode-option', role: 'radio', dataset: { mode: value },
      onclick: () => options.onMode(value),
    }, h('strong', null, label), h('small', null, sub));
    modeButtons.set(value, button);
    modeGroup.append(button);
  });
  modeGroup.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const buttons = [...modeButtons.values()];
    const current = Math.max(0, buttons.indexOf(document.activeElement));
    const delta = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
    const target = buttons[(current + delta + buttons.length) % buttons.length];
    target.focus();
    target.click();
  });

  const themeSelect = h('select', { class: 'r-setting-select', 'aria-label': '主题外观' },
    h('option', { value: 'auto' }, '跟随系统'),
    h('option', { value: 'light' }, '浅色'),
    h('option', { value: 'dark' }, '深色'),
  );
  themeSelect.addEventListener('change', () => options.onSetting('theme', themeSelect.value));

  const shuntSelect = h('select', { class: 'r-setting-select', 'aria-label': '图片分流线路' },
    ...[1, 2, 3, 4].map((value) => h('option', { value: String(value) }, `线路 ${value}`)),
  );
  shuntSelect.addEventListener('change', () => options.onSetting('shunt', shuntSelect.value));

  const prefetchSelect = h('select', { class: 'r-setting-select', 'aria-label': '阅读预加载数量' },
    ...[1, 3, 5, 8].map((value) => h('option', { value: String(value) }, `${value} 页`)),
  );
  prefetchSelect.addEventListener('change', () => options.onSetting('prefetchCount', Number(prefetchSelect.value)));

  const fitSelect = h('select', { class: 'r-setting-select', 'aria-label': '图片适配方式' },
    h('option', { value: 'contain' }, '完整显示'),
    h('option', { value: 'width' }, '适应宽度'),
  );
  fitSelect.addEventListener('change', () => options.onSetting('pageFit', fitSelect.value));

  const tapModeSelect = h('select', { class: 'r-setting-select', 'aria-label': '滚动模式点击区域' },
    h('option', { value: 'default' }, '上下区域'),
    h('option', { value: 'side' }, '左右两侧'),
  );
  tapModeSelect.addEventListener('change', () => options.onSetting('tapMode', tapModeSelect.value));

  const followBrightness = h('input', { type: 'checkbox', class: 'r-switch', 'aria-label': '亮度跟随系统' });
  followBrightness.addEventListener('change', () => options.onSetting('brightnessFollowSystem', followBrightness.checked));
  const brightnessValue = h('output', { class: 'r-setting-value' }, '100%');
  const brightness = h('input', {
    type: 'range', class: 'r-range', min: '20', max: '100', step: '1', 'aria-label': '阅读亮度',
  });
  brightness.addEventListener('input', () => {
    brightnessValue.textContent = `${brightness.value}%`;
    options.onSetting('brightness', Number(brightness.value) / 100);
  });

  const showPageNumber = h('input', { type: 'checkbox', class: 'r-switch', 'aria-label': '显示页码' });
  showPageNumber.addEventListener('change', () => options.onSetting('showPageNumber', showPageNumber.checked));
  const keepAwake = h('input', { type: 'checkbox', class: 'r-switch', 'aria-label': '阅读时保持屏幕常亮' });
  keepAwake.addEventListener('change', () => options.onSetting('keepAwake', keepAwake.checked));
  const supportZoom = h('input', { type: 'checkbox', class: 'r-switch', 'aria-label': '允许图片缩放' });
  supportZoom.addEventListener('change', () => options.onSetting('supportZoom', supportZoom.checked));
  const autoHide = h('input', { type: 'checkbox', class: 'r-switch', 'aria-label': '自动隐藏阅读控制' });
  autoHide.addEventListener('change', () => options.onSetting('readerToolbarAutoHide', autoHide.checked));
  const memoryOpt = h('input', { type: 'checkbox', class: 'r-switch', 'aria-label': '阅读图片内存优化' });
  memoryOpt.addEventListener('change', () => options.onSetting('readMemoryOptEnabled', memoryOpt.checked));
  const decodeConcurrency = h('select', { class: 'r-setting-select', 'aria-label': '图片解码并发数' },
    ...[1, 2, 3, 4].map((value) => h('option', { value: String(value) }, `${value} 路`)),
  );
  decodeConcurrency.addEventListener('change', () => options.onSetting('readDecodeConcurrency', Number(decodeConcurrency.value)));

  const zoomValue = h('output', { class: 'r-setting-value' }, '100%');
  const zoom = h('input', {
    type: 'range', class: 'r-range', min: '100', max: '400', step: '10', 'aria-label': '图片缩放比例',
  });
  zoom.addEventListener('input', () => {
    zoomValue.textContent = `${zoom.value}%`;
    options.onZoom(Number(zoom.value) / 100);
  });

  const pageValue = h('output', { class: 'r-setting-value' }, '0 / 0');
  const page = h('input', {
    type: 'range', class: 'r-range', min: '1', max: '1', step: '1', 'aria-label': '跳转页码',
  });
  page.addEventListener('input', () => {
    pageValue.textContent = `${page.value} / ${page.max}`;
  });
  page.addEventListener('change', () => options.onPage(Number(page.value) - 1));

  const prevChapter = h('button', {
    type: 'button', class: 'r-chapter-btn', onclick: () => options.onChapter(-1),
  }, icon('arrow-left', 17), h('span', null, '上一章'));
  const nextChapter = h('button', {
    type: 'button', class: 'r-chapter-btn', onclick: () => options.onChapter(1),
  }, h('span', null, '下一章'), icon('arrow-right', 17));

  const panel = h('aside', {
    class: 'r-settings', role: 'dialog', 'aria-modal': 'true',
    'aria-labelledby': titleId, 'aria-hidden': 'true',
  },
    h('div', { class: 'r-settings-head' },
      closeBtn,
      h('h3', { id: titleId }, '阅读设置'),
      h('span', { class: 'r-settings-head-spacer', 'aria-hidden': 'true' }),
    ),
    h('div', { class: 'r-settings-body' },
      h('section', { class: 'r-setting-section' },
        h('h4', null, '阅读方式'), modeGroup,
        h('label', { class: 'r-setting-row' },
          h('span', { class: 'r-setting-copy' }, h('span', { class: 'r-setting-label' }, '图片适配')),
          fitSelect,
        ),
        h('label', { class: 'r-setting-row' },
          h('span', { class: 'r-setting-copy' },
            h('span', { class: 'r-setting-label' }, '滚动点击区域'),
            h('span', { class: 'r-setting-desc' }, '点击对应区域快速滚动一屏'),
          ),
          tapModeSelect,
        ),
      ),
      h('section', { class: 'r-setting-section' },
        h('h4', null, '显示'),
        h('label', { class: 'r-setting-row' },
          h('span', { class: 'r-setting-copy' }, h('span', { class: 'r-setting-label' }, '主题外观')),
          themeSelect,
        ),
        switchRow('亮度跟随系统', '关闭后使用下方阅读亮度', followBrightness),
        rangeRow('阅读亮度', brightness, brightnessValue),
        switchRow('显示页码', '在图片角落显示当前页', showPageNumber),
        switchRow('保持屏幕常亮', '浏览器支持时使用 Wake Lock', keepAwake),
      ),
      h('section', { class: 'r-setting-section' },
        h('h4', null, '操作'),
        switchRow('允许缩放', '翻页模式支持双指、拖动和 Ctrl + 滚轮', supportZoom),
        rangeRow('当前缩放', zoom, zoomValue),
        switchRow('自动隐藏控制', '闲置后隐藏工具栏和进度条', autoHide),
      ),
      h('section', { class: 'r-setting-section' },
        h('h4', null, '性能'),
        h('label', { class: 'r-setting-row' },
          h('span', { class: 'r-setting-copy' },
            h('span', { class: 'r-setting-label' }, '图片分流'),
            h('span', { class: 'r-setting-desc' }, '切换后当前章节后续图片立即使用新线路'),
          ),
          shuntSelect,
        ),
        h('label', { class: 'r-setting-row' },
          h('span', { class: 'r-setting-copy' },
            h('span', { class: 'r-setting-label' }, '预加载数量'),
            h('span', { class: 'r-setting-desc' }, '按设备性能控制前后缓存页数'),
          ),
          prefetchSelect,
        ),
        switchRow('内存优化', '限制同时解码数和缓存，适合内存较小的设备', memoryOpt),
        h('label', { class: 'r-setting-row' },
          h('span', { class: 'r-setting-copy' },
            h('span', { class: 'r-setting-label' }, '解码并发'),
            h('span', { class: 'r-setting-desc' }, '仅在内存优化开启时生效'),
          ),
          decodeConcurrency,
        ),
      ),
      h('section', { class: 'r-setting-section r-progress-section' },
        h('h4', null, '阅读进度'),
        rangeRow('页码', page, pageValue),
        h('div', { class: 'r-chapter-actions' }, prevChapter, nextChapter),
      ),
    ),
  );
  panel.inert = true;

  function refresh() {
    const s = options.getSnapshot() || {};
    const mode = ['scroll', 'page', 'pageReverse', 'tap'].includes(s.mode) ? s.mode : 'scroll';
    modeButtons.forEach((button, value) => {
      const selected = value === mode;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-checked', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    fitSelect.value = s.pageFit === 'width' ? 'width' : 'contain';
    fitSelect.disabled = mode === 'scroll';
    tapModeSelect.value = s.tapMode === 'side' ? 'side' : 'default';
    tapModeSelect.disabled = mode !== 'scroll';
    themeSelect.value = ['auto', 'light', 'dark'].includes(s.theme) ? s.theme : 'auto';
    shuntSelect.value = ['1', '2', '3', '4'].includes(String(s.shunt)) ? String(s.shunt) : '1';
    shuntSelect.disabled = s.offline === true || s.sourceRefreshPending === true || !s.sourceReady;
    prefetchSelect.value = ['1', '3', '5', '8'].includes(String(s.prefetchCount))
      ? String(s.prefetchCount) : '3';
    followBrightness.checked = s.brightnessFollowSystem !== false;
    brightness.value = String(Math.round(clamp(s.brightness ?? 1, .2, 1) * 100));
    brightness.disabled = followBrightness.checked;
    brightnessValue.textContent = followBrightness.checked ? '系统' : `${brightness.value}%`;
    showPageNumber.checked = s.showPageNumber !== false;
    keepAwake.checked = s.keepAwake !== false;
    supportZoom.checked = s.supportZoom !== false;
    autoHide.checked = s.readerToolbarAutoHide !== false;
    memoryOpt.checked = s.readMemoryOptEnabled === true;
    decodeConcurrency.value = String(clamp(s.readDecodeConcurrency || 2, 1, 4));
    decodeConcurrency.disabled = !memoryOpt.checked;
    zoom.value = String(Math.round(clamp(s.zoom || 1, 1, 4) * 100));
    zoom.disabled = !supportZoom.checked || mode === 'scroll';
    zoomValue.textContent = `${zoom.value}%`;
    const total = Math.max(0, Number(s.total) || 0);
    const current = total ? clamp((Number(s.current) || 0) + 1, 1, total) : 1;
    page.max = String(Math.max(1, total));
    page.value = String(current);
    page.disabled = total <= 1;
    pageValue.textContent = total ? `${current} / ${total}` : '0 / 0';
    prevChapter.disabled = !s.hasPreviousChapter;
    nextChapter.disabled = !s.hasNextChapter;
  }

  function open() {
    refresh();
    mask.classList.add('on');
    panel.classList.add('on');
    panel.inert = false;
    panel.setAttribute('aria-hidden', 'false');
    queueMicrotask(() => closeBtn.focus({ preventScroll: true }));
  }

  function close() {
    mask.classList.remove('on');
    panel.classList.remove('on');
    panel.inert = true;
    panel.setAttribute('aria-hidden', 'true');
  }

  return {
    mask, panel, open, close, refresh,
    isOpen: () => panel.classList.contains('on'),
  };
}
