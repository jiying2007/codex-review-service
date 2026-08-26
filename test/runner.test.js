'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {runCodex,probeCodexCapabilities,unixRequest}=require('../src/codex');
const {runnerConfig}=require('../src/runner-server');
const {CONFIG_SCHEMA_VERSION}=require('../src/config');
const {SAFE_CORE_VERSION,SAFE_CONTRACT_VERSION,REVIEW_RECEIPT_SCHEMA_VERSION,REVIEW_PROMPT_CONTRACT_VERSION}=require('../src/codex-safe-core/safe-contract');
const posixTest=process.platform==='win32'?test.skip:test;

function withUnixServer(handler,fn){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-runner-test-')),socket=path.join(dir,'runner.sock'),server=http.createServer(handler);return new Promise((resolve,reject)=>{server.listen(socket,async()=>{try{resolve(await fn(socket));}catch(error){reject(error);}finally{await new Promise(done=>server.close(done));fs.rmSync(dir,{recursive:true,force:true});}});});}
function readJson(req){return new Promise((resolve,reject)=>{let text='';req.setEncoding('utf8');req.on('data',chunk=>text+=chunk);req.on('end',()=>{try{resolve(text?JSON.parse(text):{});}catch(error){reject(error);}});req.on('error',reject);});}
function withConfig(value,fn){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-runner-config-')),file=path.join(dir,'config.json'),old=process.env.CODEX_REVIEW_CONFIG_FILE;fs.writeFileSync(file,JSON.stringify({schemaVersion:CONFIG_SCHEMA_VERSION,...value}));process.env.CODEX_REVIEW_CONFIG_FILE=file;try{return fn();}finally{if(old===undefined)delete process.env.CODEX_REVIEW_CONFIG_FILE;else process.env.CODEX_REVIEW_CONFIG_FILE=old;fs.rmSync(dir,{recursive:true,force:true});}}
function capability(overrides={}){return{ok:true,version:'codex-cli 9.9.9',versionMatched:true,safeCoreVersion:SAFE_CORE_VERSION,safeContractVersion:SAFE_CONTRACT_VERSION,reviewReceiptSchemaVersion:REVIEW_RECEIPT_SCHEMA_VERSION,promptContractVersion:REVIEW_PROMPT_CONTRACT_VERSION,os:process.platform,arch:process.arch,maxConcurrency:1,model:'',...overrides};}

test('isolated runner reads Config Schema 1 and keeps user-specific HOME by default',()=>withConfig({gitlab:{baseUrl:'https://gitlab.test',projects:[1]},review:{timeoutSeconds:77},codex:{path:'codex-x',home:'',model:'m',versionPolicy:'warn'},runner:{mode:'isolated',socket:'/run/test-runner.sock'}},()=>{const config=runnerConfig();assert.equal(config.socket,'/run/test-runner.sock');assert.equal(config.codexPath,'codex-x');assert.equal(config.codexHome,'');assert.equal(config.codexModel,'m');assert.equal(config.reviewTimeoutSeconds,77);}));
test('runner refuses to start from inline deployment config',()=>withConfig({gitlab:{baseUrl:'https://gitlab.test',projects:[1]},runner:{mode:'inline'}},()=>assert.throws(()=>runnerConfig(),/must be isolated/)));

posixTest('controller capability probe uses Unix runner health endpoint',async()=>withUnixServer((req,res)=>{assert.equal(req.method,'GET');assert.equal(req.url,'/health');res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(capability()));},async socket=>{const result=await probeCodexCapabilities({codexRunnerSocket:socket},true);assert.equal(result.version,'codex-cli 9.9.9');assert.equal(result.versionMatched,true);assert.equal(result.mode,'runner');assert.equal(result.runnerCapability.safeCoreVersion,SAFE_CORE_VERSION);assert.equal(result.runnerCapability.promptContractVersion,REVIEW_PROMPT_CONTRACT_VERSION);}));

posixTest('controller capability probe rejects a stale runner protocol',async()=>withUnixServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(capability({safeCoreVersion:SAFE_CORE_VERSION-1})));},async socket=>{await assert.rejects(()=>probeCodexCapabilities({codexRunnerSocket:socket},true),error=>error.code==='ERUNNERCONTRACT');}));

posixTest('controller review request preserves bounded runner contract and usage',async()=>withUnixServer(async(req,res)=>{assert.equal(req.method,'POST');assert.equal(req.url,'/review');const body=await readJson(req);assert.equal(body.prompt,'review this diff');assert.equal(body.maxFindings,7);assert.equal(body.reviewTimeoutSeconds,45);assert.equal(body.model,'model-x');assert.equal(body.promptContractVersion,REVIEW_PROMPT_CONTRACT_VERSION);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({parsed:{summary:'ok',findings:[]},version:'codex-cli 9.9.9',versionMatched:true,usage:{inputTokens:100,cachedInputTokens:30,cacheWriteInputTokens:2,outputTokens:20,reasoningOutputTokens:5},model:'model-x'}));},async socket=>{const result=await runCodex('review this diff',{codexRunnerSocket:socket,reviewTimeoutSeconds:45,codexModel:'model-x'},undefined,7);assert.equal(result.mode,'runner');assert.equal(result.version,'codex-cli 9.9.9');assert.deepEqual(result.usage,{inputTokens:100,cachedInputTokens:30,cacheWriteInputTokens:2,outputTokens:20,reasoningOutputTokens:5});}));

posixTest('runner HTTP errors preserve remote error code for controller policy',async()=>withUnixServer((_req,res)=>{res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'ECODEXTIMEOUT',message:'Codex review timed out'}));},async socket=>{await assert.rejects(()=>runCodex('x',{codexRunnerSocket:socket,reviewTimeoutSeconds:30,codexModel:''},undefined,1),error=>error.code==='ECODEXTIMEOUT'&&error.status===503);}));

posixTest('aborting controller request tears down Unix runner request',async()=>withUnixServer((_req,_res)=>{},async socket=>{const controller=new AbortController(),pending=unixRequest(socket,'POST','/review',{prompt:'x'},30000,controller.signal);setTimeout(()=>controller.abort(Object.assign(new Error('superseded'),{code:'ESUPERSEDED'})),10);await assert.rejects(()=>pending,error=>error.code==='ESUPERSEDED');}));
