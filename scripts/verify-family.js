'use strict';

// Require local CodeQL SARIF findings and immutable CI evidence without private Code Scanning upload.
{
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '..');
  const helper = 'src/codex-safe-core/scripts/codeql-findings-gate.js';
  function job(text, name) {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const start = lines.indexOf('  ' + name + ':');
    assert.ok(start >= 0, 'missing required workflow job: ' + name);
    let end = start + 1;
    while (end < lines.length && !/^  [A-Za-z0-9_-]+:/.test(lines[end])) end++;
    return lines.slice(start, end).join('\n');
  }
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/security.yml'), 'utf8');
  const analysisJob = job(workflow, 'codeql');
  assert.ok(!analysisJob.includes('continue-on-error:'), 'CodeQL failures must remain fatal');
  const steps = analysisJob.split('\n      - ').slice(1).map(block => block.split('\n').map(line => line.trim()));
  function action(name) {
    const matches = steps.filter(lines => lines.some(line => line.startsWith('uses: ' + name + '@')));
    assert.equal(matches.length, 1, 'expected exactly one ' + name + ' step');
    return matches[0];
  }
  assert.ok(action('actions/checkout').includes('submodules: recursive'), 'canonical Core must be checked out');
  assert.ok(action('actions/setup-node').includes("node-version: '24.19.0'"), 'SARIF gate must use supported Node 24.19.0');
  const analyze = action('github/codeql-action/analyze');
  assert.ok(analyze.includes('output: codeql-results'), 'analyze must produce the gated report directory');
  assert.ok(analyze.includes('upload: never'), 'private repository must rely on locally gated real CodeQL SARIF rather than licensed upload');
  const findings = steps.filter(lines => lines.includes('run: node ' + helper + ' codeql-results'));
  assert.equal(findings.length, 1, 'the production Core SARIF gate must run exactly once');
  assert.ok(findings[0].includes('if: ${{ always() }}'), 'findings gate must run even when analyze/upload fails');
  assert.ok(steps.indexOf(findings[0]) > steps.indexOf(analyze), 'findings gate must inspect the actual analyze output');
  const evidence = action('actions/upload-artifact');
  assert.ok(evidence.includes('if: ${{ always() }}'), 'SARIF evidence must survive failures');
  assert.ok(evidence.includes('uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2'), 'SARIF artifact action must retain its audited exact pin');
  assert.ok(evidence.includes('name: codeql-sarif-${{ github.run_id }}-${{ github.run_attempt }}'), 'SARIF evidence must bind the run and attempt');
  assert.ok(evidence.includes('path: codeql-results/*.sarif'), 'preserve precisely the analyzed SARIF files');
  assert.ok(evidence.includes('if-no-files-found: error'), 'missing SARIF evidence must fail closed');
  assert.ok(steps.indexOf(evidence) > steps.indexOf(analyze), 'SARIF evidence must come from the current analysis');
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const caller = job(ci, 'security');
  assert.ok(caller.includes('uses: ./.github/workflows/security.yml'), 'CI must invoke the checked CodeQL workflow');
  assert.ok(!caller.includes('continue-on-error:'), 'CI must retain CodeQL failure propagation');
  for (const permission of ['actions: read', 'contents: read', 'security-events: write']) {
    assert.ok(analysisJob.includes(permission) && caller.includes(permission), 'CodeQL caller/callee permission missing: ' + permission);
  }
  const required = job(ci, 'ci-gate').split('\n').map(line => line.trim());
  const needs = required.find(line => line.startsWith('needs: [') && line.endsWith(']'));
  assert.ok(needs && needs.slice(8, -1).split(',').map(value => value.trim()).includes('security'),
    'required CI Gate must depend on the checked CodeQL workflow');
  assert.ok(required.includes('if: ${{ always() }}'), 'required CI Gate must still evaluate failed dependencies');
}


const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const core=require('../src/codex-safe-core');
const {SCHEMA_VERSION}=require('../src/db');
const contract=require('../product-contract.json');
const pkg=require('../package.json');
const root=path.resolve(__dirname,'..');

