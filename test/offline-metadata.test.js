'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

(async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'offline.js'), 'utf8');
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const { buildRestoreRequests } = await import(moduleUrl);

  const requests = buildRestoreRequests([
    { aid: '10', request: { chapterIds: ['101'] } },
    { aid: '10', request: { chapterIds: ['102', '101'] } },
    { aid: '20', request: { chapterIds: null } },
    { aid: '21', request: { chapterIds: 'not-an-array' } },
    { aid: 'bad', request: { chapterIds: null } },
  ], [
    { aid: '10', name: '选章' },
    { aid: '20', name: '整本' },
    { aid: '30', name: '只剩目录' },
  ], [
    { aid: '10', photoId: '102' },
    { aid: '30', photoId: '301' },
    { aid: '30', photoId: '302' },
    { aid: '30', photoId: 'invalid' },
  ]);

  assert.deepStrictEqual(requests, [
    { aid: '10', name: '选章', chapterIds: ['101', '102'] },
    { aid: '20', name: '整本', chapterIds: null },
    { aid: '30', name: '只剩目录', chapterIds: ['301', '302'] },
  ]);

  const fullWins = buildRestoreRequests([
    { aid: 40, request: { chapterIds: ['401'] } },
    { aid: 40, request: { chapterIds: null } },
    { aid: 40, request: { chapterIds: ['402'] } },
    { aid: 50, request: {} },
  ], [], []);
  assert.deepStrictEqual(fullWins, [{ aid: '40', name: '', chapterIds: null }]);

  console.log('offline metadata restore intent all pass');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
