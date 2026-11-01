'use strict';

const{version:SERVICE_VERSION}=require('../package.json');
const{selectGitLabCapabilities,versionAtLeast}=require('./gitlab-capabilities');
const{safePath,sha,createRawTextDiff}=require('./raw-diff-fallback');
const GITLAB_RESPONSE_MAX_BYTES=8*1024*1024;
async function readBoundedResponseText(response,maxBytes=GITLAB_RESPONSE_MAX_BYTES){const limit=Number(maxBytes);if(!Number.isSafeInteger(limit)||limit<1)throw Object.assign(new Error('GitLab response byte limit is invalid'),{code:'EGITLABOUTPUT'});const declared=Number(response.headers?.get?.('content-length')||0);if(Number.isFinite(declared)&&declared>limit){try{await response.body?.cancel?.();}catch{}throw Object.assign(new Error(`GitLab response exceeds ${limit} bytes`),{code:'EGITLABOUTPUT',status:response.status,maxBytes:limit,responseBytes:declared});}if(response.body?.getReader){const reader=response.body.getReader(),chunks=[];let total=0;try{for(;;){const{done,value}=await reader.read();if(done)break;const chunk=Buffer.from(value);total+=chunk.length;if(total>limit){try{await reader.cancel();}catch{}throw Object.assign(new Error(`GitLab response exceeds ${limit} bytes`),{code:'EGITLABOUTPUT',status:response.status,maxBytes:limit,responseBytes:total});}chunks.push(chunk);}return Buffer.concat(chunks,total).toString('utf8');}finally{try{reader.releaseLock();}catch{}}}const fallback=typeof response.text==='function'?await response.text():'';const bytes=Buffer.byteLength(fallback,'utf8');if(bytes>limit)throw Object.assign(new Error(`GitLab response exceeds ${limit} bytes`),{code:'EGITLABOUTPUT',status:response.status,maxBytes:limit,responseBytes:bytes});return fallback;}

