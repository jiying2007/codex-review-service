'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const crypto=require('node:crypto');
const {verifyWebhook}=require('../src/webhook');
const {createMultiGateway,targetFor}=require('../src/multi-gitlab-gateway');

function listen(server){return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));}
function close(server){return new Promise(resolve=>server.close(resolve));}
function call(port,pathname,{method='GET',body='',headers={}}={}){
  return new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port,path:pathname,method,headers},res=>{
      const buffers=[];res.on('data',c=>buffers.push(c));
      res.on('end',()=>{
        const raw=Buffer.concat(buffers).toString('utf8');
        let parsed=raw;try{parsed=JSON.parse(raw);}catch{}
        resolve({status:res.statusCode,body:parsed});
      });
    });req.on('error',reject);req.end(body);
  });
}
function signed(body,token,id,instance){
  const stamp=String(Math.floor(Date.now()/1000));
  const digest=crypto.createHmac('sha256',Buffer.from(token.slice(6),'base64'))
    .update(id+'.'+stamp+'.'+body).digest('base64');
  return {'content-type':'application/json','webhook-id':id,'webhook-timestamp':stamp,
    'webhook-signature':'v1,'+digest,'x-gitlab-instance':instance};
}
function mockWorker(id,origin,key,records){
  const token='whsec_'+Buffer.alloc(32,key).toString('base64');
  const config={webhookAuthMode:'standard',webhookSigningToken:token,
    requireInstanceHeader:true,webhookExpectedInstance:origin,webhookMaxSkewSeconds:300};
  const seen=new Set();
  const server=http.createServer((req,res)=>{
    function send(status,body){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));}
    if(req.method==='GET'){
      if(req.url==='/health/ready')return send(200,{status:'ready'});
      if(req.url==='/health/dependencies')return send(200,{status:'healthy'});
      if(req.url==='/version')return send(200,{id});
      if(req.url==='/metrics'){res.writeHead(200,{'content-type':'text/plain'});return res.end('worker_up 1\n');}
      return send(404,{error:'not_found'});
    }
    const chunks=[];
    req.on('data',c=>chunks.push(c));
    req.on('end',()=>{
      const body=Buffer.concat(chunks).toString('utf8');
      const verification=verifyWebhook(req.headers,body,config);
      if(!verification.ok)return send(401,{error:'unauthorized'});
      const payload=JSON.parse(body);
      if(payload.project.id!==113)return send(403,{error:'wrong_project_scope'});
      if(seen.has(verification.webhookId))return send(200,{status:'duplicate'});
      seen.add(verification.webhookId);
      records.push({id,projectId:payload.project.id,eventId:verification.webhookId});
      return send(202,{status:'queued',instance:id});
    });
  });
  return {server,token};
}
test('ingress only routes bounded, explicit GitLab instance and legacy paths',()=>{
  const ids=new Set(['legacy','sensor']);
  assert.deepEqual(targetFor('POST','/webhooks/gitlab',ids,'legacy'),{id:'legacy',path:'/webhooks/gitlab'});
  assert.deepEqual(targetFor('POST','/webhooks/gitlab/sensor',ids,'legacy'),{id:'sensor',path:'/webhooks/gitlab'});
  assert.deepEqual(targetFor('GET','/instances/sensor/health/ready',ids,'legacy'),{id:'sensor',path:'/health/ready'});
  for(const pathname of ['/webhooks/gitlab/unknown','/webhooks/gitlab/sensor?other=true',
    '/webhooks/gitlab/../sensor','/webhooks/gitlab/%2e%2e','/webhooks/gitlab/SENSOR'])
    assert.equal(targetFor('POST',pathname,ids,'legacy'),null,pathname);
  assert.equal(targetFor('GET','/webhooks/gitlab/sensor',ids,'legacy'),null);
});
test('one listening gateway isolates colliding project IDs, raw HMAC identity and delivery replay',async()=>{
  const oldEvents=[],newEvents=[];
  const legacy=mockWorker('legacy','http://192.168.1.4',11,oldEvents);
  const sensor=mockWorker('sensor','http://192.168.2.50',12,newEvents);
  const [oldPort,newPort]=await Promise.all([listen(legacy.server),listen(sensor.server)]);
  const manifest={
    server:{defaultInstance:'legacy'},
    instances:[{id:'legacy'},{id:'sensor'}]
  };
  const ports={legacy:oldPort,sensor:newPort};
  const gateway=createMultiGateway({manifest,lookupPort:id=>ports[id]||0});
  const port=await listen(gateway);
  const body=JSON.stringify({object_kind:'merge_request',project:{id:113},object_attributes:{iid:1}});
  try{
    const oldHeaders=signed(body,legacy.token,'old-113-v1','http://192.168.1.4');
    const sensorHeaders=signed(body,sensor.token,'sensor-113-v1','http://192.168.2.50');
    const a=await call(port,'/webhooks/gitlab',{method:'POST',body,headers:oldHeaders});
    const b=await call(port,'/webhooks/gitlab/sensor',{method:'POST',body,headers:sensorHeaders});
    assert.equal(a.status,202);assert.equal(b.status,202);
    assert.equal(a.body.instance,'legacy');assert.equal(b.body.instance,'sensor');
    assert.deepEqual(oldEvents.map(e=>e.projectId),[113]);
    assert.deepEqual(newEvents.map(e=>e.projectId),[113]);
    const wrong=await call(port,'/webhooks/gitlab/sensor',{method:'POST',body,headers:oldHeaders});
    const swapped=await call(port,'/webhooks/gitlab',{method:'POST',body,headers:sensorHeaders});
    assert.equal(wrong.status,401);assert.equal(swapped.status,401);
    assert.equal(oldEvents.length,1);assert.equal(newEvents.length,1);
    const replay=await call(port,'/webhooks/gitlab/sensor',{method:'POST',body,headers:sensorHeaders});
    assert.equal(replay.status,200);assert.equal(replay.body.status,'duplicate');
    assert.equal(newEvents.length,1);
    const ready=await call(port,'/health/ready');
    assert.equal(ready.status,200);
    assert.equal(ready.body.instances.length,2);
    const selected=await call(port,'/instances/sensor/version');
    assert.equal(selected.status,200);assert.equal(selected.body.id,'sensor');
    const metrics=await call(port,'/metrics');
    assert.match(metrics.body,/codex_review_instance_up\{instance="sensor"\} 1/);
    await close(sensor.server);
    const degraded=await call(port,'/health/dependencies');
    assert.equal(degraded.status,503);
    const stillActive=await call(port,'/webhooks/gitlab',{method:'POST',
      body,headers:signed(body,legacy.token,'old-113-v2','http://192.168.1.4')});
    assert.equal(stillActive.status,202,'sensor failure must not stop the legacy ingress');
    assert.equal(oldEvents.length,2);
    const unavailable=await call(port,'/webhooks/gitlab/sensor',{method:'POST',
      body,headers:signed(body,sensor.token,'sensor-113-v2','http://192.168.2.50')});
    assert.equal(unavailable.status,503);
  }finally{
    await close(gateway);
    await close(legacy.server);
    if(sensor.server.listening)await close(sensor.server);
  }
});
test('classic GitLab webhook checks an available instance header without requiring one on old versions',()=>{
  const config={webhookAuthMode:'classic-token',webhookSigningToken:'whsec_'+Buffer.alloc(32,9).toString('base64'),
    webhookExpectedInstance:'http://192.168.1.4',requireInstanceHeader:true};
  const body='{"object_kind":"note","project":{"id":113}}';
  const old={'x-gitlab-event':'Note Hook','x-gitlab-token':config.webhookSigningToken};
  assert.equal(verifyWebhook(old,body,config).ok,true,'older GitLab lacking instance header remains supported');
  assert.equal(verifyWebhook({...old,'x-gitlab-instance':'http://192.168.2.50'},body,config).reason,'wrong_instance');
  assert.equal(verifyWebhook({...old,'x-gitlab-instance':'http://192.168.1.4'},body,config).ok,true);
  assert.equal(verifyWebhook({...old,'x-gitlab-token':'not-the-secret'},body,config).ok,false);
});
