'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const http=require('node:http');
const {Store}=require('../src/db');
const {Metrics}=require('../src/telemetry');
const {renderMetrics,createHttpServer}=require('../src/http');
function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'review-metrics-truth-'));
 const store=new Store(path.join(dir,'review-service.sqlite'));
 const config={readinessCacheMs:1000,workerConcurrency:0,maxQueueDepth:1000,notificationEnabled:false};
 const service={config,active:new Map(),workers:[],stopping:false};
 return {store,config,service,close(){store.close();fs.rmSync(dir,{recursive:true,force:true});}};
}
test('historical retention is a gauge and active process counters are not duplicated',()=>{
 const f=fixture();
 try{
  const jobId=f.store.enqueue({projectId:7,mrIid:1,trigger:'test',dedupeKey:'metric',maxQueueDepth:1000});
  f.store.claimNext();
  const callId=f.store.modelCalls.begin({jobId,attempt:1,role:'reviewer',provider:'fixture',model:'fixture',estimatedTokens:100});
  f.store.modelCalls.finish(callId,{usage:{inputTokens:12,outputTokens:3},usageKnown:true});
  const metrics=new Metrics();
  metrics.inc('codex_review_input_tokens_total',12);
  metrics.inc('codex_review_output_tokens_total',3);
  const body=renderMetrics(f.store,f.service,null,null,{metrics},Date.now());
  assert.match(body,/# TYPE codex_review_retained_input_tokens gauge\ncodex_review_retained_input_tokens 12/);
  assert.match(body,/# TYPE codex_review_retained_output_tokens gauge\ncodex_review_retained_output_tokens 3/);
  assert.match(body,/# TYPE codex_review_input_tokens_total counter\ncodex_review_input_tokens_total 12/);
  assert.equal((body.match(/# TYPE codex_review_input_tokens_total /g)||[]).length,1);
  assert.equal((body.match(/# TYPE codex_review_output_tokens_total /g)||[]).length,1);
 }finally{f.close();}
});
test('burst of scrapes reuses a bounded 3-second read-only database snapshot',async()=>{
 const f=fixture();
 let calls=0;
 const orig=f.store.stats.bind(f.store);
 f.store.stats=()=>{calls++;return orig();};
 const server=createHttpServer({config:f.config,store:f.store,service:f.service,
  gitlab:{health:()=>({circuit:'closed'}),getVersion:async()=>({version:'fixture'})},
  telemetry:{metrics:new Metrics()},logger:{error(){},warn(){}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const read=()=>new Promise((resolve,reject)=>{
  http.get('http://127.0.0.1:'+server.address().port+'/metrics',res=>{
   let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({code:res.statusCode,body:data}));
  }).on('error',reject);
 });
 try{
  const responses=await Promise.all(Array.from({length:8},read));
  assert.ok(responses.every(r=>r.code===200));
  assert.equal(calls,1,'bursty scrapes must not repeat synchronous SQLite scans');
  assert.ok(responses.every(r=>r.body===responses[0].body));
 }finally{await new Promise(r=>server.close(r));f.close();}
});
