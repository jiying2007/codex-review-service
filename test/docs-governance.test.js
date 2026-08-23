'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const docs=['README.md','README.zh-CN.md','OPERATIONS.md','SECURITY.md','LONG_TERM_ASSET.md','docs/ARCHITECTURE.md'];

function read(name){return fs.readFileSync(path.join(root,name),'utf8');}

test('current documentation stays on Family v4 semantics',()=>{
  for(const name of docs){
    const text=read(name);
    assert.doesNotMatch(text,/Codex Review Service v3\.0|Codex Review Service 3\.0|\bv3\.0 is the server-side|\bv3\.0 是 Codex Safe/,`${name} must not describe the current service as v3`);
    assert.doesNotMatch(text,/codex-safe-core 3\.0\.1/,`${name} must not describe the current Core as 3.0.1`);
    assert.doesNotMatch(text,/Review Evidence \/ Rules \/ Receipt v3|Receipt v3 is the cross-product|Receipt v3 只是跨产品/,`${name} must not describe the current receipt as v3`);
  }
});

test('current documentation preserves rootless and explicit-system path boundary',()=>{
  const readme=read('README.md');
  const readmeZh=read('README.zh-CN.md');
  const operations=read('OPERATIONS.md');
  const security=read('SECURITY.md');
  const longTerm=read('LONG_TERM_ASSET.md');
  const architecture=read('docs/ARCHITECTURE.md');
  for(const text of [readme,readmeZh,operations,security,longTerm,architecture]){
    assert.match(text,/XDG_CONFIG_HOME/, 'current deployment docs must document XDG config defaults');
    assert.match(text,/\/etc\/codex-review\/config\.json/, 'current deployment docs must document explicit system config path');
  }
  assert.match(readme,/Runtime (?:code )?does not (?:detect|infer) root, sudo, or systemd/);
  assert.match(longTerm,/Runtime does not infer root\/sudo\/systemd mode/);
  assert.match(architecture,/Runtime does not infer root, sudo, or systemd/);
});

test('systemd units explicitly pin system configuration path',()=>{
  for(const name of ['deploy/systemd/codex-review-service.service','deploy/systemd/codex-review-runner.service']){
    const text=read(name);
    assert.match(text,/^Environment=CODEX_REVIEW_CONFIG_FILE=\/etc\/codex-review\/config\.json$/m,`${name} must explicitly pin system config path`);
  }
});
