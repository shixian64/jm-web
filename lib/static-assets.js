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

// 入口模块。HTML 中的 `<script type="module" src="/js/app.js">` 不经过 import map，
// 只能以无版本 URL 协商缓存（经 Cloudflare 后甚至变为 no-store），每次启动都要多
// 一次往返。改写为内联 `import "/js/app.js"`：说明符经 import map 解析为
// `?v=<哈希>` 的不可变 URL，可直接命中浏览器缓存。
// 升级取舍：v25 及更早的 SW 只认 `src="/js/app.js"` 入口，在新 SW（v26，两种写法都认）
// 接管前不会用改写后的 HTML 刷新离线首页，手动预缓存也会失败一次；在线导航不受影响，
// 且新 SW 在同一次访问中即安装并 skipWaiting/claim，窗口仅限一次页面加载。
const ENTRY_MODULE = '/js/app.js';
const ENTRY_SCRIPT = `import "${ENTRY_MODULE}";`;

/**
 * 提取模块源码中的静态 import/export-from 依赖（不含动态 import()）。
 * 只匹配语句开头的 import/export，且说明符前不跨越引号或分号。
 */
function staticImportSpecifiers(source) {
  const out = [];
  const re = /(?:^|\n)\s*(?:import|export)\s+(?:[^'";()]*?\sfrom\s*)?['"]([^'"\n]+)['"]/g;
  let match;
  while ((match = re.exec(String(source || '')))) out.push(match[1]);
  return out;
}

/** 从入口出发收集同目录静态依赖闭包（按发现顺序，不含入口本身）。 */
function moduleClosure(entryUrl, sourceOf) {
  const seen = new Set([entryUrl]);
  const order = [];
  const queue = [entryUrl];
  while (queue.length) {
    const current = queue.shift();
    const source = sourceOf(current);
    if (source == null) continue;
    for (const spec of staticImportSpecifiers(source)) {
      if (!spec.startsWith('./') && !spec.startsWith('../') && !spec.startsWith('/')) continue;
      let url;
      try { url = new URL(spec, `https://x${current}`).pathname; } catch (_) { continue; }
      if (seen.has(url)) continue;
      seen.add(url);
      order.push(url);
      queue.push(url);
    }
  }
  return order;
}

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
    manifest.sources = new Map();
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
        const entry = await load(file, st);
        manifest.set(`/${dir}/${name}`, entry.hash);
        if (name.endsWith('.js')) manifest.sources.set(`/${dir}/${name}`, entry.body);
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
    const scriptHash = (text) => `'sha256-${crypto.createHash('sha256').update(text).digest('base64')}'`;
    const inlineScriptHashes = [scriptHash(importMap)];
    let entryRewritten = false;
    if (manifest.has(ENTRY_MODULE)) {
      html = html.replace(/<script\s+type="module"\s+src="\/js\/app\.js"\s*><\/script>/i, () => {
        entryRewritten = true;
        return `<script type="module">${ENTRY_SCRIPT}</script>`;
      });
    }
    if (entryRewritten) inlineScriptHashes.push(scriptHash(ENTRY_SCRIPT));
    // 其余经典脚本（booterr.js）同样追加内容版本，走 immutable 缓存。
    html = html.replace(/(<script\b[^>]*\bsrc=")(\/js\/[^"?#]+\.js)(")/g, (whole, before, url, after) => (
      manifest.has(url) ? `${before}${url}?v=${manifest.get(url)}${after}` : whole
    ));
    // import map 必须先于任何模块请求（含 modulepreload）出现，否则浏览器会忽略它。
    // 预加载入口的静态依赖闭包：浏览器解析 HTML 时即可并行下载全部启动模块，
    // 不必逐层发现 app.js → api.js → navigation-cache.js 等依赖。
    const preloadUrls = entryRewritten
      ? [ENTRY_MODULE, ...moduleClosure(ENTRY_MODULE, (url) => manifest.sources.get(url))]
        .filter((url) => manifest.has(url))
      : [];
    const preloads = preloadUrls
      .map((url) => `  <link rel="modulepreload" href="${url}?v=${manifest.get(url)}" />`).join('\n');
    const tag = `<script type="importmap">${importMap}</script>${preloads ? `\n${preloads}` : ''}`;
    html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `  ${tag}\n</head>`) : `${tag}\n${html}`;

    const entry = makeEntry(source.key, Buffer.from(html, 'utf8'), '.html');
    entry.inlineScriptHashes = inlineScriptHashes;
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
  staticImportSpecifiers,
  moduleClosure,
  ENTRY_SCRIPT,
  contentHash,
  etagMatches,
  preferredEncoding,
  isVersionedAssetPath,
  COMPRESSIBLE_EXTS,
  IMMUTABLE_CACHE_CONTROL,
};
