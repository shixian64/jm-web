// 基于账号收藏标签的轻量偏好推荐。
//
// `network` 直接读取账号态网络首页；`builtin` 从收藏样本提取标签，
// 再通过内置数据源做精确标签搜索。计算只存在于当前页面内，不持久化
// 收藏内容，也不会把推荐失败升级为首页失败。

const VALID_SOURCES = new Set(['builtin', 'network']);
const PAGE_SIZE = 20;
const MAX_FAVORITE_PAGES = 5;
const MAX_FAVORITES = 30;
const MAX_DETAIL_REQUESTS = 12;
const MAX_TAG_SEARCHES = 4;

function abortError() {
  try { return new DOMException('请求已取消', 'AbortError'); } catch (_) {
    const error = new Error('请求已取消'); error.name = 'AbortError'; return error;
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
}

async function requestJson(path, source, signal) {
  throwIfAborted(signal);
  const response = await fetch('/api' + path, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json', 'X-JMW-Data-Source': source },
    signal,
  });
  let body = null;
  try { body = await response.json(); } catch (_) {}
  if (!response.ok) {
    const error = new Error(body?.error || `推荐请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return body || {};
}

function itemId(item) {
  return String(item?.id ?? item?.aid ?? item?.AID ?? '').trim();
}

function tagText(value) {
  if (value == null) return '';
  if (typeof value === 'object') return String(value.name || value.title || value.tag || '').trim();
  return String(value).trim();
}

/** 将各版本接口的标签形态归一化，保留中文和带空格的完整标签名。 */
export function recommendationTags(item) {
  const raw = [item?.tags, item?.tag_list, item?.tagList, item?.keywords]
    .flat(Infinity)
    .flatMap((value) => {
      const text = tagText(value);
      return text && typeof value !== 'object' ? text.split(/[,，、|/]+/) : [text];
    });
  const seen = new Set();
  const tags = [];
  for (const value of raw) {
    const clean = String(value || '').replace(/^标签[：:]?\s*/u, '').trim();
    const key = clean.toLocaleLowerCase();
    if (!clean || clean.length > 60 || seen.has(key)) continue;
    seen.add(key); tags.push(clean);
  }
  return tags;
}

function addTagWeights(weights, item, amount = 1) {
  for (const tag of recommendationTags(item)) {
    const key = tag.toLocaleLowerCase();
    const old = weights.get(key);
    weights.set(key, { tag: old?.tag || tag, weight: Number(old?.weight || 0) + amount });
  }
}

async function settlePool(items, concurrency, worker) {
  let cursor = 0;
  const results = [];
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try { results[index] = await worker(items[index], index); }
      catch (error) {
        if (error?.name === 'AbortError') throw error;
        results[index] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

async function loadFavoriteSample(source, signal) {
  const favorites = [];
  const ids = new Set();
  for (let page = 1; page <= MAX_FAVORITE_PAGES && favorites.length < MAX_FAVORITES; page++) {
    const result = await requestJson(`/favorites?o=mr&page=${page}&folder_id=0`, source, signal);
    const data = result.data || {};
    const rows = Array.isArray(data.list) ? data.list : [];
    for (const item of rows) {
      const id = itemId(item);
      if (!id || ids.has(id)) continue;
      ids.add(id); favorites.push(item);
      if (favorites.length >= MAX_FAVORITES) break;
    }
    const total = Number(data.total);
    if (rows.length < PAGE_SIZE || (Number.isFinite(total) && total <= page * PAGE_SIZE)) break;
  }
  return { favorites, ids };
}

async function extractPreference(source, signal) {
  const { favorites, ids } = await loadFavoriteSample(source, signal);
  const weights = new Map();
  favorites.forEach((item) => addTagWeights(weights, item));

  // 收藏摘要通常不带标签；只补取有限样本详情，避免首页产生无界请求。
  const missing = favorites.filter((item) => !recommendationTags(item).length && /^\d+$/.test(itemId(item)))
    .slice(0, MAX_DETAIL_REQUESTS);
  const details = await settlePool(missing, 4, async (item) => {
    const result = await requestJson(`/album?id=${encodeURIComponent(itemId(item))}`, source, signal);
    return result.data || result;
  });
  details.filter(Boolean).forEach((item) => addTagWeights(weights, item));

  const tags = [...weights.values()]
    .sort((a, b) => b.weight - a.weight || a.tag.localeCompare(b.tag, 'zh-CN'))
    .slice(0, MAX_TAG_SEARCHES);
  return { favorites, favoriteIds: ids, tags, weights };
}

function scoreCandidate(entry, matchedTag, matchedWeight, weights) {
  let score = matchedWeight;
  for (const tag of recommendationTags(entry)) score += Number(weights.get(tag.toLocaleLowerCase())?.weight || 0);
  return { entry, score, matchedTag };
}

async function builtinRecommendations(preference, maxResults, signal) {
  if (!preference.tags.length) return [];
  const searches = await settlePool(preference.tags, MAX_TAG_SEARCHES, async ({ tag, weight }) => {
    const result = await requestJson(`/search?q=${encodeURIComponent('+' + tag)}&o=mr&page=1`, 'builtin', signal);
    const rows = Array.isArray(result.data?.content) ? result.data.content : [];
    return rows.map((entry) => scoreCandidate(entry, tag, weight, preference.weights));
  });
  const byId = new Map();
  for (const scored of searches.flat().filter(Boolean)) {
    const id = itemId(scored.entry);
    if (!id || preference.favoriteIds.has(id)) continue;
    const old = byId.get(id);
    if (!old || scored.score > old.score) byId.set(id, scored);
  }
  return [...byId.values()]
    .sort((a, b) => b.score - a.score || itemId(a.entry).localeCompare(itemId(b.entry)))
    .slice(0, maxResults)
    .map(({ entry, matchedTag }) => ({ ...entry, preferenceTag: matchedTag }));
}

async function networkRecommendations(preference, maxResults, signal) {
  const result = await requestJson('/home', 'network', signal);
  const blocks = Array.isArray(result.data) ? result.data : [];
  const byId = new Map();
  for (const block of blocks) {
    for (const entry of Array.isArray(block?.content) ? block.content : []) {
      const id = itemId(entry);
      if (!id || preference.favoriteIds.has(id) || byId.has(id)) continue;
      byId.set(id, entry);
      if (byId.size >= maxResults) return [...byId.values()];
    }
  }
  return [...byId.values()];
}

/**
 * 生成当前登录账号的偏好推荐。未登录、收藏为空或上游不支持时由调用方
 * 捕获错误/空列表，首页原有内容不受影响。
 */
export async function getPreferenceRecommendations(options = {}) {
  const source = VALID_SOURCES.has(options.source) ? options.source : 'builtin';
  const maxResults = Math.max(1, Math.min(40, Number(options.maxResults) || 20));
  const signal = options.signal;
  // 网络首页推荐只需要收藏 id 去重，不需要再补取每本详情和标签。
  // 内置推荐才执行有界详情采样 + 标签搜索，避免一个首页产生无意义请求。
  const preference = source === 'network'
    ? await loadFavoriteSample(source, signal).then(({ favorites, ids }) => ({
      favorites, favoriteIds: ids, tags: [], weights: new Map(),
    }))
    : await extractPreference(source, signal);
  throwIfAborted(signal);
  if (!preference.favorites.length) return { source, tags: [], items: [] };
  const items = source === 'network'
    ? await networkRecommendations(preference, maxResults, signal)
    : await builtinRecommendations(preference, maxResults, signal);
  return { source, tags: preference.tags.map((item) => item.tag), items };
}
