'use strict';
// Unprivileged, stateless ingress for independently named GitLab instances.
// It owns no GitLab/LLM credentials, SQLite or model worker. All upstream
// identities come from fixed trusted instance names, never from webhook data.
const http=require('node:http');
const {targetFor}=require('./multi-gitlab-gateway');
const {readJson,validateShardedCatalog}=require('./sharded-catalog');
const {targetMap,readUpstream,createUpstreamReader}=require('./edge-transport');
const {contract}=require('./product-contract');
const MAX_BODY=10*1024*1024;
const ALLOWED_METRICS=new Set([
 'queue_depth','oldest_queue_age_seconds','input_tokens_total',
 'cached_input_tokens_total','output_tokens_total','model_usage_unknown_calls',
 'model_usage_unknown_estimated_tokens','status_uncertain_targets',
 'status_unknown_writes','repository_metrics_complete',
 'retained_input_tokens','retained_cached_input_tokens',
 'retained_output_tokens','retained_reasoning_output_tokens'
]);
const REPO_METRICS=new Set([
 'jobs','oldest_queue_age_seconds','known_model_tokens_today',
 'unknown_model_calls_today'
]);
const SAFE_HOP_HEADERS=new Set(['host','connection','proxy-authorization','proxy-connection',
 'keep-alive','te','trailer','transfer-encoding','upgrade','forwarded',
 'x-forwarded-for','x-forwarded-host','x-forwarded-proto']);
