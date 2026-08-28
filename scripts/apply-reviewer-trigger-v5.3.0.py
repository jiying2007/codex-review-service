from pathlib import Path
import json

root = Path('.')


def replace_once(path, old, new):
    p = root / path
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one replacement, found {count}: {old[:120]}')
    p.write_text(text.replace(old, new, 1))


# Product identity: feature release + breaking Config Schema 2 hard cut.
for path in ['package.json', 'package-lock.json', 'product-contract.json']:
    p = root / path
    data = json.loads(p.read_text())
    if path == 'package.json':
        data['version'] = '5.3.0'
    elif path == 'package-lock.json':
        data['version'] = '5.3.0'
        data['packages']['']['version'] = '5.3.0'
    else:
        data['serviceVersion'] = '5.3.0'
        data['configSchemaVersion'] = 2
    p.write_text(json.dumps(data, indent=2) + '\n')

# Canonical and deployment examples all move to Schema 2 and reviewer-native triggering.
for path in ['config.example.json', 'deploy/docker/config.example.json', 'deploy/systemd/config.example.json']:
    p = root / path
    data = json.loads(p.read_text())
    data['schemaVersion'] = 2
    review = data.setdefault('review', {})
    review.pop('requiredAssigneeUserIds', None)
    review.pop('manualReviewBypassAssignee', None)
    review['triggerAssignment'] = {'mode': 'reviewer', 'userIds': []}
    p.write_text(json.dumps(data, indent=2) + '\n')

# Config parser: remove old Assignee-only knobs and add the typed assignment policy.
replace_once(
    'src/config.js',
    "'triggerOnOpen','triggerOnPush','triggerOnReopen','requiredAssigneeUserIds','manualReviewBypassAssignee','profile'",
    "'triggerOnOpen','triggerOnPush','triggerOnReopen','triggerAssignment','profile'"
)
config_path = root / 'src/config.js'
config_text = config_path.read_text()
positive_marker = "function positiveIds(value,label){if(value===undefined)return[];if(!Array.isArray(value)||value.length>10000)throw configError(`${label} must be an array`);const ids=[];for(const item of value){if(!Number.isInteger(item)||item<=0)throw configError(`${label} contains an invalid numeric ID`);ids.push(item);}return[...new Set(ids)];}\n"
if config_text.count(positive_marker) != 1:
    raise SystemExit('src/config.js: positiveIds marker drifted')
parser = "function parseTriggerAssignment(value){const item=assertObject(value,'review.triggerAssignment');assertKeys(item,new Set(['mode','userIds']),'review.triggerAssignment');const mode=enumValue(item.mode,'reviewer','review.triggerAssignment.mode',['reviewer','assignee','either','always']),userIds=positiveIds(item.userIds,'review.triggerAssignment.userIds');if(mode==='always'&&userIds.length)throw configError('review.triggerAssignment.userIds must be empty when mode is always');return Object.freeze({mode,userIds:Object.freeze(userIds)});}\n"
config_text = config_text.replace(positive_marker, positive_marker + parser, 1)
old = "blockingSeverity=enumValue(r.blockingSeverity,'high','review.blockingSeverity',SEVERITIES),maxDiffBytes=intValue(r.maxDiffBytes,1024*1024,'review.maxDiffBytes',4096,4*1024*1024);return Object.freeze({"
new = "blockingSeverity=enumValue(r.blockingSeverity,'high','review.blockingSeverity',SEVERITIES),triggerAssignment=parseTriggerAssignment(r.triggerAssignment),maxDiffBytes=intValue(r.maxDiffBytes,1024*1024,'review.maxDiffBytes',4096,4*1024*1024);return Object.freeze({"
if config_text.count(old) != 1:
    raise SystemExit('src/config.js: loadConfig triggerAssignment insertion marker drifted')
config_text = config_text.replace(old, new, 1)
old = "requiredAssigneeUserIds:Object.freeze(positiveIds(r.requiredAssigneeUserIds,'review.requiredAssigneeUserIds')),manualReviewBypassAssignee:boolValue(r.manualReviewBypassAssignee,true,'review.manualReviewBypassAssignee'),"
if config_text.count(old) != 1:
    raise SystemExit('src/config.js: legacy assignment return marker drifted')
