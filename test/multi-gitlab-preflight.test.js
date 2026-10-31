'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {runPreflight,preflightInstance,checkResponse}=require('../src/multi-gitlab-preflight');
const jsonResponse=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});

function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'multi-preflight-'));
  function make(id,url,token,index){
    const config=path.join(dir,id+'.json'),api=path.join(dir,id+'.token'),
      signing=path.join(dir,id+'.signing');
    const cfg=JSON.parse(fs.readFileSync(
      path.join(__dirname,'../deploy/docker/config.example.json'),'utf8'));
    cfg.server.dataDir=path.join(dir,id+'-data');
    cfg.gitlab.baseUrl=url;
    cfg.gitlab.projects=[113];
    cfg.gitlab.groups=id==='legacy'?[{id:48,includeSubgroups:true}]:[];
    cfg.webhook.expectedInstance=url;
    cfg.codex.home=path.join(dir,id+'-home');
    fs.writeFileSync(config,JSON.stringify(cfg),{mode:0o600});
    fs.writeFileSync(api,token,{mode:0o600});
    fs.writeFileSync(signing,'whsec_'+Buffer.alloc(32,index).toString('base64'),{mode:0o600});
    return{id,configFile:config,homeDir:path.join(dir,id+'-home'),
      secretFiles:{GITLAB_API_TOKEN_FILE:api,GITLAB_WEBHOOK_SIGNING_TOKEN_FILE:signing}};
  }
  const legacy=make('legacy','http://192.168.1.4','old-only-read-token',7);
  const sensor=make('sensor','http://192.168.2.50','new-only-read-token',8);
  const file=path.join(dir,'multi.json');
  fs.writeFileSync(file,JSON.stringify({schemaVersion:1,
    server:{host:'127.0.0.1',port:8787,defaultInstance:'legacy',sharedProcessTrustAcknowledged:true},instances:[legacy,sensor]}),{mode:0o600});
  return {file,close:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
test('read-only multi preflight probes each project/group with the correct server credential',async()=>{
  const f=fixture(),calls=[];
  try{
    const mock=async(url,options)=>{
      calls.push({url:String(url),options});
      return jsonResponse(url.endsWith('/user')?{id:101}:{version:'17.11.7'});
    };
    const r=await runPreflight({manifestFile:f.file,fetchImpl:mock});
    assert.equal(r.ok,true);
    assert.equal(r.noModelInvocations,true);
    assert.equal(r.mode,'read-only');
    assert.deepEqual(r.results.map(x=>[x.id,x.checkedProjects,x.checkedGroups]),
      [['legacy',1,1],['sensor',1,0]]);
    assert.equal(calls.length,7);
    assert.equal(calls.filter(c=>c.url.endsWith('/api/v4/user')).length,2);
    assert.ok(r.results.every(x=>x.authenticated===true));
    assert.equal(calls.filter(c=>c.url.includes('/projects/113')).length,2);
    assert.equal(calls.filter(c=>c.url.includes('/groups/48')).length,1);
    for(const call of calls){
      assert.equal(call.options.method,'GET');
      assert.equal(call.options.redirect,'error');
      assert.equal(call.options.headers['PRIVATE-TOKEN'],
        call.url.includes('192.168.1.4')?'old-only-read-token':'new-only-read-token');
    }
    assert.doesNotMatch(JSON.stringify(r),/old-only-read-token|new-only-read-token/);
  }finally{f.close();}
});
test('one GitLab API permission failure does not conceal the other server state',async()=>{
  const f=fixture();
  try{
    const mock=async(url)=>url.includes('192.168.2.50') && url.includes('/projects/113')?
      new Response('{}',{status:403}):jsonResponse(url.endsWith('/user')?{id:101}:{version:'17.11.7'});
    const r=await runPreflight({manifestFile:f.file,fetchImpl:mock});
    assert.equal(r.ok,false);
    assert.equal(r.results[0].apiReadable,true);
    assert.equal(r.results[1].apiReadable,false);
    assert.equal(r.results[1].code,'EGITLABREAD');
  }finally{f.close();}
});
test('unsupported old GitLab API fails closed before any webhook or model calls',async()=>{
  const f=fixture();
  try{
    const mock=async(url)=>jsonResponse(url.endsWith('/user')?{id:101}:{version:'14.6.0'});
    const r=await runPreflight({manifestFile:f.file,fetchImpl:mock});
    assert.equal(r.ok,false);
    assert.deepEqual(r.results.map(item=>item.code),['EGITLABVERSION','EGITLABVERSION']);
  }finally{f.close();}
});

test('public GitLab project HTTP 200 cannot disguise missing token identity',async()=>{
  const f=fixture(),calls=[];
  try{
    const mock=async(url)=>{
      calls.push(url);
      return jsonResponse(url.endsWith('/user')?{}:{version:'17.11.7'});
    };
    const result=await runPreflight({manifestFile:f.file,fetchImpl:mock});
    assert.equal(result.ok,false);
    assert.deepEqual(result.results.map(item=>item.code),['EGITLABAUTH','EGITLABAUTH']);
    assert.ok(calls.every(url=>url.endsWith('/user')),'unverified PAT cannot use public project reads as proof');
  }finally{f.close();}
});

// These transport checks use native Response/ReadableStream or local HTTP,
// never a real GitLab token, external server, model or Service worker.
function openBody(status=200){
  let cancelled=0;
  const response=new Response(new ReadableStream({
    start(controller){controller.enqueue(Buffer.from('unused response body'));},
    cancel(){cancelled+=1;}
  }),{status});
  return{response,cancelled:()=>cancelled};
}
test('preflight transport: status-only probes release successful response bodies',async()=>{
  const f=openBody();
  let options;
  const result=await checkResponse('http://example.invalid/projects/113','synthetic-token',{
    fetchImpl:async(_url,input)=>{options=input;return f.response;}
  });
  assert.equal(result.status,200);
  assert.equal(f.cancelled(),1);
  assert.equal(options.method,'GET');
  assert.equal(options.redirect,'error');
  assert.equal(options.headers['PRIVATE-TOKEN'],'synthetic-token');
});
test('preflight transport: failed status releases its body without exposing raw errors',async()=>{
  const f=openBody(403);
  await assert.rejects(checkResponse('http://example.invalid','synthetic-token',{
    fetchImpl:async()=>f.response
  }),error=>error.code==='EGITLABREAD'&&!/synthetic-token|unused response body/.test(error.message));
  assert.equal(f.cancelled(),1);
});
test('preflight transport: bounded JSON accepts split UTF-8 and exact byte limit',async()=>{
  const bytes=Buffer.from(JSON.stringify({name:'预检',id:101}));
  const response=new Response(new ReadableStream({start(controller){
    for(const byte of bytes)controller.enqueue(Uint8Array.of(byte));
    controller.close();
  }}));
  const result=await checkResponse('http://example.invalid/user','fixture',{
    fetchImpl:async()=>response,readJson:true,maxBytes:bytes.length
  });
  assert.deepEqual(result,{name:'预检',id:101});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(response.body.locked,false);
});
test('preflight transport: oversized JSON is rejected and its stream released',async()=>{
  const f=openBody();
  await assert.rejects(checkResponse('http://example.invalid/user','fixture',{
    fetchImpl:async()=>f.response,readJson:true,maxBytes:8
  }),error=>error.code==='EGITLABSIZE');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.cancelled(),1);
  assert.equal(f.response.body.locked,false);
});
test('preflight transport: malformed JSON and invalid UTF-8 fail with bounded diagnostics',async()=>{
  for(const bytes of [Buffer.from('{not-json'),Buffer.from([0xff]),Buffer.alloc(0)]){
    await assert.rejects(checkResponse('http://example.invalid/user','fixture',{
      fetchImpl:async()=>new Response(bytes),readJson:true
    }),error=>error.code==='EGITLABBODY'&&!error.message.includes('not-json'));
  }
});
test('preflight transport: one deadline covers a pending fetch',async()=>{
  let signal;
  await assert.rejects(checkResponse('http://example.invalid','fixture',{
    timeoutMs:25,fetchImpl:async(_url,options)=>{
      signal=options.signal;return new Promise(()=>{});
    }
  }),error=>error.code==='EGITLABTIMEOUT');
  assert.equal(signal.aborted,true);
});
test('preflight transport: one deadline covers a stalled JSON body',async()=>{
  const f=openBody();
  await assert.rejects(checkResponse('http://example.invalid/user','fixture',{
    timeoutMs:25,readJson:true,fetchImpl:async()=>f.response
  }),error=>error.code==='EGITLABTIMEOUT');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.cancelled(),1);
  assert.equal(f.response.body.locked,false);
});
test('preflight transport: body cleanup cannot extend the deadline',async()=>{
  const response=new Response(new ReadableStream({cancel(){return new Promise(()=>{});}}));
  await assert.rejects(checkResponse('http://example.invalid','fixture',{
    timeoutMs:25,fetchImpl:async()=>response
  }),error=>error.code==='EGITLABTIMEOUT');
});
test('preflight transport: a response arriving after timeout is also released',async()=>{
  const f=openBody();
  let resolveFetch;
  await assert.rejects(checkResponse('http://example.invalid','fixture',{
    timeoutMs:25,fetchImpl:()=>new Promise(resolve=>{resolveFetch=resolve;})
  }),error=>error.code==='EGITLABTIMEOUT');
  resolveFetch(f.response);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.cancelled(),1);
});
test('preflight transport: invalid budgets are rejected before any request',async()=>{
  let calls=0;
  for(const options of [{timeoutMs:0},{timeoutMs:Infinity},{timeoutMs:120001},
    {maxBytes:0},{maxBytes:1024*1024+1}]){
    await assert.rejects(checkResponse('http://example.invalid','fixture',{
      ...options,fetchImpl:async()=>{calls++;return new Response('{}');}
    }),error=>error.code==='EGITLABOPTIONS');
  }
  assert.equal(calls,0);
});
test('preflight transport: arbitrary fetch messages never expose credentials',async()=>{
  for(const code of [undefined,'EGITLABREAD','EGITLABSIZE']){
    await assert.rejects(checkResponse('http://example.invalid','synthetic-token',{
      fetchImpl:async()=>{throw Object.assign(Error('synthetic-token private response'),{code});}
    }),error=>! /synthetic-token|private response/.test(error.message));
  }
});
test('preflight transport: real local HTTP covers identity, scopes, cancellation and timeout',
  {timeout:5000},async()=>{
  const http=require('node:http');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'preflight-http-'));
  const calls=[];
  let projectClosed=0,groupClosed=0,redirectFollowed=0;
  const server=http.createServer((req,res)=>{
    calls.push({url:req.url,method:req.method,token:req.headers['private-token']});
    if(req.url==='/api/v4/user')return res.end(JSON.stringify({id:101}));
    if(req.url==='/api/v4/version')return res.end(JSON.stringify({version:'17.11.7'}));
    if(req.url==='/api/v4/projects/113'||req.url==='/api/v4/groups/48'){
      res.on('close',()=>{if(req.url.includes('/projects/'))projectClosed++;else groupClosed++;});
      res.writeHead(200,{'Content-Type':'application/json'});res.write('{');return;
    }
    if(req.url==='/denied'){res.writeHead(403);res.write('private fixture response');return;}
    if(req.url==='/slow'){res.writeHead(200);res.write('{');return;}
    if(req.url==='/redirect'){res.writeHead(302,{Location:'/unexpected'});res.end();return;}
    if(req.url==='/unexpected')redirectFollowed++;
    res.end('{}');
  });
  try{
    await new Promise((resolve,reject)=>{
      server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
    });
    const origin='http://127.0.0.1:'+server.address().port;
    const configFile=path.join(dir,'config.json'),tokenFile=path.join(dir,'token');
    fs.writeFileSync(configFile,JSON.stringify({gitlab:{projects:[113],groups:[{id:48}]}}),{mode:0o600});
    fs.writeFileSync(tokenFile,'local-fixture-token',{mode:0o600});
    const result=await preflightInstance({id:'local',origin,configFile,
      secretFiles:{GITLAB_API_TOKEN_FILE:tokenFile}},{timeoutMs:1000});
    assert.equal(result.authenticated,true);
    assert.equal(result.apiReadable,true);
    assert.equal(result.checkedProjects,1);assert.equal(result.checkedGroups,1);
    assert.equal(result.writePermissionsVerified,false);
    assert.equal(result.webhookDeliveryVerified,false);
    assert.doesNotMatch(JSON.stringify(result),/local-fixture-token/);
    assert.deepEqual(calls.map(item=>item.url),[
      '/api/v4/user','/api/v4/version','/api/v4/projects/113','/api/v4/groups/48']);
    assert.ok(calls.every(item=>item.method==='GET'&&item.token==='local-fixture-token'));
    await assert.rejects(checkResponse(origin+'/denied','fixture',{timeoutMs:1000}),
      error=>error.code==='EGITLABREAD');
    await assert.rejects(checkResponse(origin+'/slow','fixture',{timeoutMs:50,readJson:true}),
      error=>error.code==='EGITLABTIMEOUT');
    await assert.rejects(checkResponse(origin+'/redirect','fixture',{timeoutMs:1000}),
      error=>error.code==='EGITLABREAD');
    assert.equal(redirectFollowed,0);
    const until=Date.now()+1000;
    while((projectClosed!==1||groupClosed!==1)&&Date.now()<until)
      await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(projectClosed,1);assert.equal(groupClosed,1);
  }finally{
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
