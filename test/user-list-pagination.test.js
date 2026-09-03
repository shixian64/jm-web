'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

// user.js 的分页辅助函数不依赖真实浏览器；提供最小模块初始化桩，避免
// 测试为了验证边界而启动整套 SPA。
global.localStorage = {
  getItem: () => null,
  setItem() {},
  removeItem() {},
  length: 0,
  key: () => null,
};
global.document = {
  createElement: () => ({
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {},
    appendChild() {},
    style: {},
    dataset: {},
  }),
  createElementNS: () => ({
    classList: { add() {} },
    setAttribute() {},
    innerHTML: '',
  }),
  createTextNode: (value) => ({ textContent: value }),
  documentElement: { dataset: {}, style: {}, classList: { toggle() {} } },
  querySelector: () => null,
  body: { classList: { contains: () => false } },
};

(async () => {
  const userUrl = pathToFileURL(path.resolve(__dirname, '..', 'public', 'js', 'user.js')).href;
  const {
    USER_LIST_PAGE_SIZE, userListItemKey, dedupeUserListPage, userListPageHasMore,
    parseFavoriteCount, normalizeHistoryTitle, canonicalHistoryKey,
    dedupeHistoryItems, localHistoryHref,
  } = await import(userUrl);

  assert.strictEqual(USER_LIST_PAGE_SIZE, 20);
  assert.strictEqual(userListItemKey({ id: 42 }), 'id:42');
  assert.strictEqual(userListItemKey({ aid: '42' }), 'id:42');
  assert.strictEqual(userListItemKey({ id: '', aid: '42' }), 'id:42');
  assert.strictEqual(
    userListItemKey({ name: ' 同一作品 ', author: ['作者'] }),
    userListItemKey({ name: '同一作品', author: ['作者'] }),
  );

  // 跨页重复 ID 只保留第一次，并把整页无新项标记出来，供 loader 收口。
  const seen = new Set();
  const firstPage = dedupeUserListPage(
    [{ id: 1 }, { id: 2 }, { id: 2 }], seen,
  );
  assert.deepStrictEqual(firstPage.items.map((item) => item.id), [1, 2]);
  assert.strictEqual(firstPage.hasNew, true);
  const repeatedPage = dedupeUserListPage([{ AID: '1' }, { aid: '2' }], seen);
  assert.deepStrictEqual(repeatedPage.items, []);
  assert.strictEqual(repeatedPage.hasNew, false);

  // total 存在时按总条数判断；短页、空页和重复页始终停止，不能被错误
  // 的 total 或 source_count 重新打开无限请求。
  assert.strictEqual(userListPageHasMore({ total: 35, page: 1, sourceCount: 20 }), true);
  assert.strictEqual(userListPageHasMore({ total: 35, page: 2, sourceCount: 15 }), false);
  assert.strictEqual(userListPageHasMore({ total: 999, page: 2, sourceCount: 0 }), false);
  assert.strictEqual(userListPageHasMore({ total: 999, page: 2, sourceCount: 20, repeated: true }), false);

  // 老线路不返回 total 时退化为页大小；本地收藏夹过滤后仍以原始
  // source_count（20）继续读取，不能因当前页没有命中分组而提前结束。
  assert.strictEqual(userListPageHasMore({ page: 1, sourceCount: 20 }), true);
  assert.strictEqual(userListPageHasMore({ page: 2, sourceCount: 7 }), false);

  // 登录资料中的收藏数是快照；收藏列表返回的 total 可能是字符串，必须按
  // 实时值校准，同时不能把满页长度误当成总数。
  assert.strictEqual(parseFavoriteCount({ data: { total: '2' } }), 2);
  assert.strictEqual(parseFavoriteCount({ data: { total: 'bad', count: '3' } }), 3);
  assert.strictEqual(parseFavoriteCount({ data: { total: '1', list: [{ id: 1 }, { id: 2 }] } }), 2);
  assert.strictEqual(parseFavoriteCount({ data: { list: [{ id: 1 }, { id: 2 }] } }), 2);
  assert.strictEqual(parseFavoriteCount({ data: { list: Array.from({ length: 20 }, () => ({})) } }), null);
  assert.strictEqual(parseFavoriteCount({ data: { total: '2', count: '20', list: [{ id: 1 }, { id: 2 }] } }), 2);
  assert.strictEqual(parseFavoriteCount({ data: { count: '20', list: Array.from({ length: 20 }, () => ({})) } }), null);

  // 同系列章节归并为一个代表项，并保留全部可删除的历史 ID；显式系列 ID
  // 优先于标题，标题回退则去掉常见章节后缀并结合作者，避免同名误合并。
  assert.strictEqual(normalizeHistoryTitle('调教开关-第 3 话'), '调教开关');
  assert.strictEqual(normalizeHistoryTitle('Foo Chapter 12'), 'Foo');
  assert.strictEqual(canonicalHistoryKey({ id: '1', series_id: '99', name: '甲' }), 'series:99');
  const groups = new Map();
  const history = dedupeHistoryItems([
    { id: '1225497', name: '特色新视界' },
    { id: '1225495', name: '特色新视界' },
    { id: '403306', name: '调教开关-第 3 话', author: '作者甲' },
    { id: '403305', name: '调教开关-第 2 话', author: '作者甲' },
    { id: '7', name: '同名-第 1 话', author: '作者甲' },
    { id: '8', name: '同名-第 2 话', author: '作者乙' },
  ], groups);
  assert.strictEqual(history.items.length, 4);
  assert.deepStrictEqual(history.items[0]._historyIds, ['1225497', '1225495']);
  assert.deepStrictEqual(history.items[1]._historyIds, ['403306', '403305']);
  const authorVariants = dedupeHistoryItems([
    { id: '301', name: '作者作品 第1话', author: ['作者甲', '作者乙'] },
    { id: '302', name: '作者作品 第2话', author: '作者甲、作者乙' },
  ]);
  assert.strictEqual(authorVariants.items.length, 1);
  const nextHistoryPage = dedupeHistoryItems([
    { id: '403304', name: '调教开关', author: '作者甲' },
    { id: '99', name: '同名-第 3 话', author: '作者丙', series_id: '7' },
    { id: '100', name: '另一章', author: '作者丙', series_id: '7' },
  ], groups);
  assert.strictEqual(nextHistoryPage.items.length, 1);
  assert.deepStrictEqual(nextHistoryPage.items[0]._historyIds, ['99', '100']);
  assert.deepStrictEqual(groups.get('title:调教开关\u001f作者甲')._historyIds, ['403306', '403305', '403304']);
  assert.deepStrictEqual(groups.get('series:7')._historyIds, ['99', '100']);
  const explicitSeries = dedupeHistoryItems([
    { id: '201', name: '同名', series_id: '2010' },
    { id: '202', name: '同名', series_id: '2020' },
  ]);
  assert.strictEqual(explicitSeries.items.length, 2);
  assert.strictEqual(localHistoryHref({ aid: '123', photoId: '456' }), '#/album/123');
  assert.strictEqual(localHistoryHref({ aid: '', AID: 456 }), '#/album/456');
  assert.strictEqual(localHistoryHref({ aid: 'not-a-number', photoId: '456' }), '');

  console.log('user list pagination all pass');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
