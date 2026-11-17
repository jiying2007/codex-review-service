'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
test('fleet ingress keeps public writes separate from authenticated management reads',()=>{
 const nginx=fs.readFileSync('deploy/nginx/fleet-ingress.conf.example','utf8');
 assert.match(nginx,/ssl_verify_client on;/);
 assert.match(nginx,/listen 127\.0\.0\.1:9443 ssl;/);
 assert.match(nginx,/proxy_next_upstream off;/);
 assert.match(nginx,/location \/ \{ return 404; \}/);
 assert.doesNotMatch(nginx,/location = \/webhooks\/gitlab\s|ssl_verify_client optional/);
 const scrape=fs.readFileSync('deploy/monitoring/prometheus-scrape.example.yaml','utf8');
 assert.match(scrape,/honor_labels: true/);assert.match(scrape,/insecure_skip_verify: false/);
 assert.match(scrape,/edge_id: fleet-primary/);assert.match(scrape,/cert_file:/);
 const rules=fs.readFileSync('deploy/monitoring/codex-review.rules.yaml','utf8');
 assert.match(rules,/absent\(up\{job="codex-review-sharded-edge"\}\)/);
 assert.match(rules,/unless on\(job, edge_id, instance\)/);
 const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
 assert.ok(pkg.files.includes('deploy/nginx/*.example'));
});
