'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

(async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'navigation.js'), 'utf8');
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const replaced = [];
  global.location = { hash: '#/week?id=old' };
  global.history = {
    state: { retained: 'yes', __jmw_route_entry: { id: 42, key: '#/week?id=old' } },
    replaceState(next, _title, url) {
      this.state = next;
      replaced.push(url);
      if (url) global.location.hash = url;
    },
  };

  const { NAV_STATE_KEY, hashRouteKey, replaceCurrentRouteHash, replaceRouteHash,
    rememberRouteEntry, clearRouteTrail, favoritesReturnTarget, returnToFavorites } = await import(moduleUrl);
  assert.strictEqual(hashRouteKey('/search?q=test'), '#/search?q=test');
  assert.strictEqual(hashRouteKey(), '#/week?id=old');

  replaceCurrentRouteHash('#/week?id=new&type=1');
  assert.strictEqual(history.state.retained, 'yes');
  assert.deepStrictEqual(history.state[NAV_STATE_KEY], { id: 42, key: '#/week?id=new&type=1' });
  assert.strictEqual(replaced.at(-1), '#/week?id=new&type=1');

  history.state = { retained: 'still' };
  replaceCurrentRouteHash('/category?id=2');
  assert.strictEqual(history.state.retained, 'still');
  assert(Number.isSafeInteger(history.state[NAV_STATE_KEY].id));
  assert.strictEqual(history.state[NAV_STATE_KEY].key, '#/category?id=2');
  assert.strictEqual(replaced.at(-1), '#/category?id=2');

  const traversals = [];
  history.go = (delta) => traversals.push(delta);
  global.window = new EventTarget();
  let renders = 0;
  window.addEventListener('hashchange', () => renders++);
  function visit(id, key) {
    location.hash = key;
    history.state = { [NAV_STATE_KEY]: { id, key } };
    rememberRouteEntry({ id, key });
  }
  clearRouteTrail();
  visit(1, '#/favorites?o=mp&folder=1');
  visit(2, '#/album/7');
  assert.deepStrictEqual(favoritesReturnTarget(), { id: 1, key: '#/favorites?o=mp&folder=1', delta: -1 });
  visit(3, '#/read/71?aid=7');
  assert.equal(favoritesReturnTarget().delta, -2);
  replaceRouteHash('#/read/72?aid=7&page=0');
  assert.equal(history.state[NAV_STATE_KEY].id, 3, '切章不新增 entry ID');
  assert.equal(renders, 1, 'replaceState 本身不发事件，辅助函数必须主动刷新一次');
  assert.equal(favoritesReturnTarget().delta, -2, '连续切章不得增加返回步数');
  assert.equal(returnToFavorites(), true);
  assert.deepStrictEqual(traversals, [-2]);
  visit(1, '#/favorites?o=mp&folder=1');
  replaceCurrentRouteHash('#/favorites?o=mr&folder=2');
  visit(4, '#/album/8');
  assert.deepStrictEqual(favoritesReturnTarget(), { id: 1, key: '#/favorites?o=mr&folder=2', delta: -1 },
    '返回后重新打开作品必须截断旧前进分支并采用最新 query');
  visit(5, '#/user');
  visit(6, '#/album/9');
  assert.equal(favoritesReturnTarget(), null, '从其他入口进入不能借用旧收藏来源');
  assert.equal(returnToFavorites(), false);
  clearRouteTrail();
  visit(10, '#/read/99?aid=9');
  assert.equal(favoritesReturnTarget(), null, '新标签页/刷新/深链接不得猜测返回距离');
  clearRouteTrail();
  visit(20, '#/favorites?o=mp&folder=0');
  visit(21, '#/album/10');
  clearRouteTrail();
  assert.equal(favoritesReturnTarget(), null, '认证切换后旧来源必须被移除');
  visit(30, '#/favorites');
  visit(31, '#/offline/10/101');
  assert.equal(favoritesReturnTarget(), null, '离线阅读退出仍使用下载中心');
  clearRouteTrail();
  visit(100, '#/favorites');
  for (let id = 101; id < 221; id++) visit(id, '#/album/' + id);
  assert.equal(favoritesReturnTarget(), null, '超过有界 trail 时宁可无快捷返回，不猜测历史');
  clearRouteTrail();
  visit(230, '#/favorites');
  visit(231, '#/album/11');
  history.state[NAV_STATE_KEY].id = 999;
  assert.equal(favoritesReturnTarget(), null, 'marker 不匹配时禁止跨历史跳转');

  // 锁定实际调用接线，而不仅仅测试独立帮助函数。
  const app = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  const reader = fs.readFileSync(path.join(__dirname, '../public/js/reader.js'), 'utf8');
  assert.match(app, /rememberRouteEntry\(\{ id: targetEntryId, key: routeKey \}\)/);
  assert.match(app, /tab\('#\/favorites\?o=mp&folder=0', 'star', '收藏更新', '#\/favorites'\)/);
  assert.match(reader, /onclick: fromFavorites \? closeToFavorites : close/);
  assert.match(reader, /replaceRouteHash\(chapterHref/);
  assert(!reader.includes('location.replace('), '切章必须使用保留 marker 的替换路由');

  delete global.window;
  delete global.history;
  delete global.location;
  console.log('navigation state/favorites origin/chapter replacement all pass');
})().catch((error) => {
  delete global.history;
  delete global.location;
  console.error(error);
  process.exitCode = 1;
});
