'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');

test('GitLab readiness tolerates transient Omnibus status failures within its bounded retry loop',()=>{
  const workflow=fs.readFileSync(path.join(__dirname,'..','.github','workflows','gitlab-system.yml'),'utf8');
  assert.match(workflow,/status="\$\(docker exec gitlab gitlab-ctl status 2>\/dev\/null \|\| true\)"/);
  assert.match(workflow,/for i in \$\(seq 1 20\)/);
  assert.match(workflow,/GitLab Omnibus services did not converge/);
});
