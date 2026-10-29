'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { loadMultiManifest, buildWorkerEnv } = require('./multi-gitlab-config');
const { createMultiGateway } = require('./multi-gitlab-gateway');
const { inspectTenantDatabases } = require('./multi-gitlab-cutover-check');
const { contract } = require('./product-contract');

function audit(event, fields={}) {
  // Do not log manifest contents, credential paths, webhook bodies or tokens.
  process.stdout.write(JSON.stringify({
    ts:new Date().toISOString(),level:'info',event,...fields
  }) + '\n');
}
function superviseWorkers(manifest,{WorkerClass=Worker,workerFile=path.join(__dirname,'index.js'),
  retryBaseMs=1000,retryMaxMs=120000}={}) {
  const states=new Map(manifest.instances.map(item=>[item.id,{
    instance:item,worker:null,port:0,attempt:0,timer:null,ready:false
  }]));
  let closing=false;
  function spawn(id) {
    if (closing) return;
    const state=states.get(id);
    try {
      fs.mkdirSync(state.instance.homeDir,{recursive:true,mode:0o700});
      fs.mkdirSync(state.instance.dataDir,{recursive:true,mode:0o700});
      const worker=new WorkerClass(workerFile,{
        env:buildWorkerEnv(state.instance),
        workerData:{codexReviewInstanceId:id}
      });
      state.worker=worker;
      state.ready=false;
      state.port=0;
      worker.on('message',message=>{
        if (state.worker!==worker || closing) return;
        if (message && message.type==='ready' && Number.isInteger(message.port) &&
            message.port>0 && message.port<=65535) {
          state.port=message.port;
          state.ready=true;
          state.attempt=0;
          audit('gitlab_instance_ready',{instance:id});
        }else if (message && message.type==='startup_failed') {
          audit('gitlab_instance_startup_failed',{instance:id,code:String(message.code||'ESTART').slice(0,80)});
        }
      });
      worker.on('error',error=>{
        if (state.worker===worker && !closing)
          audit('gitlab_instance_runtime_error',{instance:id,code:String(error.code||'EWORKER').slice(0,80)});
      });
      worker.on('exit',code=>{
        if(state.worker!==worker)return;
        state.worker=null;
        state.port=0;
        state.ready=false;
        if (closing) return;
        state.attempt+=1;
        const delay=Math.min(retryMaxMs,retryBaseMs*Math.pow(2,Math.min(7,state.attempt-1)));
        audit('gitlab_instance_unavailable',{instance:id,exitCode:Number(code)||0,restartDelayMs:delay});
        state.timer=setTimeout(()=>{state.timer=null;spawn(id);},delay);
        state.timer.unref?.();
      });
    } catch(error) {
      state.port=0;
      state.ready=false;
      state.attempt+=1;
      audit('gitlab_instance_spawn_failed',{instance:id,code:String(error.code||'ESPAWN').slice(0,80)});
      const delay=Math.min(retryMaxMs,retryBaseMs*Math.pow(2,Math.min(7,state.attempt-1)));
      state.timer=setTimeout(()=>{state.timer=null;spawn(id);},delay);
      state.timer.unref?.();
    }
  }
  async function close({timeoutMs=15000}={}) {
    closing=true;
    for (const state of states.values()) {
      clearTimeout(state.timer);
      state.timer=null;
      state.port=0;
    }
    const tasks=[...states.values()].map(async state=>{
      const worker=state.worker;
      if (!worker) return;
      await new Promise(resolve=>{
        let finished=false;
        const done=()=>{if(finished)return;finished=true;clearTimeout(timer);resolve();};
        const timer=setTimeout(()=>{
          worker.terminate().then(done,done);
        },timeoutMs);
        timer.unref?.();
        worker.once('exit',done);
        try {worker.postMessage({type:'shutdown'});}catch{worker.terminate().then(done,done);}
      });
    });
    await Promise.all(tasks);
  }
  return {
    start:()=>{for(const instance of manifest.instances)spawn(instance.id);},
    lookupPort:id=>states.get(id)?.port||0,
    status:()=>[...states.values()].map(x=>({instance:x.instance.id,ready:x.ready,restarts:x.attempt})),
    close
  };
}
function listen(server,port,host) {
  return new Promise((resolve,reject)=>{
    const error=err=>{server.removeListener('listening',success);reject(err);};
    const success=()=>{server.removeListener('error',error);resolve();};
    server.once('error',error);
    server.once('listening',success);
    server.listen(port,host);
  });
}
function assertPreparedDatabases(report,expectedSchema=contract.databaseSchemaVersion){
  const results=Array.isArray(report?.results)?report.results:[];
  if(!results.length || results.some(item=>
    !item || item.integrity!==true || item.schemaVersion!==expectedSchema)){
    const error=new Error('Multi-GitLab requires prepared, intact current-schema databases before any Worker starts');
    error.code='EMULTIDBPREP';
    throw error;
  }
  // Durable queues can be nonempty after an ordinary restart. Only the
  // one-time operator cutover must be drained; worker recovery owns retries.
  return true;
}
async function startMultiGitLab() {
  const manifest=loadMultiManifest();
  assertPreparedDatabases(inspectTenantDatabases());
  const supervisor=superviseWorkers(manifest);
  const gateway=createMultiGateway({manifest,lookupPort:supervisor.lookupPort});
  await listen(gateway,manifest.server.port,manifest.server.host);
  supervisor.start();
  audit('multi_gitlab_gateway_started',{
    host:manifest.server.host,port:manifest.server.port,
    instanceCount:manifest.instances.length,defaultInstance:manifest.server.defaultInstance
  });
  let closing=false;
  const close=async signal=>{
    if(closing)return;
    closing=true;
    audit('multi_gitlab_shutdown',{signal});
    await new Promise(resolve=>{
      let finished=false;
      const done=()=>{
        if(finished)return;
        finished=true;
        clearTimeout(timer);
        resolve();
      };
      // Accept no new events, then bound the drain of existing connections.
      gateway.close(done);
      gateway.closeIdleConnections?.();
      const timer=setTimeout(()=>gateway.closeAllConnections?.(),10000);
      timer.unref?.();
    });
    await supervisor.close();
  };
  process.on('SIGTERM',()=>close('SIGTERM').catch(()=>{process.exitCode=1;}));
  process.on('SIGINT',()=>close('SIGINT').catch(()=>{process.exitCode=1;}));
  process.on('unhandledRejection',error=>{
    audit('multi_gitlab_fatal',{code:String(error?.code||'EUNHANDLED').slice(0,80)});
    close('unhandledRejection').then(()=>{process.exitCode=1;},()=>{process.exitCode=1;});
  });
  process.on('uncaughtException',error=>{
    audit('multi_gitlab_fatal',{code:String(error?.code||'EUNCAUGHT').slice(0,80)});
    close('uncaughtException').then(()=>{process.exitCode=1;},()=>{process.exitCode=1;});
  });
  return {manifest,gateway,supervisor,close};
}
module.exports={startMultiGitLab,superviseWorkers,listen,assertPreparedDatabases};
