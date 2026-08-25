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

assert.equal(pkg.version,contract.serviceVersion,'package version must come from product contract');
assert.equal(lock.version,contract.serviceVersion,'lockfile version must match product contract');
assert.equal(lock.packages[''].version,contract.serviceVersion,'lock root package version must match product contract');
assert.equal(pkg.engines.node,`>=${contract.minimumNodeVersion} <${contract.nodeMajorVersion+1}`,'Node engine must be hard-pinned to the supported LTS major');
assert.equal(SCHEMA_VERSION,contract.databaseSchemaVersion,'database schema must match product contract');
assert.equal(core.SAFE_CORE_VERSION,contract.safeCoreMajorVersion,'Safe Core major must match product contract');
assert.equal(core.SAFE_CONTRACT_VERSION,contract.safeContractVersion,'Safe Contract must match product contract');
assert.equal(core.POLICY_SCHEMA_VERSION,contract.policySchemaVersion,'Policy schema must match product contract');
assert.equal(core.REVIEW_RECEIPT_SCHEMA_VERSION,contract.reviewReceiptVersion,'Review Receipt schema must match product contract');
const staged=execFileSync('git',['ls-files','--stage','src/codex-safe-core'],{cwd:root,encoding:'utf8'}).trim();
assert.match(staged,new RegExp(`^160000 ${contract.safeCoreCommit} 0\\tsrc/codex-safe-core$`),'Safe Core gitlink must match product contract');

for(const file of ['config.example.json','deploy/systemd/config.example.json','deploy/docker/config.example.json']){
  const config=JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
  assert.equal(config.schemaVersion,contract.configSchemaVersion,`${file} config schema must match product contract`);
}

const docs=['README.md','README.zh-CN.md','OPERATIONS.md','docs/ARCHITECTURE.md','docs/DEPLOYMENT.md','docs/DEPLOYMENT.zh-CN.md'];
for(const file of docs){const text=fs.readFileSync(path.join(root,file),'utf8');assert.doesNotMatch(text,/SQLite schema 4|SQLite Schema 4|Schema 4 database|schema 4\b/i,`${file} contains stale Schema 4 product facts`);}

const docker=fs.readFileSync(path.join(root,'deploy/docker/Dockerfile'),'utf8');
assert.match(docker,new RegExp(`node:${contract.minimumNodeVersion}-bookworm-slim@sha256:[0-9a-f]{64}`),'Docker base must pin exact Node LTS image digest');
const ci=fs.readFileSync(path.join(root,'.github/workflows/ci.yml'),'utf8');
assert.match(ci,new RegExp(contract.minimumNodeVersion.replaceAll('.','\\.')),'CI must test the product-contract Node floor');
const release=fs.readFileSync(path.join(root,'.github/workflows/release.yml'),'utf8');
assert.match(release,/ghcr\.io\/\$\{GITHUB_REPOSITORY\}/,'release must publish canonical GHCR image');
assert.match(release,/docker buildx build[\s\S]*--push/,'release must push OCI image instead of rebuilding at deployment time');
assert.match(release,/subject-name:/,'OCI digest must receive GitHub provenance attestation');
assert.match(release,/IMAGE_DIGEST\.txt/,'release must publish the canonical OCI digest');
assert.match(release,/compose\.release\.yaml/,'release must publish a digest-pinned compose manifest');

console.log(`Product contract verified: service ${contract.serviceVersion}, DB ${contract.databaseSchemaVersion}, config ${contract.configSchemaVersion}, Node ${contract.minimumNodeVersion}, GitLab ${contract.minimumGitLabVersion}.`);
