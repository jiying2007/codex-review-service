'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const release=fs.readFileSync('.github/workflows/release.yml','utf8');

test('release builds the canonical production Dockerfile',()=>{
  assert.match(release,/docker buildx build[\s\S]*--file deploy\/docker\/Dockerfile[\s\S]*--platform linux\/amd64,linux\/arm64[\s\S]*--push/);
});

test('release retry is anchored to exactly one unreleased immutable tag',()=>{
  assert.match(release,/release_sha:/);
  assert.match(release,/Multiple unreleased immutable tags exist; refusing ambiguous \/release-retry/);
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
