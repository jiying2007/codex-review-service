'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
test('source Release retains strict immutable publisher and emits run-bound decision',()=>{
  const release=fs.readFileSync(path.join(root,'.github/workflows/release.yml'),'utf8');
  assert.match(release,/Record exact source release decision/);
  assert.match(release,/node scripts\/release-integrity-admission\.js write/);
  assert.match(release,/release-intent-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(release,/steps\.version\.outputs\.publish/);
  for(const phrase of ['Release test / Node','Publish immutable GitHub Release','Attest immutable release files','Block all Critical and fixable High findings on both platforms'])
    assert.ok(release.includes(phrase));
  assert.doesNotMatch(release,/--clobber/);
});
test('downstream integrity is conditional on exact publisher job evidence, never disabled for a real release',()=>{
  const workflow=fs.readFileSync(path.join(root,'.github/workflows/release-integrity.yml'),'utf8');
  assert.match(workflow,/actions: read/);
  assert.match(workflow,/node scripts\/release-integrity-admission\.js verify/);
  assert.match(workflow,/submodules: recursive/);
  assert.match(workflow,/needs\.admission\.outputs\.published == 'true'/);
  assert.match(workflow,/expected_sha: \$\{\{ needs\.admission\.outputs\.release_sha \}\}/);
  assert.match(workflow,/needs: \[admission, integrity\]/);
  assert.match(workflow,/INTEGRITY!=='success'/);
  assert.match(workflow,/INTEGRITY!=='skipped'/);
  assert.match(workflow,/consumer-release-integrity\.yml@/);
});
