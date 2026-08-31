// 离线漫画导出：零依赖 ZIP（Store 模式）与浏览器“打印/另存为 PDF”。

import {
  getOfflineAlbum,
  getOfflineChapter,
  listOfflineChapters,
  listOfflineImages,
} from './offline.js';

const encoder = new TextEncoder();
let crcTable = null;

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
}

export function crc32(bytes, seed = 0) {
  if (!crcTable) crcTable = makeCrcTable();
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(view, offset, value) {
  view.setUint16(offset, value & 0xffff, true);
}

function u32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function dosDateTime(input) {
  const date = input instanceof Date ? input : new Date(input || Date.now());
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
}

/** 清除路径穿越与 Windows 禁止字符，同时保留中文。 */
export function safeFilename(value, fallback = 'untitled') {
  let name = String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\.\.+/g, '.')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!name || name === '.' || name === '..') name = fallback;
  return name.slice(0, 120);
}

function safeZipPath(path) {
  return String(path || '')
    .split(/[\\/]+/)
    .filter((part) => part && part !== '.' && part !== '..')
    .map((part) => safeFilename(part))
    .join('/');
}

function extensionFor(image) {
  const mime = String((image.blob && image.blob.type) || image.mime || '').toLowerCase();
  if (mime.includes('jpeg')) return 'jpg';
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('avif')) return 'avif';
  const match = String(image.name || '').match(/\.([a-z0-9]{2,5})$/i);
  return match ? match[1].toLowerCase() : 'bin';
}

function assertNotAborted(signal) {
  if (!signal || !signal.aborted) return;
  try { throw new DOMException('导出已取消', 'AbortError'); } catch (error) {
    if (error && error.name === 'AbortError') throw error;
    const fallback = new Error('导出已取消');
    fallback.name = 'AbortError';
    throw fallback;
  }
}

/**
 * 创建标准 ZIP Blob，不依赖第三方库。为避免二次压缩漫画图片，使用 Store 方法。
 * entries: [{name, blob, date?}]
 */
export async function buildZip(entries, { onProgress, signal, mime = 'application/zip' } = {}) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('没有可导出的文件');
  if (entries.length > 0xffff) throw new Error('文件数量超过经典 ZIP 上限（65535）');
  const locals = [];
  const centrals = [];
  let offset = 0;
  let done = 0;

  for (const entry of entries) {
    assertNotAborted(signal);
    if (!(entry.blob instanceof Blob)) throw new TypeError('ZIP 条目必须包含 Blob');
    const name = safeZipPath(entry.name);
    if (!name) throw new Error('ZIP 条目文件名为空');
    const nameBytes = encoder.encode(name);
    if (nameBytes.length > 0xffff) throw new Error(`文件名过长：${name.slice(0, 30)}`);
    if (entry.blob.size > 0xffffffff) throw new Error('单个文件超过 4 GiB，当前不支持 ZIP64');
    const bytes = new Uint8Array(await entry.blob.arrayBuffer());
    assertNotAborted(signal);
    const checksum = crc32(bytes);
    const stamp = dosDateTime(entry.date);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    u32(lv, 0, 0x04034b50);
    u16(lv, 4, 20);
    u16(lv, 6, 0x0800); // UTF-8 文件名
    u16(lv, 8, 0); // Store
    u16(lv, 10, stamp.time);
    u16(lv, 12, stamp.date);
    u32(lv, 14, checksum);
    u32(lv, 18, bytes.length);
    u32(lv, 22, bytes.length);
    u16(lv, 26, nameBytes.length);
    u16(lv, 28, 0);
    local.set(nameBytes, 30);
    locals.push(local, entry.blob);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    u32(cv, 0, 0x02014b50);
    u16(cv, 4, 20);
    u16(cv, 6, 20);
    u16(cv, 8, 0x0800);
    u16(cv, 10, 0);
    u16(cv, 12, stamp.time);
    u16(cv, 14, stamp.date);
    u32(cv, 16, checksum);
    u32(cv, 20, bytes.length);
    u32(cv, 24, bytes.length);
    u16(cv, 28, nameBytes.length);
    u16(cv, 30, 0);
    u16(cv, 32, 0);
    u16(cv, 34, 0);
    u16(cv, 36, 0);
    u32(cv, 38, 0);
    u32(cv, 42, offset);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length + bytes.length;
    if (offset > 0xffffffff) throw new Error('ZIP 总大小超过 4 GiB，当前不支持 ZIP64');
    done++;
    if (typeof onProgress === 'function') onProgress({ completed: done, total: entries.length, name });
  }

  const centralOffset = offset;
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  if (centralOffset + centralSize > 0xffffffff) throw new Error('ZIP 总大小超过 4 GiB，当前不支持 ZIP64');
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  u32(ev, 0, 0x06054b50);
  u16(ev, 4, 0);
  u16(ev, 6, 0);
  u16(ev, 8, entries.length);
  u16(ev, 10, entries.length);
  u32(ev, 12, centralSize);
  u32(ev, 16, centralOffset);
  u16(ev, 20, 0);
  return new Blob([...locals, ...centrals, end], { type: mime });
}

