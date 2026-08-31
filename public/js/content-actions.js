import { h } from './ui.js';

export async function copyText(value) {
  const text = String(value || '');
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = h('textarea', {
    style: 'position:fixed;left:-9999px;top:0', readonly: true,
  }, text);
  document.body.append(input);
  input.select();
  const ok = document.execCommand('copy');
  input.remove();
  if (!ok) throw new Error('浏览器未允许复制');
}

export function folderEntries(value) {
  const result = [];
  if (Array.isArray(value)) {
    value.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      if (Array.isArray(item) && item.length) {
        result.push([String(item[0]), String(item[1] || `收藏夹 ${item[0]}`)]);
        return;
      }
      const id = item.folder_id ?? item.id ?? item.fid;
      const name = item.folder_name ?? item.name ?? item.title;
      if (id != null) result.push([String(id), String(name || `收藏夹 ${id}`)]);
    });
  } else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([id, name]) => result.push([String(id), String(name || `收藏夹 ${id}`)]));
  }
  if (!result.some(([id]) => id === '0')) result.unshift(['0', '默认收藏夹']);
  const seen = new Set();
  return result.filter(([id]) => id && !seen.has(id) && seen.add(id));
}

/** 返回选中的 [id, name]；取消时返回 null。 */
export function chooseFolder(folders, title = '选择收藏夹', excludedId = null) {
  const entries = folderEntries(folders).filter(([id]) => id !== String(excludedId));
  return new Promise((resolve) => {
    const dialog = h('dialog', {
      'aria-label': title,
      style: 'width:min(420px,calc(100vw - 28px));max-height:75vh;border:1px solid var(--line);border-radius:16px;background:var(--card);color:var(--text);padding:0;box-shadow:0 18px 60px rgba(0,0,0,.3)',
    });
    const finish = (value) => {
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(value);
    };
    const list = h('div', { style: 'display:grid;gap:8px;padding:4px 16px 16px;overflow:auto' });
    entries.forEach(([id, name]) => list.append(h('button', {
      class: 'btn', type: 'button', style: 'justify-content:flex-start;min-height:42px',
      onclick: () => finish([id, name]),
    }, id === '0' ? '★' : '▣', name)));
    dialog.append(
      h('div', { style: 'display:flex;align-items:center;padding:16px;gap:10px' },
        h('strong', { style: 'flex:1' }, title),
        h('button', { class: 'btn', type: 'button', onclick: () => finish(null) }, '取消')),
      list,
    );
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); }, { once: true });
    document.body.append(dialog);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  });
}
