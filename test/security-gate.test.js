'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

test('the configured security command consumes real SARIF and blocks findings or missing analysis', t => {
  const security = fs.readFileSync(path.join(root, '.github/workflows/security.yml'), 'utf8');
  const configured = security.match(/run: node (src\/codex-safe-core\/scripts\/codeql-findings-gate\.js) (codeql-results)/);
  assert.ok(configured, 'Security must execute the shared findings gate against the analyzer output directory');
  assert.match(security, /output: codeql-results/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'service-security-gate-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, configured[2]);
  fs.mkdirSync(output);
  const run = () => spawnSync(process.execPath, [path.join(root, configured[1]), output], { encoding: 'utf8' });
  assert.notEqual(run().status, 0, 'Missing SARIF must not become a successful scan');
  const report = { version: '2.1.0', runs: [{ tool: { driver: { name: 'CodeQL', rules: [{ id: 'js/service-test', properties: { 'security-severity': '8.1' } }] } }, invocations: [{ executionSuccessful: true }], results: [] }] };
  const save = () => fs.writeFileSync(path.join(output, 'javascript.sarif'), JSON.stringify(report));
  save();
  assert.equal(run().status, 0);
  report.runs[0].results.push({ ruleId: 'js/service-test', ruleIndex: 0, level: 'warning', message: { text: 'Test high finding' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/service.js' }, region: { startLine: 1 } } }] });
  save();
  assert.notEqual(run().status, 0, 'A successful analysis with a high finding must block');
});

test('the actual CI Gate cannot accept a skipped or failed security workflow on a pull request', () => {
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const security = ci.match(/^  security:\n([\s\S]*?)(?=^  \S|$(?![\s\S]))/m)?.[1];
  assert.ok(security);
  assert.doesNotMatch(security, /^    if:/m, 'All pull requests must run the Security workflow');
  const gate = ci.slice(ci.indexOf('  ci-gate:'));
  const script = gate.match(/node - <<'NODE'\n([\s\S]*?)\n\s*NODE/)?.[1];
  assert.ok(script);
  const needs = { development: { result: 'success' }, security: { result: 'success' }, 'family-release-guard': { result: 'skipped' } };
  const run = () => spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { NEEDS_JSON: JSON.stringify(needs), EVENT_NAME: 'pull_request' } });
  assert.equal(run().status, 0);
  for (const result of ['skipped', 'failure', 'cancelled']) {
    needs.security.result = result;
    assert.notEqual(run().status, 0, `Security ${result} must block CI Gate`);
  }
});

test('all CodeQL action components in the Security workflow share one exact version and commit pin',()=>{
  const security=fs.readFileSync(path.join(root,'.github/workflows/security.yml'),'utf8');
  const uses=[...security.matchAll(/^\s*(?:-\s*)?uses:\s+github\/codeql-action\/(?:init|analyze|upload-sarif)@([0-9a-f]{40})\s+#\s+(v\d+\.\d+\.\d+)\s*$/gm)];
  assert.equal(uses.length,3,'Security must pin init, analyze and upload-sarif exactly once');
  assert.equal(new Set(uses.map(match=>match[1])).size,1,'all CodeQL action steps in the same job must use one exact commit');
  assert.equal(new Set(uses.map(match=>match[2])).size,1,'all CodeQL action steps must use one release version');
});
