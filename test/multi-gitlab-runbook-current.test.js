'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const contract=require('../product-contract.json');
const runbook=fs.readFileSync('docs/MULTI_GITLAB.zh-CN.md','utf8');
const sharded=fs.readFileSync('docs/MULTI_GITLAB_SHARDED.zh-CN.md','utf8');
test('current V8 operations state the real release/schema and strict named routing',()=>{
 assert.equal(contract.serviceVersion,require('../package.json').version);
 assert.equal(contract.databaseSchemaVersion,require('../src/db').SCHEMA_VERSION);
 assert.ok(runbook.includes('Service v'+contract.serviceVersion));
 assert.ok(runbook.includes('Schema '+contract.databaseSchemaVersion));
 for(const token of ['Manifest 使用 Schema 2','Catalog 使用 Schema 2',
   'POST /webhooks/gitlab/<instance-id>','返回 404','没有真实生产读写证据'])
  assert.ok(runbook.includes(token),token);
 assert.doesNotMatch(runbook,/默认实例自动路由|保留旧路径|旧的双文件命令仍可用/);
});
test('read-only preflight does not imply mutating database cutover or model use',()=>{
 const admin=fs.readFileSync('src/admin-cli.js','utf8');
 const checker=fs.readFileSync('src/multi-gitlab-cutover-check.js','utf8');
 assert.ok(admin.indexOf("if(command==='db-check')")<admin.indexOf('const store=admin.openStore()'));
 assert.match(checker,/new DatabaseSync\(file,\{readOnly:true\}\)/);
 for(const token of ['停止原 Writer','model_calls started/unknown',
   'notifications.enabled=false','共享 Codex/Work 额度禁令'])
  assert.ok(runbook.includes(token)||sharded.includes(token),token);
 assert.ok(sharded.includes('不启动模型'));
 assert.ok(sharded.includes('不能宣称生产'));
});
test('review and release governance remain independent of observability dashboards',()=>{
 for(const term of ['GitLab','保护规则','CodeQL','Release Integrity','没有真实生产读写证据'])
  assert.ok(runbook.includes(term),term);
 assert.ok(sharded.includes('唯一 Writer'));
 assert.ok(sharded.includes('没有 Legacy 回退')||runbook.includes('不保留旧版默认实例'));
});
