'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../src/db');
const {Publisher}=require('../src/publication');
const {GitLabClient}=require('../src/gitlab');
const config={botUsername:'bot',maxPublishAttempts:3,retryBaseDelayMs:1,retryMaxDelayMs:5,gitlabApiUrl:'https://gitlab.invalid/api/v4',gitlabToken:'synthetic-token',gitlabRequestTimeoutMs:1000,gitlabRequestsPerSecond:1000};
const refs={base_sha:'b',start_sha:'s',head_sha:'h'};
function setup(store){
  const finding={fingerprint:'a'.repeat(64),claimState:'unknown',claimFingerprint:'',severity:'high',category:'correctness',file:'a.js',side:'new',line:1,endLine:1,title:'Finding',description:'Evidence',suggestion:'',confidence:1};
  store.enqueuePublication({projectId:7,mrIid:9,type:'finding',dedupeKey:'unknown',payload:{headSha:'h',startSha:'s',finding,diffRefs:refs,oldPath:'a.js',newPath:'a.js'}});
  const client=new GitLabClient(config);client.getMergeRequest=async()=>({state:'opened',diff_refs:refs});
  return{client,publisher:new Publisher({config,store,gitlab:client,logger:{}})};
}
test('unknown remote success followed by local settlement failure is terminal and cannot blindly retry',async()=>{
  const store=new Store(':memory:'),original=global.fetch;let creates=0;
  const {publisher}=setup(store),settle=store.settleFindingPublication.bind(store);
  store.settleFindingPublication=value=>{if(value.publicationStatus==='published')throw new Error('local commit failed');return settle(value);};
  global.fetch=async()=>{creates++;assert.equal(store.findingWriteStarted(1),true);return Response.json({id:'remote',notes:[]},{status:201});};
  try{
    await publisher.process(store.claimPublication());
    assert.deepEqual({...store.db.prepare('SELECT status,error_code FROM publication_outbox').get()},{status:'failed',error_code:'ECLAIMPUBLISHUNCERTAIN'});
    store.db.exec("UPDATE publication_outbox SET status='pending',attempt=0,error_code='EADMINRETRY',available_at='2000-01-01'");
    await publisher.process(store.claimPublication());assert.equal(creates,1);
  }finally{global.fetch=original;store.close();}
});
test('durable write intent survives a settlement crash and process restart',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'service-intent-')),db=path.join(dir,'db.sqlite'),original=global.fetch;let store=new Store(db),creates=0;
  const {publisher}=setup(store);store.settleFindingPublication=()=>{throw new Error('disk settlement failure');};
  global.fetch=async()=>{creates++;return Response.json({id:'remote',notes:[]},{status:201});};
  try{
    await assert.rejects(publisher.process(store.claimPublication()),/disk settlement failure/);store.close();store=new Store(db);store.recoverPublications();
    const client=new GitLabClient(config);client.getMergeRequest=async()=>({state:'opened',diff_refs:refs});
    await new Publisher({config,store,gitlab:client,logger:{}}).process(store.claimPublication());
    assert.equal(creates,1);assert.equal(store.db.prepare('SELECT error_code FROM publication_outbox').get().error_code,'ECLAIMPUBLISHUNCERTAIN');
  }finally{global.fetch=original;store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('a circuit rejection before HTTP transport remains retryable without a write intent',async()=>{
  const store=new Store(':memory:'),original=global.fetch;let creates=0;
  const {client,publisher}=setup(store);client.circuit.openUntil=Date.now()+1000;
  global.fetch=async()=>{creates++;return Response.json({id:'remote',notes:[]},{status:201});};
  try{
    await publisher.process(store.claimPublication());assert.equal(creates,0);assert.equal(store.findingWriteStarted(1),false);assert.equal(store.db.prepare('SELECT status FROM publication_outbox').get().status,'pending');
    client.circuit.openUntil=0;store.db.exec("UPDATE publication_outbox SET available_at='2000-01-01'");await publisher.process(store.claimPublication());assert.equal(creates,1);assert.equal(store.db.prepare('SELECT status FROM publication_outbox').get().status,'published');
  }finally{global.fetch=original;store.close();}
});
test('legacy uncertainty remains durable after an administrative attempt reset',async()=>{
  const store=new Store(':memory:'),{publisher}=setup(store);let creates=0;
  publisher.gitlab.createDiscussion=async()=>{creates++;return{id:'remote',notes:[]};};
  try{
    store.db.exec("UPDATE publication_outbox SET payload_json=json_remove(payload_json,'$.findingPublicationProtocol'),attempt=2");
    await publisher.process(store.claimPublication());assert.equal(creates,0);assert.equal(store.findingWriteStarted(1),true);
    store.db.exec("UPDATE publication_outbox SET status='pending',attempt=0,error_code='EADMINRETRY',available_at='2000-01-01'");
    await publisher.process(store.claimPublication());assert.equal(creates,0);
  }finally{store.close();}
});
