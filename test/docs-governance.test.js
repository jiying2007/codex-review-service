'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const docs=['README.md','README.zh-CN.md','OPERATIONS.md','SECURITY.md','LONG_TERM_ASSET.md','docs/ARCHITECTURE.md','docs/DEPLOYMENT.md','docs/DEPLOYMENT.zh-CN.md','docs/NOTIFICATIONS.md','docs/NOTIFICATIONS.zh-CN.md','docs/GITLAB_SETUP.md','docs/GITLAB_SETUP.zh-CN.md','deploy/docker/README.md','SUPPORT.md'];

function read(name){return fs.readFileSync(path.join(root,name),'utf8');}

test('permanent product documentation exists',()=>{
  for(const name of docs) assert.ok(fs.existsSync(path.join(root,name)),`missing product document: ${name}`);
});

test('current documentation stays on Family v4 semantics',()=>{
  for(const name of docs){
    const text=read(name);
    assert.doesNotMatch(text,/Codex Review Service v3\.0|Codex Review Service 3\.0|\bv3\.0 is the server-side|\bv3\.0 是 Codex Safe/,`${name} must not describe the current service as v3`);
    assert.doesNotMatch(text,/codex-safe-core 3\.0\.1/,`${name} must not describe the current Core as 3.0.1`);
    assert.doesNotMatch(text,/Review Evidence \/ Rules \/ Receipt v3|Receipt v3 is the cross-product|Receipt v3 只是跨产品/,`${name} must not describe the current receipt as v3`);
  }
});

test('README is a deployable product entry',()=>{
  const en=read('README.md'),zh=read('README.zh-CN.md');
  assert.match(en,/5[- ]minute[\s\S]{0,40}deploy/i);
  assert.match(zh,/5 分钟[^\n]{0,40}部署/);
  for(const text of [en,zh]){
    assert.match(text,/\/etc\/codex-review\/config\.json/);
    assert.match(text,/\/webhooks\/gitlab/);
    assert.match(text,/doctor/i);
    assert.match(text,/health\/ready/);
    assert.match(text,/Docker|Compose/i);
    assert.match(text,/notification|通知/i);
  }
});

test('deployment guides cover full rollout and lifecycle',()=>{
  for(const name of ['docs/DEPLOYMENT.md','docs/DEPLOYMENT.zh-CN.md']){
    const text=read(name);
    assert.match(text,/GITLAB_API_TOKEN/);
    assert.match(text,/GITLAB_WEBHOOK_SIGNING_TOKEN/);
    assert.match(text,/Merge request events/i);
    assert.match(text,/Note events/i);
    assert.match(text,/\/webhooks\/gitlab/);
    assert.match(text,/doctor/i);
    assert.match(text,/health\/ready/);
    assert.match(text,/inline/i);
    assert.match(text,/isolated/i);
    assert.match(text,/upgrade|升级/i);
    assert.match(text,/rollback|回滚/i);
    assert.match(text,/projects|Project/);
    assert.match(text,/groups|Group/);
  }
});

test('notification docs preserve attention-only durable boundary',()=>{
  for(const name of ['docs/NOTIFICATIONS.md','docs/NOTIFICATIONS.zh-CN.md']){
    const text=read(name);
    assert.match(text,/notification_outbox/);
    assert.match(text,/Feishu|飞书/i);
    assert.match(text,/WeCom|企业微信/i);
    assert.match(text,/review\.blocked/);
    assert.match(text,/review\.failed/);
    assert.match(text,/service\.degraded/);
    assert.match(text,/retry|重试/i);
    assert.match(text,/idempot|幂等/i);
    assert.match(text,/never changes? a review verdict|不会改变 Review Verdict|绝不改变 Review Verdict/i);
  }
});

test('GitLab setup documents end-to-end acceptance',()=>{
  for(const name of ['docs/GITLAB_SETUP.md','docs/GITLAB_SETUP.zh-CN.md']){
    const text=read(name);
    assert.match(text,/GITLAB_WEBHOOK_SIGNING_TOKEN/);
    assert.match(text,/\/webhooks\/gitlab/);
    assert.match(text,/Merge request events/i);
    assert.match(text,/Note events/i);
    assert.match(text,/health\/ready/);
    assert.match(text,/Feishu|飞书|WeCom|企业微信/i);
  }
});

test('current documentation preserves rootless and explicit-system path boundary',()=>{
  const deployment=read('docs/DEPLOYMENT.md');
  const deploymentZh=read('docs/DEPLOYMENT.zh-CN.md');
  const operations=read('OPERATIONS.md');
  const security=read('SECURITY.md');
  const longTerm=read('LONG_TERM_ASSET.md');
  const architecture=read('docs/ARCHITECTURE.md');

  for(const text of [deployment,deploymentZh,operations,security,architecture]) assert.match(text,/\/etc\/codex-review\/config\.json/, 'production docs must document explicit system config path');
  for(const text of [operations,security,architecture]) assert.match(text,/XDG_CONFIG_HOME/, 'runtime-boundary docs must preserve concrete XDG config semantics');
  assert.match(longTerm,/XDG config\/state defaults/, 'long-term invariants must preserve rootless XDG semantic boundary');
  assert.match(longTerm,/\/etc\/codex-review\/config\.json/, 'long-term invariants must preserve explicit system config path');
  assert.match(longTerm,/Runtime does not infer root\/sudo\/systemd mode/);
  assert.match(architecture,/Runtime does not infer root, sudo, or systemd/);
});

test('systemd units explicitly pin system configuration path',()=>{
  for(const name of ['deploy/systemd/codex-review-service.service','deploy/systemd/codex-review-runner.service']){
    const text=read(name);
    assert.match(text,/^Environment=CODEX_REVIEW_CONFIG_FILE=\/etc\/codex-review\/config\.json$/m,`${name} must explicitly pin system config path`);
  }
});
