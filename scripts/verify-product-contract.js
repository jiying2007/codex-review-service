'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const contract=require('../product-contract.json');
const pkg=require('../package.json');
const lock=require('../package-lock.json');
const {SCHEMA_VERSION}=require('../src/db');
const core=require('../src/codex-safe-core');
const {selectGitLabCapabilities}=require('../src/gitlab-capabilities');
const {FORMATS}=require('../src/analyzer-adapters');

assert.equal(pkg.version,contract.serviceVersion,'package version must come from product contract');
assert.equal(lock.version,contract.serviceVersion,'lockfile version must match product contract');
assert.equal(lock.packages[''].version,contract.serviceVersion,'lock root package version must match product contract');
const expectedNodeEngine=`>=${contract.minimumNodeVersion} <23 || >=${contract.canonicalNodeVersion} <25`;
assert.equal(pkg.engines.node,expectedNodeEngine,'Node engine must expose only supported LTS ranges');
assert.deepEqual(contract.supportedNodeMajors,[22,24],'supported Node majors must stay explicit');
assert.equal(SCHEMA_VERSION,contract.databaseSchemaVersion,'database schema must match product contract');
assert.equal(core.SAFE_CORE_VERSION,contract.safeCoreMajorVersion,'Safe Core major must match product contract');
assert.equal(core.SAFE_CONTRACT_VERSION,contract.safeContractVersion,'Safe Contract must match product contract');
assert.equal(core.POLICY_SCHEMA_VERSION,contract.policySchemaVersion,'Policy schema must match product contract');
assert.equal(core.REVIEW_RECEIPT_SCHEMA_VERSION,contract.reviewReceiptVersion,'Review Receipt schema must match product contract');
for(const [coreKey,productKey] of [['qualityPlatformVersion','qualityPlatformVersion'],['reviewProfileVersion','reviewProfileVersion'],['profilePackVersion','profilePackVersion'],['impactEvidenceVersion','impactEvidenceVersion'],['testImpactVersion','testImpactVersion'],['analyzerFindingVersion','analyzerFindingVersion']])assert.equal(core.CORE_CONTRACT[coreKey],contract[productKey],`${productKey} must match Core`);
assert.equal(contract.analyzerAdapterVersion,1,'Analyzer Adapter contract must be explicit');
for(const format of ['sarif','gitlab-codequality','junit','cobertura','lcov','compiler','cppcheck','cyclonedx-json','trivy-json','gitleaks-json'])assert.ok(FORMATS.includes(format),`missing analyzer adapter ${format}`);
const staged=execFileSync('git',['ls-files','--stage','src/codex-safe-core'],{cwd:root,encoding:'utf8'}).trim();
assert.match(staged,new RegExp(`^160000 ${contract.safeCoreCommit} 0\\tsrc/codex-safe-core$`),'Safe Core gitlink must match product contract');

for(const file of ['config.example.json','deploy/systemd/config.example.json','deploy/docker/config.example.json']){
  const config=JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
  assert.equal(config.schemaVersion,contract.configSchemaVersion,`${file} config schema must match product contract`);
  assert.equal(Object.prototype.hasOwnProperty.call(config.review||{},'sarifFiles'),false,`${file} must not retain sarifFiles compatibility surface`);
  assert.ok(Array.isArray(config.review?.analyzerReports),`${file} must expose analyzerReports`);
  assert.ok(['general','backend','frontend','security','cpp','embedded-linux','embedded-mcu','driver','kernel','realtime'].includes(config.review?.profile),`${file} must use a Profile Pack`);
}

const floorCapabilities=selectGitLabCapabilities(contract.minimumGitLabVersion),modernCapabilities=selectGitLabCapabilities(contract.modernGitLabProfileMinimumVersion),standardWebhookCapabilities=selectGitLabCapabilities(contract.standardWebhookMinimumVersion||contract.standardWebhookMinimumGitLabVersion);
assert.equal(floorCapabilities.profile,'classic','GitLab compatibility floor must use classic diff profile');
assert.equal(floorCapabilities.webhookAuth,'classic-token','GitLab compatibility floor must use classic webhook auth');
assert.equal(modernCapabilities.profile,'modern','modern GitLab diff profile threshold must be governed');
assert.equal(standardWebhookCapabilities.webhookAuth,'standard-hmac','standard webhook threshold must be governed');
assert.equal(standardWebhookCapabilities.webhookReplayWindow,true,'standard webhook mode must retain replay-window capability');
assert.equal(contract.recommendedGitLabPolicy,'vendor-supported','recommended GitLab policy must not pretend the compatibility floor is recommended');

const docs=['README.md','README.zh-CN.md','OPERATIONS.md','SECURITY.md','docs/ARCHITECTURE.md','docs/DEPLOYMENT.md','docs/DEPLOYMENT.zh-CN.md'];
for(const file of docs){const text=fs.readFileSync(path.join(root,file),'utf8');assert.doesNotMatch(text,/SQLite schema 4|SQLite Schema 4|Schema 4 database|schema 4\b/i,`${file} contains stale Schema 4 product facts`);}
const qualityDocs=`${fs.readFileSync(path.join(root,'docs/QUALITY_PLATFORM.md'),'utf8')}\n${fs.readFileSync(path.join(root,'docs/QUALITY_PLATFORM.zh-CN.md'),'utf8')}`;
for(const term of ['Analyzer Adapter','JUnit','Code Quality','Test Impact','Profile Pack'])assert.match(qualityDocs,new RegExp(term,'i'));
const docker=fs.readFileSync(path.join(root,'deploy/docker/Dockerfile'),'utf8');
assert.match(docker,new RegExp(`node:${contract.canonicalNodeVersion}-bookworm-slim@sha256:[0-9a-f]{64}`),'Docker base must pin canonical Node LTS image digest');
const ci=fs.readFileSync(path.join(root,'.github/workflows/ci.yml'),'utf8');
assert.match(ci,new RegExp(contract.minimumNodeVersion.replaceAll('.','\\.')),'CI must test the Node compatibility floor');
assert.match(ci,new RegExp(contract.canonicalNodeVersion.replaceAll('.','\\.')),'CI must test canonical Node');
const gitlabMatrix=fs.readFileSync(path.join(root,'.github/workflows/gitlab-system.yml'),'utf8');
for(const version of ['14.6.1','17.11.7','19.3.0'])assert.match(gitlabMatrix,new RegExp(version.replaceAll('.','\\.')),`GitLab system matrix must cover ${version}`);
const release=fs.readFileSync(path.join(root,'.github/workflows/release.yml'),'utf8');
assert.match(release,/ghcr\.io\/\$\{GITHUB_REPOSITORY\}/,'release must publish canonical GHCR image');
assert.match(release,/docker buildx build[\s\S]*--push/,'release must push OCI image instead of rebuilding at deployment time');
assert.match(release,/subject-name:/,'OCI digest must receive GitHub provenance attestation');
assert.match(release,/IMAGE_DIGEST\.txt/,'release must publish the canonical OCI digest');
assert.match(release,/compose\.release\.yaml/,'release must publish a digest-pinned compose manifest');

console.log(`Product contract verified: service ${contract.serviceVersion}, DB ${contract.databaseSchemaVersion}, config ${contract.configSchemaVersion}, Profile Pack ${contract.profilePackVersion}, Test Impact ${contract.testImpactVersion}, Analyzer Adapter ${contract.analyzerAdapterVersion}, Core ${contract.safeCoreCommit}.`);