config_text = config_text.replace(old, 'triggerAssignment,', 1)
config_path.write_text(config_text)

# Webhook normalization rewritten around GitLab Reviewer/Assignee semantics.
webhook = r"""'use strict';

const crypto=require('node:crypto');
function safeEqual(a,b){const aa=Buffer.from(String(a||'')),bb=Buffer.from(String(b||''));return aa.length===bb.length&&crypto.timingSafeEqual(aa,bb);}
function normalizeUrl(value){try{return new URL(String(value)).toString().replace(/\/$/,'');}catch{return'';}}
function verifyInstance(headers,config){const actual=String(headers['x-gitlab-instance']||'').trim();if(!actual)return config.requireInstanceHeader?{ok:false,reason:'missing_instance'}:{ok:true};return normalizeUrl(actual)===normalizeUrl(config.webhookExpectedInstance)?{ok:true}:{ok:false,reason:'wrong_instance'};}
function verifySignedWebhook(headers,rawBody,config,webhookId,nowMs){const timestamp=String(headers['webhook-timestamp']||'').trim(),signatures=String(headers['webhook-signature']||'').trim();if(!timestamp||!signatures)return{ok:false,reason:'missing_signature'};const seconds=Number(timestamp);if(!Number.isFinite(seconds))return{ok:false,reason:'invalid_timestamp'};if(Math.abs(nowMs-seconds*1000)>config.webhookMaxSkewSeconds*1000)return{ok:false,reason:'stale_timestamp'};const rawKey=Buffer.from(config.webhookSigningToken.slice('whsec_'.length),'base64'),digest=crypto.createHmac('sha256',rawKey).update(`${webhookId}.${timestamp}.${rawBody}`).digest('base64'),expected=`v1,${digest}`;return signatures.split(/\s+/).some(signature=>safeEqual(expected,signature))?{ok:true,webhookId,mode:'hmac'}:{ok:false,reason:'bad_signature'};}
function classicWebhookId(headers,rawBody){const event=String(headers['x-gitlab-event']||'unknown').trim().slice(0,128);return`classic:${event}:${crypto.createHash('sha256').update(String(rawBody)).digest('hex')}`;}
function verifyClassicWebhook(headers,rawBody,config){const token=String(headers['x-gitlab-token']||'').trim();if(!token)return{ok:false,reason:'missing_classic_token'};if(!safeEqual(token,config.webhookSigningToken))return{ok:false,reason:'bad_classic_token'};return{ok:true,webhookId:classicWebhookId(headers,rawBody),mode:'classic-token'};}
function verifyWebhook(headers,rawBody,config,nowMs=Date.now()){
  if(config.webhookAuthMode==='classic-token')return verifyClassicWebhook(headers,rawBody,config);
  const webhookId=String(headers['webhook-id']||headers['idempotency-key']||headers['x-gitlab-event-uuid']||'').trim();if(!webhookId)return{ok:false,reason:'missing_webhook_id'};if(webhookId.length>255||/[\r\n\0]/.test(webhookId))return{ok:false,reason:'invalid_webhook_id'};const instance=verifyInstance(headers,config);if(!instance.ok)return instance;return verifySignedWebhook(headers,rawBody,config,webhookId,nowMs);
}
function memberIds(value){return(Array.isArray(value)?value:[]).map(item=>Number(item?.id)).filter(Number.isInteger);}
function currentAssignments(payload,attrs={}){
  const assignees=Array.isArray(payload.assignees)?payload.assignees:Array.isArray(attrs.assignees)?attrs.assignees:(payload.assignee?[payload.assignee]:[]);
  const reviewers=Array.isArray(payload.reviewers)?payload.reviewers:Array.isArray(attrs.reviewers)?attrs.reviewers:[];
  return{assignees,reviewers};
}
function roleMatch(value,userIds){const ids=memberIds(value),required=Array.isArray(userIds)?userIds:[];return required.length?required.some(id=>ids.includes(id)):ids.length>0;}
function assignmentMatch(assignments,config){const policy=config.triggerAssignment||{mode:'reviewer',userIds:[]},mode=policy.mode||'reviewer',userIds=policy.userIds||[];if(mode==='always')return true;if(mode==='reviewer')return roleMatch(assignments.reviewers,userIds);if(mode==='assignee')return roleMatch(assignments.assignees,userIds);if(mode==='either')return roleMatch(assignments.reviewers,userIds)||roleMatch(assignments.assignees,userIds);return false;}
function assignmentChangeRelevant(changes,mode){if(mode==='always'||!changes||typeof changes!=='object'||Array.isArray(changes))return false;const has=key=>Object.prototype.hasOwnProperty.call(changes,key),reviewerChanged=has('reviewers')||has('reviewer_ids'),assigneeChanged=has('assignees')||has('assignee')||has('assignee_id')||has('assignee_ids');if(mode==='reviewer')return reviewerChanged;if(mode==='assignee')return assigneeChanged;if(mode==='either')return reviewerChanged||assigneeChanged;return false;}
function normalizeEvent(payload,headers,config){
  const event=String(headers['x-gitlab-event']||payload.event_type||payload.object_kind||'unknown'),projectId=Number(payload.project?.id||payload.project_id||0)||null,projectAllowed=Boolean(projectId&&config.gitlabProjectAllowlist.has(projectId));
  if(payload.object_kind==='merge_request'){
    const attrs=payload.object_attributes||{},iid=Number(attrs.iid||0)||null,action=String(attrs.action||''),headSha=String(attrs.last_commit?.id||attrs.diff_refs?.head_sha||attrs.sha||'').trim(),baseSha=String(attrs.diff_refs?.base_sha||'').trim(),startSha=String(attrs.diff_refs?.start_sha||'').trim(),sourceBranch=String(attrs.source_branch||'').trim(),codeUpdate=action==='update'&&typeof attrs.oldrev==='string'&&attrs.oldrev.length>0,assignments=currentAssignments(payload,attrs),eligible=assignmentMatch(assignments,config),assignmentUpdate=action==='update'&&assignmentChangeRelevant(payload.changes,config.triggerAssignment?.mode||'reviewer'),shouldReview=projectAllowed&&iid&&eligible&&((action==='open'&&config.triggerOnOpen)||(action==='reopen'&&config.triggerOnReopen)||(codeUpdate&&config.triggerOnPush)||assignmentUpdate);
    return{event,kind:'merge_request',projectId,iid,action,headSha,baseSha,startSha,sourceBranch,shouldReview:Boolean(shouldReview),shouldCancel:Boolean(projectAllowed&&iid&&['close','merge'].includes(action)),projectAllowed};
  }
  if(payload.object_kind==='note'&&payload.merge_request){
    const attrs=payload.object_attributes||{},author=String(payload.user?.username||'').trim(),userId=Number(payload.user?.id||attrs.author_id||0)||null,note=String(attrs.note||'').trim(),action=String(attrs.action||''),iid=Number(payload.merge_request?.iid||0)||null,command=action==='create'&&/^\/codex\s+review\s*$/i.test(note),self=Boolean(config.botUsername)&&author.toLowerCase()===config.botUsername.toLowerCase();
    return{event,kind:'note',projectId,iid,author,userId,action,command,shouldReview:Boolean(projectAllowed&&iid&&userId&&command&&!self),shouldCancel:false,projectAllowed};
  }
  return{event,kind:'ignored',projectId,iid:null,shouldReview:false,shouldCancel:false,projectAllowed};
}
module.exports={verifyWebhook,normalizeEvent,safeEqual,verifyInstance,normalizeUrl,classicWebhookId,memberIds,currentAssignments,roleMatch,assignmentMatch,assignmentChangeRelevant};
"""
(root / 'src/webhook.js').write_text(webhook)

