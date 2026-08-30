'use strict';
/**
 * chapter_view_template HTML 解析（对齐 jm-mobile 的 DataDecode.kt）
 *
 * HTML 内嵌（JS 宽松语法：单引号、无引号键名，Gson LENIENT 可解析）：
 *   const result = { images: ['00001.webp', ...] };
 *   const config = { jmid: '340972', imghost: 'https://...', cache: '' };
 *   var aid = 340972; var scramble_id = 220980; var speed = '';
 */

/**
 * 提取 `const <name> = { ... };` 的对象字面量（花括号平衡、感知字符串），
 * 避免非贪婪正则在嵌套花括号处提前截断。
 */
function extractObject(html, name) {
  const m = new RegExp(`(?:const|var)\\s+${name}\\s*=\\s*`).exec(html);
  if (!m) return null;
  let i = m.index + m[0].length;
  while (i < html.length && /\s/.test(html[i])) i++;
  if (html[i] !== '{') return null;
  const start = i;
  let depth = 0, inStr = null, esc = false;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === inStr) inStr = null;
    } else if (ch === '"' || ch === "'") {
      inStr = ch;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (!depth) return html.slice(start, i + 1);
    }
  }
  return null;
}

/** 单引号 → 双引号、无引号键名补引号、跳过尾逗号（逐字符、感知字符串） */
function lenientParse(text) {
  if (!text || typeof text !== 'string') return null;
  let out = '';
  let inStr = null, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === inStr) { inStr = null; out += '"'; continue; }
      if (inStr === "'" && ch === '"') { out += '\\"'; continue; }
      out += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; out += '"'; continue; }
    if (ch === '{' || ch === ',') {
      // 尾逗号：后一个非空白字符是 } 或 ] 时丢弃
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (ch === ',' && (text[j] === '}' || text[j] === ']')) { i = j - 1; continue; }
      out += ch;
      // 无引号键名：{ 或 , 之后是标识符且后跟冒号 → 补引号
      const km = /^[A-Za-z_$][\w$]*/.exec(text.slice(j));
      if (km) {
        let k = j + km[0].length;
        while (k < text.length && /\s/.test(text[k])) k++;
        if (text[k] === ':') {
          out += text.slice(i + 1, j) + '"' + km[0] + '"';
          i = k - 1;
          continue;
        }
      }
      continue;
    }
    out += ch;
  }
  try {
    return JSON.parse(out);
  } catch (_) {
    return null;
  }
}

function parsePhotoHtml(html) {
  const out = {
    aid: 0,
    scrambleId: 0,
    speed: '',
    imghost: '',
    jmid: '',
    cache: '',
    images: [], // [{ name, page, url }]
  };

  const resultObj = lenientParse(extractObject(html, 'result'));
  if (resultObj && Array.isArray(resultObj.images)) {
    for (const item of resultObj.images) {
      if (typeof item === 'string') out.images.push({ name: item });
    }
  }

  const configObj = lenientParse(extractObject(html, 'config'));
  if (configObj) {
    out.imghost = String(configObj.imghost || '');
    out.jmid = String(configObj.jmid || '');
    out.cache = String(configObj.cache || '');
  }

  const aidMatch = html.match(/var aid\s*=\s*(\d+)\s*;/);
  if (aidMatch) out.aid = parseInt(aidMatch[1], 10);

  const sidMatch = html.match(/var scramble_id\s*=\s*(\d+)\s*;/);
  if (sidMatch) out.scrambleId = parseInt(sidMatch[1], 10);

  const speedMatch = html.match(/var speed\s*=\s*'([^']*)'/);
  if (speedMatch) out.speed = speedMatch[1];

  if (!out.images.length || !out.imghost || !out.jmid) {
    throw new Error('解析章节 HTML 失败（上游可能返回了异常页面）');
  }

  out.images = out.images.map((it) => {
    const page = it.name.replace(/\.[^.]+$/, ''); // 文件名去扩展名，作为扰乱种子输入
    return {
      name: it.name,
      page,
      url: `${out.imghost}/media/photos/${out.jmid}/${it.name}${out.cache || ''}`,
    };
  });

  return out;
}

module.exports = { parsePhotoHtml, extractObject, lenientParse };
