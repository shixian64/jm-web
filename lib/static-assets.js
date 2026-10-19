'use strict';
/**
 * 静态资源内容寻址：
 *  - ETag 来自文件内容哈希，而不是 size/mtime。发布制品的 mtime 统一为 0，
 *    旧算法会让“字节数相同但内容不同”的新模块被浏览器/SW 以 304 命中旧版。
 *  - index.html 注入 import map，把 /js/*.js 映射到 `?v=<内容哈希>`，
 *    CSS 链接同样追加版本；版本化 URL 由服务端以 immutable 长缓存返回。
 *  - 文本资源按需生成 br/gzip 副本并留在内存（public/ 体积有界）。
 *
 * 所有条目按 stat（size/mtime/inode）失效，开发时直接编辑 public/ 也会生效。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');

const gzipAsync = promisify(zlib.gzip);
const brotliAsync = promisify(zlib.brotliCompress);

const COMPRESSIBLE_EXTS = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.txt']);
const MIN_COMPRESS_BYTES = 1024;
// index.html 中按内容版本化的目录；其余资源（图标、manifest）保持协商缓存。
const VERSIONED_DIRS = ['js', 'css'];
const VERSIONED_EXTS = new Set(['.js', '.css']);
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

function contentHash(buf) {
  return crypto.createHash('sha256').update(buf).digest('base64url').slice(0, 16);
}

function statKey(st) {
  return `${st.size}:${st.mtimeMs}:${st.ino}`;
}

/** If-None-Match 可能是列表或带 W/ 前缀；按弱比较判断是否命中。 */
function etagMatches(header, etag) {
  if (!header || !etag) return false;
  const bare = (value) => value.trim().replace(/^W\//, '');
  const target = bare(etag);
  return String(header).split(',').some((item) => item.trim() === '*' || bare(item) === target);
}

/** 解析 Accept-Encoding，优先 br，其次 gzip；q=0 视为拒绝。 */
function preferredEncoding(acceptEncoding) {
  const accepted = new Map();
  for (const part of String(acceptEncoding || '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.trim().split('=');
      if (key === 'q') q = Number(value);
    }
    accepted.set(name, Number.isFinite(q) ? q : 0);
  }
  const allows = (name) => (accepted.has(name) ? accepted.get(name) > 0 : (accepted.get('*') || 0) > 0);
  if (allows('br')) return 'br';
  if (allows('gzip')) return 'gzip';
  return null;
}

function isVersionedAssetPath(pathname) {
  const dir = pathname.split('/')[1];
  return VERSIONED_DIRS.includes(dir) && VERSIONED_EXTS.has(path.extname(pathname).toLowerCase());
}

function createStaticAssets({ publicDir }) {
  const entries = new Map();
  let indexCache = null;

  function makeEntry(key, body, ext) {
    const hash = contentHash(body);
    return { key, body, hash, etag: `W/"${hash}"`, ext, encoded: new Map(), inlineScriptHashes: [] };
  }

  async function load(file, st) {
    const key = statKey(st);
    const hit = entries.get(file);
    if (hit && hit.key === key) return hit;
    // stat 与 read 之间若被原子替换，哈希仍来自实际读取的字节；
    // 下次 stat 键不一致时会重新读取。
    const body = await fs.promises.readFile(file);
    const entry = makeEntry(key, body, path.extname(file).toLowerCase());
    entries.set(file, entry);
    return entry;
  }

  async function versionManifest() {
    const manifest = new Map();
    for (const dir of VERSIONED_DIRS) {
      let names;
      try {
        names = await fs.promises.readdir(path.join(publicDir, dir));
      } catch (_) {
        continue;
      }
      for (const name of names.sort()) {
        if (!VERSIONED_EXTS.has(path.extname(name).toLowerCase())) continue;
        const file = path.join(publicDir, dir, name);
        let st;
        try { st = await fs.promises.stat(file); } catch (_) { continue; }
        if (!st.isFile()) continue;
        manifest.set(`/${dir}/${name}`, (await load(file, st)).hash);
      }
    }
    return manifest;
  }

  /**
   * 入口 HTML 依赖全部模块版本：任一模块变化都会改变 import map，
   * 因而 index 的内容哈希/ETag 随之变化。
   */
  async function loadIndex(file, st) {
    const source = await load(file, st);
    const manifest = await versionManifest();
    const signature = `${source.hash}|${[...manifest].map(([url, hash]) => `${url}=${hash}`).join(',')}`;
    if (indexCache && indexCache.signature === signature) return indexCache.entry;

    const imports = {};
    for (const [url, hash] of manifest) {
      if (url.endsWith('.js')) imports[url] = `${url}?v=${hash}`;
    }
    // JSON 中的 `<` 转义，避免内容里出现 `</script>` 截断标签。
    const importMap = JSON.stringify({ imports }).replace(/</g, '\\u003c');
    let html = source.body.toString('utf8');
    html = html.replace(/(<link\b[^>]*\bhref=")(\/css\/[^"?#]+\.css)(")/g, (whole, before, url, after) => (
      manifest.has(url) ? `${before}${url}?v=${manifest.get(url)}${after}` : whole
    ));
    // import map 必须先于任何模块脚本出现；入口 app.js 保持无版本 URL，
    // 让旧 Service Worker 的入口校验与离线外壳在升级窗口内仍然有效。
    const tag = `<script type="importmap">${importMap}</script>`;
    html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `  ${tag}\n</head>`) : `${tag}\n${html}`;

    const entry = makeEntry(source.key, Buffer.from(html, 'utf8'), '.html');
    entry.inlineScriptHashes = [`'sha256-${crypto.createHash('sha256').update(importMap).digest('base64')}'`];
    indexCache = { signature, entry };
    return entry;
  }

  async function encodedBody(entry, encoding) {
    if (!encoding || !COMPRESSIBLE_EXTS.has(entry.ext) || entry.body.length < MIN_COMPRESS_BYTES) return null;
    let pending = entry.encoded.get(encoding);
    if (!pending) {
      const job = encoding === 'br'
        ? brotliAsync(entry.body, {
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: entry.body.length,
          },
        })
        : gzipAsync(entry.body, { level: 9 });
      // 压缩失败或没有收益时退回原文，不影响响应。
      pending = job.then((buf) => (buf.length < entry.body.length ? buf : null), () => null);
      entry.encoded.set(encoding, pending);
    }
    return pending;
  }

  return {
    load,
    loadIndex,
    encodedBody,
    versionManifest,
    clear() {
      entries.clear();
      indexCache = null;
    },
  };
}

module.exports = {
  createStaticAssets,
  contentHash,
  etagMatches,
  preferredEncoding,
  isVersionedAssetPath,
  COMPRESSIBLE_EXTS,
  IMMUTABLE_CACHE_CONTROL,
};
