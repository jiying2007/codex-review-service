'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
test('docker deployment remains rootless and bounded',()=>{const docker=fs.readFileSync('deploy/docker/Dockerfile','utf8'),compose=fs.readFileSync('deploy/docker/compose.yaml','utf8');assert.match(docker,/ARG CODEX_VERSION=0\.149\.1/);assert.match(docker,/USER codex-review/);assert.match(compose,/read_only: true/);assert.match(compose,/cap_drop: \["ALL"\]/);assert.match(compose,/\/health\/ready/);});
