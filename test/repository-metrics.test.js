'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../src/db');
const {renderRepositoryMetrics}=require('../src/repository-metrics');
function temporary(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'safe-repository-metrics-'));
 const store=new Store(path.join(dir,'service.db'));
 return {store,close(){store.close();fs.rmSync(dir,{recursive:true,force:true});}};
}
function enqueue(store,id,n){
 return store.enqueue({projectId:id,mrIid:n,trigger:'test',
   dedupeKey:'metrics-'+id+'-'+n,maxQueueDepth:1000});
}
test('project metrics are exact numeric counts with UTC-day known and unknown model usage',()=>{
 const x=temporary();
 try{
   const a=enqueue(x.store,113,1),b=enqueue(x.store,113,2),c=enqueue(x.store,5,1);
   assert.ok(a&&b&&c);
   const first=x.store.claimNext();
   assert.equal(first.project_id,113);
   const call=x.store.modelCalls.begin({jobId:a,attempt:1,role:'reviewer',
     provider:'fixture',model:'fixture',estimatedTokens:1000});
   x.store.modelCalls.finish(call,{usage:{inputTokens:100,outputTokens:20},usageKnown:true});
   x.store.modelCalls.begin({jobId:b,attempt:1,role:'reviewer',provider:'fixture',
     model:'fixture',estimatedTokens:400});
   const body=renderRepositoryMetrics(x.store);
   assert.match(body,/codex_review_repository_metrics_complete 1/);
   assert.match(body,/codex_review_repository_jobs\{project_id="113",status="running"\} 1/);
   assert.match(body,/codex_review_repository_jobs\{project_id="113",status="queued"\} 1/);
   assert.match(body,/codex_review_repository_known_model_tokens_today\{project_id="113"\} 120/);
   assert.match(body,/codex_review_repository_unknown_model_calls_today\{project_id="113"\} 1/);
   assert.match(body,/codex_review_repository_unknown_model_calls_today\{project_id="5"\} 0/);
   assert.doesNotMatch(body,/mr_iid|head_sha|source_branch/);
 }finally{x.close();}
});
test('capacity truncation is explicitly flagged, never silently shown as complete',()=>{
 const x=temporary();
 try{
   for(const id of [1,2,3])enqueue(x.store,id,id);
   const body=renderRepositoryMetrics(x.store,{maxProjects:2});
   assert.match(body,/codex_review_repository_metrics_complete 0/);
   assert.match(body,/project_id="1"/);
   assert.match(body,/project_id="2"/);
   assert.doesNotMatch(body,/project_id="3"/);
   assert.throws(()=>renderRepositoryMetrics(x.store,{maxProjects:0}),/bound/);
   assert.throws(()=>renderRepositoryMetrics(x.store,{now:NaN}),/timestamp/);
 }finally{x.close();}
});
