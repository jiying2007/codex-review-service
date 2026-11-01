'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {GitLabClient}=require('../src/gitlab');require('../src/gitlab-evidence');
async function listen(handler,t){const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));return`http://127.0.0.1:${server.address().port}`;}
function client(origin){return new GitLabClient({gitlabApiUrl:origin+'/api/v4',gitlabToken:'synthetic-token',gitlabRequestTimeoutMs:1000,gitlabRequestsPerSecond:1000});}
test('signed artifact CDN redirects are anonymous even if redirected back to GitLab',async t=>{
  let origin;const seen=[];
  const cdn=await listen((req,res)=>{seen.push(req.headers['private-token']);res.writeHead(302,{location:origin+'/return'});res.end();},t);
  origin=await listen((req,res)=>{seen.push(req.headers['private-token']);if(req.url==='/return')res.end('artifact');else{res.writeHead(302,{location:cdn+'/signed?token=synthetic'});res.end();}},t);
  assert.equal(await client(origin).getJobArtifactFile(7,1,'report.json'),'artifact');assert.deepEqual(seen,['synthetic-token',undefined,undefined]);
});
test('same-origin reads retain authentication while cross-origin APIs and all writes reject redirects',async t=>{
  let reached=0;const other=await listen((_req,res)=>{reached++;res.end('{}');},t),seen=[];
  const origin=await listen((req,res)=>{seen.push(req.headers['private-token']);if(req.url==='/same'){res.end('{}');return;}res.writeHead(302,{location:req.url.endsWith('/same-read')?'/same':other+'/target'});res.end();},t);
  const gitlab=client(origin);assert.deepEqual((await gitlab.request('GET','/same-read')).data,{});
  await assert.rejects(gitlab.request('GET','/external'),{code:'EGITLABREDIRECT'});await assert.rejects(gitlab.request('POST','/external',{body:{value:'test'}}),{code:'EGITLABREDIRECT'});
  assert.equal(reached,0);assert.ok(seen.every(value=>value==='synthetic-token'));
});
test('artifact redirect loops are bounded',async t=>{
  let requests=0;const origin=await listen((_req,res)=>{requests++;res.writeHead(302,{location:'/loop'});res.end();},t);
  await assert.rejects(client(origin).getJobArtifactFile(7,1,'report'),{code:'EGITLABREDIRECT'});assert.equal(requests,6);
});
test('HTTPS downgrade, URL credentials and non-HTTP schemes fail before a second request',async()=>{
  const original=global.fetch;
  try{for(const location of ['http://cdn.invalid/report','https://user:pass@cdn.invalid/report','file:///tmp/report']){
    let requests=0;global.fetch=async(_url,options)=>{requests++;assert.equal(options.redirect,'manual');return new Response(null,{status:302,headers:{location}});};
    await assert.rejects(client('https://gitlab.invalid').getJobArtifactFile(7,1,'report'),{code:'EGITLABREDIRECT'});assert.equal(requests,1);
  }}finally{global.fetch=original;}
});
