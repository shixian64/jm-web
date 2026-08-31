'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'content-filter.js'), 'utf8');
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const filter = await import(url);

  assert.deepEqual(filter.parseSearchSyntax('one-piece -spoiler +exact'), {
    includes: ['one-piece', 'exact'],
    excludes: ['spoiler'],
  });
  assert.equal(
    filter.searchContentWithoutExcludedTags('one-piece -spoiler +exact'),
    'one-piece +exact',
  );
  assert.equal(filter.buildSearchQuery('one-piece', ['spoiler']), 'one-piece -spoiler');
  assert.deepEqual(filter.parseSearchSyntax('mother-in-law'), {
    includes: ['mother-in-law'],
    excludes: [],
  });

  console.log('content-filter all pass');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
