'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ReviewService}=require('../src/service');
const {Store}=require('../src/db');
const cfg={gitlabProjectAllowlist:new Set([7]),maxQueueDepth:10,manualMinAccessLevel:30,maxJobAttempts:2,retryBaseDelayMs:10,retryMaxDelayMs:100,jobTimeoutSeconds:30,maxDiffBytes:4096,maxTotalDiffBytes:4096,maxReviewChunks:2,maxFindings:10,maxPublishedFindings:10,minConfidence:0.7,blockingSeverity:'high',reviewTimeoutSeconds:30,codexModelSelectionStrategy:'auto',codexModelCandidates:[],codexModelCompatibilityPolicy:'strict',codexScoutEnabled:false,codexAdjudicatorEnabled:false,codexAdjudicatorMinSeverity:'high',workerConcurrency:1,pollIntervalMs:10,autoResolveObsolete:true,reviewDebounceMs:0,reviewDraftMergeRequests:false,triggerAssignment:{mode:'always',userIds:[]},mrMaxTokenBudget:0,projectDailyTokenBudget:0,contextEnabled:false,adaptiveContextEnabled:true,maxContextBytes:0,maxContextFiles:0,contextLines:0,skipGeneratedFiles:true,blockUnreviewableFiles:false,analyzerReports:[{format:'gitleaks-json',job:'security',path:'report.json',required:true,maxBytes:4096}]};
const policy={language:'en',maxDiffBytes:4096,maxReviewChunks:2,maxFindings:10,maxPublishedFindings:10,minConfidence:0.7,blockingSeverity:'high',severityThreshold:'info',timeoutSeconds:30,extraInstructions:'',skipGeneratedFiles:true,blockUnreviewableFiles:false,maxContextBytes:0,maxContextFiles:0,contextLines:0,source:'test',fingerprint:'a'.repeat(64)};
const head='d'.repeat(40),mr={project_id:7,source_project_id:7,target_project_id:7,iid:9,state:'opened',draft:false,source_branch:'feat',target_branch:'main',diff_refs:{base_sha:'b'.repeat(40),start_sha:'c'.repeat(40),head_sha:head},head_pipeline:{id:123,project_id:7,sha:head}};

async function scenario(artifact,{config={},effectivePolicy={},adapters={},modelFindings=[]}={}){
 const store=new Store(':memory:');
 const gitlab={getMergeRequest:async()=>mr,resolveStatusPipeline:async()=>123,listMergeRequestDiffs:async()=>({complete:true,items:[{old_path:'a.js',new_path:'a.js',diff:'@@ -1 +1 @@ fn\n-old\n+new'}]}),validateMergeRequestDiffCoverage:async()=>({complete:true}),listPipelineJobs:async()=>({complete:true,items:[{id:1,name:'security'}]}),getJobArtifactFile:async()=>artifact,...adapters};
 const service=new ReviewService({config:{...cfg,...config},store,gitlab,logger:{},getPolicyFn:async()=>({...policy,...effectivePolicy}),contextFn:async()=>({blocks:[],bytes:0,complete:true}),runCodexFn:async()=>({version:'test',model:'model-x',usage:{inputTokens:100,outputTokens:20},parsed:{findings:modelFindings}})});
 try{
  const id=store.enqueue({projectId:7,mrIid:9,trigger:'open',dedupeKey:'test'});await service.processJob(store.claimNext());
  return{job:store.getJob(id),run:store.db.prepare('SELECT * FROM review_runs WHERE job_id=?').get(id),findings:store.db.prepare('SELECT * FROM review_findings').all(),statuses:store.db.prepare("SELECT payload_json FROM publication_outbox WHERE action_type='status'").all().map(x=>JSON.parse(x.payload_json))};
 }finally{store.close();}
}
const critical=JSON.stringify([{File:'a.js',StartLine:1,RuleID:'secret',Description:'Critical analyzer finding'}]);
test('current critical analyzer blocks a clean model and records blocked receipt/status',async()=>{
 const r=await scenario(critical);assert.equal(r.job.status,'blocked');assert.equal(r.run.verdict,'block');assert.equal(r.findings[0].severity,'critical');assert.equal(r.statuses.at(-1).state,'failed');assert.equal(JSON.parse(r.run.receipt_json).qualityVerdict,'blocked');
});
test('blocking uses analyzer findings before presentation truncation and severity filtering',async()=>{
 const findings=Array.from({length:3},(_,i)=>({severity:'low',category:'correctness',file:'a.js',side:'new',line:1,endLine:1,title:'Low '+i,description:'Distinct low '+i,suggestion:'',confidence:.95}));
 const r=await scenario(critical,{effectivePolicy:{maxFindings:1,severityThreshold:'critical'},modelFindings:findings});assert.equal(r.run.verdict,'block');assert.equal(r.findings.length,1);assert.equal(r.findings[0].severity,'critical');assert.equal(r.statuses.at(-1).state,'failed');
});
for(const [label,artifact,adapters] of [['missing',null,{}],['malformed','{broken',{}],['incomplete enumeration',critical,{listPipelineJobs:async()=>({complete:false,items:[{id:1,name:'security'}]})}]]){
 test('required analyzer '+label+' cannot produce pass or a complete receipt',async()=>{
  const r=await scenario(artifact,{adapters});assert.notEqual(r.job.status,'pass');assert.equal(r.run,undefined);assert.ok(!r.statuses.some(s=>s.state==='success'));
 });
}
test('optional context failures preserve acquired required analyzer findings',async()=>{
 const r=await scenario(critical,{adapters:{listRepositoryTree:async()=>{throw new Error('optional context unavailable');}}});assert.equal(r.run.verdict,'block');assert.equal(r.findings[0].severity,'critical');
});
test('explicitly optional missing report stays advisory',async()=>{
 const r=await scenario(null,{config:{analyzerReports:cfg.analyzerReports.map(s=>({...s,required:false}))}});assert.equal(r.run.verdict,'pass');assert.equal(r.statuses.at(-1).state,'success');
});
