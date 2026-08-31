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

const cssFiles = fs.readdirSync(path.join(root, 'public', 'css'))
  .filter((name) => name.endsWith('.css')).sort();
let cssBlocks = 0;
for (const name of cssFiles) {
  const css = fs.readFileSync(path.join(root, 'public', 'css', name), 'utf8');
  const opens = (css.match(/\{/g) || []).length;
  const closes = (css.match(/\}/g) || []).length;
  if (opens !== closes) {
    console.error(`${name} 花括号不匹配：${opens} / ${closes}`);
    process.exit(1);
  }
  cssBlocks += opens;
}

console.log(`syntax/style check all pass (${files.length} JS, ${cssFiles.length} CSS / ${cssBlocks} blocks)`);
