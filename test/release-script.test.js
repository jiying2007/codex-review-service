'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run, hasChangelogVersion, changelogVersions, compareVersionDesc } = require('../scripts/release');
const {normalizeChangelog}=require('../scripts/normalize-changelog');

test('release run helper accepts inherited stdio without null.trim failure', () => {
  assert.equal(run(process.execPath, ['-e', ''], { stdio: 'inherit' }), '');
});
test('changelog normalization produces one descending canonical release sequence',()=>{const value=normalizeChangelog('## 1.0.0\n\n- old\n\n# Changelog\n\n## 2.0.0\n\n- new\n');assert.equal(value,'# Changelog\n\n## 2.0.0\n\n- new\n\n## 1.0.0\n\n- old\n');assert.deepEqual(changelogVersions(value),['2.0.0','1.0.0']);assert.deepEqual(['1.0.0','2.0.0'].sort(compareVersionDesc),['2.0.0','1.0.0']);assert.throws(()=>normalizeChangelog('## 1.0.0\n\n## 1.0.0\n'),/duplicate/);});

test('release changelog verifier accepts dated and undated SemVer headings', () => {
  assert.equal(hasChangelogVersion('# Changelog\n\n## 3.0.0 - 2026-08-22\n', '3.0.0'), true);
  assert.equal(hasChangelogVersion('# Changelog\n\n## 3.0.0\n', '3.0.0'), true);
  assert.equal(hasChangelogVersion('# Changelog\n\n## 2.0.0 - 2026-08-22\n', '3.0.0'), false);
});
