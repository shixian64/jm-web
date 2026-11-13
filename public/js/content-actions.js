import { h, openModal } from './ui.js';
import { icon } from './icons.js';

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
    let settled = false;
    let modal = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      modal?.close('action');
      resolve(value);
    };
    const list = h('div', { class: 'folder-picker-list' });
    entries.forEach(([id, name]) => list.append(h('button', {
      class: 'btn folder-picker-item',
      type: 'button',
      onclick: () => finish([id, name]),
    },
    h('span', { class: 'folder-picker-ic', 'aria-hidden': 'true' }, icon(id === '0' ? 'star' : 'folder', 17)),
    h('span', { class: 'folder-picker-name' }, name),
    h('span', { class: 'folder-picker-arr', 'aria-hidden': 'true' }, icon('chevron-right', 16)))));
    const cancelBtn = h('button', {
      class: 'btn',
      type: 'button',
      onclick: () => finish(null),
    }, '取消');
    modal = openModal({
      title,
      body: list,
      actions: [cancelBtn],
      onClose: () => finish(null),
    });
  });
}