function sendJson(res,code,body){
 const bytes=Buffer.from(JSON.stringify(body));
 res.writeHead(code,{'Content-Type':'application/json; charset=utf-8',
  'Content-Length':bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
 res.end(bytes);
}
function cleanHeaders(headers,target){
 const selected={host:target.host+':'+target.port};
 const blocked=new Set([...SAFE_HOP_HEADERS,...String(headers.connection||'').split(',').map(name=>name.trim().toLowerCase())]);
 for(const [name,value] of Object.entries(headers))
   if(!blocked.has(name))selected[name]=value;
 return selected;
}
function proxy(req,res,target,path){
 const sizeHeader=req.headers['content-length'];
 const announced=sizeHeader===undefined?0:Number(sizeHeader);
 if(!Number.isSafeInteger(announced)||announced<0||announced>MAX_BODY){
   req.resume();sendJson(res,413,{error:'payload_too_large'});return;
 }
 let settled=false,bytes=0,incomingResponse=null;
 const upstream=http.request({
   hostname:target.host,port:target.port,method:req.method,path,
   headers:cleanHeaders(req.headers,target)
 },incoming=>{
   if(settled){incoming.resume();return;}
   incomingResponse=incoming;
   incoming.on('aborted',fail);
   incoming.on('error',fail);
   const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
   for(const key of ['content-type','content-length'])
     if(incoming.headers[key]!==undefined)headers[key]=incoming.headers[key];
   res.writeHead(incoming.statusCode||502,headers);
   incoming.pipe(res);
 });
 const deadline=setTimeout(()=>upstream.destroy(new Error('upstream_timeout')),30000);
 deadline.unref?.();
 function fail(){
   if(settled)return;
   settled=true;clearTimeout(deadline);
   if(!res.headersSent)sendJson(res,503,{error:'instance_unavailable'});
   else res.destroy();
 }
 upstream.setTimeout(30000,()=>upstream.destroy(new Error('upstream_timeout')));
 upstream.on('error',fail);
 res.once('finish',()=>{settled=true;clearTimeout(deadline);});
 res.once('close',()=>{
   clearTimeout(deadline);
   if(!res.writableFinished){settled=true;req.unpipe(upstream);incomingResponse?.destroy();upstream.destroy();req.resume();}
 });
 req.on('data',chunk=>{
   bytes+=chunk.length;
   if(bytes>MAX_BODY&&!settled){
     settled=true;clearTimeout(deadline);req.unpipe(upstream);upstream.destroy();
     if(!res.headersSent)sendJson(res,413,{error:'payload_too_large'});
     else res.destroy();
     req.resume();
   }
 });
 req.on('aborted',()=>upstream.destroy());
 req.on('error',()=>upstream.destroy());
 req.pipe(upstream);
}
async function readStatus(targets,path,instanceIds,read=readUpstream){
 const results=await Promise.all(instanceIds.map(async id=>{
   const r=await read(targets[id],path);
   return {id,ready:r.status===200,reachable:r.status>0};
 }));
 const ready=results.filter(item=>item.ready).length;
 return {ready,total:instanceIds.length,instances:results};
}
function scalar(value){return /^\d+(?:\.\d+)?$/.test(value)&&Number.isFinite(Number(value))?value:null;}
function selectMetrics(body,id){
 const lines=[];
 for(const line of String(body).split(/\r?\n/)){
   let m=/^codex_review_([a-z_]+) ([0-9]+(?:\.[0-9]+)?)$/.exec(line);
   if(m&&ALLOWED_METRICS.has(m[1])&&scalar(m[2])!==null){
     lines.push('codex_review_instance_'+m[1]+'{instance="'+id+'"} '+m[2]);
     continue;
   }
   m=/^codex_review_repository_([a-z_]+)\{project_id="([1-9][0-9]*)"(?:,status="(total|queued|running)")?\} ([0-9]+(?:\.[0-9]+)?)$/.exec(line);
   if(m&&REPO_METRICS.has(m[1])&&Number.isSafeInteger(Number(m[2]))&&
      scalar(m[4])!==null&&((m[1]==='jobs')===Boolean(m[3]))){
     const suffix=m[3]?',status="'+m[3]+'"':'';
     lines.push('codex_review_repository_'+m[1]+'{instance="'+id+'",project_id="'+m[2]+'"'+suffix+'} '+m[4]);
   }
 }
 return lines;
}
async function scrapeMetrics(targets,catalog,read=readUpstream){
 const result=await Promise.all(catalog.instances.map(async item=>{
   const id=item.id;
   const [health,metrics]=await Promise.all([
     read(targets[id],'/health/ready'),
     read(targets[id],'/metrics')
   ]);
   return {id,ready:health.status===200,metrics:metrics.status===200,
     samples:metrics.status===200?selectMetrics(metrics.body,id):[]};
 }));
 const types={
   codex_review_instance_ready:'gauge',
   codex_review_instance_metrics_scrape_ok:'gauge',
   codex_review_instance_configured_projects:'gauge',
   codex_review_instance_queue_depth:'gauge',
   codex_review_instance_oldest_queue_age_seconds:'gauge',
   codex_review_instance_input_tokens_total:'counter',
   codex_review_instance_cached_input_tokens_total:'counter',
   codex_review_instance_output_tokens_total:'counter',
   codex_review_instance_retained_input_tokens:'gauge',
   codex_review_instance_retained_cached_input_tokens:'gauge',
   codex_review_instance_retained_output_tokens:'gauge',
   codex_review_instance_retained_reasoning_output_tokens:'gauge',
   codex_review_instance_model_usage_unknown_calls:'gauge',
   codex_review_instance_model_usage_unknown_estimated_tokens:'gauge',
   codex_review_instance_status_uncertain_targets:'gauge',
   codex_review_instance_status_unknown_writes:'gauge',
   codex_review_instance_repository_metrics_complete:'gauge',
   codex_review_repository_jobs:'gauge',
   codex_review_repository_oldest_queue_age_seconds:'gauge',
   codex_review_repository_known_model_tokens_today:'gauge',
   codex_review_repository_unknown_model_calls_today:'gauge'
 };
 const lines=Object.entries(types).flatMap(([name,type])=>['# TYPE '+name+' '+type]);
 for(const entry of result){
   const label='{instance="'+entry.id+'"}';
   const configured=catalog.instances.find(item=>item.id===entry.id).explicitProjects.length;
   lines.push('codex_review_instance_ready'+label+' '+(entry.ready?1:0));
   lines.push('codex_review_instance_metrics_scrape_ok'+label+' '+(entry.metrics?1:0));
   lines.push('codex_review_instance_configured_projects'+label+' '+configured);
   lines.push(...entry.samples);
 }
 return lines.join('\n')+'\n';
}

// Read-only, non-authoritative observed metrics attached to the exact configured
// repository scope. Missing evidence is NEVER converted to a zero/healthy claim.
async function repositoryStatus(targets,catalog,read=readUpstream){
 const instances=await Promise.all(catalog.instances.map(async item=>{
   const id=item.id;
   const [health,metrics]=await Promise.all([
     read(targets[id],'/health/ready'),
     read(targets[id],'/metrics')
   ]);
   const lines=metrics.status===200?selectMetrics(metrics.body,id):[];
   let complete=null;
   const observations=new Map();
   for(const line of lines){
     if(line==='codex_review_instance_repository_metrics_complete{instance="'+id+'"} 1')complete=true;
     if(line==='codex_review_instance_repository_metrics_complete{instance="'+id+'"} 0')complete=false;
     const m=/^codex_review_repository_jobs\{instance="([a-z][a-z0-9-]{0,31})",project_id="([1-9][0-9]*)",status="(total|queued|running)"\} (\d+)$/.exec(line);
     if(!m||m[1]!==id)continue;
     const key=Number(m[2]);
     if(!observations.has(key))observations.set(key,{total:null,queued:null,running:null});
     observations.get(key)[m[3]]=Number(m[4]);
   }
   return {id,ready:health.status===200,metricsReadable:metrics.status===200,
     metricsComplete:complete,
     explicitProjects:item.explicitProjects.map(project=>{
       const jobs=observations.get(project.projectId);
       const state=metrics.status!==200?'metrics_unavailable':
         jobs?'local_job_history_observed_not_remote_verified':
         complete===false?'metrics_truncated':
         complete===true?'configured_no_local_job_history':'metrics_incomplete';
       return {...project,observationStatus:state,queue:jobs||null};
     }),
     groupEnumeration:item.groupEnumeration};
 }));
 return {schemaVersion:1,kind:'sharded_repository_observations',
   observedAt:new Date().toISOString(),catalogDigest:catalog.sourceDigest,
   remoteAuthorizationVerified:false,instances};
}

function createShardedEdge({catalog,targets}={}){
 const source=validateShardedCatalog(catalog),instanceIds=source.instances.map(x=>x.id),upstreams=targetMap(targets,instanceIds);
 const ids=new Set(instanceIds);
 // Coalesce concurrent management reads without retaining a stale success
 // across successive requests. Workers retain their own bounded 3s snapshot.
 const read=createUpstreamReader(upstreams,{ttlMs:0});
 const server=http.createServer({maxHeaderSize:16*1024},async(req,res)=>{
   try{
     const route=targetFor(req.method,req.url,ids);
     if(route){proxy(req,res,upstreams[route.id],route.path);return;}
     if(req.method!=='GET'||!new Set(['/health/live','/health/ready',
       '/health/dependencies','/health/ingress','/version','/metrics','/repositories','/repositories/status']).has(req.url)){
       req.resume();sendJson(res,404,{error:'not_found'});return;
     }
     if(req.url==='/health/live'){sendJson(res,200,{status:'ok'});return;}
     if(req.url==='/version'){sendJson(res,200,{serviceVersion:contract.serviceVersion,
       mode:'sharded-edge',instances:instanceIds});return;}
     if(req.url==='/repositories'){sendJson(res,200,source);return;}
     if(req.url==='/repositories/status'){
       sendJson(res,200,await repositoryStatus(upstreams,source,read));return;
     }
     if(req.url==='/metrics'){
       const body=await scrapeMetrics(upstreams,source,read);
       res.writeHead(200,{'Content-Type':'text/plain; version=0.0.4; charset=utf-8',
         'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
       res.end(body);return;
     }
     const dependencies=req.url==='/health/dependencies';
     const ingress=req.url==='/health/ingress';
     const checks=await readStatus(upstreams,dependencies?'/health/dependencies':'/health/ready',instanceIds,read);
     const healthy=ingress?checks.ready>0:checks.ready===checks.total;
     sendJson(res,healthy?200:503,{
       status:ingress?(healthy?'routable':'unavailable'):healthy?(dependencies?'healthy':'ready'):'degraded',
       readyInstances:checks.ready,totalInstances:checks.total,instances:checks.instances
     });
   }catch{
     if(!res.headersSent)sendJson(res,503,{error:'edge_unavailable'});
     else res.destroy();
   }
 });
 server.headersTimeout=10000;server.requestTimeout=20000;server.keepAliveTimeout=5000;
 server.maxRequestsPerSocket=100;server.maxHeadersCount=64;server.maxConnections=128;
 return server;
}
function main(){
 const file=process.env.CODEX_REVIEW_SHARDED_CATALOG_FILE||'/etc/codex-review/catalog.json';
 const catalog=validateShardedCatalog(readJson(file));
 const fileTargets=process.env.CODEX_REVIEW_SHARDED_TARGETS_FILE;
 if(!fileTargets)throw new Error('CODEX_REVIEW_SHARDED_TARGETS_FILE is required; no default upstream exists');
 const targets=readJson(fileTargets);
 const server=createShardedEdge({catalog,targets});
 server.listen(8787,'0.0.0.0',()=>process.stdout.write(JSON.stringify({event:'sharded_edge_ready',port:8787})+'\n'));
 process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
 process.on('SIGINT',()=>server.close(()=>process.exit(0)));
}
if(require.main===module){try{main();}catch(error){console.error('ESHARDEDEDGE: '+String(error.message||error));process.exitCode=2;}}
module.exports={createShardedEdge,readStatus,scrapeMetrics,selectMetrics,targetMap,readUpstream,repositoryStatus};
