'use strict';

const {resolveModelRegistry}=require('./codex-safe-core/model-registry-resolver');
const {resolveModelSelection,buildModelEvidence}=require('./codex-safe-core/model-routing');
const {compareShadowReview,buildModelEconomicsScorecard}=require('./codex-safe-core/model-economics');
const {inspectRuntimeFromConfig}=require('./runtime');

const SEVERITY_RANK=Object.freeze({info:0,low:1,medium:2,high:3,critical:4});
function freeze(value){if(Array.isArray(value))return Object.freeze(value.map(freeze));if(value&&typeof value==='object')return Object.freeze(Object.fromEntries(Object.entries(value).map(([k,v])=>[k,freeze(v)])));return value;}
function usageShape(value={}){return{inputTokens:Number(value.inputTokens||0),cachedInputTokens:Number(value.cachedInputTokens||0),cacheWriteInputTokens:Number(value.cacheWriteInputTokens||0),outputTokens:Number(value.outputTokens||0),reasoningOutputTokens:Number(value.reasoningOutputTokens||0)};}
function usageAdd(total,next={}){for(const key of Object.keys(total))total[key]+=Number(next[key]||0);return total;}
function modelUnavailable(message,extra={}){const error=new Error(message);error.code='MODEL_UNAVAILABLE';Object.assign(error,extra);return error;}
function parseCandidate(value,label='candidate'){const text=String(value||'').trim(),slash=text.indexOf('/');if(slash<=0||slash===text.length-1||text.length>384||/[\r\n\0]/.test(text))throw new TypeError(`${label} must be provider/model.`);return freeze({provider:text.slice(0,slash),model:text.slice(slash+1)});}
function providerId(config,inspection){return String(inspection?.providerId||config?.codexProviderMode||'').trim();}

function createServiceModelRouter(config={},options={}){
  const registryResolution=options.registryResolution||resolveModelRegistry();
  const runtimeInspection=options.runtimeInspection||inspectRuntimeFromConfig(config);
  const provider=providerId(config,runtimeInspection);
  const strategy=String(config.codexModelSelectionStrategy||'auto');
  const compatibilityPolicy=String(config.codexModelCompatibilityPolicy||(strategy==='fixed'?'warn':'strict'));
  const candidates=Array.isArray(config.codexModelCandidates)?config.codexModelCandidates:[];
  const fixedModel=String(config.codexFixedModel||'').trim();
  function managed(role,mode,{optional=false,selectionStrategy=strategy,fixed=null,allowNonApprovedFixed=false}={}){
    if(!registryResolution.registry){
      if(role==='reviewer'&&selectionStrategy==='auto')return freeze({managed:false,role,mode,model:'',selection:null,registrySource:registryResolution.source});
      if(role==='reviewer'&&selectionStrategy==='fixed'&&fixedModel)return freeze({managed:false,role,mode,model:fixedModel,selection:null,registrySource:registryResolution.source});
      if(optional)return null;
      throw modelUnavailable(`No machine Model Registry is available for required ${role}/${mode} routing.`,{role,mode});
    }
    const request={registry:registryResolution.registry,role,mode,strategy:selectionStrategy,provider,compatibilityPolicy,crossProvider:false};
    if(selectionStrategy==='fixed'){
      const chosen=fixed||{provider,model:fixedModel};
      request.provider=chosen.provider||provider;request.model=chosen.model;request.fixed=chosen;request.requireApprovedFixed=!allowNonApprovedFixed;
    }else if(selectionStrategy==='preference')request.candidates=candidates;
    try{const selection=resolveModelSelection(request);return freeze({managed:true,role,mode,model:selection.resolvedModel,selection,registrySource:registryResolution.source});}
    catch(error){if(optional&&error?.code==='MODEL_UNAVAILABLE')return null;throw error;}
  }
  return freeze({
    provider,
    registrySource:registryResolution.source,
    registryRevision:registryResolution.registry?.revision||'',
    reviewer(){return managed('reviewer','balanced');},
    scout(){return config.codexScoutEnabled?managed('scout','fast',{optional:true}):null;},
    adjudicator(){return managed('adjudicator','deep');},
    shadow(){if(!config.codexShadowCandidate)return null;const candidate=parseCandidate(config.codexShadowCandidate,'codex.shadowCandidate');if(provider&&candidate.provider!==provider)throw Object.assign(new Error('Shadow candidate must use the active runtime provider.'),{code:'MODEL_CROSS_PROVIDER_FORBIDDEN'});return managed('reviewer','balanced',{optional:true,selectionStrategy:'fixed',fixed:candidate,allowNonApprovedFixed:true});},
    evidence(route,usage,roleRevision='service-7.5.0-v1'){return route?.selection?buildModelEvidence(route.selection,{usage,routingPolicyRevision:roleRevision,lineagePinned:false}):null;}
  });
}

