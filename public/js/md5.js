// 紧凑 MD5 实现（用于图片解扰 seed = md5("{id}{page}") 的计算）
export function md5(str) {
  const utf8 = new TextEncoder().encode(str);
  const paddedLen = (utf8.length + 9 + 63) & ~63; // 补 0x80 + 64 位长度，按 64 字节对齐
  const words = new Uint32Array(paddedLen / 4);
  const bytes = new Uint8Array(words.buffer);
  bytes.set(utf8);
  bytes[utf8.length] = 0x80;

  const bitLen = utf8.length * 8;
  words[words.length - 2] = bitLen >>> 0;
  words[words.length - 1] = Math.floor(bitLen / 0x100000000);

  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const rotl = (x, c) => ((x << c) | (x >>> (32 - c))) >>> 0;

  for (let chunk = 0; chunk < words.length; chunk += 16) {
    const M = words.subarray(chunk, chunk + 16);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + rotl(F, S[i])) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }

  const hex = (n) => {
    let s = '';
    for (let i = 0; i < 4; i++) {
      s += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
    }
    return s;
  };
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}
