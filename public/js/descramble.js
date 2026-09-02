// 图片解扰（对齐 jm-mobile ComicPicImageState 的算法）：
//   seed = seedMap[ md5("{photoId}{page}") 末字符 ]，按漫画 ID 区间取模
//   解码 = 将原图纵向切 seed 片后按相反顺序重排
import {
  validateDecodeDimensions,
  drawDescrambled,
} from './descramble-core.js';

// 保持原有公开导出，避免已有书签脚本/测试直接导入这些函数时失效。
export { calcSeed, validateDecodeDimensions } from './descramble-core.js';

let workerInstance = null;
let workerDisabled = false;
let workerRequestId = 0;
const workerPending = new Map();
let mainDecodeTail = Promise.resolve();

function makeAbortError() {
  try {
    return new DOMException('图片解码已取消', 'AbortError');
  } catch (_) {
    const error = new Error('图片解码已取消');
    error.name = 'AbortError';
    return error;
  }
}

function workerError(message, code = 'WORKER_ERROR') {
  const error = new Error(message || '图片 Worker 解码失败');
  error.code = code;
  return error;
}

function rejectWorkerPending(error) {
  for (const { reject } of workerPending.values()) reject(error);
  workerPending.clear();
}

function disposeWorker(error = workerError('图片 Worker 已停止')) {
  const current = workerInstance;
  workerInstance = null;
  if (current) {
    try { current.terminate(); } catch (_) {}
  }
  if (workerPending.size) rejectWorkerPending(error);
}

function createDecodeWorker() {
  if (workerDisabled || typeof Worker !== 'function') return null;
  if (workerInstance) return workerInstance;
  // 使用固定同源路径而不是 import.meta.url，兼容项目当前的无构建部署和
  // node --check 静态门禁；反向代理应继续把 /js/ 映射到同一应用根目录。
  if (typeof globalThis.location?.origin !== 'string') return null;
  try {
    const url = new URL('/js/descramble-worker.js', globalThis.location.origin);
    const worker = new Worker(url, { type: 'module', name: 'jmw-descramble' });
    worker.onmessage = (event) => {
      const data = event?.data || {};
      const pending = workerPending.get(data.id);
      if (!pending) return;
      workerPending.delete(data.id);
      if (data.type === 'result' && data.blob instanceof Blob && data.blob.size > 0) {
        pending.resolve({ blob: data.blob, width: Number(data.width), height: Number(data.height) });
      } else {
        const detail = data.error || {};
        const error = workerError(detail.message, detail.code);
        pending.reject(error);
        if (detail.code === 'UNSUPPORTED') {
          workerDisabled = true;
          if (workerInstance === worker) workerInstance = null;
          try { worker.terminate(); } catch (_) {}
          rejectWorkerPending(error);
        }
      }
      if (!workerPending.size && workerInstance !== worker) {
        try { worker.terminate(); } catch (_) {}
      }
    };
    worker.onerror = (event) => {
      workerDisabled = true;
      disposeWorker(workerError(event?.message || '图片 Worker 运行失败'));
    };
    workerInstance = worker;
    return worker;
  } catch (_) {
    // CSP、旧浏览器或 WebView 可能禁止模块 Worker；主线程路径仍可用。
    workerDisabled = true;
    return null;
  }
}

function decodeWithWorker(rawBlob, photoId, page, options = {}) {
  const worker = createDecodeWorker();
  if (!worker) return null;
  const id = ++workerRequestId;
  const signal = options.signal;
  let settled = false;
  let abortHandler;
  const promise = new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
      fn(value);
    };
    workerPending.set(id, {
      resolve: (value) => finish(resolve, value),
      reject: (error) => finish(reject, error),
    });
    if (signal) {
      abortHandler = () => {
        workerPending.delete(id);
        finish(reject, makeAbortError());
        try { worker.postMessage({ type: 'cancel', id }); } catch (_) {}
        // 没有其他等待者时终止当前任务，防止离开章节后 Worker 仍继续
        // 解码长条图。若仍有任务则保留共享 Worker。
        if (!workerPending.size) disposeWorker(makeAbortError());
      };
      if (signal.aborted) abortHandler();
      else signal.addEventListener('abort', abortHandler, { once: true });
    }
    if (!settled) {
      try {
        worker.postMessage({
          type: 'decode', id, blob: rawBlob,
          photoId: Number(photoId), page: page == null ? '' : String(page),
          memoryOptimized: options.memoryOptimized === true,
        });
      } catch (error) {
        workerPending.delete(id);
        finish(reject, workerError(error.message));
      }
    }
  });
  return promise;
}

/** 是否需要解扰（与客户端一致：GIF / ID ≤ scramble_id / speed==1 均不解） */
export function needsScramble({ photoId, scrambleId, speed, name }) {
  if (/\.gif$/i.test(name)) return false;
  if (photoId <= scrambleId) return false;
  if (speed === '1') return false;
  return true;
}

