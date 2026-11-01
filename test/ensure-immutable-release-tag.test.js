'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {ensureTag}=require('../scripts/ensure-immutable-release-tag');
const SHA='a'.repeat(40),OTHER='b'.repeat(40),REPO='jiying2007/codex-review-service';
const config={repository:REPO,tag:'v7.6.2',sha:SHA,token:'synthetic-fixture-token'};
function response(status,json){
  return new Response(json===undefined?null:JSON.stringify(json),{status});
}
function ref(sha=SHA){return{ref:'refs/tags/v7.6.2',object:{type:'commit',sha}};}
function fixture(routes){
  const calls=[];
  const fetchImpl=async(url,options)=>{
    const path=new URL(url).pathname;
    const name=options.method+' '+path;
    calls.push({name,options});
    const next=routes[name];
    if(!next||!next.length)throw Error('Unexpected GitHub call '+name);
    const [status,payload]=next.shift();
    return response(status,payload);
  };
  return{calls,options:{...config,fetchImpl}};
}
test('GET existing matching tag is read-only and never overwritten',async()=>{
  const f=fixture({'GET /repos/'+REPO+'/git/ref/tags/v7.6.2':[[200,ref()]]});
  assert.deepEqual(await ensureTag(f.options),{ok:true,created:false,tag:config.tag,sha:SHA});
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].options.method,'GET');
});
test('404 with error body must be treated as absent, not a tag named null',async()=>{
  const f=fixture({
    ['GET /repos/'+REPO+'/git/ref/tags/v7.6.2']:[[404,{message:'Not Found',object:null}],[200,ref()]],
    ['POST /repos/'+REPO+'/git/refs']:[[201,ref()]]
  });
  assert.deepEqual(await ensureTag(f.options),{ok:true,created:true,tag:config.tag,sha:SHA});
  assert.deepEqual(f.calls.map(x=>x.options.method),['GET','POST','GET']);
  assert.deepEqual(JSON.parse(f.calls[1].options.body),{ref:'refs/tags/v7.6.2',sha:SHA});
});
test('existing mismatched tag is immutable and never updated',async()=>{
  const f=fixture({['GET /repos/'+REPO+'/git/ref/tags/v7.6.2']:[[200,ref(OTHER)]]});
  await assert.rejects(ensureTag(f.options),e=>e.code==='ETAGMISMATCH');
  assert.equal(f.calls.length,1);
});
test('permission-denied or malformed GET blocks creation, without POST',async()=>{
  for(const [status,body] of [[403,undefined],[200,{ref:'refs/tags/v7.6.2',object:{sha:'null',type:'commit'}}]]){
    const f=fixture({['GET /repos/'+REPO+'/git/ref/tags/v7.6.2']:[[status,body]]});
    await assert.rejects(ensureTag(f.options));
    assert.equal(f.calls.length,1);
  }
});
test('POST forbidden and unexpected status fail closed',async()=>{
  for(const status of [403,500]){
    const f=fixture({
      ['GET /repos/'+REPO+'/git/ref/tags/v7.6.2']:[[404,undefined]],
      ['POST /repos/'+REPO+'/git/refs']:[[status,undefined]]
    });
    await assert.rejects(ensureTag(f.options),e=>e.code==='ETAGCREATE'||e.code==='ETAGHTTP');
    assert.equal(f.calls.length,2);
  }
});
test('POST 422 race accepts only a newly appearing matching tag',async()=>{
  const f=fixture({
    ['GET /repos/'+REPO+'/git/ref/tags/v7.6.2']:[[404,undefined],[200,ref()]],
    ['POST /repos/'+REPO+'/git/refs']:[[422,undefined]]
  });
  assert.equal((await ensureTag(f.options)).created,false);
  const bad=fixture({
    ['GET /repos/'+REPO+'/git/ref/tags/v7.6.2']:[[404,undefined],[200,ref(OTHER)]],
    ['POST /repos/'+REPO+'/git/refs']:[[422,undefined]]
  });
  await assert.rejects(ensureTag(bad.options),e=>e.code==='ETAGCONFLICT');
});
test('unexpected tag acknowledgement must not count as a publication',async()=>{
  const f=fixture({
    ['GET /repos/'+REPO+'/git/ref/tags/v7.6.2']:[[404,undefined]],
    ['POST /repos/'+REPO+'/git/refs']:[[201,ref(OTHER)]]
  });
  await assert.rejects(ensureTag(f.options),e=>e.code==='ETAGCREATE');
});
test('POST 201 still requires exact GET read-back',async()=>{
  const f=fixture({
    ['GET /repos/'+REPO+'/git/ref/tags/v7.6.2']:[[404,undefined],[404,undefined]],
    ['POST /repos/'+REPO+'/git/refs']:[[201,ref()]]
  });
  await assert.rejects(ensureTag(f.options),e=>e.code==='ETAGCONFIRM');
});
test('annotated tag may resolve to the canonical exact commit but never to another',async()=>{
  const f=fixture({
    ['GET /repos/'+REPO+'/git/ref/tags/v7.6.2']:[[200,{ref:'refs/tags/v7.6.2',object:{type:'tag',sha:OTHER}}]],
    ['GET /repos/'+REPO+'/git/tags/'+OTHER]:[[200,{object:{type:'commit',sha:SHA}}]]
  });
  assert.equal((await ensureTag(f.options)).created,false);
});
test('reject wrong repo, invalid tag, invalid sha or missing token before request',async()=>{
  const f=fixture({});
  for(const changes of [{repository:'attacker/other'},{tag:'v7.6.2/../../branch'},
    {sha:'null'},{token:''}])await assert.rejects(ensureTag({...f.options,...changes}),e=>e.code==='ETAGINPUT');
  assert.equal(f.calls.length,0);
});
test('do not follow redirects for GitHub tag operations',async()=>{
  const f=fixture({
    ['GET /repos/'+REPO+'/git/ref/tags/v7.6.2']:[[301,undefined]]
  });
  await assert.rejects(ensureTag(f.options),e=>e.code==='ETAGHTTP');
  assert.equal(f.calls[0].options.redirect,'error');
});
test('HTTP API uses a scoped authenticated origin without logging credentials',async()=>{
  const f=fixture({['GET /repos/'+REPO+'/git/ref/tags/v7.6.2']:[[403,{message:'private-fixture-token'}]]});
  await assert.rejects(ensureTag(f.options),e=>!String(e.message).includes('private-fixture-token'));
  assert.equal(f.calls[0].options.headers.Authorization,'Bearer synthetic-fixture-token');
});
