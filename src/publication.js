'use strict';

const { discussionResolved, findingBody, selectDiscussionByFingerprint }=require('./gitlab');
const { createHash }=require('node:crypto');
const { statusTarget }=require('./status-write-store');
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function retryablePublication(error){if(!error)return true;if(error.code==='EGITLABHTTP'){const status=Number(error.status);if([408,409,425,429].includes(status)||status>=500)return true;if(status>=400)return false;}return['EGITLABNETWORK','EGITLABCIRCUIT','EGITLABPAGINATION'].includes(error.code)||!error.code;}
function retryDelay(config,item,error){if(Number.isFinite(error?.retryAfterMs))return Math.min(config.retryMaxDelayMs,error.retryAfterMs);const base=Math.min(config.retryMaxDelayMs,config.retryBaseDelayMs*(2**Math.max(0,item.attempt-1)));return Math.round(base*(0.85+Math.random()*0.3));}
function serviceFindingNote(discussion,finding,botUsername=''){const marker=`<!-- codex-review-service:finding:${finding.fingerprint} -->`,username=String(botUsername||'').trim().toLowerCase();if(!username)return null;return(discussion?.notes||[]).find(note=>typeof note.body==='string'&&note.body.includes(marker)&&String(note.author?.username||'').toLowerCase()===username)||null;}
function positionMatches(note,diffRefs={}){const position=note?.position;if(!position)return false;return String(position.base_sha||'')===String(diffRefs.base_sha||'')&&String(position.start_sha||'')===String(diffRefs.start_sha||'')&&String(position.head_sha||'')===String(diffRefs.head_sha||'');}
function createdServiceNote(discussion){return(discussion?.notes||[]).find(note=>note?.resolvable===true)||discussion?.notes?.[0]||null;}
function findingReconciliationKey(item,botUsername){const p=item.payload||{},f=p.finding||{},username=String(botUsername||'').trim().toLowerCase();if(f.claimState!=='known'||!f.claimFingerprint||!username)return'';return createHash('sha256').update(JSON.stringify([Number(item.project_id),Number(item.mr_iid),username,String(f.fingerprint||''),String(f.claimFingerprint),String(p.diffRefs?.base_sha||''),String(p.diffRefs?.start_sha||''),String(p.diffRefs?.head_sha||''),String(p.oldPath||''),String(p.newPath||'')])).digest('hex');}
class Publisher{
  constructor({config,store,gitlab,logger=console}){this.config=config;this.store=store;this.gitlab=gitlab;this.logger=logger;this.stopping=false;this.workers=[];this.discussionScans=new Map();this.findingPublications=new Map();this.statusPublications=new Map();}
  projectAllowed(item){return !this.config.gitlabProjectAllowlist||this.config.gitlabProjectAllowlist.has(Number(item.project_id));}
  async currentSnapshot(item){
    const p=item?.payload;
    if(!p||typeof p!=='object'||Array.isArray(p))return false;
    const strict=p.snapshotIdentityVersion===1;
    if((p.snapshotIdentityVersion!==undefined&&p.snapshotIdentityVersion!==1)||(!strict&&['baseSha','targetBranch','sourceBranch','targetProjectId','sourceProjectId'].some(key=>Object.hasOwn(p,key))))return false;
    // A newly emitted Schema-11 action is bound to the original review
    // target. A HEAD-only check cannot detect GitLab MR retargets.
    if(strict){
      const sha=/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
      if(![p.headSha,p.startSha,p.baseSha].every(value=>typeof value==='string'&&sha.test(value))
        ||p.headSha.length!==p.startSha.length||p.headSha.length!==p.baseSha.length
        ||typeof p.sourceBranch!=='string'||!p.sourceBranch||p.sourceBranch.length>1024
        ||typeof p.targetBranch!=='string'||!p.targetBranch||p.targetBranch.length>1024
        ||!Number.isSafeInteger(p.sourceProjectId)||p.sourceProjectId<=0
        ||!Number.isSafeInteger(p.targetProjectId)||p.targetProjectId<=0)return false;
    }else if(!p.headSha||!p.startSha)return true; // Pre-Schema-11 persisted actions retain legacy semantics.
    const mr=await this.gitlab.getMergeRequest(item.project_id,item.mr_iid);
    const head=String(mr?.diff_refs?.head_sha||mr?.sha||''),start=String(mr?.diff_refs?.start_sha||'');
    if(mr?.state!=='opened'||!head||!start||head!==String(p.headSha)||start!==String(p.startSha))return false;
    if(!strict)return true;
    const sourceId=Number(mr?.source_project_id||mr?.project_id||0),targetId=Number(mr?.target_project_id||mr?.project_id||0);
    const remoteHead=String(mr?.sha||'');
    return Number(mr?.iid)===Number(item.mr_iid)
      &&sourceId===Number(p.sourceProjectId)&&targetId===Number(p.targetProjectId)
      &&String(mr?.source_branch||'')===p.sourceBranch&&String(mr?.target_branch||'')===p.targetBranch
      &&String(mr?.diff_refs?.base_sha||'')===p.baseSha&&(!remoteHead||remoteHead===head)
      &&(this.config.reviewDraftMergeRequests||!(mr.draft===true||mr.work_in_progress===true));
  }
  async publishSummary(item){if(!(await this.currentSnapshot(item)))return{cancelled:true};const result=await this.gitlab.upsertSummary(item.project_id,item.mr_iid,item.payload.body);return{remoteId:String(result?.id||'')};}
  async findExistingDiscussion(item,finding,diffRefs){const projection=this.store.claimProjection?.(item.project_id,item.mr_iid,finding.claimFingerprint);if(projection?.discussion_id&&typeof this.gitlab.getDiscussion==='function'){const direct=await this.gitlab.getDiscussion(item.project_id,item.mr_iid,projection.discussion_id),note=serviceFindingNote(direct,finding,this.config.botUsername);if(direct&&discussionResolved(direct)===false&&note&&positionMatches(note,diffRefs))return direct;}if(typeof this.gitlab.listDiscussions!=='function')return this.gitlab.findDiscussionByFingerprint(item.project_id,item.mr_iid,finding.fingerprint,diffRefs);const key=`${item.project_id}:${item.mr_iid}:${diffRefs?.head_sha||item.payload?.headSha||''}`;let scan=this.discussionScans.get(key);if(!scan){scan=this.gitlab.listDiscussions(item.project_id,item.mr_iid);this.discussionScans.set(key,scan);if(this.discussionScans.size>128)this.discussionScans.delete(this.discussionScans.keys().next().value);}let result;try{result=await scan;}catch(error){this.discussionScans.delete(key);throw error;}if(!result.complete){this.discussionScans.delete(key);const error=new Error('Could not exhaustively scan MR discussions');error.code='EGITLABPAGINATION';throw error;}return selectDiscussionByFingerprint(result.items,finding.fingerprint,diffRefs);}
  invalidateDiscussionScans(item) {
    const prefix = `${item.project_id}:${item.mr_iid}:`;
    for (const key of this.discussionScans.keys()) if (key.startsWith(prefix)) this.discussionScans.delete(key);
  }
  async publishFinding(item) {
    // Serialize same-MR writes inside this Publisher; remote reads, not cached
    // absence, decide whether an uncertain previous write already took effect.
    const key = `${item.project_id}:${item.mr_iid}`;
    const previous = this.findingPublications.get(key) || Promise.resolve();
    let unlock;
    const current = new Promise(resolve => { unlock = resolve; });
    this.findingPublications.set(key, current);
    await previous;
    try {
      this.invalidateDiscussionScans(item);
      return await this.publishFindingCurrent(item);
    } finally {
      this.invalidateDiscussionScans(item);
      unlock();
      if (this.findingPublications.get(key) === current) this.findingPublications.delete(key);
    }
  }
  async publishFindingCurrent(item){const p=item.payload,finding=p.finding;if(!(await this.currentSnapshot(item)))return{cancelled:true,findingSettlement:{projectionState:'superseded',eventType:'claim_snapshot_superseded'}};const known=finding.claimState==='known'&&Boolean(finding.claimFingerprint),reconciliationKey=findingReconciliationKey(item,this.config.botUsername),reconcilable=Boolean(reconciliationKey),writeStarted=this.store.findingWriteStarted(item.id);if(!reconcilable&&writeStarted)throw Object.assign(new Error('Previous finding write outcome requires manual inspection'),{code:'ECLAIMPUBLISHUNCERTAIN'});let existing=null;if(known)existing=await this.findExistingDiscussion(item,finding,p.diffRefs);if(!(await this.currentSnapshot(item)))return{cancelled:true,findingSettlement:{projectionState:'superseded',eventType:'claim_snapshot_superseded'}};if(existing&&discussionResolved(existing)===false){const note=serviceFindingNote(existing,finding,this.config.botUsername);if(note&&positionMatches(note,p.diffRefs)){const target=findingBody(finding),changed=String(note.body||'')!==target;if(changed)await this.gitlab.updateFindingNote(item.project_id,item.mr_iid,note.id,finding);return{remoteId:String(existing.id),findingSettlement:{discussionId:String(existing.id),serviceNoteId:String(note.id),diffRefs:p.diffRefs,projectionState:changed?'reused_updated':'reused_unchanged',eventType:changed?'claim_note_updated':'claim_reused'}};}}
    let created;
    // Every create persists its identity before transport. A known claim may
    // resend only after a fresh remote scan under the same durable identity.
    const beforeSend=()=>{this.store.markFindingWriteStarted(item.id,{reconciled:reconcilable,reconciliationKey});item.findingWriteStarted=true;};
    try {
      created = await this.gitlab.createDiscussion(item.project_id,item.mr_iid,finding,p.diffRefs,p.oldPath,p.newPath,{beforeSend});
      if(!reconcilable)item.findingWriteStarted=true;
    } catch (error) {
      if (!reconcilable && (item.findingWriteStarted||this.store.findingWriteStarted(item.id))) {
        throw Object.assign(new Error('Finding publication outcome is uncertain and cannot be safely reconciled; inspect the remote discussion before retrying.'), { code:'ECLAIMPUBLISHUNCERTAIN', cause:error });
      }
      throw error;
    }
    const note=createdServiceNote(created);return{remoteId:String(created.id),findingSettlement:{discussionId:String(created.id),serviceNoteId:String(note?.id||''),diffRefs:p.diffRefs,projectionState:'created',eventType:existing?'claim_created_for_current_snapshot':'claim_created'}};}
  async resolveDiscussion(item){if(!(await this.currentSnapshot(item)))return{cancelled:true,reason:'stale_snapshot'};const p=item.payload,finding=p.finding||{};if(finding.claimState!=='known'||!finding.claimFingerprint)return{cancelled:true,reason:'claim_identity'};const discussion=await this.gitlab.getDiscussion(item.project_id,item.mr_iid,p.discussionId);if(!discussion)return{remoteId:String(p.discussionId),findingSettlement:{discussionId:String(p.discussionId),projectionState:'resolved',eventType:'claim_discussion_missing'}};let note=null;if(discussionResolved(discussion)===false){note=serviceFindingNote(discussion,finding,this.config.botUsername);if(!note)return{cancelled:true,reason:'note_ownership'};await this.gitlab.setDiscussionResolved(item.project_id,item.mr_iid,p.discussionId,true);}return{remoteId:String(p.discussionId),findingSettlement:{discussionId:String(p.discussionId),serviceNoteId:String(note?.id||''),projectionState:'resolved',eventType:'claim_resolved'}};}
  currentStatusGeneration(item){
    if(!this.projectAllowed(item))return false;
    const name=item.payload?.statusName;
    if(name!==undefined&&name!==this.config.statusName)return false;
    return this.store.isCurrentStatusPublication(item);
  }
  statusReconcileDelay(target={}){
    const retryBaseDelayMs=Math.max(50,Number(this.config.retryBaseDelayMs)||1000),retryMaxDelayMs=Math.max(retryBaseDelayMs,Number(this.config.retryMaxDelayMs)||60000);
    return retryDelay({retryBaseDelayMs,retryMaxDelayMs},{attempt:Math.min(12,Number(target.reconcile_attempts||0)+1)});
  }
  recoverLegacyStatuses(){if(!this.statusRecoveryDone){this.store.statusWrites.adoptLegacy(this.config);this.statusRecoveryDone=true;}}
  async withStatusLock(item,work){
    const {key}=statusTarget(item,this.config);
    const previous=this.statusPublications.get(key)||Promise.resolve();let unlock;
    const current=new Promise(resolve=>{unlock=resolve;});this.statusPublications.set(key,current);await previous;
    try{return await work();}
    finally{unlock();if(this.statusPublications.get(key)===current)this.statusPublications.delete(key);}
  }
  async publishStatus(item,{repair=false}={}){
    this.recoverLegacyStatuses();
    return this.withStatusLock(item,()=>this.publishStatusCurrent(item,{repair}));
  }
  async publishStatusCurrent(item,{repair=false}={}){
    const p=item.payload||{};let attempt=null,sent=false,acknowledged=false;
    const onAttemptSettled=value=>{if(attempt){acknowledged=this.store.statusWrites.settle(attempt,value)?.outcome==='acknowledged';attempt=null;}};
    try{
      if(!this.currentStatusGeneration(item))return{cancelled:true};
      // Legacy rows predate the explicit snapshot payload. Recover their exact
      // snapshot from the durable job instead of skipping the MR recheck.
      const job=this.store.statusPublicationJob(item),snapshotItem={...item,payload:{...p,startSha:p.startSha??job?.start_sha}};
      if(item.action_type!=='cancel_status'&&(!snapshotItem.payload.headSha||!snapshotItem.payload.startSha||!(await this.currentSnapshot(snapshotItem))))return{cancelled:true};
      this.store.withTransaction(()=>this.store.statusWrites.register(item,this.config));
      const beforeSend=()=>{
        if((repair&&this.stopping)||!this.currentStatusGeneration(item))throw Object.assign(new Error('Status generation has been superseded or publication is stopping'),{code:'ESTALEPUBLICATION'});
        if(attempt)throw Object.assign(new Error('Previous status transport has not settled'),{code:'ESTATUSPROTOCOL'});
        attempt=this.store.statusWrites.begin(item,this.config,{repair});sent=true;
      };
      const result=await this.gitlab.setCommitStatus(p.statusProjectId,p.headSha,p.state,p.description,p.ref||'',p.pipelineId||null,{beforeSend,onAttemptSettled});
      // Test doubles/adapters may return without the completion hook, but no
      // adapter may report publication without the durable pre-transport hook.
      if(!sent)throw Object.assign(new Error('Status adapter bypassed the durable write intent'),{code:'ESTATUSPROTOCOL'});
      onAttemptSettled({result});
      if(!this.currentStatusGeneration(item))return{cancelled:true};
      const settled=this.store.statusWrites.complete(item,this.config,result?.id,this.statusReconcileDelay());
      return{remoteId:String(result?.id||''),statusSettled:true,uncertain:settled.uncertain,acknowledged};
    }catch(error){onAttemptSettled({error});if(error?.code==='ESTALEPUBLICATION')return{cancelled:true};throw error;}
  }
  async reconcileStatusPublications({limit=1}={}){
    this.recoverLegacyStatuses();let checked=0,repaired=0;
    while(!this.stopping&&checked<limit){
      const target=this.store.statusWrites.claimDue(this.statusReconcileDelay());if(!target)break;
      checked++;
      await this.withStatusLock(target.item,async()=>{
        const latest=this.store.statusWrites.target(target.target_key);
        // A claim may wait behind a newer publication. It only authorizes work
        // on the same uncertain generation; a completed generation is not a
        // reconciliation task even if a provider read would temporarily lag.
        if(this.stopping||!latest||latest.projection_state!=='uncertain'||latest.latest_outbox_id!==target.latest_outbox_id||latest.latest_job_id!==target.latest_job_id)return;
        const item=latest.item;
        if(statusTarget(item,this.config).key!==target.target_key||!this.currentStatusGeneration(item)){this.store.statusWrites.stale(target.target_key);return;}
        const delay=this.statusReconcileDelay(latest);
        try{
          if(item.action_type!=='cancel_status'&&!(await this.currentSnapshot(item))){this.store.statusWrites.stale(target.target_key);return;}
          const observation=await this.gitlab.readCommitStatus(item.payload,{remoteId:latest.latest_remote_id,botUsername:this.config.botUsername});
          if(!this.currentStatusGeneration(item)){this.store.statusWrites.stale(target.target_key);return;}
          const wait=observation.kind==='match'?Math.max(delay,Number(this.config.reconcileIntervalMs)||300000):delay;
          this.store.statusWrites.observe(target.target_key,observation,wait,observation.kind==='ambiguous'?'ESTATUSREADBACKIDENTITY':null);
          if(observation.kind==='match'&&observation.remoteIdMatches&&!this.store.statusWrites.unresolved(target.target_key)){
            this.store.statusWrites.complete(item,this.config,observation.remoteId,wait);return;
          }
          // A matching read proves only the present projection. It never
          // resolves a timed-out older request or authorizes another POST.
          if(this.stopping||!['missing','mismatch'].includes(observation.kind))return;
          if(item.action_type!=='cancel_status'&&!(await this.currentSnapshot(item))){this.store.statusWrites.stale(target.target_key);return;}
          if(!this.currentStatusGeneration(item))return;
          if(!this.store.statusWrites.reserveRepair(target.target_key,item.id,Number(this.config.maxPublishAttempts)||8)){
            this.store.statusWrites.observe(target.target_key,observation,Math.max(delay,Number(this.config.reconcileIntervalMs)||300000),'ESTATUSREPAIRLIMIT');return;
          }
          const result=await this.publishStatusCurrent(item,{repair:true});
          if(result.cancelled){this.store.statusWrites.stale(target.target_key);return;}
          if(result.acknowledged)repaired++;
          this.store.statusWrites.observe(target.target_key,{...observation,repairAcknowledged:result.acknowledged},delay,result.acknowledged?null:'EGITLABSTATUSIDENTITY');
        }catch(error){
          this.store.statusWrites.hold(item,this.config,'ESTATUSUNCERTAIN',delay);
          this.store.statusWrites.observe(target.target_key,{kind:'unavailable',reason:error.code||'EGITLAB'},delay,error.code||'EGITLAB');
          this.logger.warn?.({event:'status_reconciliation_failed',outboxId:item.id,code:error.code||'EGITLAB'});
        }
      });
    }
    return{checked,repaired};
  }
  async execute(item){if(!this.projectAllowed(item))return{cancelled:true,reason:'project_scope'};switch(item.action_type){case'summary':return this.publishSummary(item);case'finding':return this.publishFinding(item);case'resolve':return this.resolveDiscussion(item);case'status':case'cancel_status':return this.publishStatus(item);default:{const error=new Error(`Unknown publication action: ${item.action_type}`);error.code='EPUBLISHCONFIG';throw error;}}}
  settleFinding(item,publicationStatus,result={},errorCode=null,metadata={}){return this.store.settleFindingPublication({outboxId:item.id,runId:item.run_id,projectId:item.project_id,mrIid:item.mr_iid,finding:item.payload?.finding||{},publicationStatus,remoteId:result.remoteId||'',discussionId:result.findingSettlement?.discussionId||'',serviceNoteId:result.findingSettlement?.serviceNoteId||'',diffRefs:result.findingSettlement?.diffRefs||item.payload?.diffRefs||{},projectionState:result.findingSettlement?.projectionState||'',eventType:result.findingSettlement?.eventType||'',errorCode,metadata});}
  async process(item){try{const result=await this.execute(item),findingAction=item.action_type==='finding'||item.action_type==='resolve';if(result?.cancelled){const code={project_scope:'EPROJECTNOTALLOWED',claim_identity:'ECLAIMIDENTITY',note_ownership:'ENOTEOWNERSHIP'}[result.reason]||'ESTALEPUBLICATION';if(findingAction)this.settleFinding(item,'cancelled',result,code);else this.store.cancelPublication(item.id,code);}else if(findingAction)this.settleFinding(item,'published',result);else if(!result?.statusSettled)this.store.finishPublication(item.id,result?.remoteId||null);}catch(error){if(['status','cancel_status'].includes(item.action_type)&&this.store.statusWrites.hold(item,this.config,'ESTATUSUNCERTAIN',this.statusReconcileDelay())){this.logger.warn?.({event:'status_publication_uncertain',outboxId:item.id,code:error?.code||'EPUBLISH'});return;}const unknown=item.action_type==='finding'&&!(item.payload?.finding?.claimState==='known'&&item.payload?.finding?.claimFingerprint&&this.config.botUsername);if(unknown&&(item.findingWriteStarted||this.store.findingWriteStarted(item.id)))error=Object.assign(new Error('Finding publication outcome requires inspection'),{code:'ECLAIMPUBLISHUNCERTAIN',cause:error});const code=error?.code||'EPUBLISH',retry=item.attempt<this.config.maxPublishAttempts&&retryablePublication(error)&&!this.stopping;this.logger.warn?.({event:retry?'publication_retry':'publication_failed',outboxId:item.id,runId:item.run_id,projectId:item.project_id,mrIid:item.mr_iid,action:item.action_type,attempt:item.attempt,code,status:error?.status||null});if(retry)this.store.retryPublication(item.id,code,retryDelay(this.config,item,error));else if(item.action_type==='finding'||item.action_type==='resolve')this.settleFinding(item,'failed',{findingSettlement:{projectionState:'publication_failed',eventType:'claim_publication_failed'}},code,{errorCode:code});else this.store.failPublication(item.id,code);}}
  async workerLoop(workerId){this.recoverLegacyStatuses();while(!this.stopping){const item=this.store.claimPublication();if(item){this.logger.info?.({event:'publication_started',workerId,outboxId:item.id,runId:item.run_id,action:item.action_type});await this.process(item);}const reconciled=await this.reconcileStatusPublications();if(!item&&!reconciled.checked)await sleep(this.config.publisherPollIntervalMs);}}
  start(){if(this.workers.length)return this.workers;this.workers=Array.from({length:this.config.publisherConcurrency},(_,index)=>this.workerLoop(index+1).catch(error=>{this.logger.error?.({event:'publisher_crashed',workerId:index+1,code:error.code||'EPUBLISHER'});throw error;}));return this.workers;}
  async stop(){this.stopping=true;await Promise.allSettled(this.workers);}
}
module.exports={Publisher,retryablePublication,retryDelay,serviceFindingNote,positionMatches};
