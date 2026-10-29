'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {superviseWorkers}=require('../src/multi-gitlab');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
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
   await sleep(40);
   assert.equal(workers.length,3,'sensor worker should restart automatically');
   workers[2].emit('message',{type:'ready',port:48003});
   assert.equal(supervisor.lookupPort('sensor'),48003);
   assert.equal(supervisor.status().find(s=>s.instance==='sensor').restarts,0);
   await supervisor.close();
   assert.equal(supervisor.lookupPort('legacy'),0);
   assert.equal(supervisor.lookupPort('sensor'),0);
   const count=workers.length;
   await sleep(40);
   assert.equal(workers.length,count,'closing the gateway must prevent worker resurrection');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
