from pathlib import Path
import json

root=Path('.')
VERSION='6.0.0'

# Breaking Config Schema 2 is a major release, not a hidden v5 minor break.
for path in ['package.json','package-lock.json','product-contract.json']:
    p=root/path
    data=json.loads(p.read_text())
    if path=='package.json':
        data['version']=VERSION
    elif path=='package-lock.json':
        data['version']=VERSION
        data['packages']['']['version']=VERSION
    else:
        data['serviceVersion']=VERSION
        data['configSchemaVersion']=2
    p.write_text(json.dumps(data,indent=2)+'\n')

# Canonical compose tracks the release identity.
p=root/'deploy/docker/compose.yaml'
text=p.read_text().replace('codex-review-service:5.2.2','codex-review-service:6.0.0').replace('codex-review-service:5.3.0','codex-review-service:6.0.0')
p.write_text(text)

# Current-state docs: Config Schema 2 and Service 6.0.0.
current_docs=[
 'README.md','README.zh-CN.md','OPERATIONS.md','SECURITY.md','LONG_TERM_ASSET.md','SUPPORT.md','VERIFY_RELEASE.md',
 'docs/ARCHITECTURE.md','docs/DEPLOYMENT.md','docs/DEPLOYMENT.zh-CN.md','docs/GITLAB_SETUP.md','docs/GITLAB_SETUP.zh-CN.md',
 'docs/NOTIFICATIONS.md','docs/NOTIFICATIONS.zh-CN.md','docs/PRODUCT_CONTRACT.md','docs/QUALITY_PLATFORM.md','docs/QUALITY_PLATFORM.zh-CN.md',
 'docs/STORAGE_AND_MIGRATIONS.md','docs/TOKEN_EFFICIENCY.md','docs/TOKEN_EFFICIENCY.zh-CN.md','deploy/docker/README.md'
]
for path in current_docs:
    p=root/path
    if not p.exists(): continue
    text=p.read_text()
    text=text.replace('5.2.2','6.0.0').replace('5.3.0','6.0.0')
    text=text.replace('Config Schema 1','Config Schema 2').replace('Config Schema：**1**','Config Schema：**2**')
    text=text.replace('"schemaVersion": 1','"schemaVersion": 2').replace('schemaVersion: 1','schemaVersion: 2')
    text=text.replace('Service v5.3','Service v6.0').replace('Service v5.2','Service v6.0')
    p.write_text(text)

# Explicit operator migration/rollback boundary without runtime compatibility code.
ops=root/'OPERATIONS.md'
text=ops.read_text()
marker='## Release and rollback\n'
section='''## v6.0.0 Config Schema 2 hard cut\n\nService 6.0.0 is a breaking configuration release. Config Schema 1 is not accepted by the runtime. Before restarting 6.0.0, rewrite the configuration to `schemaVersion: 2` and replace the removed Assignee-only fields with `review.triggerAssignment`. To preserve the old automatic Assignee gate, use `{"mode":"assignee","userIds":[...]}`. The recommended new deployment uses `{"mode":"reviewer","userIds":[]}` or explicit Reviewer IDs. The manual `/codex review` command is always an explicit assignment-gate bypass in v6; there is no compatibility equivalent for the removed `manualReviewBypassAssignee: false`.\n\nRollback to v5 requires restoring a matching Config Schema 1 file before starting the v5 binary. There is intentionally no runtime Schema 1 parser, silent translation, dual-read path, or compatibility flag in v6.\n\n'''
if '## v6.0.0 Config Schema 2 hard cut' not in text:
    if marker in text:text=text.replace(marker,section+marker,1)
    else:text+='\n'+section
ops.write_text(text)

for path, heading in [('docs/DEPLOYMENT.md','## Configure Config Schema 2'),('docs/DEPLOYMENT.zh-CN.md','## 配置 Config Schema 2')]:
    p=root/path
    text=p.read_text()
    if 'v6.0.0 Config Schema 2' not in text:
        note=('''\n> **v6.0.0 Config Schema 2 breaking boundary:** v5 Config Schema 1 files must be rewritten before restart. The v6 runtime does not parse or translate Schema 1. Use `review.triggerAssignment` and choose `reviewer`, `assignee`, `either`, or `always`. Rollback to v5 requires restoring the matching Schema 1 file.\n\n''' if path.endswith('DEPLOYMENT.md') else '''\n> **v6.0.0 Config Schema 2 破坏性边界：** v5 的 Config Schema 1 配置必须在重启前人工改写。v6 运行时不会解析或转换 Schema 1。请使用 `review.triggerAssignment` 并明确选择 `reviewer`、`assignee`、`either` 或 `always`。回滚到 v5 前必须同时恢复匹配的 Schema 1 配置。\n\n''')
        idx=text.find(heading)
        if idx>=0:text=text[:idx]+note+text[idx:]
        else:text+=note
    p.write_text(text)

