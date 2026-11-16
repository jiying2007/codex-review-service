'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const fs=require('node:fs');
const Module=require('node:module');
const contract=require('../src/codex-safe-core/safe-contract');
const processRunner=require('../src/codex-safe-core/process-runner');
let scenario={},executions=0;
// Exercise the actual Core CLI -> Service adapter -> router -> SQLite path.
// The only replacement is the process boundary; no executable/model is run.
processRunner.createProcessRunner=()=>({runPreparedProcess:async(_command,args,options={})=>{
  if(args.includes('--version'))return {stdout:'codex-cli usage-fixture'};
  if(args.includes('--help'))return {stdout:[...contract.REQUIRED_CODEX_TOP_LEVEL_FLAGS,...contract.REQUIRED_CODEX_EXEC_FLAGS,'--model'].join('\n')};
  executions++;
  scenario.onExecution?.();
  const emission=scenario.responses?.[executions-1]||scenario;
  const completion={type:'turn.completed'};
  if(Object.hasOwn(emission,'rawUsage'))completion.usage=emission.rawUsage;
  const stdout=[{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:scenario.invalidJson?'not-json':JSON.stringify(emission.parsed||{findings:[]})}},completion].map(JSON.stringify).join('\n')+'\n';
  if(scenario.streaming!==false)options.onStdoutChunk?.(Buffer.from(stdout));
  if(scenario.processFailure)throw Object.assign(new Error('fixture transport timeout'),{code:'ETIMEDOUT',stdout});
  return {stdout,stderr:'',exitCode:0,stdoutTruncated:scenario.truncated===true};
}});
const {runCodexLocal,runCodex}=require('../src/codex');
const {ReviewService}=require('../src/service');
const {Store}=require('../src/db');
const {createRunnerServer}=require('../src/runner-server');
const {normalizeObservedCodexUsage,observedUsage}=require('../src/model-usage');
const {resolveReviewProfilePack}=require('../src/codex-safe-core/review-profile-pack');
const factor=resolveReviewProfilePack('general').tokenFactor;
const config={gitlabProjectAllowlist:new Set([7]),maxQueueDepth:10,manualMinAccessLevel:30,maxJobAttempts:2,retryBaseDelayMs:10,retryMaxDelayMs:100,jobTimeoutSeconds:30,maxDiffBytes:4096,maxTotalDiffBytes:12000,maxReviewChunks:2,maxFindings:10,maxPublishedFindings:10,minConfidence:0.7,blockingSeverity:'high',reviewTimeoutSeconds:30,codexPath:'fixture-never-executed',codexProviderMode:'openai',codexVersionPolicy:'off',codexModelSelectionStrategy:'auto',codexFixedModel:'',codexModelCandidates:[],codexModelCompatibilityPolicy:'strict',codexScoutEnabled:false,codexAdjudicatorEnabled:false,codexAdjudicatorMinSeverity:'high',codexShadowCandidate:'',codexModel:'',codexHome:'',workerConcurrency:1,pollIntervalMs:10,autoResolveObsolete:true,reviewDebounceMs:0,reviewDraftMergeRequests:false,triggerAssignment:{mode:'always',userIds:[]},mrMaxTokenBudget:0,projectDailyTokenBudget:0,contextEnabled:false,adaptiveContextEnabled:true,maxContextBytes:0,maxContextFiles:0,contextLines:0,skipGeneratedFiles:true,blockUnreviewableFiles:false};
const policy={language:'en',maxDiffBytes:4096,maxReviewChunks:2,maxFindings:10,maxPublishedFindings:10,minConfidence:0.7,blockingSeverity:'high',severityThreshold:'info',timeoutSeconds:30,extraInstructions:'',skipGeneratedFiles:true,blockUnreviewableFiles:false,maxContextBytes:0,maxContextFiles:0,contextLines:0,source:'fixture',fingerprint:'a'.repeat(64)};
const mr={project_id:7,source_project_id:7,target_project_id:7,iid:9,state:'opened',draft:false,source_branch:'feat',target_branch:'main',diff_refs:{base_sha:'b'.repeat(40),start_sha:'c'.repeat(40),head_sha:'d'.repeat(40)}};
const diff=n=>({old_path:`${n}.js`,new_path:`${n}.js`,diff:`@@ -1 +1 @@\n-${'a'.repeat(1700)}\n+${'b'.repeat(1700)}`});
async function review(fixture={},overrides={},prepare=null,Service=ReviewService){
  scenario=fixture;executions=0;
  const store=new Store(':memory:');
  try{
    const metrics=[],genAi=[],logs=[];
    const telemetry={traceId:()=> '0'.repeat(32),span:async(_trace,_name,_attributes,fn)=>fn(),metrics:{inc:(name,value)=>metrics.push({kind:'counter',name,value}),observe:(name,value)=>metrics.push({kind:'histogram',name,value})},recordGenAiClient:value=>genAi.push(value)};
    const gitlab={getMergeRequest:async()=>mr,resolveStatusPipeline:async()=>1,listMergeRequestDiffs:async()=>({complete:true,items:[diff(1),diff(2)]}),validateMergeRequestDiffCoverage:async()=>({complete:true})};
    const service=new Service({config:{...config,...overrides},store,gitlab,telemetry,logger:{info:value=>logs.push(value)},getPolicyFn:async()=>policy,contextFn:async()=>({blocks:[],complete:true}),runCodexFn:runCodexLocal});
    const id=store.enqueue({projectId:7,mrIid:9,trigger:'open',dedupeKey:'usage-fixture'});
    let job=store.claimNext();
    if(prepare)job=prepare(store,job)||job;
    await service.processJob(job);
    const rows=store.db.prepare('SELECT attempt,outcome,estimated_tokens,usage_known,input_tokens,output_tokens,error_code FROM model_calls ORDER BY id').all();
    return {executions,job:store.getJob(id),rows,charged:store.tokenUsageSince(7,'2000'),jobCharged:store.modelCalls.budgetUsageForJob(id),unknown:store.modelCalls.unknownForAttempt(id,job.attempt),stats:store.stats().usage,next:store.claimNext(),metrics,genAi,calibration:[...service.tokenCalibration.entries.values()],routing:logs.find(value=>value.event==='model_routing_evidence')};
  }finally{store.close();}
}
function assertUnknown(result){
  assert.ok(result.rows.length>0);
  assert.ok(result.rows.every(row=>row.usage_known===0&&row.input_tokens===null&&row.output_tokens===null));
  assert.equal(result.charged,result.rows.reduce((sum,row)=>sum+row.estimated_tokens,0));
  assert.equal(result.jobCharged,result.charged);
  assert.equal(result.stats.unknownCalls,result.rows.length);
  assert.equal(result.stats.estimatedUnknownTokens,result.charged);
}