assignment_tests = r"""'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const{normalizeEvent,assignmentMatch,assignmentChangeRelevant}=require('../src/webhook');
function config(overrides={}){return{gitlabProjectAllowlist:new Set([7]),triggerAssignment:{mode:'reviewer',userIds:[8]},triggerOnOpen:true,triggerOnPush:true,triggerOnReopen:true,botUsername:'bot',...overrides};}
function mr(extra={}){return{object_kind:'merge_request',project:{id:7},reviewers:[],assignees:[],object_attributes:{iid:9,action:'open',last_commit:{id:'head'}},...extra};}

test('reviewer mode uses Reviewer rather than Assignee',()=>{const c=config();assert.equal(normalizeEvent(mr({reviewers:[{id:8}]}),{},c).shouldReview,true);assert.equal(normalizeEvent(mr({assignees:[{id:8}]}),{},c).shouldReview,false);assert.equal(normalizeEvent(mr({reviewers:[{id:9}]}),{},c).shouldReview,false);assert.equal(normalizeEvent(mr(),{},c).shouldReview,false);});
test('empty userIds means any member in the selected role',()=>{const c=config({triggerAssignment:{mode:'reviewer',userIds:[]}});assert.equal(normalizeEvent(mr({reviewers:[{id:99}]}),{},c).shouldReview,true);assert.equal(normalizeEvent(mr(),{},c).shouldReview,false);});
test('assignee, either and always modes are explicit',()=>{assert.equal(assignmentMatch({reviewers:[],assignees:[{id:8}]},config({triggerAssignment:{mode:'assignee',userIds:[8]}})),true);assert.equal(assignmentMatch({reviewers:[{id:8}],assignees:[]},config({triggerAssignment:{mode:'either',userIds:[8]}})),true);assert.equal(assignmentMatch({reviewers:[],assignees:[]},config({triggerAssignment:{mode:'always',userIds:[]}})),true);});
test('adding a matching Reviewer to an existing MR triggers without a source push',()=>{const c=config(),payload=mr({reviewers:[{id:8}],changes:{reviewers:{previous:[],current:[{id:8}]}},object_attributes:{iid:9,action:'update',last_commit:{id:'head'}}});assert.equal(normalizeEvent(payload,{},c).shouldReview,true);});
test('removing Reviewer or unrelated metadata update does not trigger',()=>{const c=config(),removed=mr({reviewers:[],changes:{reviewers:{previous:[{id:8}],current:[]}},object_attributes:{iid:9,action:'update',last_commit:{id:'head'}}}),titleOnly=mr({reviewers:[{id:8}],changes:{title:{previous:'a',current:'b'}},object_attributes:{iid:9,action:'update',last_commit:{id:'head'}}});assert.equal(normalizeEvent(removed,{},c).shouldReview,false);assert.equal(normalizeEvent(titleOnly,{},c).shouldReview,false);});
test('code pushes remain assignment-gated',()=>{const c=config(),push=reviewers=>mr({reviewers,object_attributes:{iid:9,action:'update',oldrev:'old',last_commit:{id:'head'}}});assert.equal(normalizeEvent(push([{id:8}]),{},c).shouldReview,true);assert.equal(normalizeEvent(push([]),{},c).shouldReview,false);});
test('assignment-change relevance follows configured role',()=>{assert.equal(assignmentChangeRelevant({reviewers:{}},'reviewer'),true);assert.equal(assignmentChangeRelevant({assignees:{}},'reviewer'),false);assert.equal(assignmentChangeRelevant({assignees:{}},'assignee'),true);assert.equal(assignmentChangeRelevant({reviewers:{}},'either'),true);assert.equal(assignmentChangeRelevant({reviewers:{}},'always'),false);});
test('manual /codex review is an explicit assignment bypass',()=>{const event={object_kind:'note',project:{id:7},user:{id:12,username:'alice'},merge_request:{iid:9,reviewers:[],assignees:[]},object_attributes:{action:'create',note:'/codex review'}};assert.equal(normalizeEvent(event,{},config()).shouldReview,true);});
"""
old_test = root / 'test/assignee-policy.test.js'
if not old_test.exists():
    raise SystemExit('expected legacy assignee-policy test is missing')
