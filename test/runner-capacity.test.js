'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {createRunnerServer}=require('../src/runner-server');
const {applyRunnerCapacity}=require('../src/codex');
const {REVIEW_PROMPT_CONTRACT_VERSION}=require('../src/codex-safe-core/safe-contract');
const config={maxBodyBytes:65536,reviewTimeoutSeconds:30};
const payload=JSON.stringify({prompt:'fixture only',promptContractVersion:REVIEW_PROMPT_CONTRACT_VERSION,maxFindings:1});
function request(server){return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/review',method:'POST'},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body),retryAfter:res.headers['retry-after']}));});req.on('error',reject);req.end(payload);});}

test('real runner endpoint enforces advertised capacity with explicit backpressure',async()=>{
  let release,started,live=0,peak=0,calls=0;
  const ready=new Promise(resolve=>started=resolve),blocked=new Promise(resolve=>release=resolve);
  const server=createRunnerServer({config,runCodexFn:async()=>{calls++;live++;peak=Math.max(peak,live);started();try{await blocked;return{parsed:{findings:[]}};}finally{live--;}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const first=request(server);await ready;
    const extra=await Promise.all(Array.from({length:8},()=>request(server)));
    for(const result of extra){assert.equal(result.status,503);assert.equal(result.body.error,'ERUNNERBUSY');assert.equal(result.retryAfter,'1');}
    assert.equal(calls,1);assert.equal(peak,1);
    release();assert.equal((await first).status,200);
    assert.equal((await request(server)).status,200);
    assert.equal(calls,2);assert.equal(peak,1);
  }finally{release();await new Promise(resolve=>server.close(resolve));}
});

test('runner disconnect releases capacity only after owned operation has stopped',async()=>{
  let started,stopped,calls=0;
  const ready=new Promise(resolve=>started=resolve),done=new Promise(resolve=>stopped=resolve);
  const server=createRunnerServer({config,runCodexFn:async(_prompt,_config,signal)=>{
    calls++;if(calls>1)return{parsed:{findings:[]}};
    started();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{stopped();reject(signal.reason);},{once:true}));
  }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const client=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/review',method:'POST'});client.on('error',()=>{});client.end(payload);
    await ready;client.destroy();await done;await new Promise(resolve=>setImmediate(resolve));
    assert.equal((await request(server)).status,200);
    assert.equal(calls,2);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('controller uses minimum of configured and advertised worker capacity',()=>{
  assert.equal(applyRunnerCapacity({workerConcurrency:8},{runnerCapability:{maxConcurrency:1}}).workerConcurrency,1);
  assert.equal(applyRunnerCapacity({workerConcurrency:1},{runnerCapability:{maxConcurrency:4}}).workerConcurrency,1);
  const inline={workerConcurrency:2};assert.equal(applyRunnerCapacity(inline,{}),inline);
  assert.throws(()=>applyRunnerCapacity(inline,{runnerCapability:{maxConcurrency:0}}),{code:'ERUNNERCONTRACT'});
});
