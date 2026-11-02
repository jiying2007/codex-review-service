'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {Store}=require('../src/db');
const {Publisher}=require('../src/publication');
const {GitLabClient}=require('../src/gitlab');
const refs={base_sha:'b',start_sha:'s',head_sha:'h'};
const config={botUsername:'bot',maxPublishAttempts:4,retryBaseDelayMs:1,retryMaxDelayMs:5,gitlabToken:'synthetic-token',gitlabRequestTimeoutMs:1000,gitlabRequestsPerSecond:1000};
const finding={fingerprint:'a'.repeat(64),claimState:'known',claimFingerprint:'a'.repeat(64),anchorFingerprint:'b'.repeat(64),rootCauseKey:'missing_gate',claimClass:'correctness',severity:'high',category:'correctness',file:'a.js',side:'new',line:1,endLine:1,title:'Finding',description:'Evidence',suggestion:'',confidence:1};

async function scenario(t,{commitFirst=true,loseFirst=true}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'service-identity-')),db=path.join(dir,'db.sqlite'),remote=[];
  let store=new Store(db),creates=0,scans=0;
  store.enqueuePublication({projectId:7,mrIid:9,type:'finding',dedupeKey:'known',payload:{headSha:'h',startSha:'s',finding,diffRefs:refs,oldPath:'a.js',newPath:'a.js'}});
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    creates++;assert.equal(store.findingWriteStarted(1),true);
    const discussion={id:String(creates),notes:[{id:creates,resolvable:true,resolved:false,author:{username:'bot'},position:refs,body:JSON.parse(body).body}]};
    if(creates!==1||commitFirst)remote.push(discussion);
    if(creates===1&&loseFirst){req.socket.destroy();return;}
    res.writeHead(201,{'content-type':'application/json'});res.end(JSON.stringify(discussion));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{store.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
  function publisher(botUsername='bot'){
    const cfg={...config,botUsername,gitlabApiUrl:`http://127.0.0.1:${server.address().port}/api/v4`},client=new GitLabClient(cfg);
    client.getMergeRequest=async()=>({state:'opened',diff_refs:refs});
    client.listDiscussions=async()=>{scans++;return{complete:true,items:structuredClone(remote)};};
    return{client,publisher:new Publisher({config:cfg,store,gitlab:client,logger:{}})};
  }
  return{
    get store(){return store;},remote,get creates(){return creates;},get scans(){return scans;},publisher,
    restart(){store.close();store=new Store(db);store.recoverPublications();store.db.exec("UPDATE publication_outbox SET available_at='2000-01-01' WHERE status='pending'");},
    row(){return store.db.prepare('SELECT status,error_code,payload_json FROM publication_outbox WHERE id=1').get();}
  };
}

for(const [label,botUsername,changeClaim] of [['missing bot','',false],['changed bot','other-bot',false],['unknown claim','bot',true]]){
  test(`known remote create survives restart without a duplicate after ${label}`,async t=>{
    const s=await scenario(t);await s.publisher().publisher.process(s.store.claimPublication());
    assert.equal(s.creates,1);assert.equal(s.row().status,'pending');assert.equal(s.store.findingWriteStarted(1),true);
    s.restart();
    if(changeClaim){const payload=JSON.parse(s.row().payload_json);payload.finding.claimState='unknown';payload.finding.claimFingerprint='';s.store.db.prepare('UPDATE publication_outbox SET payload_json=? WHERE id=1').run(JSON.stringify(payload));}
    await s.publisher(botUsername).publisher.process(s.store.claimPublication());
    assert.equal(s.creates,1);assert.equal(s.row().status,'failed');assert.equal(s.row().error_code,'ECLAIMPUBLISHUNCERTAIN');
  });
}

test('the same known identity recovers remote success after a lost HTTP response',async t=>{
  const s=await scenario(t);await s.publisher().publisher.process(s.store.claimPublication());s.restart();
  await s.publisher().publisher.process(s.store.claimPublication());
  assert.equal(s.creates,1);assert.equal(s.scans,2);assert.equal(s.row().status,'published');
});

test('the same known identity may retry after a complete scan proves no remote discussion',async t=>{
  const s=await scenario(t,{commitFirst:false});await s.publisher().publisher.process(s.store.claimPublication());s.restart();
  await s.publisher().publisher.process(s.store.claimPublication());
  assert.equal(s.creates,2);assert.equal(s.remote.length,1);assert.equal(s.scans,2);assert.equal(s.row().status,'published');
});

test('a known pre-transport failure does not invent intent or prevent a later first create',async t=>{
  const s=await scenario(t,{loseFirst:false}),first=s.publisher();first.client.circuit.openUntil=Date.now()+1000;
  await first.publisher.process(s.store.claimPublication());assert.equal(s.creates,0);assert.equal(s.store.findingWriteStarted(1),false);
  s.restart();await s.publisher('').publisher.process(s.store.claimPublication());
  assert.equal(s.creates,1);assert.equal(s.row().status,'published');
});

test('an uncertain protocol 1 known attempt cannot become an unidentifiable first create',async t=>{
  const s=await scenario(t,{loseFirst:false});s.store.db.exec("UPDATE publication_outbox SET payload_json=json_set(payload_json,'$.findingPublicationProtocol',1),attempt=1,error_code='EGITLABNETWORK'");
  await s.publisher('').publisher.process(s.store.claimPublication());
  assert.equal(s.creates,0);assert.equal(s.row().error_code,'ECLAIMPUBLISHUNCERTAIN');assert.equal(s.store.findingWriteStarted(1),true);
});