async function chapterEntries(aid, photoId, prefix = '') {
  const [chapter, images] = await Promise.all([
    getOfflineChapter(aid, photoId),
    listOfflineImages(aid, photoId),
  ]);
  if (!chapter) throw new Error('离线章节不存在');
  if (!images.length) throw new Error('离线章节没有图片');
  const digits = Math.max(3, String(images.length).length);
  return {
    chapter,
    entries: images.map((image, index) => ({
      name: `${prefix}${String(index + 1).padStart(digits, '0')}.${extensionFor(image)}`,
      blob: image.blob,
      date: new Date(image.updatedAt || chapter.updatedAt || Date.now()),
    })),
  };
}

export async function buildChapterZip(aid, photoId, options = {}) {
  const [album, data] = await Promise.all([getOfflineAlbum(aid), chapterEntries(aid, photoId)]);
  const blob = await buildZip(data.entries, options);
  const base = safeFilename(`${(album && album.name) || aid} - ${data.chapter.name || photoId}`);
  return { blob, filename: `${base}.zip`, album, chapter: data.chapter };
}

export async function buildAlbumZip(aid, options = {}) {
  const [album, chapters] = await Promise.all([getOfflineAlbum(aid), listOfflineChapters(aid)]);
  if (!album) throw new Error('离线漫画不存在');
  const wanted = Array.isArray(options.chapterIds) && options.chapterIds.length
    ? new Set(options.chapterIds.map(String)) : null;
  const complete = chapters.filter((chapter) => chapter.complete && (!wanted || wanted.has(String(chapter.photoId))));
  if (!complete.length) throw new Error('这本漫画没有已完成的离线章节');
  const entries = [];
  for (let index = 0; index < complete.length; index++) {
    assertNotAborted(options.signal);
    const chapter = complete[index];
    const folder = safeFilename(`${String(index + 1).padStart(3, '0')} ${chapter.name || chapter.photoId}`);
    const data = await chapterEntries(aid, chapter.photoId, `${folder}/`);
    entries.push(...data.entries);
  }
  const blob = await buildZip(entries, options);
  return { blob, filename: `${safeFilename(album.name || aid)}.zip`, album, chapters: complete };
}

