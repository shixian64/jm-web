'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const files = [path.join(root, 'server.js')];
for (const dir of ['lib', path.join('public', 'js')]) {
  const absolute = path.join(root, dir);
  for (const name of fs.readdirSync(absolute).sort()) {
    if (name.endsWith('.js')) files.push(path.join(absolute, name));
  }
}

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

const css = fs.readFileSync(path.join(root, 'public', 'css', 'app.css'), 'utf8');
const opens = (css.match(/\{/g) || []).length;
const closes = (css.match(/\}/g) || []).length;
if (opens !== closes) {
  console.error(`app.css 花括号不匹配：${opens} / ${closes}`);
  process.exit(1);
}

console.log(`syntax/style check all pass (${files.length} JS, CSS ${opens}/${closes})`);
