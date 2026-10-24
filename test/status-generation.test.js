'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/db');
const {Publisher}=require('../src/publication');
const {GitLabClient}=require('../src/gitlab');
const refs={base_sha:'b',start_sha:'s',head_sha:'h'};
const config={statusName:'review',maxPublishAttempts:3,retryBaseDelayMs:10000,retryMaxDelayMs:10000,gitlabApiUrl:'https://gitlab.invalid/api/v4',gitlabToken:'synthetic-token',gitlabRequestTimeoutMs:1000,gitlabStatusRetries:2,gitlabRequestsPerSecond:1000};
function status(store,state,description,startSha='s',pipelineId=123,mrIid=9){
  const id=store.enqueue({projectId:7,mrIid,trigger:'command',dedupeKey:description,headSha:'h',startSha});
  store.bindJobSnapshot(id,{baseSha:'b',startSha,headSha:'h',sourceBranch:'feat',statusProjectId:7,pipelineId});
  store.finishJob(id,state==='success'?'pass':'blocked');
  store.enqueuePublication({projectId:7,mrIid,type:'status',dedupeKey:`job:${id}:status:final`,payload:{jobId:id,statusName:'review',startSha,statusProjectId:7,headSha:'h',ref:'feat',pipelineId,state,description}});
  return id;
}
function mr(){return{state:'opened',diff_refs:refs};}
test('an old success retry cannot overwrite a newer failed status on the same SHA/pipeline',async()=>{
  const store=new Store(':memory:'),writes=[];let failOld=true;
  const gitlab={getMergeRequest:async()=>mr(),setCommitStatus:async(_project,_sha,state,description,_ref,_pipeline,{beforeSend})=>{beforeSend();if(failOld){failOld=false;throw Object.assign(new Error('lost'),{code:'EGITLABNETWORK'});}writes.push({state,description});return{id:writes.length};}};
  const publisher=new Publisher({config,store,gitlab,logger:{}});
  try{
    status(store,'success','old');await publisher.process(store.claimPublication());
    status(store,'failed','new');await publisher.process(store.claimPublication());
    store.db.exec("UPDATE publication_outbox SET available_at='2000-01-01' WHERE status='pending'");
    await publisher.process(store.claimPublication());
    assert.deepEqual(writes,[{state:'failed',description:'new'}]);
    assert.equal(store.db.prepare('SELECT status FROM publication_outbox ORDER BY id LIMIT 1').get().status,'cancelled');
  }finally{store.close();}
});
test('generation changes while rate limited are checked before the actual HTTP write',async()=>{
  const store=new Store(':memory:'),client=new GitLabClient(config),original=global.fetch,writes=[];
  let release,entered;const waiting=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  client.getMergeRequest=async()=>mr();client.limiter.acquire=async()=>{entered();await gate;};
  global.fetch=async(url)=>{writes.push(new URL(url).searchParams.get('state'));return Response.json({id:1},{status:201});};
  const publisher=new Publisher({config,store,gitlab:client,logger:{}});
  try{
    status(store,'success','old');const old=publisher.process(store.claimPublication());await waiting;
    status(store,'failed','new');release();await old;await publisher.process(store.claimPublication());
    assert.deepEqual(writes,['failed']);
  }finally{global.fetch=original;store.close();}
});
test('the internal GitLab 409 retry rechecks generation before resending',async()=>{
  const store=new Store(':memory:'),client=new GitLabClient(config),original=global.fetch,writes=[];
  let observed;const first=new Promise(resolve=>{observed=resolve;});
  client.getMergeRequest=async()=>mr();
  global.fetch=async(url)=>{const state=new URL(url).searchParams.get('state');writes.push(state);if(writes.length===1){observed();return Response.json({},{status:409});}return Response.json({id:1},{status:201});};
  const publisher=new Publisher({config,store,gitlab:client,logger:{}});
  try{
    status(store,'success','old');const old=publisher.process(store.claimPublication());await first;
    status(store,'failed','new');const current=publisher.process(store.claimPublication());await Promise.all([old,current]);
    assert.deepEqual(writes,['success','failed']);
  }finally{global.fetch=original;store.close();}
});
test('same-target writes remain serialized while a newer review completes',async()=>{
  const store=new Store(':memory:'),writes=[];let entered,release;
  const first=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const gitlab={getMergeRequest:async()=>mr(),setCommitStatus:async(_p,_s,state,_d,_r,_i,{beforeSend})=>{beforeSend();writes.push(state);if(state==='success'){entered();await gate;}return{id:1};}};
  const publisher=new Publisher({config,store,gitlab,logger:{}});
  try{
    status(store,'success','old');const old=publisher.process(store.claimPublication());await first;
    status(store,'failed','new');const current=publisher.process(store.claimPublication());await Promise.resolve();assert.deepEqual(writes,['success']);release();await Promise.all([old,current]);
    assert.deepEqual(writes,['success','failed']);assert.equal(publisher.statusPublications.size,0);
  }finally{store.close();}
});
test('an unbound newer review invalidates pending older generations immediately',()=>{
  const store=new Store(':memory:');
  try{status(store,'success','old');const item=store.claimPublication();assert.equal(store.isCurrentStatusPublication(item),true);store.enqueue({projectId:7,mrIid:9,trigger:'command',dedupeKey:'queued-new'});assert.equal(store.isCurrentStatusPublication(item),false);}
  finally{store.close();}
});

