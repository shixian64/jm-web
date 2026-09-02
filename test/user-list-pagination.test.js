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

  console.log('user list pagination all pass');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
