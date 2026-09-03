'use strict';

const http = require('node:http');
const path = require('node:path');
const { outputSchema } = require('./review');
const { createProcessRunner } = require('./codex-safe-core/process-runner');
const { createCodexCli } = require('./codex-safe-core/codex-cli');
const { runtimeResolutionFromConfig, inspectRuntimeFromConfig, filteredRuntimeEnv, prepareRuntimeFromConfig } = require('./runtime');
const { usageShape: normalizeUsage, extractCodexUsage } = require('./codex-safe-core/efficiency-planner');
const {
  SAFE_CORE_VERSION,
  SAFE_CONTRACT_VERSION,
  REVIEW_RECEIPT_SCHEMA_VERSION,
  REVIEW_PROMPT_CONTRACT_VERSION,
  REQUIRED_CODEX_TOP_LEVEL_FLAGS,
  REQUIRED_CODEX_EXEC_FLAGS,
  SAFE_CODEX_CONFIG_OVERRIDES,
  buildSafeCodexArgs
} = require('./codex-safe-core/safe-contract');

const REQUIRED_TOP_FLAGS = REQUIRED_CODEX_TOP_LEVEL_FLAGS;
const REQUIRED_EXEC_FLAGS = REQUIRED_CODEX_EXEC_FLAGS;
const SAFE_CONFIG_OVERRIDES = SAFE_CODEX_CONFIG_OVERRIDES;
const capabilityCache = new Map();

function runnerSocket(config) { return String(config?.codexRunnerSocket || '').trim(); }

function filteredEnv(config, runtime = {}, sourceEnv = process.env) { return filteredRuntimeEnv(config, runtime, sourceEnv); }

function runtimeFromConfig(config) { return runtimeResolutionFromConfig(config).runtime; }

function buildCodexArgs(schemaPath, model) { return buildSafeCodexArgs(schemaPath, model); }
function usageShape(value = {}) { return { ...normalizeUsage(value) }; }
function extractUsage(stdout) { return { ...extractCodexUsage(stdout) }; }
function parseJsonlEvents(stdout) { const cli=createCodexCli({runPreparedProcess:async()=>{throw new Error('not executable');}}); return { message:cli.parseCodexJsonl(stdout), usage:extractUsage(stdout) }; }
function parseJsonl(stdout) { return parseJsonlEvents(stdout).message; }

function checkVersionPolicy(version, config) {
  if (config.codexVersionPolicy === 'off' || !config.codexAllowedVersionPattern) return true;
  let matched = false;
  try { matched = new RegExp(config.codexAllowedVersionPattern).test(version); }
  catch { const error=new Error('codex.allowedVersionPattern is not a valid regular expression');error.code='ECODEXVERSION';throw error; }
  if (!matched && config.codexVersionPolicy === 'strict') { const error=new Error(`Codex version is outside the allowed production policy: ${version}`);error.code='ECODEXVERSION';throw error; }
  return matched;
}

function abortReason(signal) { return signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('Review aborted'),{code:'EABORTED'}); }
function cancellationToken(signal) {
  return {
    get isCancellationRequested() { return Boolean(signal?.aborted); },
    onCancellationRequested(listener) {
      if (!signal) return { dispose() {} };
      const fn = () => listener();
      signal.addEventListener('abort', fn, { once:true });
      return { dispose() { signal.removeEventListener('abort', fn); } };
    }
  };
}

function createLocalCli(config, runtime = {}, childEnv = null) {
  const processRunner = createProcessRunner((_zh,en)=>en);
  const baseEnv = childEnv || filteredEnv(config, runtime);
  const runPreparedProcess = (command,args,options={},stdinText='',token) => processRunner.runPreparedProcess(command,args,{...options,env:filteredEnv(config,runtime,options.env||baseEnv)},stdinText,token);
  return createCodexCli({ runPreparedProcess, tempPrefix:'codex-review-service-', capabilityCache });
}

async function probeCodexCapabilitiesLocal(config, force=false) {
  if (force) capabilityCache.clear();
  const cli=createLocalCli(config),resolved=await cli.resolveCodexExecutable(config.codexPath),capability=await cli.probeCodexCapabilities(resolved,config.codexModel||''),version=capability.version||resolved.version||'unknown';
  return Object.freeze({version,versionMatched:checkVersionPolicy(version,config),mode:'local'});
}

async function probeCodexRuntimeLocal(config,force=false){if(force)capabilityCache.clear();const prepared=prepareRuntimeFromConfig(config),cli=createLocalCli(config,prepared.runtime,prepared.childEnv),result=await cli.runStructuredCodex({codexPath:config.codexPath,model:config.codexModel||'',runtime:prepared.runtime,phase:'connectivity-probe',schema:{type:'object',additionalProperties:false,properties:{ok:{type:'boolean',const:true}},required:['ok']},input:'Connectivity probe. Return exactly {\"ok\":true} through the required output schema. Do not use tools or external data.',schemaFileName:'runtime-probe-schema.json',maxEstimatedTokens:2048,estimatedOutputTokens:32,processOptions:{env:prepared.childEnv}});const version=result.resolved?.version||'unknown';return Object.freeze({ok:result.parsed?.ok===true,codexVersion:version,model:config.codexModel||'cli-default',provider:result.provider,durationMs:result.durationMs,versionMatched:checkVersionPolicy(version,config),mode:'local',runtimeSource:prepared.source,runtimeConfigPath:prepared.configPath});}

