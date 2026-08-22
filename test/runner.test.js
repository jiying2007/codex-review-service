'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {runCodex,probeCodexCapabilities,unixRequest}=require('../src/codex');
const {runnerConfig}=require('../src/runner-server');

function withUnixServer(handler,fn){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-runner-test-'));
  const socket=path.join(dir,'runner.sock');
  const server=http.createServer(handler);
  return new Promise((resolve,reject)=>{
    server.listen(socket,async()=>{
      try{resolve(await fn(socket));}
      catch(error){reject(error);}
      finally{await new Promise(done=>server.close(done));fs.rmSync(dir,{recursive:true,force:true});}
    });
  });
}
function readJson(req){return new Promise((resolve,reject)=>{let text='';req.setEncoding('utf8');req.on('data',chunk=>text+=chunk);req.on('end',()=>{try{resolve(text?JSON.parse(text):{});}catch(error){reject(error);}});req.on('error',reject);});}
function withConfig(value,fn){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-runner-config-')),file=path.join(dir,'config.json'),old=process.env.CODEX_REVIEW_CONFIG_FILE;fs.writeFileSync(file,JSON.stringify(value));process.env.CODEX_REVIEW_CONFIG_FILE=file;try{return fn();}finally{if(old===undefined)delete process.env.CODEX_REVIEW_CONFIG_FILE;else process.env.CODEX_REVIEW_CONFIG_FILE=old;fs.rmSync(dir,{recursive:true,force:true});}}

test('isolated runner reads canonical config and keeps user-specific HOME by default',()=>withConfig({gitlab:{baseUrl:'https://gitlab.test',projects:[1]},review:{timeoutSeconds:77},codex:{path:'codex-x',home:'',model:'m',versionPolicy:'warn'},runner:{mode:'isolated',socket:'/run/test-runner.sock'}},()=>{const config=runnerConfig();assert.equal(config.socket,'/run/test-runner.sock');assert.equal(config.codexPath,'codex-x');assert.equal(config.codexHome,'');assert.equal(config.codexModel,'m');assert.equal(config.reviewTimeoutSeconds,77);}));
test('runner refuses to start from inline deployment config',()=>withConfig({gitlab:{baseUrl:'https://gitlab.test',projects:[1]},runner:{mode:'inline'}},()=>assert.throws(()=>runnerConfig(),/must be isolated/)));

test('controller capability probe uses Unix runner health endpoint',async()=>withUnixServer((req,res)=>{
  assert.equal(req.method,'GET');
  assert.equal(req.url,'/health');
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify({ok:true,version:'codex-cli 9.9.9',versionMatched:true}));
},async socket=>{
  const result=await probeCodexCapabilities({codexRunnerSocket:socket},true);
  assert.deepEqual(result,{version:'codex-cli 9.9.9',versionMatched:true,mode:'runner'});
}));

test('controller review request preserves bounded runner contract and usage',async()=>withUnixServer(async(req,res)=>{
  assert.equal(req.method,'POST');
  assert.equal(req.url,'/review');
  const body=await readJson(req);
  assert.equal(body.prompt,'review this diff');
  assert.equal(body.maxFindings,7);
  assert.equal(body.reviewTimeoutSeconds,45);
  assert.equal(body.model,'model-x');
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify({parsed:{summary:'ok',findings:[]},version:'codex-cli 9.9.9',versionMatched:true,usage:{inputTokens:100,cachedInputTokens:30,cacheWriteInputTokens:2,outputTokens:20,reasoningOutputTokens:5},model:'model-x'}));
},async socket=>{
  const result=await runCodex('review this diff',{codexRunnerSocket:socket,reviewTimeoutSeconds:45,codexModel:'model-x'},undefined,7);
  assert.equal(result.mode,'runner');
  assert.equal(result.version,'codex-cli 9.9.9');
  assert.deepEqual(result.usage,{inputTokens:100,cachedInputTokens:30,cacheWriteInputTokens:2,outputTokens:20,reasoningOutputTokens:5});
}));

test('runner HTTP errors preserve remote error code for controller policy',async()=>withUnixServer((_req,res)=>{
  res.writeHead(503,{'content-type':'application/json'});
  res.end(JSON.stringify({error:'ECODEXTIMEOUT',message:'Codex review timed out'}));
},async socket=>{
  await assert.rejects(()=>runCodex('x',{codexRunnerSocket:socket,reviewTimeoutSeconds:30,codexModel:''},undefined,1),error=>error.code==='ECODEXTIMEOUT'&&error.status===503);
}));

test('aborting controller request tears down Unix runner request',async()=>withUnixServer((_req,_res)=>{},async socket=>{
  const controller=new AbortController();
  const pending=unixRequest(socket,'POST','/review',{prompt:'x'},30000,controller.signal);
  setTimeout(()=>controller.abort(Object.assign(new Error('superseded'),{code:'ESUPERSEDED'})),10);
  await assert.rejects(()=>pending,error=>error.code==='ESUPERSEDED');
}));