assert.equal(pkg.version,contract.serviceVersion);
assert.equal(pkg.engines.node,`>=${contract.minimumNodeVersion} <23 || >=${contract.canonicalNodeVersion} <25`);
assert.deepEqual(contract.supportedNodeMajors,[22,24]);
assert.equal(core.SAFE_CORE_VERSION,contract.safeCoreMajorVersion);
assert.equal(core.SAFE_CONTRACT_VERSION,contract.safeContractVersion);
assert.equal(core.POLICY_SCHEMA_VERSION,contract.policySchemaVersion);
assert.equal(core.REVIEW_RECEIPT_SCHEMA_VERSION,contract.reviewReceiptVersion);
assert.equal(core.FINDING_CLAIM_VERSION,contract.findingClaimVersion);
assert.equal(contract.codexRuntimeVersion,3);
assert.equal(contract.providerContractVersion,3);
assert.equal(typeof core.resolveCodexRuntime,'function');
assert.equal(typeof core.inspectCodexRuntime,'function');
assert.equal(SCHEMA_VERSION,contract.databaseSchemaVersion);
const staged=execFileSync('git',['ls-files','--stage','src/codex-safe-core'],{cwd:root,encoding:'utf8'}).trim();
assert.match(staged,new RegExp(`^160000 ${contract.safeCoreCommit} 0\\tsrc/codex-safe-core$`));

const requiredPackageFiles=[
  '.codex-safe.example.json','.env.example','CHANGELOG.md','LICENSE','LONG_TERM_ASSET.md','OPERATIONS.md','README.md','README.zh-CN.md','SUPPORT.md','SECURITY.md','VERIFY_RELEASE.md','config.example.json','product-contract.json',
  'deploy/systemd/config.example.json','deploy/systemd/*.service','deploy/systemd/*.env.example','deploy/docker/Dockerfile','deploy/docker/compose.yaml','deploy/docker/README.md','deploy/docker/config.example.json',
  'docs/ARCHITECTURE.md','docs/DEPLOYMENT.md','docs/DEPLOYMENT.zh-CN.md','docs/NOTIFICATIONS.md','docs/NOTIFICATIONS.zh-CN.md','docs/FLOW_TRACKING.md','docs/FLOW_TRACKING.zh-CN.md','docs/GITLAB_SETUP.md','docs/GITLAB_SETUP.zh-CN.md','docs/TOKEN_EFFICIENCY.md','docs/TOKEN_EFFICIENCY.zh-CN.md','docs/CODEX_PROVIDER.md','docs/CODEX_PROVIDER.zh-CN.md','docs/PRODUCT_CONTRACT.md','docs/QUALITY_PLATFORM.md','docs/QUALITY_PLATFORM.zh-CN.md','docs/STORAGE_AND_MIGRATIONS.md',
  'quality/*.json',
  'src/*.js','src/codex-safe-core/*.js','src/codex-safe-core/codex-safe.schema.json','src/codex-safe-core/quality/profile-packs.json','src/codex-safe-core/CHANGELOG.md','src/codex-safe-core/LICENSE','src/codex-safe-core/README.md','src/codex-safe-core/README.zh-CN.md','src/codex-safe-core/SECURITY.md','src/codex-safe-core/core-contract.json','src/codex-safe-core/family-non-goals.json','src/codex-safe-core/family-error-taxonomy.json','src/codex-safe-core/scripts/family-diagnostics.js','src/codex-safe-core/scripts/verify-release-artifact.js'
];
assert.deepEqual(pkg.files,requiredPackageFiles);
for(const forbidden of ['test','scripts','.github','.gitmodules','src/codex-safe-core/test','src/codex-safe-core/.github','src/codex-safe-core/package.json','src/codex-safe-core/ARCHITECTURE.md','src/codex-safe-core/CONTRIBUTING.md'])assert.equal(pkg.files.some(entry=>entry===forbidden||entry.startsWith(`${forbidden}/`)),false,`release package must exclude ${forbidden}`);