export function saveBlob(blob, filename) {
  if (!(blob instanceof Blob)) throw new TypeError('saveBlob 需要 Blob');
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeFilename(filename, 'download');
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function exportChapterZip(aid, photoId, options = {}) {
  const result = await buildChapterZip(aid, photoId, options);
  saveBlob(result.blob, result.filename);
  return result;
}

export async function exportAlbumZip(aid, options = {}) {
  const result = await buildAlbumZip(aid, options);
  saveBlob(result.blob, result.filename);
  return result;
}

function openPrintWindow(title, suppliedWindow) {
  const popup = suppliedWindow || window.open('', '_blank', 'noopener=false');
  if (!popup) throw new Error('浏览器阻止了打印窗口，请允许本站弹出窗口后重试');
  popup.document.open();
  popup.document.write('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title></title></head><body><p>正在准备离线图片…</p></body></html>');
  popup.document.close();
  popup.document.title = title;
  return popup;
}

function fillPrintDocument(popup, title, sections) {
  const doc = popup.document;
  doc.head.replaceChildren();
  const meta = doc.createElement('meta');
  meta.charset = 'utf-8';
  const titleEl = doc.createElement('title');
  titleEl.textContent = title;
  const style = doc.createElement('style');
  style.textContent = `
    @page { size: auto; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; color: #111; }
    h1, h2 { margin: 18mm 12mm 8mm; font: 600 18px system-ui, sans-serif; }
    h2 { break-before: page; font-size: 15px; }
    h2.first { break-before: auto; }
    img { display: block; width: 100%; height: auto; break-after: page; page-break-after: always; }
    img:last-child { break-after: auto; page-break-after: auto; }
    .error { min-height: 60vh; display: grid; place-items: center; color: #b42318; }
    @media print { h1 { display: none; } h2 { margin-top: 8mm; } }
  `;
  doc.head.append(meta, titleEl, style);
  doc.body.replaceChildren();
  const heading = doc.createElement('h1');
  heading.textContent = title;
  doc.body.append(heading);
  const urls = [];
  const pending = [];
  try {
    sections.forEach((section, sectionIndex) => {
      if (sections.length > 1) {
        const h2 = doc.createElement('h2');
        h2.className = sectionIndex === 0 ? 'first' : '';
        h2.textContent = section.name;
        doc.body.append(h2);
      }
      section.images.forEach((record, imageIndex) => {
        if (!(record?.blob instanceof Blob) || !record.blob.size) throw new Error(`${section.name} 第 ${imageIndex + 1} 页已损坏`);
        const url = URL.createObjectURL(record.blob);
        urls.push(url);
        const img = doc.createElement('img');
        img.alt = `${section.name} 第 ${imageIndex + 1} 页`;
        img.src = url;
        pending.push(new Promise((resolve) => {
          img.onload = resolve;
          img.onerror = () => {
            const error = doc.createElement('div');
            error.className = 'error';
            error.textContent = `${img.alt} 无法读取`;
            img.replaceWith(error);
            resolve();
          };
        }));
        doc.body.append(img);
      });
    });
  } catch (error) {
    for (const url of urls) URL.revokeObjectURL(url);
    throw error;
  }
  return { urls, pending };
}

async function runPrint(popup, title, sections, { autoPrint = true } = {}) {
  const { urls, pending } = fillPrintDocument(popup, title, sections);
  await Promise.race([
    Promise.all(pending),
    new Promise((resolve) => setTimeout(resolve, 30_000)),
  ]);
  const cleanup = () => {
    for (const url of urls) URL.revokeObjectURL(url);
  };
  popup.addEventListener('afterprint', cleanup, { once: true });
  popup.addEventListener('pagehide', cleanup, { once: true });
  // afterprint 在部分移动浏览器中不会触发，保留足够时间后兜底回收。
  setTimeout(cleanup, 10 * 60_000);
  if (autoPrint) {
    popup.focus();
    popup.print();
  }
  return { window: popup, cleanup };
}

/** 打开系统打印对话框，用户选择“另存为 PDF”即可得到 PDF。 */
export async function printOfflineChapter(aid, photoId, options = {}) {
  // 必须在第一次 await 前开窗，才能保留用户点击手势，避免弹窗拦截。
  const popup = openPrintWindow('正在准备 PDF', options.window);
  try {
    const [album, chapter, images] = await Promise.all([
      getOfflineAlbum(aid),
      getOfflineChapter(aid, photoId),
      listOfflineImages(aid, photoId),
    ]);
    if (!chapter || !images.length) throw new Error('离线章节不存在或没有图片');
    const title = `${(album && album.name) || aid} - ${chapter.name || photoId}`;
    popup.document.title = safeFilename(title);
    return await runPrint(popup, title, [{ name: chapter.name || String(photoId), images }], options);
  } catch (error) {
    popup.document.body.textContent = error.message || '准备 PDF 失败';
    throw error;
  }
}

/** 将整本已完成章节送入一次打印任务。大型漫画建议逐章导出。 */
export async function printOfflineAlbum(aid, options = {}) {
  const popup = openPrintWindow('正在准备 PDF', options.window);
  try {
    const [album, chapters] = await Promise.all([getOfflineAlbum(aid), listOfflineChapters(aid)]);
    if (!album) throw new Error('离线漫画不存在');
    const wanted = Array.isArray(options.chapterIds) && options.chapterIds.length
      ? new Set(options.chapterIds.map(String)) : null;
    const sections = [];
    for (const chapter of chapters.filter((item) => item.complete && (!wanted || wanted.has(String(item.photoId))))) {
      assertNotAborted(options.signal);
      const images = await listOfflineImages(aid, chapter.photoId);
      if (images.length) sections.push({ name: chapter.name || chapter.photoId, images });
    }
    if (!sections.length) throw new Error('没有可打印的完整章节');
    popup.document.title = safeFilename(album.name || aid);
    return await runPrint(popup, album.name || String(aid), sections, options);
  } catch (error) {
    popup.document.body.textContent = error.message || '准备 PDF 失败';
    throw error;
  }
}

export const exportChapterPdf = printOfflineChapter;
export const exportAlbumPdf = printOfflineAlbum;