old_test.unlink()
(root / 'test/assignment-policy.test.js').write_text(assignment_tests)

# Keep generic webhook tests assignment-neutral so they continue to test webhook mechanics.
replace_once(
    'test/webhook.test.js',
    "gitlabProjectAllowlist:new Set([7]),_key:key,...overrides",
    "gitlabProjectAllowlist:new Set([7]),triggerAssignment:{mode:'always',userIds:[]},_key:key,...overrides"
)

# Config contract tests: Schema 2, typed triggerAssignment and explicit legacy rejection.
replace_once(
    'test/config.test.js',
    "future=tempConfig({schemaVersion:2,...baseConfig()})",
    "future=tempConfig({schemaVersion:3,...baseConfig()})"
)
replace_once(
    'test/config.test.js',
    "/Unsupported config schema 2/",
    "/Unsupported config schema 3/"
)
config_test_path = root / 'test/config.test.js'
config_tests = config_test_path.read_text()
marker = "test('removed projectPolicyFile config field is rejected fail-closed',()=>{const t=tempConfig({...baseConfig(),review:{projectPolicyFile:'.codex-review.json'}});try{assert.throws(()=>loadStructuredConfig(t.file),/unsupported field: projectPolicyFile/);}finally{t.close();}});\n"
if config_tests.count(marker) != 1:
    raise SystemExit('test/config.test.js: insertion marker drifted')