function appendScout(prompt,validated){const findings=validated?.findings||[];if(!findings.length)return prompt;return `${prompt}\n\n--- SCOUT HYPOTHESES (UNTRUSTED MODEL OUTPUT) ---\nThe following are candidate hypotheses only. Independently verify each against the supplied immutable evidence. Do not accept a hypothesis merely because the Scout proposed it.\n${JSON.stringify(findings)}\n--- END SCOUT HYPOTHESES ---`;}
function appendAdjudication(prompt,validated){return `${prompt}\n\n--- REVIEWER CANDIDATES TO ADJUDICATE ---\nAct as the Adjudicator. Return only Reviewer findings that are fully supported by the supplied immutable evidence. Do not add unrelated findings and do not weaken deterministic evidence requirements.\n${JSON.stringify(validated?.findings||[])}\n--- END REVIEWER CANDIDATES ---`;}
function shouldAdjudicate(validated,minSeverity='high'){const threshold=SEVERITY_RANK[minSeverity]??SEVERITY_RANK.high;return (validated?.findings||[]).some(item=>(SEVERITY_RANK[item.severity]??-1)>=threshold);}

async function executeRoleAwareReview({prompt,config={},signal,maxFindings,runCodexFn,validateResult,router=createServiceModelRouter(config),beforeCall=null,afterCall=null}={}){
  if(typeof runCodexFn!=='function'||typeof validateResult!=='function')throw new TypeError('Role-aware review requires runCodexFn and validateResult.');
  const calls=[],totalUsage=usageShape(),productionModels=new Set();let scoutValidated=null,reviewerValidated=null,finalValidated=null,shadowComparison=null,shadowError='',productionLatencyMs=0,shadowLatencyMs=0;
  async function execute(role,route,input,{optional=false,shadow=false}={}){
    if(!route)return null;
    let budgetMeta=null;
    try{budgetMeta=beforeCall?await beforeCall({role,route,input,optional,shadow,maxFindings}):null;}
    catch(error){if(optional&&error?.code==='ETOKENBUDGET')return null;throw error;}
    if(budgetMeta===false){if(optional)return null;const error=new Error(`Token budget rejected required ${role} call.`);error.code='ETOKENBUDGET';throw error;}
    const started=Date.now();
    try{
      const result=await runCodexFn(input,{...config,codexModel:route.model},signal,maxFindings),durationMs=Number(result.durationMs||Date.now()-started),validated=validateResult(result.parsed),usage=usageShape(result.usage),evidence=router.evidence(route,usage);
      usageAdd(totalUsage,usage);if(shadow)shadowLatencyMs+=durationMs;else{productionLatencyMs+=durationMs;productionModels.add(result.model||route.model||'cli-default');}
      const call=freeze({role,shadow,managed:route.managed,model:result.model||route.model||'cli-default',usage,durationMs,modelEvidence:evidence,budgetMeta});calls.push(call);
      if(afterCall)await afterCall({role,route,input,result,validated,call,optional,shadow,budgetMeta});
      return{result,validated,call};
    }catch(error){if(optional)return{error};throw error;}
  }

  const scoutRoute=router.scout();
  if(scoutRoute){const scout=await execute('scout',scoutRoute,prompt,{optional:true});if(scout?.validated)scoutValidated=scout.validated;}
  const reviewerRoute=router.reviewer(),reviewerInput=appendScout(prompt,scoutValidated),reviewer=await execute('reviewer',reviewerRoute,reviewerInput);reviewerValidated=reviewer.validated;finalValidated=reviewerValidated;
  if(config.codexAdjudicatorEnabled&&shouldAdjudicate(reviewerValidated,config.codexAdjudicatorMinSeverity||'high')){
    const adjudicator=await execute('adjudicator',router.adjudicator(),appendAdjudication(prompt,reviewerValidated));finalValidated=adjudicator.validated;
  }
  const shadowRoute=router.shadow();
  if(shadowRoute){
    const shadow=await execute('reviewer',shadowRoute,prompt,{optional:true,shadow:true});
    if(shadow?.validated)shadowComparison=compareShadowReview({production:{findings:finalValidated.findings||[],usage:totalUsage,latencyMs:productionLatencyMs},candidate:{findings:shadow.validated.findings||[],usage:shadow.call.usage,latencyMs:shadowLatencyMs}});
    else if(shadow?.error)shadowError=String(shadow.error.code||shadow.error.message||'ESHADOW');
  }
  const productionCalls=calls.filter(item=>!item.shadow),economics=buildModelEconomicsScorecard([{usage:totalUsage,verifiedFindings:(finalValidated?.findings||[]).length,verifierCalls:productionCalls.filter(item=>item.role==='reviewer').length,scoutCalls:productionCalls.filter(item=>item.role==='scout').length,adjudicatorCalls:productionCalls.filter(item=>item.role==='adjudicator').length,latencyMs:productionLatencyMs+shadowLatencyMs}]);
  return freeze({finalValidated,reviewerValidated,scoutValidated,calls,usage:totalUsage,productionModels:[...productionModels],modelEvidence:productionCalls.map(item=>item.modelEvidence).filter(Boolean),shadowComparison,shadowError,economics,productionLatencyMs,shadowLatencyMs,registrySource:router.registrySource,registryRevision:router.registryRevision});
}

module.exports={SEVERITY_RANK,parseCandidate,createServiceModelRouter,appendScout,appendAdjudication,shouldAdjudicate,executeRoleAwareReview};
