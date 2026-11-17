'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const release=fs.readFileSync('.github/workflows/release.yml','utf8');

test('release builds the canonical production Dockerfile',()=>{
  assert.match(release,/docker buildx build[\s\S]*--file deploy\/docker\/Dockerfile[\s\S]*--platform linux\/amd64,linux\/arm64[\s\S]*--push/);
});

test('release retry is anchored to an explicit or uniquely unreleased immutable tag',()=>{
  assert.match(release,/release_sha:/);
  assert.match(release,/RELEASE_RETRY_REQUEST/);
  assert.match(release,/Usage: \/release-retry \[vMAJOR\.MINOR\.PATCH\]/);
  assert.match(release,/git\/ref\/heads\/main/);
  assert.match(release,/Recovering pre-tag release/);
  assert.match(release,/same-SHA CI Gate and Release tests remain mandatory/);
  assert.match(release,/Multiple unreleased immutable tags exist; use \/release-retry vMAJOR\.MINOR\.PATCH/);
  assert.match(release,/No unreleased immutable tag exists for \/release-retry/);
  assert.match(release,/release_sha=\$\(tag_sha_remote "\$tag"\)/);
  assert.match(release,/git cat-file -e/);
  assert.doesNotMatch(release,/git fetch --force --tags origin/);
  assert.match(release,/ref: \$\{\{ needs\.prepare\.outputs\.release_sha \}\}/);
  assert.match(release,/VCS_REF="\$RELEASE_SHA"/);
  assert.match(release,/org\.opencontainers\.image\.revision/);
});

test('release retains immutable tag, artifact and image guards',()=>{
  assert.doesNotMatch(release,/--clobber/);
  assert.match(release,/immutable image will not be overwritten/);
  assert.match(release,/immutable assets will not be overwritten/);
  assert.match(release,/IMAGE_DIGEST\.txt/);
  assert.match(release,/compose\.release\.yaml/);
  assert.match(release,/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8/);
});

test('release tag uses authenticated, exact-SHA idempotent API with fail-closed fallback',()=>{
  assert.match(release,/gh release view "\$tag" --repo "\$GITHUB_REPOSITORY"/);
  assert.match(release,/run: node scripts\/ensure-immutable-release-tag\.js/);
  assert.match(release,/GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(release,/RELEASE_SHA: \$\{\{ needs\.prepare\.outputs\.release_sha \}\}/);
  assert.doesNotMatch(release,/git ls-remote --exit-code --refs origin "refs\/tags\//);
});

test('explicit release retry may recover a cancelled pre-tag publication without weakening gates',()=>{
  assert.match(release,/getTag\(process\.env\.RELEASE_TAG,process\.env\.GH_TOKEN\)/);
  assert.match(release,/release_sha=\$\(tag_sha_remote "\$tag"\)/);
  assert.match(release,/release_sha=\$\(gh api "repos\/\$\{GITHUB_REPOSITORY\}\/git\/ref\/heads\/main"/);
  assert.match(release,/test "\$package_version" = "\$version"/);
  assert.match(release,/test "\$contract_version" = "\$version"/);
  assert.match(release,/Require genuine same-SHA main CI Gate before immutable publication/);
  assert.match(release,/node: \[22\.22\.2, 24\.19\.0\]/);
});


test('reusable Family and Release Integrity workflows pin the exact Product Contract Core SHA',()=>{
 const contract=require('../product-contract.json');
 const ci=fs.readFileSync('.github/workflows/ci.yml','utf8');
 const integrity=fs.readFileSync('.github/workflows/release-integrity.yml','utf8');
 const sha=contract.safeCoreCommit;
 assert.match(sha,/^[0-9a-f]{40}$/);
 const ciCore=ci.match(/uses: jiying2007\/codex-safe-core\/\.github\/workflows\/family-release-guard\.yml@([0-9a-f]{40})/);
 const expected=ci.match(/expected_core_sha: ([0-9a-f]{40})/);
 const releaseCore=integrity.match(/uses: jiying2007\/codex-safe-core\/\.github\/workflows\/consumer-release-integrity\.yml@([0-9a-f]{40})/);
 assert.ok(ciCore&&expected&&releaseCore,'all reusable workflow identities must be explicit immutable SHAs');
 assert.equal(ciCore[1],sha);
 assert.equal(expected[1],sha);
 assert.equal(releaseCore[1],sha);
});


test('GHCR blob materialization is required before Trivy and never weakens release evidence',()=>{
 const resolve=release.indexOf('Resolve digest-bound platform scan identities');
 const pull=release.indexOf('Verify both immutable OCI platform layers are retrievable');
 const scan=release.indexOf('Scan exact amd64 manifest without filtering findings');
 assert.ok(resolve>=0 && pull>resolve && scan>pull,'exact layer pull must precede Trivy scanning');
 assert.match(release,/docker pull --platform "\$platform" "\$image"/);
 assert.match(release,/timeout 180 docker pull/);
 assert.match(release,/for attempt in 1 2 3/);
 assert.match(release,/org\.opencontainers\.image\.revision/);
 assert.match(release,/org\.opencontainers\.image\.version/);
 assert.match(release,/BLOB_UNKNOWN/);
 assert.match(release,/BUILDX_NO_DEFAULT_OCI_ARTIFACT: '1'/);
 assert.match(release,/AMD64_CONFIG: \$\{\{ steps\.scan_targets\.outputs\.amd64_config \}\}/);
 assert.match(release,/ARM64_CONFIG: \$\{\{ steps\.scan_targets\.outputs\.arm64_config \}\}/);
 assert.match(release,/actual_config="\$\(docker image inspect/);
 assert.match(release,/"\$actual_config" != "\$expected_config"/);
 assert.match(release,/--provenance=mode=max/);
 assert.match(release,/--sbom=true/);
 assert.match(release,/node scripts\/trivy-findings-gate\.js --report TRIVY-linux-amd64\.json/);
 assert.match(release,/node scripts\/trivy-findings-gate\.js --report TRIVY-linux-arm64\.json/);
 assert.doesNotMatch(release,/--provenance=false|--sbom=false|TRIVY_IGNORE_UNFIXED: 'true'/);
});

test('release accepts only digest-bound config or child-manifest Docker image identity',()=>{
 const required=[
   'expected_manifest="${image##*@}"',
   'if [[ ! "$expected_manifest" =~ ^sha256:[0-9a-f]{64}$ ]]',
   'if [[ "$actual_config" != "$expected_config" && "$actual_config" != "$expected_manifest" ]]',
   'Missing verified per-platform OCI manifest identity',
   'scripts/oci-scan-targets.js',
   'docker pull --platform "$platform" "$image"'
 ];
 for(const clause of required)assert.ok(release.includes(clause),clause);
});
