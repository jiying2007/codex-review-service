'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const targets = [
  ['src', file => file.endsWith('.js')],
  ['src/codex-safe-core', file => file.endsWith('.js')],
  ['test', file => file.endsWith('.test.js')],
  ['scripts', file => file.endsWith('.js')]
];

const files = [];
for (const [relativeDir, include] of targets) {
  const dir = path.join(root, relativeDir);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !include(entry.name)) continue;
    files.push(path.join(relativeDir, entry.name));
  }
}
files.sort();

if (files.length === 0) throw new Error('syntax gate found no JavaScript files');
for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { cwd: root, stdio: 'inherit' });
}

console.log(`Syntax verified for ${files.length} JavaScript files.`);
