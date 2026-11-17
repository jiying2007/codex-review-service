'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const http=require('node:http');
const {createShardedEdge,selectMetrics,targetMap}=require('../src/sharded-edge');
const {buildShardedCatalog}=require('../src/sharded-catalog');
const catalog=buildShardedCatalog({
 legacy:{schemaVersion:8,gitlab:{baseUrl:'http://192.168.1.4',projects:[113],groups:[]},webhook:{expectedInstance:'http://192.168.1.4'}},
 sensor:{schemaVersion:8,gitlab:{baseUrl:'http://192.168.2.50',projects:[113],groups:[]},webhook:{expectedInstance:'http://192.168.2.50'}}
});
function listen(server){return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));}
function close(server){return new Promise(resolve=>server.close(resolve));}
function request(port,pathname,{method='GET',body='',headers={}}={}){
 return new Promise((resolve,reject)=>{
   const req=http.request({hostname:'127.0.0.1',port,path:pathname,method,headers},res=>{
     const chunks=[];res.on('data',chunk=>chunks.push(chunk));
     res.on('end',()=>{const text=Buffer.concat(chunks).toString('utf8');
       let parsed=text;try{parsed=JSON.parse(text);}catch{}
       resolve({status:res.statusCode,body:parsed,text});});
   });
   req.on('error',reject);req.end(body);
 });
}
function backend(id,expectedToken){
 let ready=true;const events=[];
 const server=http.createServer((req,res)=>{
   if(req.method==='GET'){
     if(req.url==='/health/live'||req.url==='/health/ready'||req.url==='/health/dependencies'){
       res.writeHead(ready?200:503,{'Content-Type':'application/json'});
       res.end(JSON.stringify({status:ready?'ready':'not_ready'}));return;
     }
     if(req.url==='/metrics'){
       res.writeHead(200,{'Content-Type':'text/plain'});
       res.end([
        'codex_review_queue_depth 2','codex_review_input_tokens_total 120',
        'codex_review_model_usage_unknown_calls 1',
        'codex_review_repository_metrics_complete 1',
        'codex_review_repository_jobs{project_id="113",status="queued"} 2',
        'codex_review_repository_known_model_tokens_today{project_id="113"} 120',
        'unknown_leaky_secret{key="x"} 999'
       ].join('\n')+'\n');return;
     }
     if(req.url==='/version'){res.writeHead(200);res.end(id);return;}
     res.writeHead(404);res.end();return;
   }
   const data=[];req.on('data',c=>data.push(c));req.on('end',()=>{
     events.push({raw:Buffer.concat(data).toString('utf8'),headers:req.headers,path:req.url});
     res.writeHead(req.headers['x-gitlab-token']===expectedToken?202:401);
     res.end(JSON.stringify({instance:id}));
   });
 });
 return {server,events,setReady(value){ready=value;}};
}
test('fixed edge preserves raw webhook identity, instance routing and same numeric project separation',async()=>{
 const a=backend('legacy','LEGACY_TEST_TOKEN'),b=backend('sensor','SENSOR_TEST_TOKEN');
 const [ap,bp]=await Promise.all([listen(a.server),listen(b.server)]);
 const edge=createShardedEdge({catalog,targets:{
   legacy:{host:'127.0.0.1',port:ap},sensor:{host:'127.0.0.1',port:bp}
 }});
 const port=await listen(edge);
 try{
   const payload='{"project":{"id":113},"object_kind":"merge_request"}';
   const legacy=await request(port,'/webhooks/gitlab/legacy',{method:'POST',body:payload,
     headers:{'x-gitlab-token':'LEGACY_TEST_TOKEN','x-forwarded-for':'unsafe-client'}});
   const sensor=await request(port,'/webhooks/gitlab/sensor',{method:'POST',body:payload,
     headers:{'x-gitlab-token':'SENSOR_TEST_TOKEN'}});
   assert.equal(legacy.status,202);assert.equal(sensor.status,202);
   assert.equal((await request(port,'/webhooks/gitlab',{method:'POST',body:payload})).status,404,'unnamed legacy route must be rejected');
   assert.equal(a.events[0].raw,payload);assert.equal(b.events[0].raw,payload);
   assert.equal(a.events[0].path,'/webhooks/gitlab/legacy');
   assert.equal(b.events[0].path,'/webhooks/gitlab/legacy');
   assert.equal(a.events[0].headers['x-forwarded-for'],undefined);
   assert.equal((await request(port,'/webhooks/gitlab/sensor',{method:'POST',body:payload,
     headers:{'x-gitlab-token':'LEGACY_TEST_TOKEN'}})).status,401);
   assert.equal((await request(port,'/webhooks/gitlab/unknown',{method:'POST'})).status,404);
   assert.equal((await request(port,'/webhooks/gitlab/sensor?inject=1',{method:'POST'})).status,404);
   const inventory=await request(port,'/repositories');
   assert.equal(inventory.status,200);
   assert.deepEqual(inventory.body.instances.map(i=>i.explicitProjects[0].repositoryKey),
     ['legacy:113','sensor:113']);
   assert.equal(inventory.text.includes('TEST_TOKEN'),false);
   const health=await request(port,'/health/ready');
   assert.equal(health.status,200);assert.equal(health.body.readyInstances,2);
   const metrics=await request(port,'/metrics');
   assert.equal(metrics.status,200);
   assert.match(metrics.text,/codex_review_instance_ready\{instance="legacy"\} 1/);
   assert.match(metrics.text,/codex_review_instance_queue_depth\{instance="sensor"\} 2/);
   assert.match(metrics.text,/codex_review_repository_jobs\{instance="sensor",project_id="113",status="queued"\} 2/);
   assert.match(metrics.text,/codex_review_instance_model_usage_unknown_calls\{instance="sensor"\} 1/);
   assert.doesNotMatch(metrics.text,/unknown_leaky_secret/);
   b.setReady(false);
   const incomplete=await request(port,'/health/ready');
   assert.equal(incomplete.status,503);assert.equal(incomplete.body.readyInstances,1);
   assert.equal((await request(port,'/health/ingress')).status,200);
   assert.equal((await request(port,'/instances/legacy/health/ready')).status,200);
   assert.equal((await request(port,'/instances/sensor/health/ready')).status,503);
   await close(b.server);
   const partial=await request(port,'/metrics');
   assert.equal(partial.status,200);
   assert.match(partial.text,/codex_review_instance_metrics_scrape_ok\{instance="sensor"\} 0/);
   assert.match(partial.text,/codex_review_instance_metrics_scrape_ok\{instance="legacy"\} 1/);
   assert.equal((await request(port,'/webhooks/gitlab/legacy',{method:'POST',body:payload,
     headers:{'x-gitlab-token':'LEGACY_TEST_TOKEN'}})).status,202);
   assert.equal((await request(port,'/webhooks/gitlab/sensor',{method:'POST',body:payload,
     headers:{'x-gitlab-token':'SENSOR_TEST_TOKEN'}})).status,503);
 }finally{
   await close(edge);await close(a.server);if(b.server.listening)await close(b.server);
 }
});
test('edge rejects untrusted arbitrary proxy targets and malformed metric labels',()=>{
 assert.throws(()=>targetMap({legacy:{host:'169.254.169.254',port:80},sensor:{host:'sensor',port:8787}},['legacy','sensor']),/fixed trusted/);
 assert.throws(()=>targetMap({legacy:{host:'legacy',port:8787},sensor:{host:'sensor',port:8787},other:{host:'other',port:8787}},['legacy','sensor']),/dynamic/);
 const filtered=selectMetrics([
  'codex_review_queue_depth 3',
  'codex_review_retained_input_tokens 120',
  'codex_review_repository_jobs{project_id="113",status="queued"} 2',
  'codex_review_repository_jobs{project_id="113",status="evil"} 7',
  'codex_review_repository_jobs{project_id="9999999999999999999999999999",status="queued"} 8',
  'codex_review_queue_depth{project_id="113"} 999',
  'codex_review_repository_known_model_tokens_today{project_id="113"} 90',
  'password{secret="x"} 1'
 ].join('\n'),'legacy').join('\n');
 assert.match(filtered,/codex_review_instance_queue_depth\{instance="legacy"\} 3/);
 assert.match(filtered,/codex_review_instance_retained_input_tokens\{instance="legacy"\} 120/);
 assert.match(filtered,/codex_review_repository_known_model_tokens_today\{instance="legacy",project_id="113"\} 90/);
 assert.doesNotMatch(filtered,/password|evil|999999999999999999999/);
});
