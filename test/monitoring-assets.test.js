'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
test('monitoring assets are credential-free and use bounded instance/project metrics',()=>{
 const d=JSON.parse(fs.readFileSync('deploy/monitoring/grafana-fleet.json','utf8'));
 assert.equal(d.dashboard.uid,'codex-review-fleet');
 const queries=d.dashboard.panels.flatMap(p=>p.targets.map(t=>t.expr)).join('\n');
 for(const metric of ['codex_review_instance_ready','codex_review_instance_metrics_scrape_ok',
   'codex_review_instance_oldest_queue_age_seconds','codex_review_instance_status_uncertain_targets',
   'codex_review_repository_jobs','codex_review_instance_retained_input_tokens'])
   assert.ok(queries.includes(metric),metric);
 const alerts=fs.readFileSync('deploy/monitoring/codex-review.rules.yaml','utf8');
 for(const alert of ['CodexReviewEdgeUnavailable','CodexReviewMetricsUnavailable',
   'CodexReviewInstanceNotReady','CodexReviewStatusWriteUncertain'])assert.ok(alerts.includes(alert));
 assert.doesNotMatch(JSON.stringify(d)+alerts,/apiKey|Bearer |GITLAB_API_TOKEN_FILE|OPENAI_API_KEY|webhook.signing.token/i);
});
