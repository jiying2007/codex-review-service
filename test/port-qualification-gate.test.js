'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const workflow=fs.readFileSync(path.join(__dirname,'../.github/workflows/ci.yml'),'utf8');
const gate="if: ${{ github.event_name != 'pull_request' || startsWith(github.head_ref, 'port/') }}";
function job(name){
  const start=workflow.indexOf('\n  '+name+':\n');
  assert.ok(start>=0,'missing '+name);
  const next=workflow.slice(start+1).match(/\n  [a-z0-9-]+:\n/);
  return workflow.slice(start,next?start+1+next.index:undefined);
}
test('port PRs run Node22, migration, crash and real GitLab qualification',()=>{
  for(const name of ['compatibility-node22','migration-portability','fault-injection','gitlab-system'])
    assert.ok(job(name).includes(gate),'risk qualification absent from '+name);
});
test('ordinary PR stays lightweight; main security/family and immutable release gates remain',()=>{
  assert.match(job('security'),/if: github\.event_name != 'pull_request'/);
  assert.match(job('family-release-guard'),/if: github\.event_name != 'pull_request'/);
  assert.match(job('ci-gate'),/if: \$\{\{ always\(\) \}\}/);
  assert.match(job('ci-gate'),/value\.result==='success'/);
  assert.match(workflow,/npm run ci/);
});