function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function encodeProject(value){return encodeURIComponent(String(value));}
function nextPageFromHeaders(headers,currentPage){const x=String(headers.get('x-next-page')||'').trim();if(x){const n=Number(x);return Number.isInteger(n)&&n>currentPage?n:null;}const link=String(headers.get('link')||'');for(const part of link.split(',')){if(!/;\s*rel="?next"?/i.test(part))continue;const match=part.match(/<([^>]+)>/);if(!match)return null;try{const n=Number(new URL(match[1]).searchParams.get('page'));return Number.isInteger(n)&&n>currentPage?n:null;}catch{return null;}}return 0;}
function normalizeDiffVersionSize(value){const text=String(value??'').trim();if(!/^\d+$/.test(text))return null;const size=Number(text);return Number.isSafeInteger(size)&&size>=0?size:null;}
function parseRetryAfter(value){if(!value)return null;const seconds=Number(value);if(Number.isFinite(seconds))return Math.max(0,seconds*1000);const at=Date.parse(value);return Number.isFinite(at)?Math.max(0,at-Date.now()):null;}
function findingBody(finding){const markers=[`<!-- codex-review-service:finding:${finding.fingerprint} -->`];if(finding.anchorFingerprint)markers.push(`<!-- codex-review-service:anchor:${finding.anchorFingerprint} -->`);if(finding.claimState==='known'&&finding.claimFingerprint)markers.push(`<!-- codex-review-service:claim:${finding.claimFingerprint} -->`);return`**${finding.severity.toUpperCase()} · ${finding.title}**\n\n${finding.description}`+(finding.suggestion?`\n\n**Suggestion:** ${finding.suggestion}`:'')+`\n\n${markers.join('\n')}`;}
function selectDiscussionByFingerprint(discussions,fingerprint,diffRefs=null){const marker=`<!-- codex-review-service:finding:${fingerprint} -->`,matches=(discussions||[]).filter(d=>Array.isArray(d.notes)&&d.notes.some(n=>typeof n.body==='string'&&n.body.includes(marker)));if(!diffRefs)return matches[0]||null;const positioned=matches.filter(d=>d.notes.some(n=>n.position&&String(n.position.base_sha||'')===String(diffRefs.base_sha||'')&&String(n.position.start_sha||'')===String(diffRefs.start_sha||'')&&String(n.position.head_sha||'')===String(diffRefs.head_sha||'')));return positioned.find(d=>discussionResolved(d)===false)||positioned[0]||matches[0]||null;}
class RateLimiter{constructor(perSecond){this.interval=Math.max(1,Math.ceil(1000/Math.max(1,perSecond)));this.tail=Promise.resolve();this.nextAt=0;}async acquire(){let release;const turn=new Promise(resolve=>release=resolve),previous=this.tail;this.tail=turn;await previous;const wait=Math.max(0,this.nextAt-Date.now());if(wait)await sleep(wait);this.nextAt=Date.now()+this.interval;release();}}
class CircuitBreaker{constructor(threshold,resetMs){this.threshold=threshold;this.resetMs=resetMs;this.failures=0;this.openUntil=0;}before(){if(this.openUntil>Date.now()){const error=new Error('GitLab circuit breaker is open');error.code='EGITLABCIRCUIT';error.retryAfterMs=this.openUntil-Date.now();throw error;}if(this.openUntil&&this.openUntil<=Date.now()){this.openUntil=0;this.failures=0;}}success(){this.failures=0;this.openUntil=0;}failure(error){const status=Number(error?.status||0),transient=error?.code==='EGITLABNETWORK'||status===429||status>=500;if(!transient)return;this.failures+=1;if(this.failures>=this.threshold)this.openUntil=Date.now()+this.resetMs;}state(){return this.openUntil>Date.now()?'open':'closed';}}
function redirectError(message){return Object.assign(new Error(message),{code:'EGITLABREDIRECT'});}
async function fetchGitLab(url,options,{allowExternalRedirect=false,beforeSend}={}){
  let current=new URL(url),headers={...options.headers};
  for(let redirects=0;redirects<=5;redirects++){
    // Synchronous generation/write-intent checks run after throttling and
    // immediately before transport, with no intervening asynchronous boundary.
    const checked=beforeSend?.();if(checked&&typeof checked.then==='function')await checked;
    const response=await fetch(current,{...options,headers,redirect:'manual'});
    if(![301,302,303,307,308].includes(response.status))return response;
    await response.body?.cancel?.();
    if(redirects===5)throw redirectError('GitLab redirect limit exceeded');
    if(options.method!=='GET')throw redirectError('GitLab writes must not be redirected');
    const location=response.headers?.get?.('location');if(!location)throw redirectError('GitLab redirect has no Location');
    let next;try{next=new URL(location,current);}catch{throw redirectError('GitLab redirect URL is invalid');}
    if(!['http:','https:'].includes(next.protocol)||next.username||next.password||next.hash)throw redirectError('GitLab redirect URL is unsafe');
    if(current.protocol==='https:'&&next.protocol!=='https:')throw redirectError('GitLab redirect must not downgrade HTTPS');
    if(next.origin!==current.origin){if(!allowExternalRedirect)throw redirectError('GitLab API redirect must remain on the configured origin');headers={'User-Agent':headers['User-Agent']};}
    current=next;
  }
  throw redirectError('GitLab redirect did not terminate');
}
class GitLabClient{
constructor(config){this.config=config;this.apiUrl=config.gitlabApiUrl;this.token=config.gitlabToken;this.statusName=config.statusName;this.limiter=new RateLimiter(config.gitlabRequestsPerSecond||20);this.circuit=new CircuitBreaker(config.gitlabCircuitFailureThreshold||8,config.gitlabCircuitResetMs||30000);this.versionInfo=null;this.capabilities=null;}
async request(method,pathname,{query,body,expected=[200],accept='json',allowExternalRedirect=false,beforeSend}={}){
  this.circuit.before();await this.limiter.acquire();this.circuit.before();
  const url=new URL(this.apiUrl+pathname);if(query)for(const[key,value]of Object.entries(query))if(value!==undefined&&value!==null&&value!=='')url.searchParams.set(key,String(value));
  let response;
  try{response=await fetchGitLab(url,{method,headers:{'PRIVATE-TOKEN':this.token,'User-Agent':`codex-review-service/${SERVICE_VERSION}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(this.config.gitlabRequestTimeoutMs)},{allowExternalRedirect,beforeSend});}
  catch(cause){if(typeof cause?.code==='string'&&!['ETIMEDOUT','ECONNRESET','ENOTFOUND'].includes(cause.code))throw cause;const error=new Error(`GitLab ${method} ${pathname} network failure`);error.code='EGITLABNETWORK';error.cause=cause;this.circuit.failure(error);throw error;}
  let text;try{text=await readBoundedResponseText(response,this.config.gitlabResponseMaxBytes||GITLAB_RESPONSE_MAX_BYTES);}catch(error){this.circuit.failure(error);throw error;}
  if(!expected.includes(response.status)){const error=new Error(`GitLab ${method} ${pathname} failed with ${response.status}`);error.code='EGITLABHTTP';error.status=response.status;error.responseBody=text.slice(0,2000);error.retryAfterMs=parseRetryAfter(response.headers.get('retry-after'));this.circuit.failure(error);throw error;}
  let data=text;if(accept==='json'){if(!text)data=null;else try{data=JSON.parse(text);}catch(cause){const error=new Error(`GitLab ${method} ${pathname} returned invalid JSON`);error.code='EGITLABJSON';error.cause=cause;throw error;}}
  this.circuit.success();return{data,status:response.status,headers:response.headers};
}
async getVersion(){if(this.versionInfo)return this.versionInfo;const version=(await this.request('GET','/version')).data;this.capabilities=selectGitLabCapabilities(version?.version);this.versionInfo=version;return version;}
async getCapabilities(){if(!this.capabilities)await this.getVersion();return this.capabilities;}
async getMergeRequest(projectId,iid){return(await this.request('GET',`/projects/${encodeProject(projectId)}/merge_requests/${iid}`)).data;}
async compareCommits(projectId,from,to){const data=(await this.request('GET',`/projects/${encodeProject(projectId)}/repository/compare`,{query:{from,to,straight:true}})).data,items=Array.isArray(data?.diffs)?data.diffs:[];return{items,complete:Boolean(data&&Array.isArray(data.diffs)&&data.compare_timeout!==true),compareTimeout:data?.compare_timeout===true,sameRef:data?.compare_same_ref===true,commitCount:Array.isArray(data?.commits)?data.commits.length:0};}
async paginated(pathname,query={}){const items=[];let page=1;while(page<=this.config.gitlabMaxPages){const response=await this.request('GET',pathname,{query:{...query,per_page:100,page}});if(!Array.isArray(response.data)){const error=new Error('GitLab pagination response is not an array');error.code='EGITLABJSON';throw error;}items.push(...response.data);const next=nextPageFromHeaders(response.headers,page);if(next===0)return{items,complete:true};if(!next)return{items,complete:false};page=next;}return{items,complete:false};}
async listMergeRequestDiffs(projectId,iid){const capabilities=await this.getCapabilities();if(capabilities.profile==='classic'){const response=await this.request('GET',`/projects/${encodeProject(projectId)}/merge_requests/${iid}/changes`),data=response.data;if(!data||!Array.isArray(data.changes))return{items:[],complete:false,overflow:null,profile:'classic',reason:'changes_response_invalid'};const overflow=data.overflow;return{items:data.changes,complete:overflow===false,overflow:typeof overflow==='boolean'?overflow:null,profile:'classic',reason:overflow===false?'complete':'changes_overflow_or_unknown'};}const result=await this.paginated(`/projects/${encodeProject(projectId)}/merge_requests/${iid}/diffs`);return{...result,profile:'modern'};}
async recoverClassicEmptyDiffs(projectId,mr,diffResult,maxDiffBytes){if(diffResult?.profile!=='classic'||diffResult.complete!==true||diffResult.overflow!==false)return diffResult;const startSha=String(mr?.diff_refs?.start_sha||''),headSha=String(mr?.diff_refs?.head_sha||mr?.sha||'');if(!sha(startSha)||!sha(headSha))return diffResult;const items=[];for(const entry of diffResult.items||[]){const path=String(entry?.new_path||entry?.old_path||'');const candidate=typeof entry?.diff==='string'&&entry.diff.length===0&&!entry?.too_large&&!entry?.collapsed&&!entry?.generated_file&&!entry?.renamed_file&&!entry?.new_file&&!entry?.deleted_file&&safePath(path);if(!candidate){items.push(entry);continue;}let fallback;try{const oldText=await this.getRepositoryFileRaw(projectId,path,startSha),newText=await this.getRepositoryFileRaw(projectId,path,headSha);fallback=oldText===null||newText===null?{status:'missing'}:createRawTextDiff({oldText,newText,maxDiffBytes});}catch{fallback={status:'read_failed'};}if(fallback.status==='available'){items.push({...entry,diff:fallback.diffText,raw_diff_fallback:{source:'gitlab-raw-file-fallback',status:'available',startSha,headSha,oldBytes:fallback.oldBytes,newBytes:fallback.newBytes,diffBytes:fallback.diffBytes}});}else items.push({...entry,raw_diff_fallback:{source:'gitlab-raw-file-fallback',status:fallback.status,oldBytes:Number(fallback.oldBytes||0),newBytes:Number(fallback.newBytes||0),diffBytes:Number(fallback.diffBytes||0)}});}return{...diffResult,items};}
listMergeRequestVersions(projectId,iid){return this.paginated(`/projects/${encodeProject(projectId)}/merge_requests/${iid}/versions`);}
listMergeRequestPipelines(projectId,iid){return this.paginated(`/projects/${encodeProject(projectId)}/merge_requests/${iid}/pipelines`);}
listProjectPipelines(projectId,{sha='',ref='',source=''}={}){return this.paginated(`/projects/${encodeProject(projectId)}/pipelines`,{sha,ref,source,order_by:'id',sort:'desc'});}
async resolveStatusPipeline(statusProjectId,mrProjectId,iid,sha,ref,mr){if(!this.config.bindStatusPipeline)return null;const head=mr?.head_pipeline;if(head&&Number(head.project_id)===Number(statusProjectId)&&String(head.sha||'')===String(sha))return Number(head.id)||null;try{const direct=await this.listProjectPipelines(statusProjectId,{sha,ref});if(direct.complete){const match=direct.items.find(p=>String(p.sha||'')===String(sha));if(match)return Number(match.id)||null;}}catch{}if(Number(statusProjectId)===Number(mrProjectId)){try{const result=await this.listMergeRequestPipelines(mrProjectId,iid);if(result.complete){const match=result.items.find(p=>String(p.sha||'')===String(sha));if(match)return Number(match.id)||null;}}catch{}}return null;}
async validateMergeRequestDiffCoverage(projectId,iid,mr,diffResult){if(!diffResult?.complete||!Array.isArray(diffResult.items))return{complete:false,reason:diffResult?.reason||'diff_pagination',profile:diffResult?.profile||'modern'};if(diffResult.profile==='classic'){if(diffResult.overflow!==false)return{complete:false,reason:'changes_overflow_or_unknown',profile:'classic'};return{complete:true,reason:'complete',realSize:diffResult.items.length,profile:'classic',verification:'changes_overflow'};}const versions=await this.listMergeRequestVersions(projectId,iid);if(!versions.complete)return{complete:false,reason:'diff_versions_pagination',profile:'modern'};const headSha=String(mr.diff_refs?.head_sha||mr.sha||''),startSha=String(mr.diff_refs?.start_sha||''),baseSha=String(mr.diff_refs?.base_sha||'');const version=versions.items.find(item=>String(item.head_commit_sha||'')===headSha&&String(item.start_commit_sha||'')===startSha&&(!baseSha||String(item.base_commit_sha||'')===baseSha));if(!version)return{complete:false,reason:'diff_version_not_found',profile:'modern'};if(String(version.state||'')!=='collected')return{complete:false,reason:`diff_version_state:${String(version.state||'unknown')}`,profile:'modern'};const realSize=normalizeDiffVersionSize(version.real_size);if(realSize===null)return{complete:false,reason:'diff_version_real_size_unknown',profile:'modern'};if(realSize!==diffResult.items.length)return{complete:false,reason:'diff_version_size_mismatch',realSize,returnedSize:diffResult.items.length,profile:'modern'};return{complete:true,reason:'complete',realSize,profile:'modern',verification:'versions_real_size'};}
async listRepositoryTree(projectId,ref){return this.paginated(`/projects/${encodeProject(projectId)}/repository/tree`,{ref,recursive:true});}
listOpenMergeRequests(projectId){return this.paginated(`/projects/${encodeProject(projectId)}/merge_requests`,{state:'opened',scope:'all'});}
listNotes(projectId,iid){return this.paginated(`/projects/${encodeProject(projectId)}/merge_requests/${iid}/notes`,{sort:'asc'});}
listDiscussions(projectId,iid){return this.paginated(`/projects/${encodeProject(projectId)}/merge_requests/${iid}/discussions`);}
async createNote(projectId,iid,body){return(await this.request('POST',`/projects/${encodeProject(projectId)}/merge_requests/${iid}/notes`,{body:{body},expected:[201]})).data;}
async updateNote(projectId,iid,noteId,body){return(await this.request('PUT',`/projects/${encodeProject(projectId)}/merge_requests/${iid}/notes/${noteId}`,{body:{body}})).data;}
async upsertSummary(projectId,iid,body){
  if(!this.statusAuthor)this.statusAuthor=(await this.request('GET','/user')).data;
  const actorId=Number(this.statusAuthor?.id);
  if(!Number.isSafeInteger(actorId)||actorId<=0||typeof this.statusAuthor?.username!=='string'||!this.statusAuthor.username){
    throw Object.assign(new Error('Authenticated GitLab actor identity is unavailable; refusing summary publication.'),{code:'EGITLABAUTHOR'});
  }
  const marker='<!-- codex-review-service:summary -->',result=await this.listNotes(projectId,iid);
  if(!result.complete)throw Object.assign(new Error('Could not exhaustively scan MR notes for summary marker'),{code:'EGITLABPAGINATION'});
  const own=result.items.filter(note=>typeof note.body==='string'&&note.body.includes(marker)&&Number(note.author?.id)===actorId);
  if(own.length>1)throw Object.assign(new Error('Multiple actor-owned summary notes require reconciliation.'),{code:'EGITLABAMBIGUOUS'});
  const rendered=`${body}\n\n${marker}`;
  return own.length?this.updateNote(projectId,iid,own[0].id,rendered):this.createNote(projectId,iid,rendered);
}
async findDiscussionByFingerprint(projectId,iid,fingerprint,diffRefs=null){const result=await this.listDiscussions(projectId,iid);if(!result.complete){const error=new Error('Could not exhaustively scan MR discussions');error.code='EGITLABPAGINATION';throw error;}return selectDiscussionByFingerprint(result.items,fingerprint,diffRefs);}
async createDiscussion(projectId,iid,finding,diffRefs,oldPath,newPath,{beforeSend}={}){const position={position_type:'text',base_sha:diffRefs.base_sha,start_sha:diffRefs.start_sha,head_sha:diffRefs.head_sha,old_path:oldPath||newPath,new_path:newPath||oldPath};if(finding.side==='old')position.old_line=finding.line;else position.new_line=finding.line;return(await this.request('POST',`/projects/${encodeProject(projectId)}/merge_requests/${iid}/discussions`,{body:{body:findingBody(finding),position},expected:[201],beforeSend})).data;}
updateFindingNote(projectId,iid,noteId,finding){return this.updateNote(projectId,iid,noteId,findingBody(finding));}
async getDiscussion(projectId,iid,discussionId){const response=await this.request('GET',`/projects/${encodeProject(projectId)}/merge_requests/${iid}/discussions/${encodeURIComponent(discussionId)}`,{expected:[200,404]});return response.status===404?null:response.data;}
async setDiscussionResolved(projectId,iid,discussionId,resolved){return(await this.request('PUT',`/projects/${encodeProject(projectId)}/merge_requests/${iid}/discussions/${encodeURIComponent(discussionId)}`,{body:{resolved:Boolean(resolved)}})).data;}
async getProjectMember(projectId,userId){const response=await this.request('GET',`/projects/${encodeProject(projectId)}/members/all/${encodeURIComponent(userId)}`,{expected:[200,404]});return response.status===404?null:response.data;}
async getRepositoryFileRaw(projectId,filePath,ref){const response=await this.request('GET',`/projects/${encodeProject(projectId)}/repository/files/${encodeURIComponent(filePath)}/raw`,{query:{ref},expected:[200,404],accept:'text'});return response.status===404?null:response.data;}
async setCommitStatus(projectId,sha,state,description,ref='',pipelineId=null,{beforeSend,onAttemptSettled}={}){
  const doRequest=()=>this.request('POST',`/projects/${encodeProject(projectId)}/statuses/${sha}`,{query:{state,name:this.statusName,description:String(description||'').slice(0,255),ref,pipeline_id:pipelineId||undefined,target_url:this.config.statusTargetUrl||undefined},expected:[201],beforeSend});
  let lastError;
  for(let attempt=0;attempt<this.config.gitlabStatusRetries;attempt++){
    let result;
    try{result=(await doRequest()).data;}
    catch(error){
      onAttemptSettled?.({error});lastError=error;
      if(error.status!==409||attempt===this.config.gitlabStatusRetries-1)throw error;
      await sleep(Math.min(2000,250*(attempt+1)));continue;
    }
    onAttemptSettled?.({result});return result;
  }
  throw lastError;
}
async readCommitStatus(payload,{remoteId='',botUsername=''}={}){
  // pipeline_id filtering is absent before GitLab 17.9. Never infer a pipeline
  // from name/SHA alone, and never treat an implicit pipeline as exact evidence.
  const version=String((await this.getVersion())?.version||'');
  if(!versionAtLeast(version,'17.9.0')||!Number.isSafeInteger(Number(payload.pipelineId))||Number(payload.pipelineId)<=0){
    return{kind:'ambiguous',reason:'pipeline_identity_unavailable'};
  }
  if(!this.statusAuthor)this.statusAuthor=(await this.request('GET','/user')).data;
  const author=this.statusAuthor,username=String(botUsername||'').toLowerCase();
  if(!Number.isSafeInteger(Number(author?.id))||Number(author.id)<=0||!author?.username||(username&&String(author.username).toLowerCase()!==username))return{kind:'ambiguous',reason:'bot_identity_unavailable'};
  const result=await this.paginated(`/projects/${encodeProject(payload.statusProjectId)}/repository/commits/${encodeURIComponent(payload.headSha)}/statuses`,{ref:payload.ref,name:payload.statusName||this.statusName,pipeline_id:payload.pipelineId,all:false});
  if(!result.complete)return{kind:'ambiguous',reason:'incomplete_status_scan'};
  if(!result.items.length)return{kind:'missing',reason:'exact_pipeline_has_no_status'};
  if(result.items.length!==1)return{kind:'ambiguous',reason:'multiple_statuses'};
  const status=result.items[0];
  if(String(status.sha||'')!==String(payload.headSha)||String(status.ref||'')!==String(payload.ref||'')||String(status.name||'')!==String(payload.statusName||this.statusName)||
    !Number.isSafeInteger(Number(status.id))||Number(status.id)<=0||Number(status.author?.id)!==Number(author.id)||String(status.author?.username||'').toLowerCase()!==String(author.username).toLowerCase()||
    (status.pipeline_id!==undefined&&Number(status.pipeline_id)!==Number(payload.pipelineId))||!['pending','running','success','failed','canceled','skipped'].includes(status.status)){
    return{kind:'ambiguous',reason:'status_identity_mismatch'};
  }
  const matches=String(status.status)===String(payload.state)&&String(status.description||'')===String(payload.description||'').slice(0,255);
  return{kind:matches?'match':'mismatch',remoteId:String(status.id),remoteIdMatches:Boolean(remoteId)&&String(status.id)===String(remoteId),
    state:status.status,description:String(status.description||''),pipelineId:Number(payload.pipelineId),authorId:Number(author.id)};
}
health(){return{circuit:this.circuit.state(),profile:this.capabilities?.profile||'unknown',version:this.capabilities?.version||null};}
}
function discussionResolved(discussion){if(!discussion||!Array.isArray(discussion.notes))return null;const note=discussion.notes.find(item=>item?.resolvable===true);return note?Boolean(note.resolved):null;}
module.exports={GitLabClient,discussionResolved,findingBody,selectDiscussionByFingerprint,encodeProject,nextPageFromHeaders,normalizeDiffVersionSize,parseRetryAfter,RateLimiter,CircuitBreaker,readBoundedResponseText,GITLAB_RESPONSE_MAX_BYTES};