async function runCodexLocal(prompt, config, signal, maxFindings=config.maxFindings) {
  const prepared=prepareRuntimeFromConfig(config), cli=createLocalCli(config,prepared.runtime,prepared.childEnv), token=cancellationToken(signal);
  try {
    const result=await cli.runStructuredCodex({codexPath:config.codexPath,model:config.codexModel||'',runtime:prepared.runtime,schema:outputSchema(maxFindings),input:prompt,schemaFileName:'review-schema.json',token,maxStdoutBytes:6*1024*1024,maxStderrBytes:1024*1024,processOptions:{detached:process.platform!=='win32',env:prepared.childEnv}});
    const version=result.resolved.version||'unknown';
    return {parsed:result.parsed,version,versionMatched:checkVersionPolicy(version,config),usage:usageShape(result.usage),requestEstimate:result.requestEstimate,durationMs:result.durationMs,model:config.codexModel||'',mode:'local',runtimeSource:prepared.source,runtimeConfigPath:prepared.configPath};
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    if (error?.code==='ETIMEDOUT') error.code='ECODEXTIMEOUT';
    if (error?.code==='EOUTPUTLIMIT') error.code='ECODEXOUTPUT';
    throw error;
  }
}

function unixRequest(socket,method,requestPath,body,timeoutMs,signal){return new Promise((resolve,reject)=>{const data=body===undefined?null:Buffer.from(JSON.stringify(body)),req=http.request({socketPath:socket,path:requestPath,method,headers:data?{'Content-Type':'application/json','Content-Length':data.length}:{},timeout:timeoutMs},res=>{let text='';res.setEncoding('utf8');res.on('data',chunk=>{text+=chunk;if(text.length>8*1024*1024)req.destroy(Object.assign(new Error('Runner response too large'),{code:'ERUNNEROUTPUT'}));});res.on('end',()=>{let payload;try{payload=text?JSON.parse(text):{};}catch{return reject(Object.assign(new Error('Runner returned invalid JSON'),{code:'ERUNNEROUTPUT'}));}if(res.statusCode<200||res.statusCode>=300){const error=new Error(payload.message||payload.error||`Runner returned ${res.statusCode}`);error.code=payload.error||'ERUNNER';error.status=res.statusCode;return reject(error);}resolve(payload);});});req.on('timeout',()=>req.destroy(Object.assign(new Error('Runner request timed out'),{code:'ERUNNERTIMEOUT'})));req.on('error',reject);const onAbort=()=>req.destroy(abortReason(signal));signal?.addEventListener('abort',onAbort,{once:true});req.on('close',()=>signal?.removeEventListener('abort',onAbort));req.end(data||undefined);});}

function assertRunnerCapability(value, config = {}) {
  const expected = {
    safeCoreVersion: SAFE_CORE_VERSION,
    safeContractVersion: SAFE_CONTRACT_VERSION,
    reviewReceiptSchemaVersion: REVIEW_RECEIPT_SCHEMA_VERSION,
    promptContractVersion: REVIEW_PROMPT_CONTRACT_VERSION
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value?.[key] !== expectedValue) {
      const error = new Error(`Runner ${key} mismatch: expected ${expectedValue}, received ${value?.[key] ?? '<missing>'}`);
      error.code = 'ERUNNERCONTRACT';
      throw error;
    }
  }
  if (!['linux','darwin','win32'].includes(String(value?.os || '')) || typeof value?.arch !== 'string' || !value.arch) {
    const error = new Error('Runner platform capability is missing or invalid'); error.code='ERUNNERCONTRACT'; throw error;
  }
  if (!Number.isInteger(value?.maxConcurrency) || value.maxConcurrency < 1) {
    const error = new Error('Runner maxConcurrency capability is invalid'); error.code='ERUNNERCONTRACT'; throw error;
  }
  const requestedModel = String(config.codexModel || '');
  if (requestedModel && value.model && value.model !== requestedModel) {
    const error = new Error(`Runner model mismatch: expected ${requestedModel}, received ${value.model}`); error.code='ERUNNERCONTRACT'; throw error;
  }
  return Object.freeze({...value});
}

async function probeCodexCapabilities(config, force=false) {
  const socket=runnerSocket(config);
  if(!socket)return probeCodexCapabilitiesLocal(config,force);
  const value=await unixRequest(socket,'GET','/health',undefined,10000);
  const runnerCapability=assertRunnerCapability(value,config);
  return {version:value.version||'unknown',versionMatched:value.versionMatched!==false,mode:'runner',runnerCapability};
}
async function probeCodexRuntime(config,force=false){const socket=runnerSocket(config);if(!socket)return probeCodexRuntimeLocal(config,force);const value=await unixRequest(socket,'POST','/probe',{},(config.codexRequestTimeoutSeconds+15)*1000);return{...value,mode:'runner'};}
async function runCodex(prompt,config,signal,maxFindings=config.maxFindings){const socket=runnerSocket(config);if(!socket)return runCodexLocal(prompt,config,signal,maxFindings);const result=await unixRequest(socket,'POST','/review',{prompt,maxFindings,reviewTimeoutSeconds:config.reviewTimeoutSeconds,model:config.codexModel||'',promptContractVersion:REVIEW_PROMPT_CONTRACT_VERSION},(config.reviewTimeoutSeconds+15)*1000,signal);return{...result,usage:usageShape(result.usage),mode:'runner'};}

module.exports={runCodex,runCodexLocal,filteredEnv,runtimeFromConfig,inspectRuntimeFromConfig,inspectRuntimeFromConfig,inspectRuntimeFromConfig,parseJsonl,parseJsonlEvents,buildCodexArgs,probeCodexRuntime,probeCodexRuntimeLocal,probeCodexCapabilities,probeCodexCapabilitiesLocal,SAFE_CONFIG_OVERRIDES,REQUIRED_TOP_FLAGS,REQUIRED_EXEC_FLAGS,checkVersionPolicy,usageShape,runnerSocket,unixRequest,extractUsage,cancellationToken,assertRunnerCapability};
