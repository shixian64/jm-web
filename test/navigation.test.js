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

  const { NAV_STATE_KEY, hashRouteKey, replaceCurrentRouteHash } = await import(moduleUrl);
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

  delete global.history;
  delete global.location;
  console.log('navigation state helper all pass');
})().catch((error) => {
  delete global.history;
  delete global.location;
  console.error(error);
  process.exitCode = 1;
});
