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
  assert.match(ci,/process\.env\.EVENT_NAME==='pull_request'&&releaseOnly\.has\(name\)&&value\.result==='skipped'/);
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

test('private CodeQL has the minimal workflow metadata permission it requires',()=>{
  const security=fs.readFileSync(path.join(root,'.github/workflows/security.yml'),'utf8');
  const codeql=security.slice(security.indexOf('  codeql:'));
  assert.match(codeql,/permissions:\n\s+actions: read\n\s+contents: read\n\s+security-events: write/);
  assert.doesNotMatch(codeql,/actions: write/);
  const ci=fs.readFileSync(path.join(root,'.github/workflows/ci.yml'),'utf8');
  const caller=ci.slice(ci.indexOf('  security:'),ci.indexOf('  fault-injection:'));
  assert.match(caller,/permissions:\n\s+actions: read\n\s+contents: read\n\s+security-events: write/);
  assert.doesNotMatch(caller,/actions: write/);
});

test('private-only platform features degrade to explicit non-red capability states',()=>{
  const security=fs.readFileSync(path.join(root,'.github/workflows/security.yml'),'utf8');
  assert.match(security,/code-scanning-capability:/);
  assert.match(security,/code-scanning\/alerts\?per_page=1/);
  assert.match(security,/if: needs\.code-scanning-capability\.outputs\.enabled == 'true'/);
  assert.match(security,/Code Scanning is unavailable for this private repository/);
  const scorecard=fs.readFileSync(path.join(root,'.github/workflows/scorecard.yml'),'utf8');
  assert.match(scorecard,/private-repository-note:/);
  assert.match(scorecard,/github\.event\.repository\.private == true/);
  assert.match(scorecard,/github\.event\.repository\.private == false/);
});

test('release integrity distinguishes immutable publication from a no-version main push',()=>{
  const integrity=fs.readFileSync(path.join(root,'.github/workflows/release-integrity.yml'),'utf8');
  assert.match(integrity,/Distinguish a new product release from a no-version main change/);
  assert.match(integrity,/previous_version/);
  assert.match(integrity,/verify=false/);
  assert.match(integrity,/needs\.detect\.outputs\.verify == 'true'/);
  assert.match(integrity,/consumer-release-integrity\.yml/);
});
