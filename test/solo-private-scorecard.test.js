'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
test('private GitHub Scorecard is explicitly not attempted without suitable GraphQL access',()=>{
  const workflow=fs.readFileSync('.github/workflows/scorecard.yml','utf8');
  assert.match(workflow,/analysis:\s*\n(?:[^\n]*\n)*?\s+if: \$\{\{ github\.event\.repository\.private == false \}\}/);
  assert.match(workflow,/ossf\/scorecard-action@2d1146689b8cda280b9bc96326124645441f03bc/);
  assert.match(workflow,/publish_results: true/);
  assert.match(workflow,/branches: \[main\]/);
  assert.doesNotMatch(workflow,/continue-on-error:\s*true|[Ff]ake|[Ff]orged-SARIF/);
});
test('publisher security checks remain independent of Scorecard applicability',()=>{
  const ci=fs.readFileSync('.github/workflows/ci.yml','utf8');
  const release=fs.readFileSync('.github/workflows/release.yml','utf8');
  assert.match(ci,/security:/);
  assert.match(ci,/family-release-guard:/);
  assert.match(release,/Block unfixed Critical OCI vulnerabilities/);
  assert.match(release,/Attest immutable release files/);
});
