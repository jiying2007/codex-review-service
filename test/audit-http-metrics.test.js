'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {Store}=require('../src/db');
const {createHttpServer}=require('../src/http');
const {createShardedEdge}=require('../src/sharded-edge');
const {buildShardedCatalog}=require('../src/sharded-catalog');
async function serve(t,server){
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 return server.address().port;
}
function get(port,path){return new Promise((resolve,reject)=>{
 const request=http.get({host:'127.0.0.1',port,path},res=>{
  const chunks=[];res.on('data',c=>chunks.push(c));
  res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString('utf8')}));
  res.on('error',reject);
 });request.on('error',reject);request.setTimeout(5000,()=>request.destroy(new Error('fixture timeout')));
});}
test('real HTTP metrics reject corrupted queue evidence, recover, and preserve liveness',async t=>{
 const store=new Store(':memory:');t.after(()=>store.close());
 store.enqueue({projectId:1,mrIid:1,trigger:'test',dedupeKey:'age-corruption'});
 store.db.exec("UPDATE review_jobs SET created_at='invalid-date'");
 const config={gitlabProjectAllowlist:new Set([1])};
 const server=createHttpServer({config,store,service:{config,active:new Map(),workers:[]},
   publisher:{workers:[]},notifier:{workers:[]},gitlab:{},logger:{error(){}}});
 const port=await serve(t,server);
 const failed=await get(port,'/metrics');
 assert.equal(failed.status,503);assert.doesNotMatch(failed.body,/oldest_queue_age_seconds.*0/);
 assert.equal((await get(port,'/health/live')).status,200);
 store.db.prepare('UPDATE review_jobs SET created_at=?').run(new Date().toISOString());
 const recovered=await get(port,'/metrics');assert.equal(recovered.status,200);
 assert.match(recovered.body,/codex_review_repository_jobs\{project_id="1",status="queued"\} 1/);
});
test('fleet HTTP metrics and repository observations share in-flight backend reads',async t=>{
 let release;const barrier=new Promise(resolve=>{release=resolve;});
 const seen=new Map(),targets={},configs={};
 for(const id of ['primary','sensor']){
  configs[id]={schemaVersion:8,gitlab:{baseUrl:'http://'+id+'.test',projects:[1],groups:[]},webhook:{expectedInstance:'http://'+id+'.test'}};
  const backend=http.createServer(async(req,res)=>{
    const key=id+req.url;seen.set(key,(seen.get(key)||0)+1);await barrier;
    res.writeHead(200);res.end(req.url==='/metrics'?'codex_review_repository_metrics_complete 1\n':'{}');
  });
  targets[id]={host:'127.0.0.1',port:await serve(t,backend)};
 }
 const edge=createShardedEdge({catalog:buildShardedCatalog(configs),targets});
 let requests=0;edge.on('request',()=>{if(++requests===40)release();});
 const port=await serve(t,edge);
 const replies=await Promise.all(Array.from({length:40},(_,i)=>get(port,i%2?'/metrics':'/repositories/status')));
 assert.ok(replies.every(reply=>reply.status===200));
 for(const id of ['primary','sensor'])for(const path of ['/health/ready','/metrics'])assert.equal(seen.get(id+path),1,id+path);
});
