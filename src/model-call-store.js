'use strict';

const MODEL_CALL_SCHEMA=`
  CREATE TABLE model_calls(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES review_jobs(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL,
    call_index INTEGER NOT NULL,
    role TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('started','succeeded','failed','unknown')),
    estimated_tokens INTEGER NOT NULL,
    usage_known INTEGER NOT NULL DEFAULT 0 CHECK(usage_known IN (0,1)),
    input_tokens INTEGER,cached_input_tokens INTEGER,cache_write_input_tokens INTEGER,
    output_tokens INTEGER,reasoning_output_tokens INTEGER,
    error_code TEXT NOT NULL DEFAULT '',started_at TEXT NOT NULL,finished_at TEXT,
    UNIQUE(job_id,attempt,call_index)
  );
  CREATE INDEX idx_model_calls_job ON model_calls(job_id,attempt,id);
  CREATE INDEX idx_model_calls_started ON model_calls(started_at,outcome);
`;
const FIELDS=['inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens','reasoningOutputTokens'];
function observedUsage(usage,explicit){
  const required=['inputTokens','outputTokens'];
  if(explicit===false||!usage||!required.every(key=>Number.isSafeInteger(usage[key])&&usage[key]>=0))return null;
  // Normalized all-zero provider responses do not prove that usage was reported.
  if(explicit!==true&&usage.inputTokens+usage.outputTokens===0)return null;
  if(!FIELDS.every(key=>usage[key]===undefined||(Number.isSafeInteger(usage[key])&&usage[key]>=0)))return null;
  return FIELDS.map(key=>usage[key]||0);
}

class ModelCallStore{
  constructor(store){this.store=store;this.db=store.db;}
  begin({jobId,attempt,role,provider,model,estimatedTokens}){return this.store.withTransaction(()=>{
    const next=Number(this.db.prepare('SELECT COALESCE(MAX(call_index),0)+1 value FROM model_calls WHERE job_id=? AND attempt=?').get(jobId,attempt).value);
    const result=this.db.prepare("INSERT INTO model_calls(job_id,attempt,call_index,role,provider,model,outcome,estimated_tokens,started_at) VALUES(?,?,?,?,?,?,'started',?,?)").run(jobId,attempt,next,String(role||''),String(provider||''),String(model||''),Math.max(0,Math.ceil(Number(estimatedTokens)||0)),new Date().toISOString());
    return Number(result.lastInsertRowid);
  });}
  finish(id,{usage,usageKnown,errorCode='',model='',failed=false}={}){
    const values=observedUsage(usage,usageKnown);
    return this.db.prepare("UPDATE model_calls SET outcome=?,usage_known=?,input_tokens=?,cached_input_tokens=?,cache_write_input_tokens=?,output_tokens=?,reasoning_output_tokens=?,error_code=?,model=CASE WHEN ?<>'' THEN ? ELSE model END,finished_at=? WHERE id=? AND outcome='started'").run(failed?'failed':'succeeded',values?1:0,...(values||[null,null,null,null,null]),String(errorCode),String(model),String(model),new Date().toISOString(),id).changes;
  }
  unknownForAttempt(jobId,attempt){return Number(this.db.prepare("SELECT COUNT(*) count FROM model_calls WHERE job_id=? AND attempt=? AND usage_known=0 AND outcome IN ('started','failed','unknown')").get(jobId,attempt).count);}
  recover(){return this.store.withTransaction(()=>{
    const now=new Date().toISOString();
    const jobs=this.db.prepare("UPDATE review_jobs SET status='failed',error_code='EMODELCALLUNCERTAIN',finished_at=? WHERE status='running' AND EXISTS(SELECT 1 FROM model_calls c WHERE c.job_id=review_jobs.id AND c.attempt=review_jobs.attempt AND c.outcome='started')").run(now).changes;
    this.db.prepare("UPDATE model_calls SET outcome='unknown',error_code='ESERVICERESTART',finished_at=? WHERE outcome='started'").run(now);
    return jobs;
  });}
  budgetUsageSince(projectId,since){
    const row=this.db.prepare(`SELECT COALESCE(SUM(tokens),0) tokens FROM (
      SELECT CASE WHEN c.usage_known=1 THEN c.input_tokens+c.output_tokens ELSE c.estimated_tokens END tokens
      FROM model_calls c JOIN review_jobs j ON j.id=c.job_id WHERE j.project_id=? AND c.started_at>=? AND c.outcome<>'started'
      UNION ALL SELECT r.input_tokens+r.output_tokens tokens FROM review_runs r JOIN review_jobs j ON j.id=r.job_id
      WHERE j.project_id=? AND r.created_at>=? AND NOT EXISTS(SELECT 1 FROM model_calls c WHERE c.job_id=j.id)
    )`).get(projectId,since,projectId,since);
    return Number(row.tokens||0);
  }
  summary(){return this.db.prepare(`SELECT COALESCE(SUM(input),0) input,COALESCE(SUM(cached),0) cached,COALESCE(SUM(output),0) output,COALESCE(SUM(reasoning),0) reasoning,COALESCE(SUM(unknown),0) unknownCalls,COALESCE(SUM(estimated),0) estimatedUnknownTokens FROM (
    SELECT input_tokens input,cached_input_tokens cached,output_tokens output,reasoning_output_tokens reasoning,1-usage_known unknown,CASE WHEN usage_known=0 THEN estimated_tokens ELSE 0 END estimated FROM model_calls
    UNION ALL SELECT r.input_tokens,r.cached_input_tokens,r.output_tokens,r.reasoning_output_tokens,0,0 FROM review_runs r WHERE NOT EXISTS(SELECT 1 FROM model_calls c WHERE c.job_id=r.job_id)
  )`).get();}
}
module.exports={MODEL_CALL_SCHEMA,ModelCallStore,observedUsage};
