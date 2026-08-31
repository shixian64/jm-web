// 内容筛选与搜索排除语法。保持为纯函数，便于首页、分类、搜索和用户列表复用。

const EXCLUDED_TAG_SEPARATOR = '\u001f';

export function normalizeTags(values) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const tag = String(value == null ? '' : value).trim().replace(/^[+-]+/, '').trim();
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }
  return result;
}

export function parseSearchSyntax(value) {
  const includes = [];
  const excludes = [];
  for (const raw of String(value || '').trim().split(/\s+/).filter(Boolean)) {
    // “-标签”只在词首表示排除；one-piece、作者名等词内连字符必须原样搜索。
    if (raw.length > 1 && raw.startsWith('-')) excludes.push(raw.slice(1));
    else if (raw.length > 1 && raw.startsWith('+')) includes.push(raw.slice(1));
    else includes.push(raw);
  }
  return { includes: normalizeTags(includes), excludes: normalizeTags(excludes) };
}

/**
 * 移除 `-标签` 排除项，同时保留 `+标签` 的精确标签搜索前缀。
 * 这与 Android 端 searchContentWithoutExcludedTags 的语义一致。
 */
export function searchContentWithoutExcludedTags(value) {
  return String(value || '').trim().split(/\s+/).filter((raw) => {
    return raw && !(raw.length > 1 && raw.startsWith('-'));
  }).join(' ');
}

export function serializeExcludedTags(tags) {
  return normalizeTags(tags).join(EXCLUDED_TAG_SEPARATOR);
}

export function deserializeExcludedTags(value) {
  if (!value) return [];
  return normalizeTags(String(value).split(EXCLUDED_TAG_SEPARATOR));
}

export function buildSearchQuery(searchContent, excludedTags) {
  const base = String(searchContent || '').trim().replace(/\s+/g, ' ');
  const excluded = normalizeTags(excludedTags).map((tag) => `-${tag}`).join(' ');
  return [base, excluded].filter(Boolean).join(' ');
}

function strings(value) {
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') {
    return [value.name, value.title, value.slug].filter(Boolean).map(String);
  }
  return value == null ? [] : [String(value)];
}

/** 与 Android 客户端一致做不区分大小写的完整标签匹配。 */
export function comicTags(item) {
  item = item || {};
  return normalizeTags([
    ...strings(item.tags),
    ...strings(item.actors),
    ...strings(item.works),
    ...strings(item.roles),
    ...strings(item.category),
    ...strings(item.category_sub),
  ]);
}

export function isComicBlocked(item, blockedTags) {
  const blocked = new Set(normalizeTags(blockedTags).map((tag) => tag.toLocaleLowerCase()));
  if (!blocked.size) return false;
  return comicTags(item).some((tag) => blocked.has(tag.toLocaleLowerCase()));
}

export function filterComics(items, blockedTags) {
  const list = Array.isArray(items) ? items : [];
  const normalized = normalizeTags(blockedTags);
  return normalized.length ? list.filter((item) => !isComicBlocked(item, normalized)) : list;
}
