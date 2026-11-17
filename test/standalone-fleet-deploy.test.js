'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
test('standalone multi-host node is an explicit opt-in single-writer release image',()=>{
 const y=fs.readFileSync('deploy/docker/compose.instance.yaml','utf8');
 assert.match(y,/profiles: \["cutover-standalone"\]/);
 assert.match(y,/ghcr\.io\/jiying2007\/codex-review-service@sha256:/);
 assert.match(y,/CODEX_REVIEW_INSTANCE_ID/);
 assert.match(y,/instance-state:\s*\n\s+external: true/);
 assert.match(y,/instance-home:\s*\n\s+external: true/);
 assert.match(y,/GITLAB_API_TOKEN_FILE: \/run\/secrets\/gitlab_api/);
 assert.match(y,/GITLAB_WEBHOOK_SIGNING_TOKEN_FILE: \/run\/secrets\/gitlab_webhook/);
 assert.doesNotMatch(y,/^\s*ports:/m);
 assert.doesNotMatch(y,/^\s*build:|^\s*env_file:/m);
 assert.doesNotMatch(y,/--privileged|cap_add:|network_mode: host/);
});
