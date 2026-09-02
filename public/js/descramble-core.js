// 图片解扰的无 DOM 核心。阅读器主线程、下载器 Worker 共用同一份
// 种子和尺寸校验，避免不同执行上下文逐渐产生算法漂移。
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

/**
 * 在申请全尺寸 Canvas 前检查图片栅格规模。浏览器端解扰至少会同时
 * 持有 ImageBitmap、Canvas 和编码缓冲，长条图的像素数比压缩文件大小
 * 更能代表实际内存压力；超过预算时让调用方进入可重试错误态。
 */
export function validateDecodeDimensions(width, height, { memoryOptimized = false } = {}) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w <= 0 || h <= 0) {
    const error = new Error('图片尺寸无效');
    error.code = 'DECODE_INVALID_DIMENSIONS';
    throw error;
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
    const mib = Number.isFinite(estimatedBytes)
      ? Math.max(1, Math.round(estimatedBytes / (1024 * 1024))) : '未知';
    const error = new Error(`图片过大（约 ${mib} MiB 解码内存），已停止以保护设备`);
    error.code = 'DECODE_LIMIT';
    throw error;
  }
  return { width: w, height: h, pixels, estimatedBytes };
}

/**
 * 把纵向分片按相反顺序画回目标上下文。ctx 只需实现标准 Canvas 2D
 * drawImage 接口，因此可以同时用于 Window Canvas 和 OffscreenCanvas。
 */
export function drawDescrambled(ctx, bitmap, photoId, page, width, height) {
  const seed = calcSeed(photoId, page);
  const remainder = height % seed;
  for (let i = 0; i < seed; i++) {
    let sliceH = Math.floor(height / seed);
    let dy = sliceH * i;
    const sy = height - sliceH * (i + 1) - remainder;
    if (i === 0) sliceH += remainder;
    else dy += remainder;
    if (sliceH <= 0) continue;
    ctx.drawImage(bitmap, 0, sy, width, sliceH, 0, dy, width, sliceH);
  }
}