test('missing and partial raw usage remain unknown through the real accounting path',async()=>{
  for(const fixture of [{},{rawUsage:{input_tokens:100}},{rawUsage:{output_tokens:20}}]){
    const result=await review(fixture);
    assert.equal(result.executions,2);assert.equal(result.job.status,'pass');assertUnknown(result);
  }
});
test('complete usage and explicit observed zero settle once with the actual counts',async()=>{
  for(const [rawUsage,total] of [[{input_tokens:100,output_tokens:20},240],[{input_tokens:0,output_tokens:0},0]]){
    const result=await review({rawUsage});
    assert.equal(result.executions,2);assert.equal(result.charged,total);assert.equal(result.jobCharged,total);
    assert.equal(result.stats.unknownCalls,0);assert.ok(result.rows.every(row=>row.usage_known===1));
    assert.equal(result.genAi.length,2);assert.equal(result.routing.usageKnown,true);assert.notEqual(result.routing.economics,null);
  }
});
test('unknown usage cannot become measured metrics, calibration samples or an economics score',async()=>{
  for(const rawUsage of [{input_tokens:100},{input_tokens:100,output_tokens:-20},{input_tokens:100,output_tokens:20,cached_input_tokens:101}]){
    const result=await review({rawUsage});assertUnknown(result);
    assert.equal(result.calibration.length,0);
    assert.equal(result.genAi.length,0);
    assert.equal(result.metrics.some(item=>/tokens_total$|input_bytes_per_token/.test(item.name)),false);
    assert.equal(result.routing.economics,null);assert.equal(result.routing.usageKnown,false);
    assert.equal(result.metrics.filter(item=>item.name==='gen_ai_client_operation_duration_seconds').length,2);
    assert.equal(result.metrics.filter(item=>item.name==='codex_review_chunk_estimated_tokens').length,2);
  }
});
test('malformed raw counts, conflicting aliases and inconsistent totals cannot become known',async()=>{
  const invalid=[{input_tokens:'100',output_tokens:20},{input_tokens:100,output_tokens:null},{input_tokens:100,output_tokens:-1},{input_tokens:100,output_tokens:1.5},{input_tokens:100,output_tokens:Number.MAX_SAFE_INTEGER},{input_tokens:100,output_tokens:20,cached_input_tokens:'0'},{input_tokens:100,output_tokens:20,cache_write_input_tokens:101},{input_tokens:100,output_tokens:20,reasoning_output_tokens:21},{input_tokens:100,inputTokens:99,output_tokens:20},{input_tokens:100,output_tokens:20,total_tokens:121},{input_tokens:100,output_tokens:20,total_tokens:'120'}];
  for(const rawUsage of invalid)assertUnknown(await review({rawUsage}));
  assert.equal(normalizeObservedCodexUsage({input_tokens:1,output_tokens:Infinity}),null);
  assert.equal(normalizeObservedCodexUsage({input_tokens:1,output_tokens:NaN}),null);
  assert.equal(observedUsage({inputTokens:Number.MAX_SAFE_INTEGER,outputTokens:1},true),null);
  assert.deepEqual(normalizeObservedCodexUsage({input_tokens:100,inputTokens:100,output_tokens:20,total_tokens:120}),{inputTokens:100,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:20,reasoningOutputTokens:0});
  assert.notEqual(normalizeObservedCodexUsage({input_tokens:100,output_tokens:20,cached_input_tokens:100,reasoning_output_tokens:20}),null);
});
test('non-streaming complete output is inspected, while a capture-only tail remains unknown',async()=>{
  const complete=await review({rawUsage:{input_tokens:100,output_tokens:20},streaming:false});
  assert.equal(complete.charged,240);assert.equal(complete.stats.unknownCalls,0);
  assertUnknown(await review({rawUsage:{input_tokens:100,output_tokens:20},streaming:false,truncated:true}));
});
test('MR preflight retains unknown estimates across chunks without counting the next intent twice',async()=>{
  const baseline=await review(),first=baseline.rows[0].estimated_tokens;
  const result=await review({}, {mrMaxTokenBudget:Math.ceil(first/factor)});
  assert.equal(result.executions,1,'the first call fits exactly; the next call does not');
  assert.equal(result.job.status,'incomplete');assert.equal(result.rows.length,1);assert.equal(result.charged,first);assertUnknown(result);
});
test('MR preflight settles complete usage instead of adding both observation and estimate',async()=>{
  const baseline=await review(),first=baseline.rows[0].estimated_tokens,second=baseline.rows[1].estimated_tokens;
  // Preflight must admit the first complete estimated request, then account
  // for measured 120 tokens rather than retaining its previous estimate.
  // A profile/context change may make either chunk the larger request.
  const budget=Math.max(first,120+second);
  const result=await review({rawUsage:{input_tokens:100,output_tokens:20}},
    {mrMaxTokenBudget:Math.ceil(budget/factor)});
  assert.equal(result.executions,2);assert.equal(result.job.status,'pass');assert.equal(result.charged,240);
});
test('budget interruptions retain completed roles and cannot create empty zero-cost economics',async()=>{
  const registry={revision:'usage-fixture',models:[{provider:'openai',model:'scout-fixture',class:'fast',roles:['scout'],status:'approved',health:'healthy',qualificationId:'q-scout'},{provider:'openai',model:'review-fixture',class:'balanced',roles:['reviewer'],status:'approved',health:'healthy',qualificationId:'q-review'},{provider:'openai',model:'judge-fixture',class:'frontier',roles:['adjudicator'],status:'approved',health:'healthy',qualificationId:'q-judge'}]};
  const filename=require.resolve('../src/service'),isolated=new Module(filename,module),routing=require('../src/model-routing-runtime');
  isolated.filename=filename;isolated.paths=module.paths;const originalRequire=isolated.require.bind(isolated);
  isolated.require=request=>request==='./model-routing-runtime'?{...routing,createServiceModelRouter:config=>routing.createServiceModelRouter(config,{registryResolution:{registry,source:'fixture'},runtimeInspection:{providerId:'openai'}})}:originalRequire(request);
  isolated._compile(fs.readFileSync(filename,'utf8'),filename);
  const baseline=await review(),first=baseline.rows[0].estimated_tokens;
  const finding={severity:'high',category:'correctness',file:'1.js',side:'new',line:1,endLine:1,title:'Fixture regression',description:'Fixture changed line violates an invariant.',suggestion:'Repair the change.',confidence:.95};
  const cases=[
    {fixture:{},overrides:{codexScoutEnabled:true},executions:1,scouts:1,known:[0]},
    {fixture:{rawUsage:{input_tokens:3500,output_tokens:100}},overrides:{codexScoutEnabled:true},executions:1,scouts:1,known:[1]},
    {fixture:{rawUsage:{input_tokens:3500,output_tokens:100},parsed:{findings:[finding]}},overrides:{codexAdjudicatorEnabled:true},executions:1,scouts:0,known:[1]},
    {fixture:{responses:[{rawUsage:{input_tokens:100,output_tokens:20}},{rawUsage:{input_tokens:100,output_tokens:20}},{}]},overrides:{codexScoutEnabled:true,mrMaxTokenBudget:Math.ceil((first*1.5)/factor)},executions:3,scouts:2,known:[1,1,0]}
  ];
  for(const item of cases){
    const result=await review(item.fixture,{mrMaxTokenBudget:Math.ceil(first/factor),...item.overrides},null,isolated.exports.ReviewService);
    assert.equal(result.executions,item.executions);assert.equal(result.rows.length,item.executions);assert.equal(result.job.status,'incomplete');assert.ok(result.charged>0);
    assert.deepEqual(result.rows.map(row=>row.usage_known),item.known);
    assert.equal(result.routing.economics,null);assert.equal(result.routing.usageKnown,item.known.every(Boolean));
    assert.equal(result.routing.productionCalls,item.executions);assert.equal(result.routing.scoutCalls,item.scouts);assert.equal(result.routing.economicsComplete,false);
  }
  const stopped=await review({}, {codexScoutEnabled:true,mrMaxTokenBudget:1},null,isolated.exports.ReviewService);
  assert.equal(stopped.executions,0);assert.equal(stopped.rows.length,0);assert.equal(stopped.routing.usageKnown,true);assert.equal(stopped.routing.economics.usage.totalTokens,0);
});
test('project preflight continues to charge unknown estimates independently',async()=>{
  const baseline=await review(),first=baseline.rows[0].estimated_tokens;
  const result=await review({}, {projectDailyTokenBudget:first});
  assert.equal(result.executions,1);assert.equal(result.job.status,'incomplete');assert.equal(result.charged,first);assertUnknown(result);
});
test('earlier paid attempts remain in the same job MR budget',async()=>{
  const baseline=await review(),first=baseline.rows[0].estimated_tokens;
  const result=await review({}, {mrMaxTokenBudget:Math.ceil(first/factor)}, (store,job)=>{
    const id=store.modelCalls.begin({jobId:job.id,attempt:job.attempt,role:'reviewer',provider:'fixture',model:'fixture',estimatedTokens:700});
    store.modelCalls.finish(id,{failed:true,errorCode:'ECODEX_RATE_LIMIT',usage:{inputTokens:500,outputTokens:0},usageKnown:true});
    store.retryJob(job.id,'ECODEX_RATE_LIMIT',0);return store.claimNext();
  });
  assert.equal(result.job.attempt,2);assert.equal(result.executions,0);assert.equal(result.job.status,'incomplete');
  assert.equal(result.rows.length,1);assert.equal(result.rows[0].attempt,1);assert.equal(result.charged,500);
});
test('process and output failures retain unknown billing and cannot be automatically replayed',async()=>{
  for(const fixture of [{processFailure:true},{invalidJson:true}])for(const usage of [{},{rawUsage:{input_tokens:100}},{rawUsage:{input_tokens:100,output_tokens:20}}]){
      const result=await review({...fixture,...usage});
      assert.equal(result.executions,1);assert.equal(result.job.status,'failed');assert.equal(result.job.error_code,'EMODELCALLUNCERTAIN');
      assert.equal(result.unknown,1);assert.equal(result.next,null);assertUnknown(result);
    }
});

