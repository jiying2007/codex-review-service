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
  assert.match(release,/git rev-list -n 1 "\$tag"/);
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
  assert.match(release,/gh release view "\\$tag" --repo "\\$GITHUB_REPOSITORY"/);
  assert.match(release,/run: node scripts\\/ensure-immutable-release-tag\\.js/);
  assert.match(release,/GH_TOKEN: \\$\\{\\{ github\\.token \\}\\}/);
  assert.match(release,/RELEASE_SHA: \\$\\{\\{ needs\\.prepare\\.outputs\\.release_sha \\}\\}/);
  assert.doesNotMatch(release,/git ls-remote --exit-code --refs origin "refs\\/tags\\//);
});

test('explicit release retry may recover a cancelled pre-tag publication without weakening gates',()=>{
  assert.match(release,/if git rev-parse --verify --quiet "refs\/tags\/\$\{tag\}"/);
  assert.match(release,/release_sha=\$\(gh api "repos\/\$\{GITHUB_REPOSITORY\}\/git\/ref\/heads\/main"/);
  assert.match(release,/test "\$package_version" = "\$version"/);
  assert.match(release,/test "\$contract_version" = "\$version"/);
  assert.match(release,/Require genuine same-SHA main CI Gate before immutable publication/);
  assert.match(release,/node: \[22\.22\.2, 24\.19\.0\]/);
});