# Changelog entry becomes the correctly versioned major release.
p=root/'CHANGELOG.md'
text=p.read_text().replace('## 5.3.0 - 2026-08-28','## 6.0.0 - 2026-08-28',1)
text=text.replace('Hard-cut Config Schema 2 from the Assignee-only trigger fields','Hard-cut Config Schema 2 from the Assignee-only trigger fields',1)
p.write_text(text)

# Tests/fixtures follow the product contract rather than stale literals.
p=root/'test/admin.test.js'; text=p.read_text(); text=text.replace('schemaVersion:1,server:{dataDir}', 'schemaVersion:contract.configSchemaVersion,server:{dataDir}',1); p.write_text(text)
p=root/'test/config.test.js'; text=p.read_text(); text=text.replace('assert.equal(config.configSchemaVersion,1)', 'assert.equal(config.configSchemaVersion,CONFIG_SCHEMA_VERSION)',1); p.write_text(text)
p=root/'test/assignment-policy.test.js'; text=p.read_text();
text=text.replace("assignmentMatch({reviewers:[],assignees:[{id:8}]},config({triggerAssignment:{mode:'assignee',userIds:[8]}}))", "assignmentMatch({reviewers:[],assignees:[{id:8}]},{mode:'assignee',userIds:[8]})")
text=text.replace("assignmentMatch({reviewers:[{id:8}],assignees:[]},config({triggerAssignment:{mode:'either',userIds:[8]}}))", "assignmentMatch({reviewers:[{id:8}],assignees:[]},{mode:'either',userIds:[8]})")
text=text.replace("assignmentMatch({reviewers:[],assignees:[]},config({triggerAssignment:{mode:'always',userIds:[]}}))", "assignmentMatch({reviewers:[],assignees:[]},{mode:'always',userIds:[]})")
p.write_text(text)
p=root/'test/project-scope.test.js'; text=p.read_text(); text=text.replace("gitlabProjectAllowlist:scope,reviewDraftMergeRequests:false,maxQueueDepth:10,reviewDebounceMs:0", "gitlabProjectAllowlist:scope,reviewDraftMergeRequests:false,triggerAssignment:{mode:'always',userIds:[]},maxQueueDepth:10,reviewDebounceMs:0",1); p.write_text(text)
p=root/'test/runner.test.js'; text=p.read_text().replace("isolated runner reads Config Schema 1", "isolated runner reads Config Schema 2",1); p.write_text(text)

p=root/'test/docs-governance.test.js'; text=p.read_text()
text=text.replace("assert.match(text,/Config Schema[^\\n]{0,20}1/i);", "assert.match(text,new RegExp(`Config Schema[^\\n]{0,20}${contract.configSchemaVersion}`,'i'));",1)
text=text.replace("assert.match(text,/schemaVersion[^\\n]{0,20}1/);", "assert.match(text,new RegExp(`schemaVersion[^\\n]{0,20}${contract.configSchemaVersion}`));",1)
text=text.replace("for(const text of[operations,security,longTerm]){assert.match(text,/Config Schema 1/);", "for(const text of[operations,security,longTerm]){assert.match(text,new RegExp(`Config Schema ${contract.configSchemaVersion}`));",1)
text=text.replace("README files expose v5 deployable product entry", "README files expose v6 deployable product entry",1)
p.write_text(text)

# Family verification text reflects the service major.
p=root/'scripts/verify-family.js'; text=p.read_text().replace('compatibility profiles + Service v5 operations + exact Safe Core Family v4 boundary verified.', 'compatibility profiles + Service v6 operations + exact Safe Core Family v4 boundary verified.',1); p.write_text(text)

# No temporary finalizer in the feature commit.
Path(__file__).unlink()