async function controllerResult(payload){
  const original=http.request;
  http.request=(_options,callback)=>{
    const request=new EventEmitter();
    request.end=()=>queueMicrotask(()=>{const response=new PassThrough();response.statusCode=200;callback(response);response.end(JSON.stringify(payload));});
    request.destroy=error=>request.emit('error',error);
    return request;
  };
  try{return await runCodex('fixture',{...config,codexRunnerSocket:'/fixture/not-opened'});}
  finally{http.request=original;}
}
test('Controller validates the Runner observation flag and original fields before normalization',async()=>{
  for(const payload of [{usage:{inputTokens:100,outputTokens:0}},{usage:{inputTokens:100},usageKnown:true},{usage:{inputTokens:100,outputTokens:'20'},usageKnown:true},{usage:{inputTokens:100,outputTokens:20,totalTokens:121},usageKnown:true},{usage:{inputTokens:100,input_tokens:99,outputTokens:20},usageKnown:true},{usage:{inputTokens:100,outputTokens:20,cachedInputTokens:101},usageKnown:true},{usage:{inputTokens:100,outputTokens:20,reasoningOutputTokens:21},usageKnown:true},{usage:null,usageKnown:true}])assert.equal((await controllerResult(payload)).usageKnown,false);
  assert.equal((await controllerResult({usage:{inputTokens:0,outputTokens:0},usageKnown:true})).usageKnown,true);
});
async function runnerResult(){
  const server=createRunnerServer({config:{...config,maxBodyBytes:1024}}),request=new PassThrough(),response=new EventEmitter();
  request.method='POST';request.url='/review';response.writeHead=status=>{response.statusCode=status;};response.writableEnded=false;response.destroyed=false;
  const done=new Promise(resolve=>{response.end=body=>{response.writableEnded=true;resolve({status:response.statusCode,payload:JSON.parse(String(body))});};});
  server.emit('request',request,response);
  request.end(JSON.stringify({prompt:'fixture',maxFindings:1,reviewTimeoutSeconds:30,promptContractVersion:contract.REVIEW_PROMPT_CONTRACT_VERSION}));
  return done;
}
test('isolated Runner preserves explicit zero and unknown observations across its JSON response',async()=>{
  for(const [fixture,known] of [[{},false],[{rawUsage:{input_tokens:100}},false],[{rawUsage:{input_tokens:0,output_tokens:0}},true]]){
    scenario=fixture;const response=await runnerResult();assert.equal(response.status,200);
    assert.equal(response.payload.usageKnown,known);assert.equal((await controllerResult(response.payload)).usageKnown,known);
  }
});
