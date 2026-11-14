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
  assert.match(ci,/releaseOnly=new Set\(\['compatibility-node22','migration-portability','fault-injection','gitlab-system','family-release-guard'\]\)/);
  assert.match(ci,/process\.env\.EVENT_NAME==='pull_request'&&releaseOnly\.has\(name\)&&value\.result==='skipped'/);
});

test('main and Release keep the expensive production qualification',()=>{
  const ci=fs.readFileSync(path.join(root,'.github/workflows/ci.yml'),'utf8');
  const release=fs.readFileSync(path.join(root,'.github/workflows/release.yml'),'utf8');
  for(const name of ['compatibility-node22','migration-portability','security','fault-injection','gitlab-system','family-release-guard'])
    assert.match(ci,new RegExp(name));
  assert.match(release,/node: \[22\.22\.2, 24\.19\.0\]/);
  assert.match(release,/Build or recover canonical OCI image/);
  assert.match(release,/Block all Critical and fixable High findings on both platforms/);
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

test('dashboard capability affects upload while local CodeQL analysis remains mandatory',()=>{
  const security=fs.readFileSync(path.join(root,'.github/workflows/security.yml'),'utf8');
  assert.match(security,/code-scanning\/alerts\?per_page=1/);
  assert.doesNotMatch(security,/needs: code-scanning-capability/);
  assert.match(security,/upload: never/);
  assert.match(security,/steps\.detect\.outputs\.enabled == 'true'/);
  assert.match(security,/Local CodeQL analysis, the SARIF findings gate, and the SARIF artifact remain required/);
  assert.ok(security.indexOf('scripts/codeql-findings-gate.js')<security.indexOf('- id: detect'));
  const scorecard=fs.readFileSync(path.join(root,'.github/workflows/scorecard.yml'),'utf8');
  assert.match(scorecard,/private-repository-note:/);
  assert.match(scorecard,/github\.event\.repository\.private == true/);
  assert.match(scorecard,/github\.event\.repository\.private == false/);
});

test('real immutable publisher waits for successful main CI Gate at exact source SHA',()=>{
  const release=fs.readFileSync(path.join(root,'.github/workflows/release.yml'),'utf8');
  assert.match(release,/Require genuine same-SHA main CI Gate before immutable publication/);
  assert.match(release,/run: node scripts\/verify-publisher-main-ci\.js/);
  assert.match(release,/RELEASE_SHA: \$\{\{ needs\.prepare\.outputs\.release_sha \}\}/);
  assert.match(release,/actions: read/);
  assert.match(release,/Publish immutable GitHub Release/);
  const source=fs.readFileSync(path.join(root,'scripts/verify-publisher-main-ci.js'),'utf8');
  assert.match(source,/head_branch==='main'/);
  assert.match(source,/name==='CI Gate'/);
  assert.match(source,/source:'main-CI'/);
});
