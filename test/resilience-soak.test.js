'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/db');

function tempDir(){return fs.mkdtempSync(path.join(os.tmpdir(),'codex-review-resilience-'));}
function cleanup(dir){fs.rmSync(dir,{recursive:true,force:true});}

function enqueue(store,{projectId=1,mrIid=1,headSha='head',dedupeKey,maxQueueDepth=1000,delayMs=0}={}){
  return store.enqueue({projectId,mrIid,headSha,trigger:'webhook',dedupeKey,maxQueueDepth,delayMs});
}

test('queue backpressure fails closed at the configured depth without over-admission',()=>{
  const store=new Store(':memory:');
  for(let i=0;i<32;i++) assert.ok(enqueue(store,{projectId:i+1,mrIid:1,headSha:`head-${i}`,dedupeKey:`burst-${i}`,maxQueueDepth:32}));
  assert.equal(store.queueDepth(),32);
  assert.throws(()=>enqueue(store,{projectId:999,mrIid:1,headSha:'overflow',dedupeKey:'overflow',maxQueueDepth:32}),error=>error?.code==='EQUEUEFULL'&&error?.status===503);
  assert.equal(store.queueDepth(),32);
  store.close();
});

test('rapid updates for one MR supersede stale queued heads instead of growing an unbounded queue',()=>{
  const store=new Store(':memory:');
  let latestId=null;
  for(let i=0;i<200;i++) latestId=enqueue(store,{projectId:7,mrIid:42,headSha:`head-${i}`,dedupeKey:`head-${i}`,maxQueueDepth:8});
  assert.equal(store.queueDepth(),1);
  const claimed=store.claimNext();
  assert.equal(claimed.id,latestId);
  assert.equal(claimed.head_sha,'head-199');
  assert.equal(store.claimNext(),null);
  store.close();
});

test('a running MR serializes later work for the same MR while allowing another MR to proceed',()=>{
  const store=new Store(':memory:');
  const first=enqueue(store,{projectId:3,mrIid:10,headSha:'same-head',dedupeKey:'first'});
  const running=store.claimNext();
  assert.equal(running.id,first);
  const sameMr=enqueue(store,{projectId:3,mrIid:10,headSha:'same-head',dedupeKey:'second'});
  const otherMr=enqueue(store,{projectId:3,mrIid:11,headSha:'other-head',dedupeKey:'other'});
  const next=store.claimNext();
  assert.equal(next.id,otherMr);
  assert.notEqual(next.id,sameMr);
  store.close();
});

test('process restart recovers an in-flight review job for retry without creating a duplicate job',()=>{
  const dir=tempDir();
  const dbPath=path.join(dir,'state.sqlite');
  let store=new Store(dbPath);
  const id=enqueue(store,{projectId:11,mrIid:9,headSha:'restart-head',dedupeKey:'restart'});
  const first=store.claimNext();
  assert.equal(first.id,id);
  assert.equal(first.attempt,1);
  store.close();

  store=new Store(dbPath);
  assert.equal(store.recoverInterruptedJobs(),1);
  assert.equal(store.queueDepth(),1);
  const retry=store.claimNext();
  assert.equal(retry.id,id);
  assert.equal(retry.attempt,2);
  assert.equal(store.queueDepth(),0);
  store.close();
  cleanup(dir);
});

test('duplicate webhook burst is idempotent at the durable ingress boundary',()=>{
  const store=new Store(':memory:');
  let accepted=0;
  for(let i=0;i<500;i++) if(store.recordWebhook({webhookId:'same-delivery',eventType:'merge_request',projectId:1,mrIid:2})) accepted++;
  assert.equal(accepted,1);
  store.close();
});
