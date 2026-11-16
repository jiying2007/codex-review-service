'use strict';

const crypto=require('node:crypto');
const path=require('node:path');
const{genAiUsageAttributes}=require('./telemetry');
const{buildSnapshot,buildPrompt,validateChunkResult,consolidateReviews,mergeCurrentEvidenceFindings,emptyReview,deterministicSummary,formatSummary,createServiceReviewReceipt}=require('./review');
const{runCodex}=require('./codex');
const{getEffectivePolicy}=require('./policy');
const{buildReviewContext}=require('./context');
const{collectServiceQualityEvidence,qualityContextForChunk,anchorAnalyzerFindings}=require('./quality');
const{resolveReviewProfilePack}=require('./codex-safe-core/review-profile-pack');
const{fingerprint,REVIEW_PROMPT_CONTRACT_VERSION}=require('./codex-safe-core/safe-contract');
const{computeReviewSubjectFingerprint,shouldPersistJudgmentReceipt}=require('./codex-safe-core/judgment-lifecycle');
const{classifyFindingLifecycle}=require('./finding-ledger');
const{eventForReview,eventForReviewStarted,eventForFailure,planStatusCardActions,planNotificationActions}=require('./notification');
const{currentAssignments,assignmentMatch}=require('./assignment');
const{estimateChunkTokens,adaptiveContextConfig,selectChunksWithinByteBudget,allocateFindingCapacities,TokenBudgetLedger,TokenEstimatorCalibration}=require('./cost-planner');
const{createServiceModelRouter,executeRoleAwareReview}=require('./model-routing-runtime');
const{buildModelEconomicsScorecard}=require('./codex-safe-core/model-economics');
const{createTokenCalibrationStore}=require('./codex-safe-core/token-calibration-store');
const{observedUsage}=require('./model-usage');

const NON_RETRYABLE_ERRORS=new Set(['ECODEXVERSION','ECODEXOUTPUT','ECODEXNOTFOUND','ECODEXAUTH','EPROJECTPOLICY','EJOBTIMEOUT','EUNAUTHORIZED','ETOKENBUDGET','EMODELCALLUNCERTAIN']);
function abortError(code,message){return Object.assign(new Error(message),{code});}
function retryable(error){if(!error)return true;if(NON_RETRYABLE_ERRORS.has(error.code))return false;if(error.code==='EGITLABHTTP'){const status=Number(error.status);if([408,409,425,429].includes(status)||status>=500)return true;if(status>=400)return false;}return !['EPROJECTNOTALLOWED'].includes(error.code);}
function retryDelay(config,job,error){if(Number.isFinite(error?.retryAfterMs))return Math.min(config.retryMaxDelayMs,error.retryAfterMs);const base=Math.min(config.retryMaxDelayMs,config.retryBaseDelayMs*(2**Math.max(0,job.attempt-1)));return Math.round(base*(0.85+Math.random()*0.3));}
function usageAdd(total,next={}){for(const key of['inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens','reasoningOutputTokens'])total[key]=(total[key]||0)+Number(next[key]||0);return total;}
function usageTotal(usage){return Number(usage.inputTokens||0)+Number(usage.outputTokens||0);}
function utcDayStart(){const d=new Date();return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())).toISOString();}
function isDraft(mr){return mr?.draft===true||mr?.work_in_progress===true;}
function reviewSubject(snapshot){return{type:'gitlab-mr',projectId:Number(snapshot.projectId),mrIid:Number(snapshot.iid),startSha:snapshot.startSha,headSha:snapshot.headSha};}

