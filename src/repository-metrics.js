'use strict';
// Local, low-cardinality, read-only per-repository operational metrics.
// Unknown model-call usage is never silently substituted with zero tokens.
const MAX_PROJECTS=256;
function renderRepositoryMetrics(store,{maxProjects=MAX_PROJECTS,now=Date.now()}={}){
 if(!store?.db?.prepare)throw new TypeError('Repository metrics require a real SQLite Store');
 if(!Number.isSafeInteger(maxProjects)||maxProjects<1||maxProjects>MAX_PROJECTS)
   throw new RangeError('Invalid repository metrics bound');
 const rows=store.db.prepare(
   "SELECT project_id,COUNT(*) total, "+
   "SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) queued, "+
   "SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) running, "+
   "MIN(CASE WHEN status='queued' THEN created_at END) oldest "+
   "FROM review_jobs GROUP BY project_id ORDER BY project_id LIMIT ?"
 ).all(maxProjects+1);
 const complete=rows.length<=maxProjects;
 const projects=rows.slice(0,maxProjects).filter(x=>Number.isSafeInteger(x.project_id)&&x.project_id>0);
 const since=new Date(now);
 if(!Number.isFinite(since.getTime()))throw new TypeError('Invalid metrics timestamp');
 since.setUTCHours(0,0,0,0);
 const tokens=store.db.prepare(
   "SELECT j.project_id,"+
   "SUM(CASE WHEN c.usage_known=1 THEN COALESCE(c.input_tokens,0)+COALESCE(c.output_tokens,0) ELSE 0 END) known,"+
   "SUM(CASE WHEN c.usage_known=0 THEN 1 ELSE 0 END) unknown "+
   "FROM model_calls c JOIN review_jobs j ON j.id=c.job_id "+
   "WHERE c.started_at>=? AND j.project_id IN "+
   "(SELECT project_id FROM review_jobs GROUP BY project_id ORDER BY project_id LIMIT ?) "+
   "GROUP BY j.project_id"
 ).all(since.toISOString(),maxProjects);
 const usage=new Map(tokens.map(x=>[x.project_id,x]));
 const lines=[
   '# TYPE codex_review_repository_metrics_complete gauge',
   'codex_review_repository_metrics_complete '+(complete?'1':'0'),
   '# TYPE codex_review_repository_jobs gauge',
   '# TYPE codex_review_repository_oldest_queue_age_seconds gauge',
   '# TYPE codex_review_repository_known_model_tokens_today gauge',
   '# TYPE codex_review_repository_unknown_model_calls_today gauge'
 ];
 for(const p of projects){
   const id=String(p.project_id),label='{project_id="'+id+'"}';
   for(const [state,number] of [['total',p.total],['queued',p.queued],['running',p.running]]){
     const value=Number(number);
     if(!Number.isSafeInteger(value)||value<0)throw new Error('Invalid persisted per-project job count');
     lines.push('codex_review_repository_jobs{project_id="'+id+'",status="'+state+'"} '+value);
   }
   const date=p.oldest?Date.parse(p.oldest):now;
   const age=p.oldest&&Number.isFinite(date)?Math.max(0,Math.floor((now-date)/1000)):0;
   lines.push('codex_review_repository_oldest_queue_age_seconds'+label+' '+age);
   const stats=usage.get(p.project_id);
   const known=Number(stats?.known??0),unknown=Number(stats?.unknown??0);
   if(!Number.isSafeInteger(known)||known<0||!Number.isSafeInteger(unknown)||unknown<0)
     throw new Error('Invalid persisted per-project model usage');
   lines.push('codex_review_repository_known_model_tokens_today'+label+' '+known);
   lines.push('codex_review_repository_unknown_model_calls_today'+label+' '+unknown);
 }
 return lines.join('\n')+'\n';
}
module.exports={renderRepositoryMetrics,MAX_PROJECTS};
