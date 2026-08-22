'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run, hasChangelogVersion } = require('../scripts/release');

test('release run helper accepts inherited stdio without null.trim failure', () => {
  assert.equal(run(process.execPath, ['-e', ''], { stdio: 'inherit' }), '');
});

test('release changelog verifier accepts dated and undated SemVer headings', () => {
  assert.equal(hasChangelogVersion('# Changelog\n\n## 3.0.0 - 2026-08-22\n', '3.0.0'), true);
  assert.equal(hasChangelogVersion('# Changelog\n\n## 3.0.0\n', '3.0.0'), true);
  assert.equal(hasChangelogVersion('# Changelog\n\n## 2.0.0 - 2026-08-22\n', '3.0.0'), false);
});
