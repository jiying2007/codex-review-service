'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const http=require('node:http');
const {buildShardedCatalog,validateShardedCatalog}=require('../src/sharded-catalog');
const {createShardedEdge,targetMap}=require('../src/sharded-edge');

const config=(id,project=113)=>({
 schemaVersion:8,gitlab:{baseUrl:'http://'+id+'.gitlab.test',projects:[project],groups:[]},
 webhook:{expectedInstance:'http://'+id+'.gitlab.test'}
});
const configs={legacy:config('legacy'),sensor:config('sensor'),qa:config('qa')};
function serve(handler){const server=http.createServer(handler);return new Promise(resolve=>
 server.listen(0,'127.0.0.1',()=>resolve({server,port:server.address().port})));
}
function close(server){return new Promise(r=>server.close(r));}
function request(port,pathname,{method='GET',headers={},body=''}={}){
 return new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port,path:pathname,method,headers},res=>{
   const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{
    const raw=Buffer.concat(chunks).toString('utf8');
    let value=raw;try{value=JSON.parse(raw);}catch{}
    resolve({status:res.statusCode,raw,value});
   });
  });req.on('error',reject);req.end(body);
 });
}
test('N-instance catalog remains bounded, canonical and never forges remote membership',()=>{
 const catalog=buildShardedCatalog(configs);
 assert.deepEqual(catalog.instances.map(x=>x.id),['legacy','sensor','qa']);
 assert.deepEqual(validateShardedCatalog(catalog),catalog);
 assert.deepEqual(catalog.instances.map(x=>x.explicitProjects[0].repositoryKey),['legacy:113','sensor:113','qa:113']);
 assert.ok(catalog.instances.every(x=>x.explicitProjects[0].status==='configured_not_live_verified'));
 assert.throws(()=>buildShardedCatalog(Object.fromEntries(Array.from({length:17},(_,i)=>
   [i===0?'legacy':'id'+i,config('host'+i)]))),/1-15|bounded/);
 assert.throws(()=>buildShardedCatalog({legacy:configs.legacy,qa:config('legacy')}),/origin/);
 assert.throws(()=>validateShardedCatalog({...catalog,instances:[...catalog.instances].reverse()}),/noncanonical/);
 assert.throws(()=>targetMap({legacy:{host:'legacy',port:8787},sensor:{host:'sensor',port:8787},
   qa:{host:'169.254.169.254',port:8787}},['legacy','sensor','qa']),/fixed trusted/);
});
test('third GitLab isolates raw webhook delivery and status never interprets missing metrics as zero',async()=>{
 const events=[];
 const servers=[];
 const specs=[
  {id:'legacy',token:'legacy-test-secret',ready:200,metrics:[
   'codex_review_repository_metrics_complete 1',
   'codex_review_repository_jobs{project_id="113",status="total"} 3',
   'codex_review_repository_jobs{project_id="113",status="queued"} 2',
   'codex_review_repository_jobs{project_id="113",status="running"} 1'
  ].join('\n')+'\n'},
  {id:'sensor',token:'sensor-test-secret',ready:200,metrics:'codex_review_repository_metrics_complete 1\n'},
  {id:'qa',token:'qa-test-secret',ready:503,metrics:null}
 ];
 try{
  for(const spec of specs){
   const s=await serve((req,res)=>{
    if(req.method==='POST'){
     const chunks=[];req.on('data',x=>chunks.push(x));req.on('end',()=>{
      events.push({id:spec.id,path:req.url,raw:Buffer.concat(chunks).toString('utf8')});
      res.writeHead(req.headers['x-gitlab-token']===spec.token?202:401);res.end();
     });return;
    }
    if(req.url==='/health/ready'||req.url==='/health/dependencies'){
     res.writeHead(spec.ready);res.end();return;
    }
    if(req.url==='/metrics'){
     res.writeHead(spec.metrics===null?503:200,{'Content-Type':'text/plain'});
     res.end(spec.metrics||'');return;
    }
    res.writeHead(200);res.end();
   });servers.push(s);
  }
  const catalog=buildShardedCatalog(configs);
  const targets=Object.fromEntries(specs.map((s,i)=>[s.id,{host:'127.0.0.1',port:servers[i].port}]));
  const edge=await serve(createShardedEdge({catalog,targets}));
  servers.push(edge);
  const post=await request(edge.port,'/webhooks/gitlab/qa',{method:'POST',body:'{"event":1}',headers:{'x-gitlab-token':'qa-test-secret'}});
  assert.equal(post.status,202);
  assert.deepEqual(events,[{id:'qa',path:'/webhooks/gitlab',raw:'{"event":1}'}]);
  assert.equal((await request(edge.port,'/webhooks/gitlab/qa',{method:'POST',headers:{'x-gitlab-token':'legacy-test-secret'}})).status,401);
  const status=await request(edge.port,'/repositories/status');
  assert.equal(status.status,200);
  assert.equal(status.value.remoteAuthorizationVerified,false);
  assert.equal(status.value.instances.length,3);
  const [legacy,sensor,qa]=status.value.instances;
  assert.equal(legacy.explicitProjects[0].observationStatus,'local_job_history_observed_not_remote_verified');
  assert.equal(legacy.explicitProjects[0].queue.queued,2);
  assert.equal(sensor.explicitProjects[0].observationStatus,'configured_no_local_job_history');
  assert.equal(sensor.explicitProjects[0].queue,null);
  assert.equal(qa.explicitProjects[0].observationStatus,'metrics_unavailable');
  assert.equal(qa.explicitProjects[0].queue,null);
  assert.equal((await request(edge.port,'/health/ready')).status,503);
  assert.equal((await request(edge.port,'/health/ingress')).status,200);
  const metrics=await request(edge.port,'/metrics');
  assert.match(metrics.raw,/codex_review_instance_ready\{instance="qa"\} 0/);
  assert.doesNotMatch(status.raw,/secret|apiKey|GITLAB_API_TOKEN_FILE/);
 }finally{await Promise.all(servers.map(s=>close(s.server)));}
});
