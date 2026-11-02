'use strict';

// Public ingress for many isolated internal Service workers, never a
// cross-GitLab API client. The target is chosen by a bounded route segment;
// each worker still authenticates its own raw webhook and project allowlist.
const http = require('node:http');
const { INSTANCE_ID } = require('./multi-gitlab-config');
const { contract } = require('./product-contract');

const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const PROXY_TIMEOUT_MS = 30000;
const GET_PATHS = new Set(['/health/live','/health/ready','/health/dependencies','/version','/metrics']);
function response(res, code, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff',
    'Content-Length': data.length
  });
  res.end(data);
}
function targetFor(method, rawUrl, ids, defaultInstance) {
  let url;
  try { url = new URL(rawUrl, 'http://localhost'); } catch { return null; }
  if (url.search || url.hash) return null;
  if (method === 'POST' && url.pathname === '/webhooks/gitlab')
    return {id:defaultInstance, path:'/webhooks/gitlab'};
  if (method === 'POST') {
    const match = /^\/webhooks\/gitlab\/([a-z][a-z0-9-]{0,31})$/.exec(url.pathname);
    if (match && ids.has(match[1])) return {id:match[1], path:'/webhooks/gitlab'};
  }
  if (method === 'GET') {
    const match = /^\/instances\/([a-z][a-z0-9-]{0,31})(\/health\/(?:live|ready|dependencies)|\/metrics|\/version)$/.exec(url.pathname);
    if (match && ids.has(match[1])) return {id:match[1], path:match[2]};
  }
  return null;
}
function proxyHeaders(source, port) {
  const result={host:'127.0.0.1:' + port};
  const blocked=new Set(['host','connection','proxy-authorization','proxy-connection','keep-alive',
    'te','trailer','transfer-encoding','upgrade','x-forwarded-for','x-forwarded-host','x-forwarded-proto']);
  for (const [name,value] of Object.entries(source)) if (!blocked.has(name)) result[name]=value;
  return result;
}
function proxyRequest(req,res,port,path) {
  if (!port) { req.resume(); return response(res,503,{error:'instance_unavailable'}); }
  const announced = Number(req.headers['content-length'] || 0);
  if (!Number.isSafeInteger(announced) || announced < 0 || announced > MAX_REQUEST_BYTES) {
    req.resume();
    return response(res,413,{error:'payload_too_large'});
  }
  let finished=false,bytes=0;
  const proxy=http.request({
    hostname:'127.0.0.1', port, method:req.method, path,
    headers:proxyHeaders(req.headers,port)
  },upstream=>{
    if (finished) { upstream.resume(); return; }
    const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
    for (const name of ['content-type','content-length'])
      if (upstream.headers[name] !== undefined) headers[name]=upstream.headers[name];
    res.writeHead(upstream.statusCode || 502,headers);
    upstream.pipe(res);
  });
  proxy.setTimeout(PROXY_TIMEOUT_MS,()=>proxy.destroy(Object.assign(new Error('worker timeout'),{code:'ETIMEOUT'})));
  proxy.on('error',()=>{
    // A request rejected with 413 already owns the response; destroying the
    // upstream connection must not destroy that response before it reaches GitLab.
    if(finished)return;
    if(res.headersSent){res.destroy();return;}
    finished=true;
    response(res,503,{error:'instance_unavailable'});
  });
  req.on('data',chunk=>{
    bytes+=chunk.length;
    if (bytes>MAX_REQUEST_BYTES && !finished) {
      finished=true;
      req.unpipe(proxy);
      proxy.destroy();
      if (!res.headersSent) response(res,413,{error:'payload_too_large'});
      req.resume();
    }
  });
  req.on('aborted',()=>proxy.destroy());
  req.on('error',()=>proxy.destroy());
  req.pipe(proxy);
}
function workerStatus(port,path,timeout=4000) {
  return new Promise(resolve=>{
    if (!port) return resolve({available:false,status:'unavailable'});
    let settled=false;
    const done=value=>{
      if(settled)return;
      settled=true;
      resolve(value);
    };
    const r=http.get({host:'127.0.0.1',port,path,timeout},res=>{
      res.resume();
      res.on('end',()=>done({
        available:res.statusCode===200,
        status:res.statusCode===200?'ready':'degraded'
      }));
      res.on('aborted',()=>done({available:false,status:'unavailable'}));
      res.on('error',()=>done({available:false,status:'unavailable'}));
    });
    r.on('timeout',()=>r.destroy());
    r.on('error',()=>done({available:false,status:'unavailable'}));
  });
}
function createMultiGateway({manifest, lookupPort,lookupRestartCount=()=>0}) {
  const ids=new Set(manifest.instances.map(item=>item.id));
  const server=http.createServer({maxHeaderSize:16*1024},async(req,res)=>{
    try {
      const route=targetFor(req.method,req.url,ids,manifest.server.defaultInstance);
      if (route) return proxyRequest(req,res,lookupPort(route.id),route.path);
      if (req.method!=='GET' || !GET_PATHS.has(req.url)) {
        req.resume();
        return response(res,404,{error:'not_found'});
      }
      if (req.url==='/health/live') return response(res,200,{status:'ok'});
      if (req.url==='/version') return response(res,200,{
        serviceVersion:contract.serviceVersion,configSchemaVersion:contract.configSchemaVersion,
        mode:'multi-gitlab',instances:[...ids]
      });
      if (req.url==='/metrics') {
        const values=manifest.instances.map(item=>{
          const available=Boolean(lookupPort(item.id));
          return 'codex_review_instance_up{instance="' + item.id + '"} ' + (available?'1':'0');
        });
        const restarts=manifest.instances.map(item=>
          'codex_review_instance_restarts_total{instance="' + item.id + '"} ' +
          Number(lookupRestartCount(item.id)||0));
        const body='# TYPE codex_review_instance_up gauge\n' + values.join('\n') + '\n' +
          '# TYPE codex_review_instance_restarts_total counter\n' +
          restarts.join('\n') + '\n';
        res.writeHead(200,{'Content-Type':'text/plain; version=0.0.4; charset=utf-8',
          'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
        return res.end(body);
      }
      const dependency=req.url==='/health/dependencies';
      const path=dependency?'/health/dependencies':'/health/ready';
      const checks=await Promise.all(manifest.instances.map(async item=>({
        id:item.id,...(await workerStatus(lookupPort(item.id),path))
      })));
      const healthy=checks.every(item=>item.available);
      return response(res,healthy?200:503,{
        status:healthy?(dependency?'healthy':'ready'):'degraded',
        instances:checks
      });
    }catch{
      if (!res.headersSent) response(res,503,{error:'gateway_unavailable'});
      else res.destroy();
    }
  });
  server.headersTimeout=10000;
  server.requestTimeout=20000;
  server.keepAliveTimeout=5000;
  server.maxRequestsPerSocket=100;
  server.maxHeadersCount=64;
  return server;
}
module.exports={createMultiGateway,targetFor,proxyHeaders,proxyRequest,workerStatus,MAX_REQUEST_BYTES};
