// 模块 Worker：只承担图片解码、Canvas 重排和编码，不接触网络、Cookie 或页面 DOM。
// 不支持 OffscreenCanvas/createImageBitmap 的浏览器会收到 UNSUPPORTED，
// 由 descramble.js 回退到主线程兼容路径。
import { validateDecodeDimensions, drawDescrambled } from './descramble-core.js';

function makeWorkerError(message, code = 'WORKER_ERROR') {
  const error = new Error(message || '图片 Worker 解码失败');
  error.code = code;
  return error;
}

function canvasToBlob(canvas) {
  const encode = (type) => {
    if (typeof canvas.convertToBlob === 'function') {
      return canvas.convertToBlob({ type, quality: 0.92 }).then((blob) => {
        if (!blob) throw makeWorkerError(`${type} 编码失败`, 'ENCODE_FAILED');
        return blob;
      });
    }
    if (typeof canvas.toBlob === 'function') {
      return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(makeWorkerError(`${type} 编码失败`, 'ENCODE_FAILED'));
        }, type, 0.92);
      });
    }
    return Promise.reject(makeWorkerError('当前 Worker 不支持 Canvas 编码', 'UNSUPPORTED'));
  };
  return encode('image/webp').catch((error) => encode('image/jpeg').catch(() => { throw error; }));
}

async function decodeMessage(data) {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    throw makeWorkerError('当前浏览器不支持 OffscreenCanvas 图片解码', 'UNSUPPORTED');
  }
  if (!(data.blob instanceof Blob) || !data.blob.size) {
    throw makeWorkerError('图片内容为空', 'INVALID_IMAGE');
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(data.blob);
    const { width, height } = validateDecodeDimensions(bitmap.width, bitmap.height, {
      memoryOptimized: data.memoryOptimized === true,
    });
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw makeWorkerError('当前 Worker 无法创建图片画布', 'UNSUPPORTED');
    ctx.imageSmoothingEnabled = false;
    drawDescrambled(
      ctx, bitmap, Number(data.photoId), data.page == null ? '' : String(data.page), width, height,
    );
    try {
      const blob = await canvasToBlob(canvas);
      if (!(blob instanceof Blob) || !blob.size) throw makeWorkerError('解扰结果为空', 'ENCODE_FAILED');
      return { blob, width, height };
    } finally {
      try { canvas.width = 1; canvas.height = 1; } catch (_) {}
    }
  } catch (error) {
    if (error?.code) throw error;
    throw makeWorkerError(error?.message || '图片 Worker 解码失败', 'DECODE_FAILED');
  } finally {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
  }
}

// 单个 Worker 串行持有全尺寸 ImageBitmap/Canvas。网络仍由阅读器自己的
// 有界并发负责；这里避免阅读器和离线下载同时触发多张 RGBA 画布驻留。
const canceled = new Set();
let decodeTail = Promise.resolve();

self.addEventListener('message', (event) => {
  const data = event?.data || {};
  if (data.type === 'cancel' && data.id != null) {
    canceled.add(data.id);
    return;
  }
  if (data.type !== 'decode' || data.id == null) return;
  decodeTail = decodeTail.catch(() => {}).then(async () => {
    if (canceled.delete(data.id)) return;
    try {
      const result = await decodeMessage(data);
      if (!canceled.delete(data.id)) {
        self.postMessage({ type: 'result', id: data.id, ...result });
      }
    } catch (error) {
      if (!canceled.delete(data.id)) {
        self.postMessage({
          type: 'error',
          id: data.id,
          error: { code: error?.code || 'WORKER_ERROR', message: error?.message || '图片 Worker 解码失败' },
        });
      }
    }
  });
});
