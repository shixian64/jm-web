// 图片解扰（对齐 jm-mobile ComicPicImageState 的算法）：
//   seed = seedMap[ md5("{photoId}{page}") 末字符 ]，按漫画 ID 区间取模
//   解码 = 将原图纵向切 seed 片后按相反顺序重排
import { md5 } from './md5.js';

const SEED_MAP = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20];
const LEFT = 268850;
const RIGHT = 421925;
const MAX_DECODE_PIXELS = 48_000_000;
const MAX_DECODE_WORKING_BYTES = 256 * 1024 * 1024;
const MAX_DECODE_DIMENSION = 32767;
const MEMORY_OPT_MAX_DECODE_PIXELS = 24_000_000;
const MEMORY_OPT_MAX_DECODE_WORKING_BYTES = 128 * 1024 * 1024;
const MEMORY_OPT_MAX_DECODE_DIMENSION = 16384;

export function calcSeed(photoId, page) {
  const keyMd5 = md5(`${photoId}${page}`);
  let code = keyMd5.charCodeAt(keyMd5.length - 1);
  if (photoId >= LEFT && photoId <= RIGHT) code %= 10;
  else if (photoId >= RIGHT + 1) code %= 8;
  // photoId < LEFT：不取模，任何十六进制字符码都越界 → 回落 10（与客户端一致）
  return SEED_MAP[code] ?? 10;
}

/** 是否需要解扰（与客户端一致：GIF / ID ≤ scramble_id / speed==1 均不解） */
export function needsScramble({ photoId, scrambleId, speed, name }) {
  if (/\.gif$/i.test(name)) return false;
  if (photoId <= scrambleId) return false;
  if (speed === '1') return false;
  return true;
}

/**
 * 在申请全尺寸 Canvas 前检查图片栅格规模。浏览器端解扰至少会同时
 * 持有 ImageBitmap、Canvas 和编码缓冲，长条图的像素数比压缩文件大小
 * 更能代表实际内存压力；超过预算时让当前页进入可重试错误态，避免
 * 触发移动浏览器 OOM 或把整页 UI 杀掉。
 */
export function validateDecodeDimensions(width, height, { memoryOptimized = false } = {}) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w <= 0 || h <= 0) {
    throw new Error('图片尺寸无效');
  }
  const pixels = w * h;
  const maxPixels = memoryOptimized ? MEMORY_OPT_MAX_DECODE_PIXELS : MAX_DECODE_PIXELS;
  const maxBytes = memoryOptimized ? MEMORY_OPT_MAX_DECODE_WORKING_BYTES : MAX_DECODE_WORKING_BYTES;
  const maxDimension = memoryOptimized ? MEMORY_OPT_MAX_DECODE_DIMENSION : MAX_DECODE_DIMENSION;
  // ImageBitmap 与 Canvas 各按 RGBA 4 bytes 估算；编码器可能再保留一份，
  // 因此把估算乘以 2 作为保守的工作集水位。
  const estimatedBytes = pixels * 8;
  if (w > maxDimension || h > maxDimension || !Number.isSafeInteger(pixels)
      || pixels > maxPixels || estimatedBytes > maxBytes) {
    const mib = Math.max(1, Math.round(estimatedBytes / (1024 * 1024)));
    throw new Error(`图片过大（约 ${mib} MiB 解码内存），已停止以保护设备`);
  }
  return { width: w, height: h, pixels, estimatedBytes };
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

/**
 * 解码单张图片（调用方先取好原图 Blob，解扰与原图共用下载缓存）：
 * createImageBitmap → 分片重排 → Blob
 * 返回 { blob, width, height }
 */
export async function decodeFromBlob(rawBlob, photoId, page, options = {}) {
  const bmp = await decodeBitmap(rawBlob);
  try {
    const seed = calcSeed(photoId, page);
    const { width: w, height: hgt } = validateDecodeDimensions(
      bmp.width,
      bmp.height,
      { memoryOptimized: options.memoryOptimized === true },
    );

    const canvas = makeCanvas(w, hgt);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前浏览器无法创建图片画布');
    ctx.imageSmoothingEnabled = false;

    const remainder = hgt % seed;
    for (let i = 0; i < seed; i++) {
      let sliceH = Math.floor(hgt / seed);
      let dy = sliceH * i;
      const sy = hgt - sliceH * (i + 1) - remainder;
      if (i === 0) sliceH += remainder;
      else dy += remainder;
      if (sliceH <= 0) continue;
      ctx.drawImage(bmp, 0, sy, w, sliceH, 0, dy, w, sliceH);
    }

    const blob = await canvasToBlob(canvas);
    return { blob, width: w, height: hgt };
  } finally {
    if (typeof bmp.close === 'function') bmp.close();
  }
}
