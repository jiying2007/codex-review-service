'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const contract=require('../product-contract.json');
const runbook=fs.readFileSync('docs/MULTI_GITLAB.zh-CN.md','utf8');
test('multi-GitLab operations use current immutable Service and Schema identity',()=>{
  assert.equal(contract.serviceVersion,require('../package.json').version);
  assert.equal(contract.databaseSchemaVersion,require('../src/db').SCHEMA_VERSION);
  assert.ok(runbook.includes('v'+contract.serviceVersion));
  assert.ok(runbook.includes('Schema '+contract.databaseSchemaVersion));
  assert.ok(runbook.includes('9 → 10 → 11'));
  assert.match(runbook,/refs\/|digest|IMAGE_DIGEST|sha256/i);
  assert.match(runbook,/未.*生产|不宣称.*生产|不能证明内网/);
  assert.doesNotMatch(runbook,/7\.6\.1 → 7\.6\.2|正式 7\.6\.2 镜像|PR #132 的Schema11 新基线与本 PR 是堆叠关系/);
});
test('operator instructions distinguish read-only cutover from mutating admin DB opener',()=>{
  const admin=fs.readFileSync('src/admin-cli.js','utf8');
  const preflight=fs.readFileSync('src/multi-gitlab-cutover-check.js','utf8');
  assert.match(admin,/const store=admin\.openStore\(\)/);
  assert.ok(admin.indexOf("if(command==='db-check')")<admin.indexOf('const store=admin.openStore()'),'db-check must run before Store');
  assert.match(preflight,/new DatabaseSync\(file,\{readOnly:true\}\)/);
  assert.match(runbook,/旧 v7\.6\.3 和更早版本.*可能打开 Store 并迁移数据库/);
  assert.match(runbook,/v7\.6\.4 起.*只读校验数据库/);
  assert.match(runbook,/multi-gitlab-cutover-check\.js/);
  assert.match(runbook,/停止原 Writer/);
  assert.match(runbook,/9 → 10 → 11/);
});
test('non-model advisory rollout does not impersonate merge authority or production signoff',()=>{
  assert.match(runbook,/mergeAuthorized:false/);
  assert.match(runbook,/refTransactionBound:false/);
  assert.match(runbook,/没有任何自动 Merge\/Approve 权限/);
  assert.match(runbook,/不要求虚构第二人批准/);
  assert.match(runbook,/禁令明确解除/);
  assert.match(runbook,/CodeQL\/构建级签名能力须明确记录为不适用/);
});