addition = "test('triggerAssignment defaults to reviewer and rejects legacy Assignee-only fields',()=>{const t=tempConfig({...baseConfig(),review:{triggerAssignment:{mode:'either',userIds:[8,9]}}}),legacy=tempConfig({...baseConfig(),review:{requiredAssigneeUserIds:[8]}}),legacyManual=tempConfig({...baseConfig(),review:{manualReviewBypassAssignee:true}}),invalid=tempConfig({...baseConfig(),review:{triggerAssignment:{mode:'always',userIds:[8]}}});try{withEnvs({CODEX_REVIEW_CONFIG_FILE:t.file,GITLAB_API_TOKEN:'token',GITLAB_WEBHOOK_SIGNING_TOKEN:signingToken()},()=>assert.deepEqual(loadConfig().triggerAssignment,{mode:'either',userIds:[8,9]}));assert.throws(()=>loadStructuredConfig(legacy.file),/unsupported field: requiredAssigneeUserIds/);assert.throws(()=>loadStructuredConfig(legacyManual.file),/unsupported field: manualReviewBypassAssignee/);withEnvs({CODEX_REVIEW_CONFIG_FILE:invalid.file,GITLAB_API_TOKEN:'token',GITLAB_WEBHOOK_SIGNING_TOKEN:signingToken()},()=>assert.throws(()=>loadConfig(),/must be empty when mode is always/));}finally{t.close();legacy.close();legacyManual.close();invalid.close();}});\ntest('triggerAssignment default is reviewer with any Reviewer accepted',()=>{const t=tempConfig({...baseConfig()});try{withEnvs({CODEX_REVIEW_CONFIG_FILE:t.file,GITLAB_API_TOKEN:'token',GITLAB_WEBHOOK_SIGNING_TOKEN:signingToken()},()=>assert.deepEqual(loadConfig().triggerAssignment,{mode:'reviewer',userIds:[]}));}finally{t.close();}});\n"
config_test_path.write_text(config_tests.replace(marker, marker + addition, 1))

# GitLab operator docs make the Reviewer contract explicit.
en_path = root / 'docs/GITLAB_SETUP.md'
en = en_path.read_text().replace('Create Config Schema 1 (`"schemaVersion": 1`)', 'Create Config Schema 2 (`"schemaVersion": 2`)')
en_marker = '\n## Provider profiles\n'
if en.count(en_marker) != 1:
    raise SystemExit('docs/GITLAB_SETUP.md provider marker drifted')