const configs=['config.example.json','deploy/systemd/config.example.json','deploy/docker/config.example.json'].map(file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8')));for(const config of configs)assert.equal(config.schemaVersion,contract.configSchemaVersion);const[userConfig,systemConfig,dockerConfig]=configs;assert.equal(Object.hasOwn(userConfig.server||{},'dataDir'),false);assert.equal(Object.hasOwn(userConfig.runner||{},'socket'),false);assert.equal(systemConfig.server.dataDir,'/var/lib/codex-review');assert.equal(systemConfig.runner.socket,'/run/codex-review-runner/runner.sock');const normalized=structuredClone(systemConfig);delete normalized.server.dataDir;delete normalized.runner.socket;assert.deepEqual(normalized,userConfig);assert.equal(dockerConfig.server.host,'0.0.0.0');assert.equal(dockerConfig.server.dataDir,'/var/lib/codex-review');

const dbSource=fs.readFileSync(path.join(root,'src/db.js'),'utf8'),notificationSource=fs.readFileSync(path.join(root,'src/notification.js'),'utf8'),secretSource=fs.readFileSync(path.join(root,'src/secrets.js'),'utf8'),indexSource=fs.readFileSync(path.join(root,'src/index.js'),'utf8'),httpSource=fs.readFileSync(path.join(root,'src/http.js'),'utf8'),adminSource=fs.readFileSync(path.join(root,'src/admin.js'),'utf8'),gitlabSource=fs.readFileSync(path.join(root,'src/gitlab.js'),'utf8'),gitlabCapabilities=fs.readFileSync(path.join(root,'src/gitlab-capabilities.js'),'utf8'),webhookSource=fs.readFileSync(path.join(root,'src/webhook.js'),'utf8'),runtimeSource=fs.readFileSync(path.join(root,'src/runtime.js'),'utf8');assert.doesNotMatch(dbSource,/ALTER TABLE|hasColumn\(|migrate\(/);assert.match(dbSource,/EDBSCHEMA/);assert.match(dbSource,/notification_outbox/);assert.match(notificationSource,/review\.blocked/);assert.match(notificationSource,/service\.degraded/);assert.doesNotMatch(notificationSource,/mustache/i);assert.match(secretSource,/_FILE/);assert.match(secretSource,/mutually exclusive/);assert.match(indexSource,/fatal_runtime_error/);assert.match(indexSource,/gitlab_capabilities_ready/);assert.match(indexSource,/unhandledRejection/);assert.match(indexSource,/uncaughtException/);assert.match(httpSource,/\/health\/dependencies/);assert.match(httpSource,/\/version/);assert.match(httpSource,/oldest_queue_age_seconds/);assert.match(adminSource,/node:sqlite/);assert.match(adminSource,/quick_check/);assert.match(adminSource,/foreign_key_check/);assert.match(gitlabCapabilities,/profile:modernDiff\?'modern':'classic'/);assert.match(gitlabCapabilities,/webhookAuth:standardWebhook\?'standard-hmac':'classic-token'/);assert.match(gitlabSource,/merge_requests\/\$\{iid\}\/changes/);assert.match(gitlabSource,/overflow===false/);assert.match(gitlabSource,/merge_requests\/\$\{iid\}\/diffs/);assert.match(gitlabSource,/diff_version_size_mismatch/);assert.match(webhookSource,/classicWebhookId/);assert.match(webhookSource,/x-gitlab-token/);assert.match(webhookSource,/createHash\('sha256'\)/);assert.match(webhookSource,/webhookAuthMode==='classic-token'/);assert.match(webhookSource,/webhook-signature/);assert.match(runtimeSource,/resolveCodexRuntime/);assert.doesNotMatch(runtimeSource,/GITLAB_API_TOKEN/);

const release=fs.readFileSync(path.join(root,'.github/workflows/release.yml'),'utf8');assert.match(release,/branches:\s*\[main\]/);assert.match(release,/github\.event\.comment\.body == '\/release-retry'/);assert.doesNotMatch(release,/--clobber/);assert.match(release,/Release .* already exists; immutable assets will not be overwritten/);assert.match(release,/docker buildx build[\s\S]*--file deploy\/docker\/Dockerfile[\s\S]*--platform linux\/amd64,linux\/arm64[\s\S]*--push/);assert.match(release,/IMAGE_DIGEST\.txt/);assert.match(release,/compose\.release\.yaml/);assert.match(release,/generate-consumer-ci-receipt\.js --output CONSUMER_CI_RECEIPT\.json/);assert.match(release,/sha256sum "\$tgz" SBOM\.spdx\.json IMAGE_DIGEST\.txt compose\.release\.yaml CONSUMER_CI_RECEIPT\.json > SHA256SUMS/);assert.match(release,/CONSUMER_CI_RECEIPT\.json[\s\S]*SHA256SUMS/);assert.match(release,/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8/);assert.match(release,/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25/);

const ci=fs.readFileSync(path.join(root,'.github/workflows/ci.yml'),'utf8'),security=fs.readFileSync(path.join(root,'.github/workflows/security.yml'),'utf8'),gitlabMatrix=fs.readFileSync(path.join(root,'.github/workflows/gitlab-system.yml'),'utf8');assert.match(ci,/22\.22\.2/);assert.match(ci,/24\.19\.0/);assert.match(ci,/docker-smoke/);assert.match(ci,/recovery-gate/);assert.match(security,/npm audit --omit=dev --audit-level=high/);assert.match(security,/Denied runtime license/);assert.match(security,/codeql-action\/init@24c54180a607b1449ed407dd24f251e4e9147c8d/);assert.match(security,/codeql-action\/analyze@24c54180a607b1449ed407dd24f251e4e9147c8d/);assert.doesNotMatch(security,/dependency-review-action/);assert.match(gitlabMatrix,/14\.6\.1-ce\.0/);assert.match(gitlabMatrix,/17\.11\.7-ce\.0/);assert.match(gitlabMatrix,/19\.3\.0-ce\.0/);assert.match(gitlabMatrix,/scripts\/gitlab-system-smoke\.js/);

const sourceFiles=fs.readdirSync(path.join(root,'src')).filter(name=>name.endsWith('.js')),source=sourceFiles.map(name=>fs.readFileSync(path.join(root,'src',name),'utf8')).join('\n');for(const forbidden of ['CODEX_RUNNER_SOCKET','GITLAB_PROJECT_ALLOWLIST','GITLAB_WEBHOOK_SECRET_TOKEN','.codex-review.json','service_extension_schema'])assert.doesNotMatch(source,new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),`runtime compatibility residue forbidden: ${forbidden}`);

for(const doc of ['README.md','README.zh-CN.md','OPERATIONS.md','SECURITY.md','LONG_TERM_ASSET.md','docs/ARCHITECTURE.md','docs/DEPLOYMENT.md','docs/DEPLOYMENT.zh-CN.md','docs/NOTIFICATIONS.md','docs/NOTIFICATIONS.zh-CN.md','docs/GITLAB_SETUP.md','docs/GITLAB_SETUP.zh-CN.md','docs/TOKEN_EFFICIENCY.md','docs/TOKEN_EFFICIENCY.zh-CN.md','SUPPORT.md']){const text=fs.readFileSync(path.join(root,doc),'utf8');assert.doesNotMatch(text,/\.codex-review\.json/);if(!doc.includes('NOTIFICATIONS')&&!doc.includes('GITLAB_SETUP'))assert.doesNotMatch(text,/SQLite schema 4|SQLite Schema 4|\bNode 22\.13\b/i,`${doc} carries stale current product facts`);}

console.log(`Codex Review Service ${contract.serviceVersion}: Runtime/Provider Contract v3 + Service operations + exact Safe Core Family v4 boundary verified.`);
