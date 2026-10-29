'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {superviseWorkers,assertPreparedDatabases}=require('../src/multi-gitlab');
const {contract}=require('../src/product-contract');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(predicate,{timeoutMs=1500,pollMs=15}={}){
 const start=Date.now();
 while(Date.now()-start<timeoutMs){
   if(predicate())return;
   await sleep(pollMs);
 }
 assert.fail('timed out while awaiting expected Worker state');
}
test('worker crash isolates the affected GitLab, restarts with bounded backoff and drains cleanly',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'multi-workers-')),workers=[];
 class MockWorker extends EventEmitter {
   constructor(file,options){super();this.options=options;workers.push(this);}
   postMessage(message){if(message?.type==='shutdown')this.emit('exit',0);}
   terminate(){this.emit('exit',1);return Promise.resolve(1);}
 }
 const manifest={instances:[
   {id:'legacy',configFile:path.join(dir,'legacy.json'),homeDir:path.join(dir,'legacy-home'),
     dataDir:path.join(dir,'legacy-db'),secretFiles:{GITLAB_API_TOKEN_FILE:path.join(dir,'old.token')}},
   {id:'sensor',configFile:path.join(dir,'sensor.json'),homeDir:path.join(dir,'sensor-home'),
     dataDir:path.join(dir,'sensor-db'),secretFiles:{GITLAB_API_TOKEN_FILE:path.join(dir,'new.token')}}
 ]};
 try{
   const supervisor=superviseWorkers(manifest,{WorkerClass:MockWorker,workerFile:path.join(dir,'fake-worker'),
     retryBaseMs:10,retryMaxMs:20});
   supervisor.start();
   assert.equal(workers.length,2);
   assert.equal(supervisor.lookupPort('legacy'),0,'unready worker cannot accept requests');
   assert.notEqual(workers[0].options.env.CODEX_HOME,workers[1].options.env.CODEX_HOME);
   workers[0].emit('message',{type:'ready',port:48001});
   workers[1].emit('message',{type:'ready',port:48002});
   assert.equal(supervisor.lookupPort('legacy'),48001);
   assert.equal(supervisor.lookupPort('sensor'),48002);
   workers[1].emit('exit',7);
   assert.equal(supervisor.lookupPort('sensor'),0);
   assert.equal(supervisor.lookupPort('legacy'),48001,'other GitLab remains available');
   await waitFor(()=>workers.length===3);
   assert.equal(workers.length,3,'sensor worker should restart automatically');
   workers[2].emit('message',{type:'ready',port:48003});
   assert.equal(supervisor.lookupPort('sensor'),48003);
   assert.equal(supervisor.status().find(s=>s.instance==='sensor').restarts,1,
     'a recovered Worker still contributes to cumulative restart monitoring');
   assert.equal(supervisor.status().find(s=>s.instance==='sensor').backoffAttempt,0);
   assert.equal(supervisor.restartCount('legacy'),0);
   assert.equal(supervisor.restartCount('sensor'),1);
   await supervisor.close();
   assert.equal(supervisor.lookupPort('legacy'),0);
   assert.equal(supervisor.lookupPort('sensor'),0);
   const count=workers.length;
   await sleep(40);
   assert.equal(workers.length,count,'closing the gateway must prevent worker resurrection');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('a first multi-GitLab start cannot mount old/missing DB, but restart can recover queued jobs',()=>{
 const schema=contract.databaseSchemaVersion;
 const healthy={id:'legacy',schemaVersion:schema,integrity:true,drained:true};
 assert.equal(assertPreparedDatabases({results:[healthy,{...healthy,id:'sensor'}]}),true);
 assert.equal(assertPreparedDatabases({results:[{...healthy,drained:false,code:'EDBNOTDRAINED'}]}),true,
   'ordinary crash recovery must not discard queued durable jobs');
 for(const bad of [
   {results:[]},
   {results:[{...healthy,schemaVersion:9}]},
   {results:[{...healthy,integrity:false}]},
   {results:[{id:'missing',drained:false,code:'EDBMISSING'}]},
   {results:[healthy,{...healthy,id:'sensor',schemaVersion:9}]}
 ]){
   assert.throws(()=>assertPreparedDatabases(bad),error=>error?.code==='EMULTIDBPREP');
 }
});

test('stalled tenant initialization is terminated without disabling healthy legacy worker',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'multi-worker-timeout-'));
  const created=[];
  class MockWorker extends EventEmitter {
    constructor(file,options){
      super();
      this.options=options;
      created.push(this);
      if(options.workerData.codexReviewInstanceId==='legacy'||
          created.filter(x=>x.options.workerData.codexReviewInstanceId==='sensor').length>1){
        queueMicrotask(()=>this.emit('message',{
          type:'ready',
          port:options.workerData.codexReviewInstanceId==='legacy'?48101:48102
        }));
      }
    }
    postMessage(message){if(message?.type==='shutdown')this.emit('exit',0);}
    terminate(){this.emit('exit',1);return Promise.resolve(1);}
  }
  const make=id=>({id,configFile:path.join(directory,id+'.json'),
    homeDir:path.join(directory,id+'-home'),dataDir:path.join(directory,id+'-state'),
    secretFiles:{GITLAB_API_TOKEN_FILE:path.join(directory,id+'.token')}});
  const supervisor=superviseWorkers({instances:[make('legacy'),make('sensor')]},{
    WorkerClass:MockWorker,workerFile:path.join(directory,'worker.js'),
    startTimeoutMs:12,retryBaseMs:12,retryMaxMs:25
  });
  try{
    supervisor.start();
    await waitFor(()=>supervisor.lookupPort('sensor')===48102);
    assert.equal(supervisor.lookupPort('legacy'),48101);
    assert.equal(supervisor.lookupPort('sensor'),48102);
    assert.ok(created.length>=3,'timed out sensor worker must be restarted');
    assert.equal(created.filter(x=>x.options.workerData.codexReviewInstanceId==='legacy').length,1);
  }finally{
    await supervisor.close();
    fs.rmSync(directory,{recursive:true,force:true});
  }
});