en_section = """
## Review assignment trigger

Automatic MR review is gated by `review.triggerAssignment`:

- `reviewer` (**default**) matches the GitLab **Reviewer** list. This is the recommended code-review workflow.
- `assignee` matches the GitLab Assignee list.
- `either` accepts a match in Reviewer or Assignee.
- `always` disables assignment gating; `userIds` must be empty.

For `reviewer`, `assignee`, and `either`, an empty `userIds` list means any current member in the selected role is sufficient. When `userIds` is non-empty, at least one current member must match a configured GitLab numeric user ID. Adding a matching Reviewer to an already-open MR triggers review even when there is no new source commit. Removing a Reviewer does not trigger review, and unrelated MR metadata updates remain ignored.

The explicit `/codex review` Note command bypasses assignment gating by design; existing Project allowlist, caller identity/access checks, bot self-checks, and all review safety gates still apply. Config Schema 2 hard-removes `requiredAssigneeUserIds` and `manualReviewBypassAssignee`; old files fail closed instead of being silently translated.
"""
en_path.write_text(en.replace(en_marker, en_section + en_marker, 1))

zh_path = root / 'docs/GITLAB_SETUP.zh-CN.md'
zh = zh_path.read_text().replace('创建 Config Schema 1（`"schemaVersion": 1`）', '创建 Config Schema 2（`"schemaVersion": 2`）')
zh_marker = '\n## Provider Profile\n'
if zh.count(zh_marker) != 1:
    raise SystemExit('docs/GITLAB_SETUP.zh-CN.md provider marker drifted')
zh_section = """
## Review 指派触发

MR 自动 Review 由 `review.triggerAssignment` 统一控制：

- `reviewer`（**默认**）：匹配 GitLab **Reviewer / 评审人**，这是推荐的代码审查工作流。
- `assignee`：匹配 GitLab Assignee / 指派人。
- `either`：Reviewer 或 Assignee 任一匹配即可。
- `always`：关闭指派门禁；此模式下 `userIds` 必须为空。

在 `reviewer`、`assignee`、`either` 模式下，`userIds` 为空表示所选角色中只要存在任意当前用户即可；`userIds` 非空时，至少一个当前用户必须匹配配置中的 GitLab 数字 User ID。对于已经打开的 MR，后续只要新增一个匹配的 Reviewer，即使没有新的 source commit，也会立即触发 Review；移除 Reviewer 不会触发，标题等无关 MR 元数据更新也不会误触发。

显式 `/codex review` Note 命令按设计绕过指派门禁，但 Project allowlist、调用者身份/权限检查、Bot 自触发保护以及全部 Review 安全门禁仍然生效。Config Schema 2 已硬删除 `requiredAssigneeUserIds` 和 `manualReviewBypassAssignee`；旧配置直接 fail-closed，不做静默兼容转换。
"""
zh_path.write_text(zh.replace(zh_marker, zh_section + zh_marker, 1))

# Release notes.
changelog_path = root / 'CHANGELOG.md'
changelog = changelog_path.read_text()
heading = '# Changelog\n'
if not changelog.startswith(heading):
    raise SystemExit('CHANGELOG.md heading drifted')
release = """# Changelog

## 5.3.0 - 2026-08-28

### Reviewer-native GitLab trigger contract

- Hard-cut Config Schema 2 from the Assignee-only trigger fields to one typed `review.triggerAssignment` contract with `reviewer`, `assignee`, `either`, and `always` modes.
- Make GitLab Reviewer the default automatic-review role; empty `userIds` means any current Reviewer, while configured IDs restrict triggering to explicit GitLab users.
- Treat a matching Reviewer/Assignee assignment update on an already-open MR as a review trigger without requiring a source push; removals and unrelated metadata updates do not trigger.
- Keep `/codex review` as an explicit assignment-bypass command while preserving project, identity/access, self-trigger, evidence, publication, and safety gates.
- Remove `requiredAssigneeUserIds`, `manualReviewBypassAssignee`, and the Assignee-specific test surface with no compatibility translation or residual runtime path.
"""
changelog_path.write_text(release + changelog[len(heading):])

# Remove one-shot patch assets from the final branch.
(root / '.github/workflows/apply-reviewer-trigger-v5.3.0.yml').unlink()
Path(__file__).unlink()