function makeCanvas(w, hgt) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, hgt);
  const c = document.createElement('canvas');
  c.width = w; c.height = hgt;
  return c;
}

async function canvasToBlob(canvas) {
  const encode = (type) => {
    if (canvas.convertToBlob) {
      return canvas.convertToBlob({ type, quality: 0.92 }).then((blob) => {
        if (!blob) throw new Error(`${type} 编码失败`);
        return blob;
      });
    }
    return new Promise((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(`${type} 编码失败`))), type, 0.92)
    );
  };
  try {
    return await encode('image/webp');
  } catch (error) {
    // 少数旧 Safari/WebView 的 Canvas 不支持 WebP 输出，降级 JPEG
    // 仍能保留解扰结果；优先抛出 WebP 错误以便保留原始诊断。
    try { return await encode('image/jpeg'); } catch (_) { throw error; }
  }
}

/** createImageBitmap 不可用时为 Safari/旧 WebView 提供 Image 元素回退。 */
async function decodeBitmap(blob) {
  const bitmapFactory = typeof createImageBitmap === 'function' ? createImageBitmap : null;
  if (bitmapFactory) {
    try {
      return await bitmapFactory(blob);
    } catch (error) {
      // 某些 WebView 声明了 createImageBitmap 但不支持 WebP/AVIF；
      // 只有存在 Image 回退时才继续尝试，否则保留原始错误便于诊断。
      if (typeof Image === 'undefined') throw error;
    }
  }
  if (typeof Image === 'undefined' || typeof globalThis.URL?.createObjectURL !== 'function') {
    throw new Error('当前浏览器不支持图片解码');
  }
  const objectUrl = globalThis.URL.createObjectURL(blob);
  try {
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.decoding = 'async';
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('图片解码失败'));
      element.src = objectUrl;
    });
    image.close = () => {
      try { globalThis.URL.revokeObjectURL(objectUrl); } catch (_) {}
    };
    return image;
  } catch (error) {
    try { globalThis.URL.revokeObjectURL(objectUrl); } catch (_) {}
    throw error;
  }
}

/** 在当前 Window 上执行解码，作为 Worker 不可用时的兼容回退。 */
async function decodeFromBlobOnMain(rawBlob, photoId, page, options = {}) {
  if (options.signal?.aborted) throw makeAbortError();
  const bmp = await decodeBitmap(rawBlob);
  try {
    if (options.signal?.aborted) throw makeAbortError();
    const { width: w, height: hgt } = validateDecodeDimensions(
      bmp.width,
      bmp.height,
      { memoryOptimized: options.memoryOptimized === true },
    );

    const canvas = makeCanvas(w, hgt);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前浏览器无法创建图片画布');
    ctx.imageSmoothingEnabled = false;
    drawDescrambled(ctx, bmp, photoId, page, w, hgt);
    try {
      const blob = await canvasToBlob(canvas);
      if (options.signal?.aborted) throw makeAbortError();
      return { blob, width: w, height: hgt };
    } finally {
      // 让浏览器尽早释放大块 backing store；返回的 Blob 不依赖 Canvas。
      try { canvas.width = 1; canvas.height = 1; } catch (_) {}
    }
  } finally {
    if (typeof bmp.close === 'function') bmp.close();
  }
}

/** Worker 不可用时也只串行持有一张全尺寸主线程 Canvas。 */
function queueDecodeOnMain(rawBlob, photoId, page, options) {
  const task = mainDecodeTail.catch(() => {}).then(() => {
    if (options.signal?.aborted) throw makeAbortError();
    return decodeFromBlobOnMain(rawBlob, photoId, page, options);
  });
  mainDecodeTail = task.then(() => undefined, () => undefined);
  return task;
}

/**
 * 解码单张图片（调用方先取好原图 Blob，解扰与原图共用下载缓存）：
 * 优先交给模块 Worker，避免长条漫画在主线程执行 Canvas 操作；不支持
 * Worker 的浏览器自动回退到 Window Canvas。返回 { blob, width, height }。
 */
export async function decodeFromBlob(rawBlob, photoId, page, options = {}) {
  const workerPromise = options.useWorker === false
    ? null : decodeWithWorker(rawBlob, photoId, page, options);
  if (workerPromise) {
    try {
      return await workerPromise;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      // 尺寸上限是跨执行上下文的不变量，不能因 Worker 失败而绕过；
      // 其余 Worker/CSP/格式兼容错误交由旧实现重试。
      if (['DECODE_LIMIT', 'DECODE_INVALID_DIMENSIONS', 'ENCODE_FAILED', 'INVALID_IMAGE']
        .includes(error?.code)) {
        throw error;
      }
      if (error?.code === 'UNSUPPORTED') workerDisabled = true;
    }
  }
  return queueDecodeOnMain(rawBlob, photoId, page, options);
}