test('a newer MR sharing an implicit pipeline target invalidates the older status generation',async()=>{
  const store=new Store(':memory:'),writes=[];
  const gitlab={getMergeRequest:async()=>mr(),setCommitStatus:async(_p,_s,state)=>{writes.push(state);return{id:1};}};
  const publisher=new Publisher({config,store,gitlab,logger:{}});
  try{
    status(store,'success','old-other-mr','s',null,9);const old=store.claimPublication();
    status(store,'failed','new-other-mr','s',123,10);await publisher.process(store.claimPublication());await publisher.process(old);
    assert.deepEqual(writes,['failed']);assert.equal(store.db.prepare('SELECT status FROM publication_outbox WHERE id=?').get(old.id).status,'cancelled');
  }finally{store.close();}
});

test('implicit and explicit pipeline aliases share one order through actual HTTP completion',async t=>{
  const http=require('node:http'),store=new Store(':memory:'),writes=[];let entered,release,newCalls=0;
  const first=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://fixture'),state=url.searchParams.get('state');
    if(state==='success'){entered();await gate;}
    writes.push({state,pipeline:Number(url.searchParams.get('pipeline_id')||123)});
    res.writeHead(201,{'content-type':'application/json'});res.end(JSON.stringify({id:writes.length}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const client=new GitLabClient({...config,gitlabApiUrl:`http://127.0.0.1:${server.address().port}/api/v4`});
  client.getMergeRequest=async()=>mr();const send=client.setCommitStatus.bind(client);
  client.setCommitStatus=(...args)=>{if(args[2]==='failed')newCalls++;return send(...args);};
  const publisher=new Publisher({config,store,gitlab:client,logger:{}});
  try{
    status(store,'success','old-implicit','s',null);const old=publisher.process(store.claimPublication());await first;
    status(store,'failed','new-explicit','s',123);const current=publisher.process(store.claimPublication());
    await new Promise(resolve=>setImmediate(resolve));assert.equal(newCalls,0);
    release();await Promise.all([old,current]);
    assert.deepEqual(writes,[{state:'success',pipeline:123},{state:'failed',pipeline:123}]);assert.equal(publisher.statusPublications.size,0);
  }finally{release();store.close();}
});

test('legacy status rows recover their durable snapshot before publishing',async()=>{
  const store=new Store(':memory:');let writes=0;
  const gitlab={getMergeRequest:async()=>({state:'opened',diff_refs:{...refs,start_sha:'rebased'}}),setCommitStatus:async()=>{writes++;return{id:1};}};
  const publisher=new Publisher({config,store,gitlab,logger:{}});
  try{
    const jobId=status(store,'success','legacy');
    const row=store.db.prepare('SELECT id,payload_json FROM publication_outbox').get(),payload=JSON.parse(row.payload_json);
    delete payload.startSha;delete payload.jobId;delete payload.statusName;
    store.db.prepare('UPDATE publication_outbox SET payload_json=? WHERE id=?').run(JSON.stringify(payload),row.id);
    const item=store.claimPublication();assert.equal(store.statusPublicationJob(item).id,jobId);
    await publisher.process(item);
    assert.equal(writes,0);assert.equal(store.db.prepare('SELECT status FROM publication_outbox WHERE id=?').get(row.id).status,'cancelled');
  }finally{store.close();}
});
