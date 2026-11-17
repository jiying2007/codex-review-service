'use strict';
// Synthetic offline query benchmark; never opens an operator database or calls a model.
const { DatabaseSync } = require('node:sqlite');
const { performance } = require('node:perf_hooks');
const fs = require('node:fs'), crypto = require('node:crypto'), os = require('node:os');
const { repositoryCounts, renderRepositoryMetrics } = require('../src/repository-metrics');
const BASELINE_SOURCE = 'ca9fa890aab1478cbe30976de0f26a34bcfaacf2';
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function quantile(samples, p) { const sorted=[...samples].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]; }
function benchmark(size, samples = 7) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE review_jobs(id INTEGER PRIMARY KEY,project_id INTEGER,mr_iid INTEGER,status TEXT,created_at TEXT,available_at TEXT);
      CREATE TABLE model_calls(job_id INTEGER,usage_known INTEGER,input_tokens INTEGER,output_tokens INTEGER,started_at TEXT);
      WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<${size})
      INSERT INTO review_jobs SELECT n,1+(n%64),n,CASE WHEN n%1000=0 THEN 'queued' WHEN n%1000=1 THEN 'running' ELSE 'pass' END,
      '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z' FROM seq;
      CREATE INDEX idx_review_jobs_mr ON review_jobs(project_id,mr_iid,id);
      CREATE INDEX idx_review_jobs_status_available ON review_jobs(status,available_at,id);
      CREATE INDEX idx_model_calls_started ON model_calls(started_at);
      CREATE INDEX idx_model_calls_job ON model_calls(job_id);`);
    const selected=Array.from({length:64},(_,i)=>i+1),slots=selected.map(()=>'?').join(',');
    // Exact pre-fix aggregate shape from BASELINE_SOURCE; no database tuning
    // or ANALYZE is applied to only one side of the paired comparison.
    const sql="SELECT project_id,COUNT(*) total,SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) queued,"+
      "SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) running,MIN(CASE WHEN status='queued' THEN created_at END) oldest "+
      'FROM review_jobs WHERE project_id IN ('+slots+') GROUP BY project_id ORDER BY project_id';
    const baseline=()=>db.prepare(sql).all(...selected);
    const candidate=()=>repositoryCounts(db,selected,256);
    const normalized=rows=>JSON.stringify(rows.map(r=>[r.project_id,r.total,r.queued,r.running,r.oldest]));
    const reference=normalized(baseline());
    if(normalized(candidate())!==reference)throw new Error('Aggregate equivalence failed');
    baseline();candidate();
    const before=[],after=[];
    for(let i=0;i<samples;i++) {
      for(const [fn,output] of (i%2?[[candidate,after],[baseline,before]]:[[baseline,before],[candidate,after]])) {
        const start=performance.now();const rows=fn();output.push(performance.now()-start);
        if(normalized(rows)!==reference)throw new Error('Paired result drift');
      }
    }
    const render=[];
    for(let i=0;i<samples;i++) {
      const start=performance.now();renderRepositoryMetrics({db},{projectIds:selected,now:Date.parse('2026-01-01T00:10:00Z')});render.push(performance.now()-start);
    }
    return {rows:size,projectCount:64,equivalent:true,resultSha256:digest(reference),
      baselineMs:before,candidateMs:after,rendererMs:render,
      baselineMedianMs:quantile(before,.5),candidateMedianMs:quantile(after,.5),
      baselineP95Ms:quantile(before,.95),candidateP95Ms:quantile(after,.95),rendererP95Ms:quantile(render,.95),
      improvementPercent:(1-quantile(after,.5)/quantile(before,.5))*100};
  } finally { db.close(); }
}
function main(args=process.argv.slice(2)) {
  if(args.length!==0 && !(args.length===2 && args[0]==='--output'))throw new TypeError('Usage: benchmark-repository-metrics.js [--output report.json]');
  const result={schemaVersion:1,kind:'offline_repository_metric_query_benchmark',
    baselineSource:BASELINE_SOURCE,sourceSha:process.env.GITHUB_SHA||null,runId:process.env.GITHUB_RUN_ID||null,
    node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model||'unknown',
    sources:Object.fromEntries(['src/repository-metrics.js','src/metrics-age.js','scripts/benchmark-repository-metrics.js'].map(file=>[file,digest(fs.readFileSync(require('node:path').join(__dirname,'..',file)))])),
    warmupPerVariant:2,pairedSamples:7,comparisonScope:'repository_job_aggregates_only',
    results:[10000,100000,1000000].map(size=>benchmark(size)),modelCalls:0,
    productionQualified:false,webhookLatencyMeasured:false,fullServiceScrapeMeasured:false,
    warning:'Synthetic in-memory query measurements are not on-host webhook P95/P99 or production SLO acceptance.'};
  const text=JSON.stringify(result,null,2)+'\n';
  if(args.length)fs.writeFileSync(args[1],text,{flag:'wx',mode:0o600});
  process.stdout.write(text);return result;
}
if(require.main===module)main();
module.exports={benchmark};
