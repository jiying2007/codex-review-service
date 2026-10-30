'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const source=fs.readFileSync('ci/gitlab-free-offline.template.yml','utf8');

test('optional GitLab Free template remains a protected-controller-only unsigned development CI lane',()=>{
  assert.match(source,/INSTALL IN A SEPARATE, ADMIN-PROTECTED GITLAB CONTROL PROJECT/);
  assert.match(source,/DO NOT load this CI definition from an untrusted source PR/);
  assert.match(source,/tags: \[isolated-ephemeral\]/);
  assert.match(source,/GIT_STRATEGY: none/);
  assert.match(source,/when: manual/);
  assert.match(source,/TRUSTED_COLLECTOR:\?/);
  assert.match(source,/REVIEWED_SHA.*git -C/);
  assert.match(source,/VERIFIED_SOURCE_CHECKOUT:\?/);
  assert.match(source,/node "\$TRUSTED_COLLECTOR"/);
  assert.match(source,/--suites "\$SELECTED_OFFLINE_SUITES"/);
  assert.match(source,/SELECTED_OFFLINE_SUITES: "syntax,offline-unit,migration"/);
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
  assert.match(source,/remote get-url origin/);
  assert.match(source,/test -z "\$origin" \|\| test "\$origin" = \/dev\/null/);
  assert.match(source,/unset CI_JOB_TOKEN CI_REPOSITORY_URL/);
  assert.doesNotMatch(source,/PRIVATE-TOKEN:|OPENAI_API_KEY:|GITLAB_API_TOKEN:/);
});

test('manual multi-GitLab development requires the real multi-offline suite',()=>{
  const at=source.indexOf('multi-gitlab-dev:');
  assert.ok(at>0);
  const block=source.slice(at);
  assert.match(block,/extends: \.offline-dev/);
  assert.match(block,/REQUIRED_NODE_MAJOR: "24"/);
  assert.match(block,/SELECTED_OFFLINE_SUITES: "syntax,offline-unit,migration,multi-offline"/);
  assert.doesNotMatch(block,/CODEX_API_KEY|codex exec|release/);
});

test('manual OSS SAST validates with pinned Semgrep CE and local rules without cloud access',()=>{
  const at=source.indexOf('\noss-sast-dev:');
  assert.ok(at>0,'Community Edition development SAST job missing');
  const job=source.slice(at);
  assert.match(job,/tags: \[isolated-ephemeral\]/);
  assert.match(job,/when: manual/);
  assert.match(job,/SEMGREP_CE_VERIFIED_IMAGE_DIGEST/);
  assert.match(job,/GIT_STRATEGY: none/);
  assert.match(job,/TRUSTED_SEMGREP_RULES:\?/);
  assert.match(job,/REVIEWED_SHA:\?/);
  assert.match(job,/VERIFIED_SOURCE_CHECKOUT:\?/);
  assert.match(job,/semgrep scan --metrics=off --config "\$TRUSTED_SEMGREP_RULES" --error/);
  assert.match(job,/oss-sast-report\.json/);
  assert.doesNotMatch(job,/--config[= ]auto|codeql|semgrep login|semgrep ci|codex exec|gh release/);
});
