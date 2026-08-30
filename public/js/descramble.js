// 图片解扰（对齐 jm-mobile ComicPicImageState 的算法）：
//   seed = seedMap[ md5("{photoId}{page}") 末字符 ]，按漫画 ID 区间取模
//   解码 = 将原图纵向切 seed 片后按相反顺序重排
import { md5 } from './md5.js';

const SEED_MAP = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20];
const LEFT = 268850;
const RIGHT = 421925;

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

function makeCanvas(w, hgt) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, hgt);
  const c = document.createElement('canvas');
  c.width = w; c.height = hgt;
  return c;
}

function canvasToBlob(canvas) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/webp', quality: 0.92 });
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/webp', 0.92)
  );
}

/**
 * 解码单张图片（调用方先取好原图 Blob，解扰与原图共用下载缓存）：
 * createImageBitmap → 分片重排 → Blob
 * 返回 { blob, width, height }
 */
export async function decodeFromBlob(rawBlob, photoId, page) {
  const bmp = await createImageBitmap(rawBlob);

  const seed = calcSeed(photoId, page);
  const w = bmp.width;
  const hgt = bmp.height;

  const canvas = makeCanvas(w, hgt);
  const ctx = canvas.getContext('2d');
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
  bmp.close();

  const blob = await canvasToBlob(canvas);
  return { blob, width: w, height: hgt };
}
