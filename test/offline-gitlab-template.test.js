'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const source=fs.readFileSync('ci/gitlab-free-offline.template.yml','utf8');

test('optional GitLab Free template remains a protected-controller-only unsigned development CI lane',()=>{
  assert.match(source,/INSTALL IN A SEPARATE, ADMIN-PROTECTED GITLAB CONTROL PROJECT/);
  assert.match(source,/DO NOT load this CI definition from an untrusted source PR/);
  assert.match(source,/tags: \[isolated-ephemeral\]/);
  assert.match(source,/GIT_SUBMODULE_STRATEGY: recursive/);
  assert.match(source,/TRUSTED_COLLECTOR:\?/);
  assert.match(source,/CI_COMMIT_SHA.*git rev-parse HEAD/);
  assert.match(source,/node "\$TRUSTED_COLLECTOR"/);
  assert.match(source,/--suites syntax,offline-unit,migration/);
  assert.match(source,/ci\.unsigned\.json/);
  assert.match(source,/when: always/);
  assert.doesNotMatch(source,/--type\s+review|--type\s+ci|gh release|codex exec|codex login/);
  assert.doesNotMatch(source,/^\s+trigger:\s+main/m);
});
test('GitLab Free development uses two required, digest-supplied Node images without secrets',()=>{
  for(const [job,major,image] of [
    ['node22-dev','22','NODE22_VERIFIED_IMAGE_DIGEST'],
    ['node24-dev','24','NODE24_VERIFIED_IMAGE_DIGEST']
  ]){
    const index=source.indexOf(job+':');
    assert.ok(index>0,job+' job missing');
    const block=source.slice(index,index+190);
    assert.match(block,/extends: \.offline-dev/);
    assert.ok(block.includes('image: "$'+image+'"'));
    assert.ok(block.includes('REQUIRED_NODE_MAJOR: "'+major+'"'));
  }
  assert.match(source,/git remote set-url origin \/dev\/null/);
  assert.match(source,/git config --local credential\.helper/);
  assert.match(source,/unset CI_JOB_TOKEN CI_REPOSITORY_URL/);
  assert.doesNotMatch(source,/PRIVATE-TOKEN:|OPENAI_API_KEY:|GITLAB_API_TOKEN:/);
});
