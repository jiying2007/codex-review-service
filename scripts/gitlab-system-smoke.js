'use strict';

const assert=require('node:assert/strict');
const {GitLabClient,discussionResolved}=require('../src/gitlab');
const {ProjectScopeManager}=require('../src/project-scope');

const baseUrl=String(process.env.GITLAB_BASE_URL||'').replace(/\/$/,'');
const token=String(process.env.GITLAB_API_TOKEN||'');
if(!baseUrl||!token)throw new Error('GITLAB_BASE_URL and GITLAB_API_TOKEN are required');
const api=`${baseUrl}/api/v4`;
async function request(method,path,{body,expected=[200]}={}){const response=await fetch(api+path,{method,headers:{'PRIVATE-TOKEN':token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const text=await response.text();if(!expected.includes(response.status))throw new Error(`${method} ${path}: ${response.status} ${text.slice(0,500)}`);return text?JSON.parse(text):null;}
function semverAtLeast(value,min){const a=String(value).split('.').map(Number),b=String(min).split('.').map(Number);for(let i=0;i<3;i++){if((a[i]||0)>(b[i]||0))return true;if((a[i]||0)<(b[i]||0))return false;}return true;}
async function waitFor(fn,label,attempts=60){let last;for(let i=0;i<attempts;i++){try{const value=await fn();if(value)return value;}catch(error){last=error;}await new Promise(r=>setTimeout(r,1000));}throw last||new Error(`Timed out waiting for ${label}`);}

async function main(){const suffix=`codex-review-${Date.now()}`,group=await request('POST','/groups',{body:{name:suffix,path:suffix},expected:[201]});let project;try{project=await request('POST','/projects',{body:{name:'service-e2e',path:'service-e2e',namespace_id:group.id,initialize_with_readme:true,default_branch:'main'},expected:[201]});const pid=project.id;
  await request('POST',`/projects/${pid}/repository/branches`,{body:{branch:'feature',ref:'main'},expected:[201]});
  await request('POST',`/projects/${pid}/repository/files/review.txt`,{body:{branch:'feature',content:'line one\nline two\n',commit_message:'add review fixture'},expected:[201]});
  const mr=await request('POST',`/projects/${pid}/merge_requests`,{body:{source_branch:'feature',target_branch:'main',title:'Codex Review Service provider E2E'},expected:[201]});
  const config={gitlabApiUrl:api,gitlabToken:token,gitlabRequestTimeoutMs:30000,gitlabMaxPages:20,gitlabRequestsPerSecond:50,gitlabCircuitFailureThreshold:4,gitlabCircuitResetMs:1000,statusName:'codex-review-e2e',statusTargetUrl:'',gitlabStatusRetries:3,bindStatusPipeline:false,gitlabProjectAllowlist:new Set(),gitlabGroups:[{id:group.id,includeSubgroups:true}]};
  const client=new GitLabClient(config),version=await client.getVersion();assert.ok(semverAtLeast(version.version,'19.1.0'),`unexpected GitLab version ${version.version}`);
  const scope=new ProjectScopeManager(client,config),snapshot=await scope.refresh();assert.equal(snapshot.healthy,true);assert.ok(scope.projects.has(pid));
  const hydrated=await waitFor(async()=>{const value=await client.getMergeRequest(pid,mr.iid);return value.diff_refs?.head_sha&&value.diff_refs?.start_sha&&value.diff_refs?.base_sha?value:null;},'MR diff refs');
  const diffs=await waitFor(async()=>{const value=await client.listMergeRequestDiffs(pid,mr.iid);return value.complete&&value.items.some(item=>item.new_path==='review.txt')?value:null;},'MR diffs');
  const coverage=await waitFor(async()=>{const value=await client.validateMergeRequestDiffCoverage(pid,mr.iid,hydrated,diffs);return value.complete?value:null;},'diff coverage');assert.equal(coverage.complete,true);
  assert.equal(await client.getRepositoryFileRaw(pid,'review.txt','feature'),'line one\nline two\n');
  const note1=await client.upsertSummary(pid,mr.iid,'E2E summary one'),note2=await client.upsertSummary(pid,mr.iid,'E2E summary two');assert.equal(note1.id,note2.id);
  const finding={severity:'high',title:'E2E finding',description:'Provider discussion contract test.',suggestion:'Keep this deterministic.',fingerprint:'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',side:'new',line:1};
  const discussion=await client.createDiscussion(pid,mr.iid,finding,hydrated.diff_refs,'review.txt','review.txt');assert.ok(discussion.id);const found=await client.findDiscussionByFingerprint(pid,mr.iid,finding.fingerprint);assert.equal(found.id,discussion.id);await client.setDiscussionResolved(pid,mr.iid,discussion.id,true);const resolved=await client.getDiscussion(pid,mr.iid,discussion.id);assert.equal(discussionResolved(resolved),true);
  const status=await client.setCommitStatus(pid,hydrated.diff_refs.head_sha,'success','Provider E2E complete','feature');assert.equal(status.status,'success');
  const open=await client.listOpenMergeRequests(pid);assert.equal(open.complete,true);assert.ok(open.items.some(item=>item.iid===mr.iid));
  process.stdout.write(JSON.stringify({ok:true,gitlabVersion:version.version,projectId:pid,mrIid:mr.iid,diffCount:diffs.items.length})+'\n');
}finally{if(group?.id)try{await request('DELETE',`/groups/${group.id}`,{expected:[202,204]});}catch{}}}
main().catch(error=>{console.error(error);process.exitCode=1;});
