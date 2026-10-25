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
test('existing real GitLab matrix verifies status readback and preserves the classic fallback',()=>{
  const workflow=fs.readFileSync(path.join(__dirname,'..','.github','workflows','gitlab-system.yml'),'utf8');
  const smoke=fs.readFileSync(path.join(__dirname,'..','scripts','gitlab-system-smoke.js'),'utf8');
  for(const version of ['14.6.1-ce.0','17.11.7-ce.0','19.3.0-ce.0'])assert.ok(workflow.includes(version));
  assert.match(workflow,/node scripts\/gitlab-system-smoke\.js/);
  assert.match(smoke,/client\.readCommitStatus\(statusPayload/);
  assert.match(smoke,/statusReadback\.remoteIdMatches,true/);
  assert.match(smoke,/pipeline_identity_unavailable/);
  assert.match(smoke,/old GitLab must retain normal commit-status writes/);
});
