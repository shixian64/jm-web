// 下载中心 UI。保持为独立模块，路由层可直接 mountDownloadCenter(root)。

import { downloads } from './downloads.js';
import {
  listOfflineAlbums,
  listOfflineChapters,
  getOfflineStorageEstimate,
  requestPersistentStorage,
  checkOfflineIntegrity,
} from './offline.js';
import { exportAlbumZip, exportAlbumPdf, exportChapterZip, exportChapterPdf } from './export.js';
import { setting } from './store.js';

function element(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) if (child != null) node.append(child.nodeType ? child : document.createTextNode(String(child)));
  return node;
}

function ensureStyles() {
  if (document.querySelector('link[data-jmw-offline-style]')) return;
  const link = element('link', { rel: 'stylesheet', href: '/css/offline.css', 'data-jmw-offline-style': '1' });
  document.head.append(link);
}

function bytes(value) {
  let n = Number(value) || 0;
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) { n /= 1024; unit++; }
  return `${n >= 10 || unit === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[unit]}`;
}

function confirmLargePdf(chapters, selectedIds = null) {
  const wanted = selectedIds && selectedIds.length ? new Set(selectedIds.map(String)) : null;
  const selected = chapters.filter((chapter) => chapter.complete
    && (!wanted || wanted.has(String(chapter.photoId))));
  const pages = selected.reduce((sum, chapter) => sum + Number(chapter.imageCount || 0), 0);
  const size = selected.reduce((sum, chapter) => sum + Number(chapter.totalBytes || 0), 0);
  if (pages < 200 && size < 256 * 1024 * 1024) return true;
  return confirm(`将一次载入 ${selected.length} 章、约 ${pages} 页（${bytes(size)}）到打印窗口，可能占用较多内存。是否继续？`);
}

function statusLabel(status) {
  return ({
    queued: '等待中', fetching: '准备中', downloading: '下载中', paused: '已暂停', completed: '已完成', failed: '失败',
  })[status] || status;
}

function actionButton(label, fn, kind = '') {
  const button = element('button', { type: 'button', class: `download-action ${kind}`.trim() }, label);
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await fn(); } catch (error) { alert(error.message || '操作失败'); }
    finally { if (button.isConnected) button.disabled = false; }
  });
  return button;
}

/**
 * 挂载下载管理页。
 * options.openChapter(aid, photoId) 可覆盖默认 #/offline/:aid/:photoId 路由。
 */
