'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {Store}=require('../src/db');
const {ReviewService}=require('../src/service');

const metadata={webhookId:'delivery-atomic',eventType:'merge_request',projectId:7,mrIid:9};
function enqueue(store){return store.enqueue({projectId:7,mrIid:9,trigger:'command',dedupeKey:'command:delivery-atomic',requestWebhookId:metadata.webhookId});}

test('webhook, nested job and Flow intent roll back together; retry commits once',()=>{
  const store=new Store(':memory:');
  try{
    assert.throws(()=>store.acceptWebhook(metadata,()=>{
      enqueue(store);
      store.transitionFlowState({projectId:7,flowType:'pipeline',externalId:'1',status:'failed',deliveryIdentity:metadata.webhookId},()=>[]);
      throw new Error('flow interrupted');
    }),/flow interrupted/);
    assert.equal(store.stats().webhookCount,0);
    assert.equal(store.queueDepth(),0);
    assert.equal(store.stats().flowStates,0);
    assert.equal(store.acceptWebhook(metadata,()=>({jobId:enqueue(store)})).duplicate,false);
    assert.equal(store.acceptWebhook(metadata,()=>{throw new Error('must not repeat');}).duplicate,true);
    assert.equal(store.queueDepth(),1);
    assert.ok(store.db.prepare('SELECT processed_at FROM webhook_events').get().processed_at);
  }finally{store.close();}
});

test('unprocessed legacy webhook can finish on redelivery without duplicating its job',()=>{
  const store=new Store(':memory:');
  try{
    store.recordWebhook(metadata);enqueue(store);
    const accepted=store.acceptWebhook(metadata,()=>({jobId:enqueue(store)}));
    assert.equal(accepted.duplicate,false);
    assert.equal(accepted.result.jobId,null);
    assert.equal(store.queueDepth(),1);
    assert.equal(store.acceptWebhook(metadata,()=>{}).duplicate,true);
  }finally{store.close();}
});

test('active cancellation is applied only after durable webhook acceptance',()=>{
  const store=new Store(':memory:'),controller=new AbortController();
  const service=new ReviewService({config:{gitlabProjectAllowlist:new Set([7])},store,gitlab:{},logger:{}});
  service.active.set('7:9',{controller});
  const event={projectId:7,iid:9,projectAllowed:true,shouldCancel:true,action:'close'};
  try{
    assert.throws(()=>store.acceptWebhook(metadata,()=>{service.handleEvent(event,metadata.webhookId);assert.equal(controller.signal.aborted,false);throw new Error('flow failed');}),/flow failed/);
    assert.equal(controller.signal.aborted,false);
    store.acceptWebhook(metadata,()=>{const result=service.handleEvent(event,metadata.webhookId);assert.equal(controller.signal.aborted,false);return result;});
    assert.equal(controller.signal.reason.code,'ECANCELLED');
  }finally{store.close();}
});

for(const crashAt of ['after-record','after-job','after-mark','after-commit']){
  test(`process loss ${crashAt} leaves either no acceptance or one complete acceptance`,()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'service-webhook-crash-')),file=path.join(dir,'state.sqlite');
    try{
      const child=spawnSync(process.execPath,['-e',`
        const {Store}=require(${JSON.stringify(require.resolve('../src/db'))});
        const store=new Store(process.argv[1]),metadata=${JSON.stringify(metadata)};
        const crash=()=>process.exit(73);
        if(process.argv[2]==='after-record'){const original=store.recordWebhook.bind(store);store.recordWebhook=(...args)=>{original(...args);crash();};}
        if(process.argv[2]==='after-mark'){const original=store.markWebhookProcessed.bind(store);store.markWebhookProcessed=(...args)=>{original(...args);crash();};}
        store.acceptWebhook(metadata,()=>{store.enqueue({projectId:7,mrIid:9,trigger:'command',dedupeKey:'command:delivery-atomic',requestWebhookId:metadata.webhookId});if(process.argv[2]==='after-job')crash();return{status:'queued'};});
        crash();
      `,file,crashAt],{encoding:'utf8',timeout:10000});
      assert.equal(child.status,73,child.stderr);
      const store=new Store(file);
      try{
        const committed=crashAt==='after-commit';
        assert.equal(store.stats().webhookCount,committed?1:0);
        assert.equal(store.queueDepth(),committed?1:0);
        assert.equal(store.acceptWebhook(metadata,()=>({jobId:enqueue(store)})).duplicate,committed);
        assert.equal(store.queueDepth(),1);
        assert.equal(store.acceptWebhook(metadata,()=>{}).duplicate,true);
      }finally{store.close();}
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
}
