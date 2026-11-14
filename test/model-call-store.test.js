'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const {Store}=require('../src/db');
const {migrate11To12,verifyMigrationBackup}=require('../src/db-migrations');

function job(store,key='one'){const id=store.enqueue({projectId:7,mrIid:9,trigger:'command',dedupeKey:key});store.claimNext();return id;}
function call(store,jobId,extra={}){return store.modelCalls.begin({jobId,attempt:1,role:'reviewer',provider:'fixture',model:'fixture',estimatedTokens:500,...extra});}

test('call accounting includes partial failure and never counts final run usage twice',()=>{
  const store=new Store(':memory:');
  try{
    const id=job(store),first=call(store,id);store.modelCalls.finish(first,{usage:{inputTokens:100,outputTokens:20}});
    const second=call(store,id);store.modelCalls.finish(second,{failed:true,errorCode:'ECODEXTIMEOUT'});
    assert.equal(store.modelCalls.unknownForAttempt(id,1),1);
    assert.equal(store.tokenUsageSince(7,'2000'),620,'unobserved call uses an explicit estimate for configured budget accounting');
    const summary=store.stats().usage;assert.equal(summary.input,100);assert.equal(summary.output,20);assert.equal(summary.unknownCalls,1);assert.equal(summary.estimatedUnknownTokens,500);
    store.saveRunWithOutbox(id,{verdict:'pass',summary:'fixture',findings:[],coverageComplete:true,usage:{inputTokens:100,outputTokens:20}},1,{source:'fixture',fingerprint:'fixture'},[]);
    assert.equal(store.stats().usage.input,100);assert.equal(store.tokenUsageSince(7,'2000'),620);
    assert.equal(store.modelCalls.finish(first,{usage:{inputTokens:900,outputTokens:900}}),0,'settlement is idempotent');
  }finally{store.close();}
});

test('missing usage remains unknown; explicit observed zero is distinguishable',()=>{
  const store=new Store(':memory:');
  try{
    const id=job(store);store.modelCalls.finish(call(store,id),{usage:{inputTokens:0,outputTokens:0}});
    store.modelCalls.finish(call(store,id),{usage:{inputTokens:0,outputTokens:0},usageKnown:true});
    const rows=store.db.prepare('SELECT usage_known,input_tokens,output_tokens FROM model_calls ORDER BY id').all();
    assert.deepEqual(rows.map(row=>[row.usage_known,row.input_tokens,row.output_tokens]),[[0,null,null],[1,0,0]]);
  }finally{store.close();}
});

test('process loss keeps observed cost and parks unfinished calls instead of replaying',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'service-usage-crash-')),file=path.join(dir,'state.sqlite');
  try{
    const child=spawnSync(process.execPath,['-e',`
      const {Store}=require(${JSON.stringify(require.resolve('../src/db'))});
      const store=new Store(process.argv[1]);const id=store.enqueue({projectId:7,mrIid:9,trigger:'command',dedupeKey:'one'});store.claimNext();
      const start=()=>store.modelCalls.begin({jobId:id,attempt:1,role:'reviewer',provider:'fixture',model:'fixture',estimatedTokens:500});
      store.modelCalls.finish(start(),{usage:{inputTokens:100,outputTokens:20}});start();process.exit(73);
    `,file],{encoding:'utf8',timeout:10000});
    assert.equal(child.status,73,child.stderr);
    const store=new Store(file);
    try{
      assert.equal(store.recoverInterruptedJobs(),0);
      assert.equal(store.getJob(1).status,'failed');assert.equal(store.getJob(1).error_code,'EMODELCALLUNCERTAIN');
      assert.equal(store.claimNext(),null);assert.equal(store.tokenUsageSince(7,'2000'),620);
      assert.deepEqual(store.db.prepare('SELECT outcome FROM model_calls ORDER BY id').all().map(row=>row.outcome),['succeeded','unknown']);
    }finally{store.close();}
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

for(const fail of [false,true]){
  test(`Schema 11 call-ledger migration ${fail?'rolls back on injected failure':'preserves jobs and verifies backup'}`,()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'service-usage-migrate-')),file=path.join(dir,'state.sqlite');
    let db;
    try{
      const store=new Store(file);job(store);store.db.exec('DROP TABLE model_calls; DELETE FROM schema_migrations WHERE version=12; PRAGMA user_version=11;');store.close();
      db=new DatabaseSync(file);
      if(fail){assert.throws(()=>migrate11To12(db,file,{beforeCommit(){throw new Error('injected');}}),{code:'EDBMIGRATION'});assert.equal(db.prepare('PRAGMA user_version').get().user_version,11);assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='model_calls'").get().n,0);}
      else{const migration=migrate11To12(db,file);assert.equal(verifyMigrationBackup(migration.backupPath,11),true);assert.equal(db.prepare('PRAGMA user_version').get().user_version,12);assert.equal(db.prepare('SELECT COUNT(*) n FROM model_calls').get().n,0);}
      assert.equal(db.prepare('SELECT status FROM review_jobs WHERE id=1').get().status,'running');
    }finally{db?.close();fs.rmSync(dir,{recursive:true,force:true});}
  });
}
