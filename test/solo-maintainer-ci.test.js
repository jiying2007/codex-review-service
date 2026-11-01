'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');

test('ordinary PR CI uses the canonical runtime and all pull-request bases',()=>{
  const ci=fs.readFileSync(path.join(root,'.github/workflows/ci.yml'),'utf8');
  assert.match(ci,/pull_request:\s*\n\s*workflow_dispatch:/);
  assert.match(ci,/Development \/ Node 24\.19\.0/);
  assert.match(ci,/node-version: '24\.19\.0'/);
  assert.match(ci,/releaseOnly=new Set\(\['compatibility-node22','migration-portability','security','fault-injection','gitlab-system','family-release-guard'\]\)/);
  assert.match(ci,/github\.event_name==='pull_request'&&releaseOnly\.has\(name\)&&value\.result==='skipped'/);
});

test('main and Release keep the expensive production qualification',()=>{
  const ci=fs.readFileSync(path.join(root,'.github/workflows/ci.yml'),'utf8');
  const release=fs.readFileSync(path.join(root,'.github/workflows/release.yml'),'utf8');
  for(const name of ['compatibility-node22','migration-portability','security','fault-injection','gitlab-system','family-release-guard'])
    assert.match(ci,new RegExp(name));
  assert.match(release,/node: \[22\.22\.2, 24\.19\.0\]/);
  assert.match(release,/Build or recover canonical OCI image/);
  assert.match(release,/Block unfixed Critical OCI vulnerabilities/);
  assert.match(release,/Attest immutable release files/);
  assert.match(release,/Publish immutable GitHub Release/);
});