export function mountDownloadCenter(root, options = {}) {
  if (!root || !root.appendChild) throw new TypeError('mountDownloadCenter 需要 DOM 根节点');
  ensureStyles();
  let destroyed = false;
  let taskRenderTimer = 0;
  let pendingTasks = null;
  let libraryRenderPromise = null;
  let libraryRenderPending = false;
  let storageRefreshPromise = null;
  let storageRefreshPending = false;
  const coverUrls = new Set();
  const taskNodes = new Map();
  const taskArea = element('section', { class: 'download-section' });
  const libraryArea = element('section', { class: 'download-section' });
  const integrityArea = element('section', { class: 'download-section', 'aria-live': 'polite' });
  const taskHeading = element('h2', { text: '下载任务 (0)', tabindex: '-1' });
  const taskEmpty = element('div', { class: 'download-empty', text: '还没有下载任务，可从漫画详情页选择下载。' });
  taskArea.append(taskHeading, taskEmpty);
  const storageText = element('span', { class: 'download-storage', text: '正在统计空间…' });
  const container = element('div', { class: 'download-center' },
    element('header', { class: 'download-center-head' },
      element('div', null,
        element('h1', { text: '下载与离线' }),
        element('p', { text: '下载后的正文保存在当前浏览器，可断网阅读。' }),
      ),
      storageText,
      actionButton('申请持久存储', async () => {
        const accepted = await requestPersistentStorage();
        alert(accepted ? '浏览器已允许持久保存' : '浏览器未授予持久保存；仍可正常离线，但空间紧张时缓存可能被清理');
        refreshStorage();
      }),
    ),
    integrityArea,
    taskArea,
    libraryArea,
  );
  root.append(container);

  async function runAutomaticIntegrityCheck() {
    const mode = ['partial', 'full'].includes(setting.cacheIntegrityCheckMode) ? setting.cacheIntegrityCheckMode : 'off';
    if (mode === 'off') return;
    integrityArea.replaceChildren(element('div', { class: 'download-integrity checking', text: `${mode === 'full' ? '完全' : '部分'}检查缓存中…` }));
    try {
      const result = await checkOfflineIntegrity({ mode });
      if (destroyed) return;
      if (result.healthy) {
        integrityArea.replaceChildren(element('div', { class: 'download-integrity healthy', text: result.message }));
        return;
      }
      const repair = actionButton('重新下载缺失内容', async () => {
        const grouped = new Map();
        for (const item of result.brokenItems || []) {
          if (!/^\d+$/.test(String(item.photoId))) continue;
          if (!grouped.has(String(item.aid))) grouped.set(String(item.aid), new Set());
          grouped.get(String(item.aid)).add(String(item.photoId));
        }
        for (const aid of result.brokenAlbumIds || []) if (!grouped.has(String(aid))) grouped.set(String(aid), new Set());
        for (const [aid, ids] of grouped) {
          const chapterIds = [...ids];
          await downloads.enqueueAlbum(aid, { chapterIds: chapterIds.length ? chapterIds : null, shunt: setting.shunt, concurrency: 3 });
        }
        integrityArea.replaceChildren(element('div', { class: 'download-integrity checking', text: '修复任务已加入下载队列。' }));
      }, 'primary');
      integrityArea.replaceChildren(element('div', { class: 'download-integrity broken' },
        element('strong', { text: '发现离线缓存不完整' }),
        element('span', { text: result.message }), repair));
    } catch (error) {
      if (!destroyed) integrityArea.replaceChildren(element('div', { class: 'download-integrity broken', text: `完整性检查失败：${error.message}` }));
    }
  }

  function openChapter(aid, photoId) {
    if (typeof options.openChapter === 'function') options.openChapter(aid, photoId);
    else location.hash = `#/offline/${encodeURIComponent(aid)}/${encodeURIComponent(photoId)}`;
  }

  async function refreshStorageOnce() {
    try {
      const estimate = await getOfflineStorageEstimate();
      if (!destroyed) storageText.textContent = estimate.browserQuota
        ? `漫画 ${bytes(estimate.offlineBytes)} · 浏览器 ${bytes(estimate.browserUsage)} / ${bytes(estimate.browserQuota)}${estimate.persistent ? ' · 已持久化' : ''}`
        : `漫画缓存 ${bytes(estimate.offlineBytes)}`;
    } catch (_) {
      if (!destroyed) storageText.textContent = '无法读取空间信息';
    }
  }

  function refreshStorage() {
    storageRefreshPending = true;
    if (storageRefreshPromise) return storageRefreshPromise;
    storageRefreshPromise = (async () => {
      while (storageRefreshPending && !destroyed) {
        storageRefreshPending = false;
        await refreshStorageOnce();
      }
    })().finally(() => { storageRefreshPromise = null; });
    return storageRefreshPromise;
  }

  function updateTaskControls(record, task) {
    const active = ['queued', 'fetching', 'downloading'].includes(task.status);
    const controlKey = active ? 'active' : task.status;
    if (record.controlKey === controlKey) return;
    const restoreFocus = record.controls.contains(document.activeElement);
    record.controlKey = controlKey;
    const controls = record.controls;
    controls.replaceChildren();
    if (active) controls.append(actionButton('暂停', () => downloads.pause(task.id)));
    if (task.status === 'paused' || task.status === 'failed') controls.append(actionButton(task.status === 'failed' ? '重试' : '继续', () => downloads.resume(task.id), 'primary'));
    controls.append(actionButton('移除任务', () => downloads.remove(task.id)));
    controls.append(actionButton('删除任务和缓存', async () => {
      if (confirm(`确定删除“${task.albumName || task.aid}”的全部离线正文吗？`)) await downloads.remove(task.id, { removeData: true });
    }, 'danger'));
    if (restoreFocus) queueMicrotask(() => controls.querySelector('button:not(:disabled)')?.focus({ preventScroll: true }));
  }

  function createTaskRecord(task) {
    const progress = element('progress', { max: '100', value: '0', 'aria-label': '下载进度' });
    const title = element('strong');
    const status = element('span');
    const meta = element('div', { class: 'download-meta' });
    const message = element('div', { class: 'download-message' });
    const controls = element('div', { class: 'download-actions' });
    const article = element('article', { class: 'download-task', 'data-task-id': task.id },
      element('div', { class: 'download-task-row' }, title, status),
      progress, meta, message, controls);
    return { article, title, status, progress, meta, message, controls, controlKey: '' };
  }

  function renderTasks(tasks) {
    if (destroyed) return;
    const list = Array.isArray(tasks) ? tasks : [];
    const wanted = new Set(list.map((task) => String(task.id)));
    let removedFocusedTask = false;
    for (const [id, record] of taskNodes) {
      if (wanted.has(id)) continue;
      if (record.article.contains(document.activeElement)) removedFocusedTask = true;
      record.article.remove();
      taskNodes.delete(id);
    }
    taskHeading.textContent = `下载任务 (${list.length})`;
    taskEmpty.hidden = list.length > 0;
    let cursor = taskEmpty.nextSibling;
    for (const task of list) {
      const id = String(task.id);
      let record = taskNodes.get(id);
      if (!record) {
        record = createTaskRecord(task);
        taskNodes.set(id, record);
      }
      const p = task.progress || {};
      record.title.textContent = task.albumName || `漫画 ${task.aid}`;
      record.status.className = `download-status ${task.status}`;
      record.status.textContent = statusLabel(task.status);
      record.progress.value = Number(p.percent || 0);
      record.progress.setAttribute('aria-valuetext', `${p.completed || 0} / ${p.total || 0} 页`);
      record.meta.textContent = `${p.completed || 0}/${p.total || 0} 页 · ${bytes(p.bytes)}${p.bytesPerSecond ? ` · ${bytes(p.bytesPerSecond)}/s` : ''}${p.failed ? ` · ${p.failed} 页失败` : ''}`;
      record.message.textContent = task.message || '';
      updateTaskControls(record, task);
      // 即使节点仍 connected，把带焦点的 article 再 append 到原父节点也会让
      // Chromium 将焦点退回 body。只有顺序确实变化时才移动节点，并保留原控件焦点。
      if (record.article !== cursor) {
        const focused = record.article.contains(document.activeElement) ? document.activeElement : null;
        taskArea.insertBefore(record.article, cursor);
        if (focused?.isConnected && document.activeElement !== focused) {
          queueMicrotask(() => focused.isConnected && focused.focus({ preventScroll: true }));
        }
      }
      cursor = record.article.nextSibling;
    }
    if (removedFocusedTask) {
      const next = taskArea.querySelector('.download-task button:not(:disabled)');
      queueMicrotask(() => (next || taskHeading).focus({ preventScroll: true }));
    }
  }

  function scheduleTaskRender(tasks) {
    pendingTasks = tasks;
    if (destroyed || taskRenderTimer) return;
    taskRenderTimer = setTimeout(() => {
      taskRenderTimer = 0;
      const latest = pendingTasks;
      pendingTasks = null;
      renderTasks(latest);
    }, 120);
  }

  async function renderLibraryOnce() {
    const albums = await listOfflineAlbums();
    if (destroyed) return;
    const rows = await Promise.all(albums.map(async (album) => ({
      album,
      chapters: await listOfflineChapters(album.aid),
    })));
    if (destroyed) return;

    const nextCoverUrls = new Set();
    let adoptedCoverUrls = false;
    try {
      const albumGrid = element('div', { class: 'offline-album-grid' });
      for (const { album, chapters } of rows) {
      let cover = '';
      if (album.coverBlob instanceof Blob) {
        cover = URL.createObjectURL(album.coverBlob);
        nextCoverUrls.add(cover);
      }
      const chapterList = element('div', { class: 'offline-chapter-list' });
      const selectedChapters = new Set();
      const selectedZip = actionButton('所选 ZIP', () => exportAlbumZip(album.aid, { chapterIds: [...selectedChapters] }));
      const selectedPdf = actionButton('所选合并 PDF', () => {
        const chapterIds = [...selectedChapters];
        if (!confirmLargePdf(chapters, chapterIds)) return null;
        return exportAlbumPdf(album.aid, { chapterIds });
      });
      selectedZip.disabled = true;
      selectedPdf.disabled = true;
      const refreshSelected = () => {
        selectedZip.disabled = selectedChapters.size === 0;
        selectedPdf.disabled = selectedChapters.size === 0;
      };
      for (const chapter of chapters) {
        const rowActions = element('div', { class: 'download-actions compact' });
        if (chapter.complete) {
          const checkbox = element('input', { type: 'checkbox', 'aria-label': `选择导出 ${chapter.name || chapter.photoId}` });
          checkbox.addEventListener('change', () => {
            if (checkbox.checked) selectedChapters.add(String(chapter.photoId));
            else selectedChapters.delete(String(chapter.photoId));
            refreshSelected();
          });
          rowActions.append(
            checkbox,
            actionButton('阅读', () => openChapter(album.aid, chapter.photoId), 'primary'),
            actionButton('ZIP', () => exportChapterZip(album.aid, chapter.photoId)),
            actionButton('PDF', () => exportChapterPdf(album.aid, chapter.photoId)),
          );
        }
        chapterList.append(element('div', { class: 'offline-chapter-row' },
          element('span', { text: chapter.name || `章节 ${chapter.photoId}` }),
          element('small', { text: `${chapter.imageCount || 0} 页 · ${bytes(chapter.totalBytes)}${chapter.complete ? '' : ' · 未完成'}` }),
          rowActions,
        ));
      }
      const albumActions = element('div', { class: 'download-actions' },
        actionButton('导出整本 ZIP', () => exportAlbumZip(album.aid)),
        actionButton('导出整本 PDF', () => confirmLargePdf(chapters) ? exportAlbumPdf(album.aid) : null),
        selectedZip,
        selectedPdf,
        actionButton('删除离线漫画', async () => {
          if (confirm(`确定删除“${album.name || album.aid}”的全部离线内容吗？`)) {
            await downloads.removeAlbum(album.aid);
            await requestLibraryRender();
            await refreshStorage();
          }
        }, 'danger'),
      );
        albumGrid.append(element('article', { class: 'offline-album' },
        cover ? element('img', { class: 'offline-cover', src: cover, alt: '' }) : element('div', { class: 'offline-cover placeholder', text: 'JM' }),
        element('div', { class: 'offline-album-body' },
          element('div', { class: 'download-task-row' },
            element('strong', { text: album.name || `漫画 ${album.aid}` }),
            element('span', { text: `${chapters.filter((chapter) => chapter.complete).length}/${chapters.length} 章` }),
          ),
          chapterList,
          albumActions,
        ),
        ));
      }
      const libraryNodes = [element('h2', { text: `离线资料库 (${albums.length})` }), albumGrid];
      if (!albums.length) libraryNodes.push(element('div', { class: 'download-empty', text: '暂无离线漫画。' }));
      libraryArea.replaceChildren(...libraryNodes);
      for (const url of coverUrls) URL.revokeObjectURL(url);
      coverUrls.clear();
      for (const url of nextCoverUrls) coverUrls.add(url);
      adoptedCoverUrls = true;
    } finally {
      // createObjectURL 之后任一 DOM 构建步骤抛错时，也不能遗留本轮临时 URL。
      if (!adoptedCoverUrls) for (const url of nextCoverUrls) URL.revokeObjectURL(url);
    }
  }

  function requestLibraryRender() {
    libraryRenderPending = true;
    if (libraryRenderPromise) return libraryRenderPromise;
    libraryRenderPromise = (async () => {
      while (libraryRenderPending && !destroyed) {
        libraryRenderPending = false;
        await renderLibraryOnce();
      }
    })().catch((error) => {
      if (!destroyed) {
        for (const url of coverUrls) URL.revokeObjectURL(url);
        coverUrls.clear();
        libraryArea.replaceChildren(element('div', { class: 'download-empty', text: error.message || '下载中心加载失败' }));
      }
    }).finally(() => { libraryRenderPromise = null; });
    return libraryRenderPromise;
  }

  async function refresh() {
    const tasks = await downloads.list();
    if (destroyed) return;
    renderTasks(tasks);
    await Promise.all([requestLibraryRender(), refreshStorage()]);
  }

  function handleDownloadChange(tasks, _task, type) {
    scheduleTaskRender(tasks);
    if (['complete', 'error', 'remove', 'data-remove', 'restore'].includes(type)) {
      requestLibraryRender();
      refreshStorage();
    }
  }

  const unsubscribe = downloads.subscribe(handleDownloadChange);
  refresh().catch((error) => {
    if (!destroyed) libraryArea.replaceChildren(element('div', { class: 'download-empty', text: error.message || '下载中心加载失败' }));
  });
  runAutomaticIntegrityCheck();

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    unsubscribe();
    if (taskRenderTimer) clearTimeout(taskRenderTimer);
    taskRenderTimer = 0;
    pendingTasks = null;
    libraryRenderPending = false;
    storageRefreshPending = false;
    for (const url of coverUrls) URL.revokeObjectURL(url);
    coverUrls.clear();
    container.remove();
  }

  return { destroy, refresh };
}

/** 与 app.js 现有 view(root) -> cleanup 约定兼容的路由函数。 */
export function downloadsView(root, options = {}) {
  const mounted = mountDownloadCenter(root, options);
  return () => mounted.destroy();
}
