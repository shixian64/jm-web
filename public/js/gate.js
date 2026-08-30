// 访问口令门控（服务器设置 ACCESS_PASSWORD 环境变量时启用）
import { api } from './api.js';
import { h } from './ui.js';
import { icon } from './icons.js';

export function passwordGate(onSuccess) {
  const titleId = 'password-gate-title';
  const inputId = 'password-gate-input';
  const errorId = 'password-gate-error';
  const input = h('input', {
    id: inputId, class: 'input', type: 'password', placeholder: '访问口令',
    autocomplete: 'current-password', 'aria-describedby': errorId,
  });
  const btn = h('button', { class: 'btn primary block' }, '进 入');
  const appRoot = document.getElementById('app');
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const appHadInert = !!(appRoot && appRoot.hasAttribute('inert'));
  const appWasInert = !!(appRoot && 'inert' in appRoot && appRoot.inert);
  let cleaned = false;
  let focusRaf = 0;

  const overlay = h('div', {
    role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId,
    style: 'position:fixed;inset:0;z-index:300;background:var(--bg);display:flex;align-items:center;justify-content:center;padding:20px',
    onkeydown: (e) => {
      if (e.key !== 'Tab') return;
      const focusable = [input, btn].filter((el) => !el.disabled);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (focusable.length === 1 || (e.shiftKey && document.activeElement === first)
        || (!e.shiftKey && document.activeElement === last)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    },
  },
    h('form', {
      class: 'card', style: 'max-width:340px;width:100%;padding:28px',
      onsubmit: async (e) => {
        e.preventDefault();
        if (btn.disabled) return;
        btn.disabled = true;
        try {
          await api.auth(input.value);
          cleanup(true);
          onSuccess();
        } catch (err) {
          const msg = overlay.querySelector('.err');
          msg.textContent = err.message;
        } finally {
          btn.disabled = false;
        }
      },
    },
      h('h2', { id: titleId, style: 'display:flex;align-items:center;justify-content:center;gap:8px;margin:2px 0 18px' }, icon('lock', 22), 'JM Web 访问验证'),
      h('label', { for: inputId, style: 'display:block;font-size:13px;color:var(--text-2);margin-bottom:6px' }, '访问口令'),
      input,
      h('div', {
        id: errorId, class: 'err', role: 'alert', 'aria-live': 'assertive',
        style: 'color:var(--danger);font-size:12.5px;margin-top:8px;min-height:18px',
      }),
      h('div', { style: 'margin-top:14px' }, btn),
      h('p', { style: 'font-size:12px;color:var(--text-2);text-align:center;margin-top:12px' }, '此站点已开启访问口令保护'),
    ),
  );

  function cleanup(restoreFocus = false) {
    if (cleaned) return;
    cleaned = true;
    if (focusRaf) cancelAnimationFrame(focusRaf);
    focusRaf = 0;
    overlay.remove();
    if (appRoot) {
      if (appHadInert) appRoot.setAttribute('inert', '');
      else appRoot.removeAttribute('inert');
      if ('inert' in appRoot) appRoot.inert = appWasInert;
    }
    if (restoreFocus && previouslyFocused && previouslyFocused.isConnected
      && typeof previouslyFocused.focus === 'function') {
      previouslyFocused.focus({ preventScroll: true });
    }
  }

  // 先隔离后台，再把模态层接入 DOM；否则对脱离文档的 input 调用 focus 不会生效。
  if (appRoot) appRoot.setAttribute('inert', '');
  document.body.appendChild(overlay);
  input.focus({ preventScroll: true });
  // 防止启动阶段已排队的页面聚焦 RAF 抢回焦点。
  focusRaf = requestAnimationFrame(() => {
    focusRaf = 0;
    if (!cleaned && overlay.isConnected) input.focus({ preventScroll: true });
  });

  return cleanup;
}
