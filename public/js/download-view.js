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

function emptyState(title, description = '') {
  return element('div', { class: 'download-empty' },
    element('strong', { text: title }),
    description ? element('span', { text: description }) : null);
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

const ACTIVE_TASK_STATUSES = new Set(['queued', 'fetching', 'downloading']);
// 批量操作会逐项经过下载管理器的跨标签停写/锁流程，限制单批数量既避免
// 无意中一次删除过多任务，也让不支持 Web Locks 的浏览器能在可预期时间内完成。
const MAX_BATCH_SELECTION = 50;

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
  let latestTasks = [];
  let batchMode = false;
  let batchBusy = false;
  const coverUrls = new Set();
  const taskNodes = new Map();
  const selectedTaskIds = new Set();
  const taskArea = element('section', { class: 'download-section' });
  const libraryArea = element('section', { class: 'download-section' });
  const integrityArea = element('section', { class: 'download-section', 'aria-live': 'polite' });
  const taskHeading = element('h2', { text: '下载任务 (0)', tabindex: '-1' });
  const batchToolbarId = `download-batch-${Math.random().toString(36).slice(2, 10)}`;
  const batchToggle = element('button', {
    type: 'button',
    class: 'download-action download-batch-toggle',
    'aria-expanded': 'false',
    'aria-controls': batchToolbarId,
    hidden: '',
  }, '批量管理');
  const selectAll = element('input', { type: 'checkbox', 'aria-label': '全选下载任务' });
  const selectAllText = element('span', { text: '全选' });
  const batchSummary = element('span', { class: 'download-batch-summary', text: '已选择 0 项' });
  const batchAnnouncement = element('span', {
    class: 'download-batch-announcement',
    'aria-live': 'polite',
    'aria-atomic': 'true',
  });
  const batchPause = element('button', { type: 'button', class: 'download-action' }, '暂停');
  const batchResume = element('button', { type: 'button', class: 'download-action primary' }, '继续');
  const batchRetry = element('button', { type: 'button', class: 'download-action primary' }, '重试');
  const batchRemove = element('button', { type: 'button', class: 'download-action danger' }, '删除任务');
  const batchButtons = [batchPause, batchResume, batchRetry, batchRemove];
  const batchToolbar = element('div', {
    id: batchToolbarId,
    class: 'download-batch-toolbar',
    role: 'group',
    'aria-label': '批量管理下载任务',
    hidden: '',
  },
  element('label', { class: 'download-select-all' }, selectAll, selectAllText),
  batchSummary,
  element('div', { class: 'download-batch-actions' }, ...batchButtons));
  const taskEmpty = emptyState('还没有下载任务', '可从漫画详情页选择章节或整本下载。');
  taskArea.append(
    element('div', { class: 'download-section-heading' }, taskHeading, batchToggle),
    batchToolbar,
    batchAnnouncement,
    taskEmpty,
  );
  const storageText = element('span', { class: 'download-storage', text: '正在统计空间…' });
  const container = element('div', { class: 'download-center' },
    element('header', { class: 'download-center-head' },
      element('div', null,
        element('span', { class: 'download-kicker', text: 'LOCAL LIBRARY' }),
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

  function selectedTasks(predicate = () => true) {
    return latestTasks.filter((task) => selectedTaskIds.has(String(task.id)) && predicate(task));
  }

  function announceBatch(message) {
    // 重复执行同一种操作时也要让屏幕阅读器重新播报。
    batchAnnouncement.textContent = '';
    queueMicrotask(() => {
      if (!destroyed) batchAnnouncement.textContent = message;
    });
  }

  function updateBatchUi() {
    const taskIds = new Set(latestTasks.map((task) => String(task.id)));
    for (const id of selectedTaskIds) if (!taskIds.has(id)) selectedTaskIds.delete(id);

    const selectable = latestTasks.slice(0, MAX_BATCH_SELECTION);
    const allSelected = selectable.length > 0
      && selectable.every((task) => selectedTaskIds.has(String(task.id)))
      && selectedTaskIds.size === selectable.length;
    selectAll.checked = allSelected;
    selectAll.indeterminate = selectedTaskIds.size > 0 && !allSelected;
    selectAll.disabled = batchBusy || latestTasks.length === 0;
    selectAllText.textContent = latestTasks.length > MAX_BATCH_SELECTION
      ? `全选前 ${MAX_BATCH_SELECTION} 项`
      : '全选';
    selectAll.setAttribute('aria-label', latestTasks.length > MAX_BATCH_SELECTION
      ? `全选前 ${MAX_BATCH_SELECTION} 个下载任务`
      : '全选下载任务');
    batchSummary.textContent = `已选择 ${selectedTaskIds.size} 项${latestTasks.length > MAX_BATCH_SELECTION ? `（单批最多 ${MAX_BATCH_SELECTION} 项）` : ''}`;

    const pausable = selectedTasks((task) => ACTIVE_TASK_STATUSES.has(task.status)).length;
    const resumable = selectedTasks((task) => task.status === 'paused').length;
    const retryable = selectedTasks((task) => task.status === 'failed').length;
    batchPause.textContent = pausable ? `暂停 (${pausable})` : '暂停';
    batchResume.textContent = resumable ? `继续 (${resumable})` : '继续';
    batchRetry.textContent = retryable ? `重试 (${retryable})` : '重试';
    batchRemove.textContent = selectedTaskIds.size ? `删除任务 (${selectedTaskIds.size})` : '删除任务';
    batchToolbar.setAttribute('aria-busy', String(batchBusy));
    batchPause.disabled = batchBusy || pausable === 0;
    batchResume.disabled = batchBusy || resumable === 0;
    batchRetry.disabled = batchBusy || retryable === 0;
    batchRemove.disabled = batchBusy || selectedTaskIds.size === 0;
    batchToggle.disabled = batchBusy;

    for (const [id, record] of taskNodes) {
      const checked = selectedTaskIds.has(id);
      record.checkbox.checked = checked;
      record.checkbox.disabled = batchBusy
        || (!checked && selectedTaskIds.size >= MAX_BATCH_SELECTION);
      record.selection.hidden = !batchMode;
      record.article.classList.toggle('is-selected', batchMode && checked);
    }
  }

  function setBatchMode(enabled, { restoreFocus = false } = {}) {
    batchMode = Boolean(enabled) && latestTasks.length > 0;
    if (!batchMode) selectedTaskIds.clear();
    taskArea.classList.toggle('batch-selecting', batchMode);
    batchToolbar.hidden = !batchMode;
    batchToggle.textContent = batchMode ? '完成' : '批量管理';
    batchToggle.setAttribute('aria-expanded', String(batchMode));
    updateBatchUi();
    announceBatch(batchMode ? '已进入批量管理模式' : '已退出批量管理模式');
    if (batchMode) queueMicrotask(() => selectAll.focus({ preventScroll: true }));
    else if (restoreFocus) queueMicrotask(() => batchToggle.focus({ preventScroll: true }));
  }

  function toggleTaskSelection(id, checked, checkbox) {
    id = String(id);
    if (checked) {
      if (selectedTaskIds.size >= MAX_BATCH_SELECTION && !selectedTaskIds.has(id)) {
        checkbox.checked = false;
        announceBatch(`每批最多选择 ${MAX_BATCH_SELECTION} 个任务，请先处理当前选择`);
        return;
      }
      selectedTaskIds.add(id);
    } else selectedTaskIds.delete(id);
    updateBatchUi();
    announceBatch(`已选择 ${selectedTaskIds.size} 个任务`);
  }

  async function runBatch({ label, pastLabel, predicate, operation, confirmMessage }) {
    if (batchBusy) return;
    const targets = selectedTasks(predicate).slice(0, MAX_BATCH_SELECTION);
    if (!targets.length) return;
    if (confirmMessage && !confirm(confirmMessage(targets.length))) return;

    batchBusy = true;
    updateBatchUi();
    announceBatch(`正在${label} ${targets.length} 个任务`);
    let completed = 0;
    let skipped = 0;
    const failures = [];
    try {
      // 有意串行复用单任务方法。每项都会重新读取状态并走原有跨标签停写和
      // IndexedDB 锁；若同一本漫画存在多个任务，也不会让多个删除/恢复相互争用。
      for (const snapshot of targets) {
        try {
          const current = await downloads.get(snapshot.id);
          if (!current || !predicate(current)) {
            skipped++;
            continue;
          }
          const result = await operation(current);
          if (result === false) skipped++;
          else completed++;
        } catch (error) {
          failures.push(error?.message || '操作失败');
        }
      }
    } finally {
      batchBusy = false;
      const currentTasks = await downloads.list().catch(() => null);
      if (currentTasks) renderTasks(currentTasks);
      else updateBatchUi();
    }
    const details = [`已${pastLabel} ${completed} 个任务`];
    if (skipped) details.push(`${skipped} 个状态已变化`);
    if (failures.length) details.push(`${failures.length} 个失败`);
    announceBatch(details.join('，'));
    if (failures.length) {
      const first = failures[0];
      alert(`${label}完成，但有 ${failures.length} 个任务失败：${first}${failures.length > 1 ? '（其余错误请稍后重试）' : ''}`);
    }
  }

  batchToggle.addEventListener('click', () => setBatchMode(!batchMode, { restoreFocus: batchMode }));
  selectAll.addEventListener('change', () => {
    selectedTaskIds.clear();
    if (selectAll.checked) {
      for (const task of latestTasks.slice(0, MAX_BATCH_SELECTION)) selectedTaskIds.add(String(task.id));
    }
    updateBatchUi();
    announceBatch(selectAll.checked ? `已选择 ${selectedTaskIds.size} 个任务` : '已取消全选');
  });
  batchPause.addEventListener('click', () => runBatch({
    label: '暂停', pastLabel: '暂停',
    predicate: (task) => ACTIVE_TASK_STATUSES.has(task.status),
    operation: (task) => downloads.pause(task.id),
  }));
  batchResume.addEventListener('click', () => runBatch({
    label: '继续', pastLabel: '继续',
    predicate: (task) => task.status === 'paused',
    operation: (task) => downloads.resume(task.id),
  }));
  batchRetry.addEventListener('click', () => runBatch({
    label: '重试', pastLabel: '加入重试队列',
    predicate: (task) => task.status === 'failed',
    operation: (task) => downloads.retry(task.id),
  }));
  batchRemove.addEventListener('click', () => runBatch({
    label: '删除', pastLabel: '删除',
    predicate: () => true,
    operation: (task) => downloads.remove(task.id),
    confirmMessage: (count) => `确定删除选中的 ${count} 个下载任务吗？已下载的离线正文将保留。`,
  }));

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
    const checkbox = element('input', { type: 'checkbox' });
    const selection = element('label', { class: 'download-task-select', hidden: '' },
      checkbox,
      element('span', { class: 'download-visually-hidden', text: '选择任务' }),
    );
    const progress = element('progress', { max: '100', value: '0', 'aria-label': '下载进度' });
    const title = element('strong');
    const status = element('span');
    const meta = element('div', { class: 'download-meta' });
    const message = element('div', { class: 'download-message' });
    const controls = element('div', { class: 'download-actions' });
    const article = element('article', { class: 'download-task', 'data-task-id': task.id },
      element('div', { class: 'download-task-row' },
        element('div', { class: 'download-task-title' }, selection, title),
        status,
      ),
      progress, meta, message, controls);
    const record = { article, title, status, progress, meta, message, controls, checkbox, selection, taskId: String(task.id), controlKey: '' };
    checkbox.addEventListener('change', () => toggleTaskSelection(record.taskId, checkbox.checked, checkbox));
    article.addEventListener('click', (event) => {
      if (!batchMode || batchBusy || event.target.closest('button, input, label, a')) return;
      checkbox.click();
    });
    return record;
  }

  function renderTasks(tasks) {
    if (destroyed) return;
    const list = Array.isArray(tasks) ? tasks : [];
    latestTasks = list;
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
    batchToggle.hidden = list.length === 0;
    if (!list.length && batchMode) setBatchMode(false);
    let cursor = taskEmpty.nextSibling;
    for (const task of list) {
      const id = String(task.id);
      let record = taskNodes.get(id);
      if (!record) {
        record = createTaskRecord(task);
        taskNodes.set(id, record);
      }
      const p = task.progress || {};
      record.taskId = id;
      record.title.textContent = task.albumName || `漫画 ${task.aid}`;
      record.checkbox.setAttribute('aria-label', `选择下载任务：${record.title.textContent}`);
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
      const next = batchMode
        ? taskArea.querySelector('.download-task-select input:not(:disabled)')
        : taskArea.querySelector('.download-task button:not(:disabled)');
      queueMicrotask(() => (next || taskHeading).focus({ preventScroll: true }));
    }
    updateBatchUi();
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
      if (!albums.length) libraryNodes.push(emptyState('离线资料库为空', '下载完成的漫画会显示在这里。'));
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
        libraryArea.replaceChildren(emptyState('下载中心加载失败', error.message || '请稍后重试。'));
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
    if (!destroyed) libraryArea.replaceChildren(emptyState('下载中心加载失败', error.message || '请稍后重试。'));
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