// Count concrete changed-line evidence, not merely submitted file names.
// One authoritative view of planned, scheduled and actually completed evidence.
// The initial snapshot's plannedUnits is the only retained baseline; every other
// field is recomputed after total-diff selection and after model execution.
function evidenceCoverageLedger(snapshot,chunks,reviewedCount=chunks.length){
 const expected=new Set(),scheduled=new Set(),modelReviewed=new Set(),scheduledFiles=new Set();
 const key=(path,side,line)=>JSON.stringify([path,side,line]);
 for(const file of snapshot.files||[])if(!file.skipped){
   for(const side of ['new','old'])for(const line of file.changedLines?.[side]||[])
     expected.add(key(file.path,side,line));
 }
 chunks.forEach((chunk,index)=>{
   for(const file of chunk.files||[]){
     scheduledFiles.add(file.path);
     for(const side of ['new','old'])for(const line of file.changedLines?.[side]||[]){
       const value=key(file.path,side,line);
       scheduled.add(value);
       if(index<reviewedCount)modelReviewed.add(value);
     }
   }
 });
 const countIn=set=>[...expected].filter(value=>set.has(value)).length;
 const planned=countIn(scheduled),completed=countIn(modelReviewed);
 const original=snapshot.coverageLedger||{};
 const plannedUnits=Number.isSafeInteger(original.plannedEvidenceUnits)
   ?original.plannedEvidenceUnits
   :chunks.reduce((n,chunk)=>n+Math.max(0,Number(chunk.unitCount)||0),0);
 return Object.freeze({
   providerComplete:Boolean(original.providerComplete??true),
   changedFiles:(snapshot.files||[]).length,
   reviewableFiles:(snapshot.files||[]).filter(file=>!file.skipped).length,
   scheduledFiles:scheduledFiles.size,
   changedLines:expected.size,
   scheduledChangedLines:planned,
   unscheduledChangedLines:expected.size-planned,
   plannedEvidenceUnits:plannedUnits,
   scheduledEvidenceUnits:chunks.reduce((n,chunk)=>n+Math.max(0,Number(chunk.unitCount)||0),0),
   scheduledChunks:chunks.length,
   coverageGaps:(snapshot.coverageGaps||[]).length,
   plannedForModel:planned,
   completedByModel:completed,
   unplannedChangedLines:expected.size-planned,
   notReviewedChangedLines:expected.size-completed,
   plannedChunks:chunks.length,
   completedChunks:Math.min(chunks.length,Math.max(0,reviewedCount)),
   plannedFiles:scheduledFiles.size
 });
}
class ReviewService{
  constructor({config,store,gitlab,logger=console,telemetry=null,runCodexFn=runCodex,getPolicyFn=getEffectivePolicy,contextFn=buildReviewContext}){this.config=config;this.store=store;this.gitlab=gitlab;if(!('recoverClassicEmptyDiffs' in this.gitlab))Object.defineProperty(this.gitlab,'recoverClassicEmptyDiffs',{value:async(_projectId,_mr,diffResult)=>diffResult,enumerable:false});this.logger=logger;this.telemetry=telemetry;this.runCodexFn=runCodexFn;this.getPolicyFn=getPolicyFn;this.contextFn=contextFn;this.active=new Map();this.stopping=false;this.workers=[];this.tokenLedger=new TokenBudgetLedger();this.tokenCalibration=new TokenEstimatorCalibration();this.tokenCalibrationStore=null;if(config.dataDir){try{this.tokenCalibrationStore=createTokenCalibrationStore({filePath:path.join(config.dataDir,'token-calibration.json')});this.tokenCalibrationStore.restore(this.tokenCalibration);}catch(error){this.logger.warn?.({event:'token_calibration_restore_failed',code:error.code||'ECALIBRATIONSTORE'});}}}
  key(projectId,iid){return`${projectId}:${iid}`;}
  reservationKey(job){return`job:${job.id}`;}
  traceId(value=''){return this.telemetry?.traceId(value)||crypto.createHash('md5').update(value||crypto.randomUUID()).digest('hex');}
  ensureAllowedProject(projectId){if(this.config.gitlabProjectAllowlist&&!this.config.gitlabProjectAllowlist.has(Number(projectId))){const error=new Error('GitLab project is not allowed');error.code='EPROJECTNOTALLOWED';throw error;}}
  afterAcceptance(callback){if(this.store.afterCommit)this.store.afterCommit(callback);else callback();}
  handleEvent(event,webhookId){
    if(!event.projectAllowed||!event.projectId)return{status:'ignored'};
    this.ensureAllowedProject(event.projectId);
    if(event.shouldCancel&&event.iid){this.store.cancelMergeRequest(event.projectId,event.iid,'cancelled');const active=this.active.get(this.key(event.projectId,event.iid));if(active)this.afterAcceptance(()=>active.controller.abort(abortError('ECANCELLED',`Merge request ${event.action}`)));return{status:'cancelled'};}
    if(!event.shouldReview)return{status:'ignored'};
    const manual=event.kind==='note';
    const dedupeKey=`${manual?'command':'event'}:${webhookId}`;
    const jobId=this.store.enqueue({projectId:event.projectId,mrIid:event.iid,baseSha:event.baseSha||'',startSha:event.startSha||'',headSha:event.headSha||'',sourceBranch:event.sourceBranch||'',trigger:manual?'command':event.action,dedupeKey,requestedByUserId:manual?event.userId:null,requestWebhookId:webhookId,maxQueueDepth:this.config.maxQueueDepth,delayMs:manual?0:this.config.reviewDebounceMs,traceId:this.traceId(String(webhookId))});
    const active=this.active.get(this.key(event.projectId,event.iid)),changed=active&&((event.headSha&&active.headSha&&event.headSha!==active.headSha)||(event.startSha&&active.startSha&&event.startSha!==active.startSha)||(event.baseSha&&active.baseSha&&event.baseSha!==active.baseSha)||(event.sourceBranch&&active.sourceBranch&&event.sourceBranch!==active.sourceBranch)||(event.targetBranch&&active.targetBranch&&event.targetBranch!==active.targetBranch));
    if(changed)this.afterAcceptance(()=>active.controller.abort(abortError('ESUPERSEDED','A newer merge request snapshot arrived')));
    return{status:jobId?'queued':'duplicate',jobId};
  }
  enqueueHydratedMr(projectId,mr,trigger='reconcile'){
    if(isDraft(mr)&&!this.config.reviewDraftMergeRequests)return null;
    if(!assignmentMatch(currentAssignments(mr,mr),this.config.triggerAssignment))return null;
    const headSha=String(mr.diff_refs?.head_sha||mr.sha||'').trim(),startSha=String(mr.diff_refs?.start_sha||'').trim(),baseSha=String(mr.diff_refs?.base_sha||'').trim(),sourceBranch=String(mr.source_branch||''),targetBranch=String(mr.target_branch||'');
    if(!headSha||!startSha)return null;
    const jobId=this.store.enqueue({projectId,mrIid:Number(mr.iid),baseSha,startSha,headSha,sourceBranch,trigger,dedupeKey:`reconcile:${startSha}:${headSha}:${crypto.createHash('sha256').update(JSON.stringify([baseSha,sourceBranch,targetBranch])).digest('hex').slice(0,16)}`,maxQueueDepth:this.config.maxQueueDepth,delayMs:this.config.reviewDebounceMs,traceId:this.traceId(`${projectId}:${mr.iid}:${startSha}:${headSha}:${baseSha}:${sourceBranch}:${targetBranch}`)});
    const active=this.active.get(this.key(projectId,Number(mr.iid)));
    if(active&&((active.headSha&&active.headSha!==headSha)||(active.startSha&&active.startSha!==startSha)||(active.baseSha&&baseSha&&active.baseSha!==baseSha)||(active.sourceBranch&&sourceBranch&&active.sourceBranch!==sourceBranch)||(active.targetBranch&&targetBranch&&active.targetBranch!==targetBranch)))active.controller.abort(abortError('ESUPERSEDED','Reconciliation found a newer merge request snapshot'));
    return jobId;
  }
  async reconcile(){if(!this.config.gitlabProjectAllowlist||this.stopping)return{projects:0,enqueued:0};let enqueued=0;for(const projectId of this.config.gitlabProjectAllowlist){try{const result=await this.gitlab.listOpenMergeRequests(projectId);if(!result.complete)this.logger.warn?.({event:'reconcile_incomplete',projectId});for(const mr of result.items)if(this.enqueueHydratedMr(projectId,mr))enqueued++;}catch(error){this.logger.warn?.({event:'reconcile_failed',projectId,code:error.code||'EUNKNOWN',status:error.status||null});}}return{projects:this.config.gitlabProjectAllowlist.size,enqueued};}
  async authorizeManual(job){if(job.trigger!=='command')return true;if(!job.requested_by_user_id)return false;if(this.config.manualMinAccessLevel<=0)return true;const member=await this.gitlab.getProjectMember(job.project_id,job.requested_by_user_id);return Boolean(member&&Number(member.access_level)>=this.config.manualMinAccessLevel);}
  async hydrateJob(job){
    const mr=await this.gitlab.getMergeRequest(job.project_id,job.mr_iid);
    if(mr.state!=='opened')return{mr,terminal:'cancelled'};
    if(isDraft(mr)&&!this.config.reviewDraftMergeRequests)return{mr,terminal:'skipped'};
    const headSha=String(mr.diff_refs?.head_sha||mr.sha||'').trim(),startSha=String(mr.diff_refs?.start_sha||'').trim(),baseSha=String(mr.diff_refs?.base_sha||'').trim();
    if(!headSha||!startSha||!baseSha){const error=new Error('Merge request diff refs are not ready');error.code='EDIFFREFS';throw error;}
    let statusProjectId=Number(mr.source_project_id||job.project_id);if(!Number.isInteger(statusProjectId)||statusProjectId<=0)statusProjectId=job.project_id;
    const sourceBranch=String(mr.source_branch||''),targetBranch=String(mr.target_branch||''),pipelineId=await this.gitlab.resolveStatusPipeline(statusProjectId,job.project_id,job.mr_iid,headSha,sourceBranch,mr);
    const bound=this.store.bindJobSnapshot(job.id,{baseSha,startSha,headSha,sourceBranch,targetBranch,statusProjectId,pipelineId});
    if(bound.status==='duplicate'&&job.trigger==='reconcile')return{mr,terminal:'duplicate'};
    const statusJob={...job,head_sha:headSha,source_branch:sourceBranch},statusEvent=eventForReviewStarted(statusJob,mr),statusActions=planStatusCardActions(this.config,statusEvent,job.id);
    if(statusActions.length)this.store.enqueueReviewStatusCards(job.id,statusActions);
    const active=this.active.get(this.key(job.project_id,job.mr_iid));
    if(active){active.headSha=headSha;active.startSha=startSha;active.baseSha=baseSha;active.statusProjectId=statusProjectId;active.pipelineId=pipelineId;active.sourceBranch=sourceBranch;active.targetBranch=targetBranch;}
    return{mr,terminal:null,statusProjectId,pipelineId};
  }
  checkProjectBudget(projectId){if(!this.config.projectDailyTokenBudget)return;const used=this.store.tokenUsageSince(projectId,utcDayStart()),reserved=this.tokenLedger.reservedForProject(projectId);if(used+reserved>=this.config.projectDailyTokenBudget){const error=new Error('Project daily Codex token budget exhausted');error.code='ETOKENBUDGET';throw error;}}
  reserveChunkBudget(job,estimatedTokens){if(!this.config.projectDailyTokenBudget)return;const committed=this.store.tokenUsageSince(job.project_id,utcDayStart());this.tokenLedger.reserve(this.reservationKey(job),job.project_id,estimatedTokens,{budget:this.config.projectDailyTokenBudget,committed});}
  recordUsage(usage={},estimated=0,riskScore=0,usageKnown=true){
    const metrics=this.telemetry?.metrics;if(!metrics)return;
    if(usageKnown){
      metrics.inc('codex_review_input_tokens_total',Number(usage.inputTokens||0));metrics.inc('codex_review_cached_input_tokens_total',Number(usage.cachedInputTokens||0));metrics.inc('codex_review_cache_write_input_tokens_total',Number(usage.cacheWriteInputTokens||0));metrics.inc('codex_review_output_tokens_total',Number(usage.outputTokens||0));metrics.inc('codex_review_reasoning_output_tokens_total',Number(usage.reasoningOutputTokens||0));
      const semantic=genAiUsageAttributes(usage);metrics.inc('gen_ai_usage_input_tokens_total',semantic['gen_ai.usage.input_tokens']);metrics.inc('gen_ai_usage_cache_read_input_tokens_total',semantic['gen_ai.usage.cache_read.input_tokens']);metrics.inc('gen_ai_usage_cache_creation_input_tokens_total',semantic['gen_ai.usage.cache_creation.input_tokens']);metrics.inc('gen_ai_usage_output_tokens_total',semantic['gen_ai.usage.output_tokens']);metrics.inc('gen_ai_usage_reasoning_output_tokens_total',semantic['gen_ai.usage.reasoning_output_tokens']);
    }
    metrics.observe('codex_review_chunk_estimated_tokens',Number(estimated||0),[1000,5000,10000,25000,50000,100000,250000]);metrics.observe('codex_review_chunk_risk_score',Number(riskScore||0),[1,2,4,6,8,10,15,20]);
  }
  enqueueStatus(job,state,description,type='status'){if(!job.head_sha||!job.status_project_id)return null;return this.store.enqueuePublication({runId:null,projectId:job.project_id,mrIid:job.mr_iid,type,dedupeKey:`job:${job.id}:status:${state}`,payload:{snapshotIdentityVersion:1,sourceProjectId:job.status_project_id||job.project_id,targetProjectId:job.project_id,sourceBranch:job.source_branch||'',targetBranch:job.target_branch||'',baseSha:job.base_sha||'',jobId:job.id,startSha:job.start_sha,statusName:this.config.statusName,statusProjectId:job.status_project_id,headSha:job.head_sha,state,description,ref:job.source_branch||'',pipelineId:job.pipeline_id||null}});}
  async reviewSnapshot(job,mr,fullDiffs,policy,controller){
    let qualityEvidence;
    try{qualityEvidence=await collectServiceQualityEvidence(this.gitlab,mr,fullDiffs,this.config);}catch(error){if((this.config.analyzerReports||[]).some(spec=>spec.required))throw error;this.logger.warn?.({event:'quality_evidence_degraded',jobId:job.id,projectId:job.project_id,mrIid:job.mr_iid,code:error?.code||'EQUALITYEVIDENCE'});qualityEvidence={profile:resolveReviewProfilePack(this.config.reviewProfile||'general'),impact:{nodes:[],edges:[],text:'',bytes:0,complete:false,truncated:true},analyzerFindings:[],analyzerEvidence:{text:'',included:0,total:0,bytes:0,truncated:false},degradationReasons:['quality_collection_failed']};}
    const profile=qualityEvidence.profile||resolveReviewProfilePack(this.config.reviewProfile||'general');
    this.telemetry?.metrics.inc('codex_review_impact_nodes_total',qualityEvidence.impact?.nodes?.length||0);
    this.telemetry?.metrics.inc('codex_review_analyzer_findings_total',qualityEvidence.analyzerFindings?.length||0);
    const fullSnapshot=buildSnapshot(mr,fullDiffs,policy),reviewSnapshot=fullSnapshot;
    const qualityDegradations=[...new Set(qualityEvidence.degradationReasons||[])].slice(0,24);
    for(const reason of qualityDegradations)fullSnapshot.advisories.push('quality:'+reason);
    if(qualityDegradations.length)this.telemetry?.metrics.inc('codex_review_quality_evidence_degraded_total',qualityDegradations.length);fullSnapshot.rawDiffFallbacks=Object.freeze(fullSnapshot.files.map(file=>file.raw_diff_fallback?{path:file.path,...file.raw_diff_fallback}:null).filter(Boolean));if(fullSnapshot.rawDiffFallbacks.length)this.logger.info?.({event:'gitlab_raw_diff_fallback',jobId:job.id,projectId:job.project_id,mrIid:job.mr_iid,results:fullSnapshot.rawDiffFallbacks.map(item=>({path:item.path,status:item.status,oldBytes:item.oldBytes,newBytes:item.newBytes,diffBytes:item.diffBytes}))});
    const baseTotalBudget=this.config.maxTotalDiffBytes||this.config.maxDiffBytes,profileTotalBudget=Math.max(policy.maxDiffBytes,Math.floor(baseTotalBudget*profile.evidenceFactor)),selection=selectChunksWithinByteBudget(reviewSnapshot.chunks,profileTotalBudget);
    reviewSnapshot.chunks=selection.chunks;
    fullSnapshot.coverageLedger=evidenceCoverageLedger(fullSnapshot,selection.chunks);
    this.telemetry?.metrics.inc('codex_review_unplanned_changed_lines_total',fullSnapshot.coverageLedger.unplannedChangedLines);
    if(!selection.complete){const omitted=selection.omitted.map(chunk=>chunk.files.map(file=>file.path).join(',')).filter(Boolean);fullSnapshot.coverageGaps.push(`mr_diff_budget:${omitted.slice(0,8).join('|')||'chunk_omitted'}`);fullSnapshot.coverageComplete=false;this.telemetry?.metrics.inc('codex_review_diff_budget_omitted_chunks_total',selection.omitted.length);}
    fullSnapshot.coverageLedger=evidenceCoverageLedger(fullSnapshot,reviewSnapshot.chunks);
    const evidenceEntries=[];
    if(!reviewSnapshot.chunks.length){
      const review=emptyReview(reviewSnapshot,policy);
      review.summary=deterministicSummary(review.findings,policy);
      review.usage={inputTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:0,reasoningOutputTokens:0};
      review.usageKnown=true;review.reviewProfile=profile.name;fullSnapshot.coverageLedger=evidenceCoverageLedger(fullSnapshot,[],0);review.coverageLedger=fullSnapshot.coverageLedger;review.modelCoverage=fullSnapshot.coverageLedger;review.qualityEvidenceStatus=Object.freeze({degraded:qualityDegradations.length>0,reasons:qualityDegradations});review.contextCoverage={omittedSlices:0,omittedFiles:[],reasons:{}};review.saturatedChunks=[];review.modelInferenceCount=0;
      review.evidenceManifestDigest=fingerprint({version:1,diffFingerprint:fullSnapshot.diffFingerprint,coverageGaps:fullSnapshot.coverageGaps,advisories:fullSnapshot.advisories,coverageLedger:fullSnapshot.coverageLedger,fallbacks:fingerprint(fullSnapshot.rawDiffFallbacks),profile:profile.name,quality:{impact:fingerprint(qualityEvidence.impact||{}),analyzers:fingerprint(qualityEvidence.analyzerFindings||[]),degradationReasons:qualityDegradations},chunks:[]});
      review.reviewSubjectFingerprint=computeReviewSubjectFingerprint({subject:reviewSubject(fullSnapshot),diffFingerprint:fullSnapshot.diffFingerprint,policyFingerprint:policy.fingerprint||'<none>',evidenceManifestDigest:review.evidenceManifestDigest,promptContractVersion:REVIEW_PROMPT_CONTRACT_VERSION,reviewProfile:profile.name,model:''});
      return{snapshot:fullSnapshot,review};
    }
    const findingCapacities=allocateFindingCapacities(reviewSnapshot.chunks,policy.maxFindings);
    const results=[],usage={inputTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:0,reasoningOutputTokens:0},models=new Set(),modelEvidence=[],shadowModelEvidence=[],shadowComparisons=[],shadowErrors=[],optionalRoleErrors=[],economicsRecords=[],roleCalls=[],saturatedChunks=[],contextOmissions=[];let version='unknown',estimatedTotal=0,economicsComplete=true;const modelRouter=createServiceModelRouter(this.config);
    for(const chunk of reviewSnapshot.chunks){
      if(controller.signal.aborted)throw controller.signal.reason;
      const contextConfig=adaptiveContextConfig(this.config,policy,chunk),perChunkFindings=findingCapacities[chunk.index],profileContextConfig={...contextConfig,maxContextBytes:Math.floor(contextConfig.maxContextBytes*profile.contextFactor),maxContextFiles:Math.max(contextConfig.maxContextFiles?1:0,Math.floor(contextConfig.maxContextFiles*profile.contextFactor)),contextLines:Math.max(contextConfig.contextLines?1:0,Math.floor(contextConfig.contextLines*profile.contextFactor))},context=await this.contextFn(this.gitlab,mr,chunk,profileContextConfig);
      const chunkQuality=qualityContextForChunk(qualityEvidence,chunk);
      context.blocks=[...(context.blocks||[]),...chunkQuality.blocks];context.bytes=(context.bytes||0)+chunkQuality.bytes;
      if(chunkQuality.truncated){fullSnapshot.advisories.push('quality_context_clipped:chunk='+chunk.index);this.telemetry?.metrics.inc('codex_review_quality_context_clipped_chunks_total',1);}
      if(context.omitted?.length){contextOmissions.push(...context.omitted.map(item=>({...item,chunkIndex:chunk.index})));this.telemetry?.metrics.inc('codex_review_context_omitted_slices_total',context.omitted.length);}
      if(!context.complete)fullSnapshot.advisories.push(`context:${context.reason||'partial'}`);
      const prompt=buildPrompt(reviewSnapshot,chunk,policy,context),provider=this.config.codexProviderMode||'openai';
      const beforeCall=({role,route,input,optional,shadow})=>{const effectiveProvider=route?.selection?.resolvedProvider||provider,effectiveModel=route?.model||'default',bytesPerToken=this.tokenCalibration.bytesPerToken(effectiveProvider,effectiveModel),estimate=estimateChunkTokens(input,perChunkFindings,bytesPerToken),effectiveMrTokenBudget=this.config.mrMaxTokenBudget?Math.max(1,Math.floor(this.config.mrMaxTokenBudget*profile.tokenFactor)):0;if(effectiveMrTokenBudget&&this.store.modelCalls.budgetUsageForJob(job.id)+estimate.total>effectiveMrTokenBudget){const error=new Error('MR Model Routing token budget exhausted');error.code='ETOKENBUDGET';error.optional=optional||shadow;throw error;}this.reserveChunkBudget(job,estimate.total);estimatedTotal+=estimate.total;const modelCallId=this.store.modelCalls.begin({jobId:job.id,attempt:job.attempt,role:shadow?`shadow:${role}`:role,provider:effectiveProvider,model:effectiveModel,estimatedTokens:estimate.total});return{modelCallId,estimatedTokens:estimate.total,riskScore:contextConfig.riskScore};};
      const onCallResult=({result,budgetMeta})=>{this.store.modelCalls.finish(budgetMeta.modelCallId,{usage:result.usage,usageKnown:result.usageKnown,model:result.model});this.tokenLedger.release(this.reservationKey(job));};
      const onCallError=({error,budgetMeta,role,shadow,optional})=>{const notStarted=['ERUNNERBUSY','ERUNNERREQUEST','ERUNNERCONTRACT'].includes(error?.code);this.store.modelCalls.finish(budgetMeta.modelCallId,{usage:notStarted?{inputTokens:0,outputTokens:0}:error?.usage,usageKnown:notStarted?true:error?.usageKnown,errorCode:error?.code||'EMODEL',failed:true});this.tokenLedger.release(this.reservationKey(job));if(optional){optionalRoleErrors.push({chunkIndex:chunk.index,role,shadow,code:String(error?.code||'EOPTIONAL_ROLE')});if(shadow)shadowErrors.push({chunkIndex:chunk.index,code:String(error?.code||'ESHADOW')});}};
      const afterCall=({route,input,result,budgetMeta,call})=>{
        // Keep completed calls even if a later required role cannot pass budget
        // preflight. A returned chunk must not append these observations again.
        roleCalls.push(call);usageAdd(usage,call.usage||{});
        if(call.shadow){if(call.modelEvidence)shadowModelEvidence.push(call.modelEvidence);}
        else{models.add(call.model);if(call.modelEvidence)modelEvidence.push(call.modelEvidence);if(call.version)version=call.version;}
        const effectiveProvider=route?.selection?.resolvedProvider||provider,effectiveModel=result.model||route?.model||'default',usageKnown=observedUsage(result.usage,result.usageKnown)!==null;
        if(usageKnown){
          const calibration=this.tokenCalibration.observe(effectiveProvider,effectiveModel,{bytes:Buffer.byteLength(input,'utf8'),usage:result.usage});
          this.telemetry?.metrics.observe('codex_review_input_bytes_per_token',calibration.ratio,[1,1.5,2,2.5,3,4,6]);
          this.telemetry?.recordGenAiClient({operation:'review',provider:effectiveProvider,model:effectiveModel,durationSeconds:Number(result.durationMs||0)/1000,usage:result.usage});
          if(this.tokenCalibrationStore){try{this.tokenCalibrationStore.write(this.tokenCalibration);}catch(error){this.logger.warn?.({event:'token_calibration_write_failed',code:error.code||'ECALIBRATIONSTORE'});}}
        }else this.telemetry?.metrics.observe('gen_ai_client_operation_duration_seconds',Math.max(0,Number(result.durationMs||0)/1000));
        this.recordUsage(result.usage,budgetMeta?.estimatedTokens||0,contextConfig.riskScore,usageKnown);
      };
      const priorCallCount=roleCalls.length;
      let routed;try{routed=await executeRoleAwareReview({prompt,config:this.config,signal:controller.signal,maxFindings:perChunkFindings,runCodexFn:this.runCodexFn,validateResult:parsed=>validateChunkResult(parsed,chunk,policy),router:modelRouter,beforeCall,afterCall,onCallResult,onCallError});}catch(error){if(error?.code==='ETOKENBUDGET'){if(roleCalls.length>priorCallCount)economicsComplete=false;fullSnapshot.coverageGaps.push('token_budget_preflight');fullSnapshot.coverageComplete=false;this.telemetry?.metrics.inc('codex_review_token_budget_preflight_blocks_total',1);break;}throw error;}
      if(routed.shadowComparison)shadowComparisons.push({chunkIndex:chunk.index,...routed.shadowComparison});if(routed.usageKnown)economicsRecords.push({usage:routed.usage,verifiedFindings:routed.finalValidated.findings.length,verifierCalls:routed.calls.filter(x=>!x.shadow&&x.role==='reviewer').length,scoutCalls:routed.calls.filter(x=>!x.shadow&&x.role==='scout').length,adjudicatorCalls:routed.calls.filter(x=>!x.shadow&&x.role==='adjudicator').length,latencyMs:routed.productionLatencyMs+routed.shadowLatencyMs});results.push(routed.finalValidated);
      if(routed.finalValidated.modelFindingCount>=perChunkFindings){saturatedChunks.push({chunkIndex:chunk.index,limit:perChunkFindings});fullSnapshot.advisories.push('finding_capacity_saturated:chunk='+chunk.index);this.telemetry?.metrics.inc('codex_review_finding_capacity_saturated_chunks_total',1);}
      evidenceEntries.push({index:chunk.index,diffDigest:fingerprint(chunk.diffText),contextDigest:fingerprint(context.blocks||[]),riskScore:contextConfig.riskScore,modelEvidence:routed.modelEvidence});
    }
    let review=consolidateReviews(reviewSnapshot,results,policy);
    const deterministicAnalyzerFindings=anchorAnalyzerFindings(fullSnapshot,qualityEvidence.analyzerFindings);
    review=mergeCurrentEvidenceFindings(review,deterministicAnalyzerFindings,policy);
    review.summary=deterministicSummary(review.findings,policy);review.codexVersion=version;review.codexModel=[...models].join(',');review.usage=usage;review.usageKnown=roleCalls.every(call=>call.usageKnown)&&optionalRoleErrors.length===0;review.estimatedTokenBudget=estimatedTotal;review.reviewProfile=profile.name;review.impactNodes=qualityEvidence.impact?.nodes?.length||0;review.impactBytes=qualityEvidence.impact?.bytes||0;review.analyzerFindingCount=qualityEvidence.analyzerFindings?.length||0;fullSnapshot.coverageLedger=evidenceCoverageLedger(fullSnapshot,reviewSnapshot.chunks,results.length);review.coverageLedger=fullSnapshot.coverageLedger;review.modelCoverage=fullSnapshot.coverageLedger;review.qualityEvidenceStatus=Object.freeze({degraded:qualityDegradations.length>0,reasons:qualityDegradations});review.contextCoverage=Object.freeze({omittedSlices:contextOmissions.length,omittedFiles:[...new Set(contextOmissions.map(item=>item.path))].slice(0,80),reasons:contextOmissions.reduce((out,item)=>(out[item.reason]=(out[item.reason]||0)+1,out),{})});review.saturatedChunks=Object.freeze(saturatedChunks);review.modelInferenceCount=roleCalls.filter(x=>!x.shadow).length;review.shadowInferenceCount=roleCalls.filter(x=>x.shadow).length;review.modelRoutingContractVersion=1;review.modelRegistrySource=modelRouter.registrySource;review.modelRegistryRevision=modelRouter.registryRevision;review.modelEvidence=Object.freeze(modelEvidence);review.shadowModelEvidence=Object.freeze(shadowModelEvidence);review.shadowComparisons=Object.freeze(shadowComparisons);review.shadowErrors=Object.freeze(shadowErrors);review.optionalRoleErrors=Object.freeze(optionalRoleErrors);review.modelEconomics=review.usageKnown&&economicsComplete?buildModelEconomicsScorecard(economicsRecords):null;this.logger.info?.({event:'model_routing_evidence',jobId:job.id,registryRevision:modelRouter.registryRevision,productionCalls:review.modelInferenceCount,shadowCalls:review.shadowInferenceCount,scoutCalls:roleCalls.filter(x=>!x.shadow&&x.role==='scout').length,adjudicatorCalls:roleCalls.filter(x=>!x.shadow&&x.role==='adjudicator').length,shadowErrors:review.shadowErrors.length,optionalRoleErrors:review.optionalRoleErrors.length,usage:review.usage,usageKnown:review.usageKnown,economicsComplete,economics:review.modelEconomics});
    if(!fullSnapshot.coverageComplete){review.coverageComplete=false;review.verdict='incomplete';}
    review.evidenceManifestDigest=fingerprint({version:1,diffFingerprint:fullSnapshot.diffFingerprint,coverageGaps:fullSnapshot.coverageGaps,advisories:fullSnapshot.advisories,coverageLedger:fullSnapshot.coverageLedger,fallbacks:fingerprint(fullSnapshot.rawDiffFallbacks),profile:profile.name,quality:{impact:fingerprint(qualityEvidence.impact||{}),analyzers:fingerprint(qualityEvidence.analyzerFindings||[]),degradationReasons:qualityDegradations},modelRouting:{contractVersion:1,registryRevision:modelRouter.registryRevision,modelEvidence},chunks:evidenceEntries});
    review.reviewSubjectFingerprint=computeReviewSubjectFingerprint({subject:reviewSubject(fullSnapshot),diffFingerprint:fullSnapshot.diffFingerprint,policyFingerprint:policy.fingerprint||'<none>',evidenceManifestDigest:review.evidenceManifestDigest,promptContractVersion:REVIEW_PROMPT_CONTRACT_VERSION,reviewProfile:profile.name,model:review.codexModel});
    return{snapshot:fullSnapshot,review};
  }
  async assertCurrentSnapshot(job,snapshot){
    // A retarget can leave the source HEAD and start SHA unchanged. Do not
    // publish a review of the former target branch under the new MR identity.
    const latest=await this.gitlab.getMergeRequest(job.project_id,job.mr_iid);
    const observed={
      iid:Number(latest?.iid||0),
      sourceProjectId:Number(latest?.source_project_id||latest?.project_id||0),
      targetProjectId:Number(latest?.target_project_id||latest?.project_id||0),
      headSha:String(latest?.diff_refs?.head_sha||latest?.sha||''),
      startSha:String(latest?.diff_refs?.start_sha||''),
      baseSha:String(latest?.diff_refs?.base_sha||''),
      sourceBranch:String(latest?.source_branch||''),
      targetBranch:String(latest?.target_branch||'')
    };
    const frozen={
      iid:Number(snapshot?.iid||0),
      sourceProjectId:Number(snapshot?.sourceProjectId||0),
      targetProjectId:Number(snapshot?.targetProjectId||0),
      headSha:String(snapshot?.headSha||''),
      startSha:String(snapshot?.startSha||''),
      baseSha:String(snapshot?.baseSha||''),
      sourceBranch:String(snapshot?.sourceBranch||''),
      targetBranch:String(snapshot?.targetBranch||'')
    };
    const identityComplete=Object.values(observed).every(value=>typeof value==='number'?Number.isSafeInteger(value)&&value>0:Boolean(value))
      &&Object.values(frozen).every(value=>typeof value==='number'?Number.isSafeInteger(value)&&value>0:Boolean(value));
    const mismatch=Object.keys(frozen).some(key=>frozen[key]!==observed[key]);
    const rawHead=String(latest?.sha||'');
    if(!identityComplete||mismatch||latest?.state!=='opened'||(isDraft(latest)&&!this.config.reviewDraftMergeRequests)
      ||(rawHead&&rawHead!==observed.headSha))
      throw abortError('ESUPERSEDED','Merge request source/target identity or diff refs changed during review');
  }
  planPublication(job,snapshot,review,policy,createdAt=''){const identity={snapshotIdentityVersion:1,sourceProjectId:snapshot.sourceProjectId,targetProjectId:snapshot.targetProjectId,sourceBranch:snapshot.sourceBranch,targetBranch:snapshot.targetBranch,baseSha:snapshot.baseSha};const actions=[],prefix=`job:${job.id}`,previous=this.store.priorFindings(job.project_id,job.mr_iid),findingLifecycle=classifyFindingLifecycle(review.findings,previous),lifecycleCounts=findingLifecycle.counts,lifecycleText=policy.language==='zh-CN'?`Finding 生命周期：新增 ${lifecycleCounts.new} · 持续 ${lifecycleCounts.persistent} · 已解决 ${lifecycleCounts.resolved} · 回归 ${lifecycleCounts.regressed} · 未分类 ${lifecycleCounts.unclassified}`:`Finding lifecycle: new ${lifecycleCounts.new} · persistent ${lifecycleCounts.persistent} · resolved ${lifecycleCounts.resolved} · regressed ${lifecycleCounts.regressed} · unclassified ${lifecycleCounts.unclassified}`;review.findingLifecycle=findingLifecycle;actions.push({projectId:job.project_id,mrIid:job.mr_iid,type:'summary',dedupeKey:`${prefix}:summary`,payload:{...identity,headSha:snapshot.headSha,startSha:snapshot.startSha,body:`${formatSummary(review,snapshot,policy,createdAt)}\n\n${lifecycleText}`}});if(this.config.autoResolveObsolete&&review.coverageComplete===true)for(const entry of findingLifecycle.entries.filter(item=>item.state==='resolved')){const old=entry.historicalFinding;if(old?.discussion_id)actions.push({projectId:job.project_id,mrIid:job.mr_iid,type:'resolve',dedupeKey:`${prefix}:resolve:${old.discussion_id}`,payload:{...identity,headSha:snapshot.headSha,startSha:snapshot.startSha,discussionId:old.discussion_id,finding:{fingerprint:old.fingerprint,claimState:'known',claimFingerprint:old.claim_fingerprint||old.claimFingerprint,anchorFingerprint:old.anchor_fingerprint||old.anchorFingerprint||'',rootCauseKey:old.root_cause_key||old.rootCauseKey||'',claimClass:old.claim_class||old.claimClass||'',contentDigest:old.content_digest||old.contentDigest||''}}});}for(const finding of review.findings.slice(0,policy.maxPublishedFindings)){const file=snapshot.files.find(f=>f.path===finding.file&&!f.skipped);if(!file)continue;actions.push({projectId:job.project_id,mrIid:job.mr_iid,type:'finding',dedupeKey:`${prefix}:finding:${finding.fingerprint}`,payload:{...identity,headSha:snapshot.headSha,startSha:snapshot.startSha,finding,diffRefs:snapshot.diffRefs,oldPath:file.old_path,newPath:file.new_path}});}const state=review.verdict==='block'||review.verdict==='incomplete'?'failed':'success',description=review.verdict==='pass'?'No substantive findings':review.verdict==='incomplete'?'Review coverage incomplete':`${review.findings.length} finding(s)`;actions.push({projectId:job.project_id,mrIid:job.mr_iid,type:'status',dedupeKey:`${prefix}:status:final`,payload:{...identity,jobId:job.id,startSha:snapshot.startSha,statusName:this.config.statusName,statusProjectId:job.status_project_id||job.project_id,headSha:snapshot.headSha,state,description,ref:snapshot.sourceBranch,pipelineId:job.pipeline_id||null}});return actions;}
async processJob(job){const key=this.key(job.project_id,job.mr_iid),controller=new AbortController();this.active.set(key,{headSha:job.head_sha||'',startSha:job.start_sha||'',baseSha:job.base_sha||'',targetBranch:job.target_branch||'',controller,jobId:job.id,statusProjectId:job.status_project_id||job.project_id,pipelineId:job.pipeline_id||null,sourceBranch:job.source_branch||''});const started=Date.now(),timer=setTimeout(()=>controller.abort(abortError('EJOBTIMEOUT','Review job exceeded JOB_TIMEOUT_SECONDS')),this.config.jobTimeoutSeconds*1000);const run=async()=>{this.ensureAllowedProject(job.project_id);if(!(await this.authorizeManual(job))){this.store.finishJob(job.id,'unauthorized','EUNAUTHORIZED');return;}const hydrated=await this.hydrateJob(job);if(hydrated.terminal){if(hydrated.terminal!=='duplicate')this.store.finishJob(job.id,hydrated.terminal,hydrated.terminal==='skipped'?'EDRAFT':null);return;}job=this.store.getJob(job.id)||job;this.checkProjectBudget(job.project_id);this.enqueueStatus(job,'running','Codex review is running');const mr=hydrated.mr,policy=await this.getPolicyFn(this.gitlab,job.project_id,mr,this.config);let diffResult=await this.gitlab.listMergeRequestDiffs(job.project_id,job.mr_iid);diffResult=await this.gitlab.recoverClassicEmptyDiffs(job.project_id,mr,diffResult,policy.maxDiffBytes);const hard=await this.gitlab.validateMergeRequestDiffCoverage(job.project_id,job.mr_iid,mr,diffResult);if(!hard.complete){diffResult.complete=false;diffResult.coverageReason=hard.reason;this.logger.warn?.({event:'diff_coverage_incomplete',traceId:job.trace_id,jobId:job.id,projectId:job.project_id,mrIid:job.mr_iid,reason:hard.reason});}const{snapshot,review}=await this.reviewSnapshot(job,mr,diffResult,policy,controller);if(!snapshot.coverageComplete){review.coverageComplete=false;review.verdict='incomplete';}await this.assertCurrentSnapshot(job,snapshot);const durationMs=Date.now()-started,receiptProjection=shouldPersistJudgmentReceipt({executionMode:'fresh',inference:review.modelInferenceCount>0})?createServiceReviewReceipt(snapshot,review,policy):null,reviewCreatedAt=receiptProjection?.receipt?.createdAt||new Date().toISOString(),actions=this.planPublication(job,snapshot,review,policy,reviewCreatedAt),notificationEvent=eventForReview({job,mr,snapshot,review,durationMs,topFindings:this.config.notificationTopFindings,occurredAt:reviewCreatedAt}),notificationActions=planNotificationActions(this.config,notificationEvent,`run:${job.id}:${snapshot.headSha}`);this.store.saveRunWithOutbox(job.id,review,durationMs,policy,actions,receiptProjection,notificationActions,snapshot);this.store.finishJob(job.id,review.verdict==='block'?'blocked':review.verdict);};try{if(this.telemetry)await this.telemetry.span(job.trace_id||this.traceId(),'review.job',{projectId:job.project_id,mrIid:job.mr_iid,jobId:job.id},run);else await run();}catch(error){const code=error?.code||'EUNKNOWN';if(code==='ESUPERSEDED'||code==='ECANCELLED'){job=this.store.getJob(job.id)||job;this.enqueueStatus(job,'canceled',code==='ESUPERSEDED'?'Review superseded':'Review canceled','cancel_status');this.store.finishJob(job.id,code==='ESUPERSEDED'?'superseded':'cancelled',code);return;}if(code==='ESHUTDOWN'){if(this.store.modelCalls.unknownForAttempt(job.id,job.attempt))this.store.finishJob(job.id,'failed','EMODELCALLUNCERTAIN');else this.store.requeueRunningJob(job.id,code);return;}const unknownCall=this.store.modelCalls.unknownForAttempt(job.id,job.attempt)>0,shouldRetry=!unknownCall&&job.attempt<this.config.maxJobAttempts&&retryable(error)&&!this.stopping;this.logger.error?.({event:shouldRetry?'review_retry':'review_failed',traceId:job.trace_id,jobId:job.id,projectId:job.project_id,mrIid:job.mr_iid,attempt:job.attempt,code,status:error?.status||null,message:String(error?.message||'').slice(0,500)});if(shouldRetry)this.store.retryJob(job.id,code,retryDelay(this.config,job,error));else{job=this.store.getJob(job.id)||job;const notificationEvent=eventForFailure(job,code),notificationActions=planNotificationActions(this.config,notificationEvent,`job:${job.id}`);this.store.finishJobWithNotifications(job.id,'failed',unknownCall?'EMODELCALLUNCERTAIN':code,notificationActions);this.enqueueStatus(job,'failed',code==='EPROJECTPOLICY'?'Codex review policy is invalid':code==='ETOKENBUDGET'?'Codex review token budget exhausted':'codex review service failed');}}finally{this.tokenLedger.release(this.reservationKey(job));clearTimeout(timer);if(this.active.get(key)?.controller===controller)this.active.delete(key);}}
  async workerLoop(workerId){while(!this.stopping){const job=this.store.claimNext();if(!job){await new Promise(resolve=>setTimeout(resolve,this.config.pollIntervalMs));continue;}this.logger.info?.({event:'job_started',traceId:job.trace_id,workerId,jobId:job.id,projectId:job.project_id,mrIid:job.mr_iid});await this.processJob(job);}}
  startWorkers(){if(this.workers.length)return this.workers;this.workers=Array.from({length:this.config.workerConcurrency},(_,index)=>this.workerLoop(index+1).catch(error=>{this.logger.error?.({event:'worker_crashed',workerId:index+1,code:error.code||'EWORKER'});throw error;}));return this.workers;}
  async stop(){this.stopping=true;for(const active of this.active.values())active.controller.abort(abortError('ESHUTDOWN','Service is shutting down'));await Promise.allSettled(this.workers);}
}
module.exports={ReviewService,evidenceCoverageLedger,NON_RETRYABLE_ERRORS,retryable,retryDelay,abortError,usageAdd,usageTotal,isDraft};
