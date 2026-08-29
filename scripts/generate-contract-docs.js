'use strict';

const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const contract=require('../product-contract.json');
const core=require('../src/codex-safe-core/core-contract.json');
const START='<!-- BEGIN GENERATED PRODUCT CONTRACT -->';
const END='<!-- END GENERATED PRODUCT CONTRACT -->';

function contractLines(){return[
  `Service ${contract.serviceVersion}`,
  `DB Schema ${contract.databaseSchemaVersion}`,
  `Config Schema ${contract.configSchemaVersion}`,
  `Policy Schema ${contract.policySchemaVersion}`,
  `Review Receipt ${contract.reviewReceiptVersion}`,
  `Safe Contract ${contract.safeContractVersion}`,
  `Safe Core ${contract.safeCoreCommit}`,
  `Quality Platform ${core.qualityPlatformVersion}`,
  `Review Profile ${core.reviewProfileVersion}`,
  `Profile Pack ${core.profilePackVersion}`,
  `Impact Evidence ${core.impactEvidenceVersion}`,
  `Test Impact ${core.testImpactVersion}`,
  `Analyzer Finding ${core.analyzerFindingVersion}`,
  `Analyzer Adapter ${contract.analyzerAdapterVersion}`,
  `Native Node: 22 LTS >=${contract.minimumNodeVersion} OR 24 LTS >=${contract.canonicalNodeVersion}`,
  `Canonical Docker Node: ${contract.canonicalNodeVersion}`,
  `GitLab compatibility floor: ${contract.minimumGitLabVersion}`,
  `GitLab recommendation: ${contract.recommendedGitLabPolicy} release`
];}
function block(){return[START,'',`Codex Review Service **${contract.serviceVersion}** owns production operations and GitLab compatibility profiles while consuming the exact-pinned Safe Core quality/review platform. \`product-contract.json\` is the machine-checked product identity:`,'','```text',...contractLines(),'```','',END].join('\n');}
function readmeBlock(zh=false){const facts=zh?[
  `- Service：**${contract.serviceVersion}**`,`- Database Schema：**${contract.databaseSchemaVersion}**`,`- Config Schema：**${contract.configSchemaVersion}**`,`- Policy Schema：**${contract.policySchemaVersion}**`,`- Review Receipt：**${contract.reviewReceiptVersion}**`,`- Safe Contract：**${contract.safeContractVersion}**`,`- Safe Core：精确提交 \`${contract.safeCoreCommit}\``,`- Quality Platform：**${core.qualityPlatformVersion}**`,`- Review Profile：**${core.reviewProfileVersion}**`,`- Profile Pack：**${core.profilePackVersion}**`,`- Impact Evidence：**${core.impactEvidenceVersion}**`,`- Test Impact：**${core.testImpactVersion}**`,`- Analyzer Finding：**${core.analyzerFindingVersion}**`,`- Analyzer Adapter：**${contract.analyzerAdapterVersion}**`,`- Native/systemd Node.js：**Node 22 LTS >=${contract.minimumNodeVersion}，或 Node 24 LTS >=${contract.canonicalNodeVersion}**；明确不支持 Node 23`,`- 官方 Docker runtime：**Node ${contract.canonicalNodeVersion}**`,`- GitLab Self-Managed 兼容下限：**${contract.minimumGitLabVersion}**`,'- GitLab 推荐策略：生产环境应运行 **GitLab 官方仍支持的版本**，兼容下限不代表建议长期停留在旧版本'
]:[
  `- Service: **${contract.serviceVersion}**`,`- Database Schema: **${contract.databaseSchemaVersion}**`,`- Config Schema: **${contract.configSchemaVersion}**`,`- Policy Schema: **${contract.policySchemaVersion}**`,`- Review Receipt: **${contract.reviewReceiptVersion}**`,`- Safe Contract: **${contract.safeContractVersion}**`,`- Safe Core: exact commit \`${contract.safeCoreCommit}\``,`- Quality Platform: **${core.qualityPlatformVersion}**`,`- Review Profile: **${core.reviewProfileVersion}**`,`- Profile Pack: **${core.profilePackVersion}**`,`- Impact Evidence: **${core.impactEvidenceVersion}**`,`- Test Impact: **${core.testImpactVersion}**`,`- Analyzer Finding: **${core.analyzerFindingVersion}**`,`- Analyzer Adapter: **${contract.analyzerAdapterVersion}**`,`- Native/systemd Node.js: **22 LTS >=${contract.minimumNodeVersion}, or 24 LTS >=${contract.canonicalNodeVersion}**; Node 23 is intentionally unsupported`,`- Canonical Docker runtime: **Node ${contract.canonicalNodeVersion}**`,`- GitLab Self-Managed compatibility floor: **${contract.minimumGitLabVersion}**`,'- GitLab recommendation: run a **vendor-supported GitLab release**; the compatibility floor is not a recommendation to stay on an old release'
];return[START,'',zh?'`product-contract.json` 是唯一机器校验的当前产品身份：':'`product-contract.json` is the single machine-checked source for the current product identity:','',...facts,'',END].join('\n');}
function replaceGenerated(text,replacement=block()){const start=text.indexOf(START),end=text.indexOf(END);if(start<0||end<start)throw new Error('Generated product-contract markers are missing');return text.slice(0,start)+replacement+text.slice(end+END.length);}
function ensureReadmeBlock(text,{zh=false}={}){let out=text;if(out.includes(START)&&out.includes(END))out=replaceGenerated(out,readmeBlock(zh));else{const heading=zh?'## 产品契约':'## Product contract';const boundary=zh?'\nGitLab 兼容通过':'\nGitLab compatibility';const start=out.indexOf(heading),end=out.indexOf(boundary,start);if(start<0||end<start)throw new Error(`Unable to locate ${heading} identity section`);out=out.slice(0,start+heading.length)+'\n\n'+readmeBlock(zh)+'\n'+out.slice(end);}out=zh?out.replace(/当前正式产品基线为 \*\*v\d+\.\d+\.\d+\*\*：/,'当前产品身份由下方机器生成契约区块定义：').replace(/codex-review-service-\d+\.\d+\.\d+\.tgz/g,`codex-review-service-${contract.serviceVersion}.tgz`).replace(/Service v\d+\.\d+ 不改变共享 Review 协议/g,`Service v${contract.serviceVersion.split('.').slice(0,2).join('.')} 不改变共享 Review 协议`).replace(/Schema \d+ verification pass/g,`Schema ${contract.databaseSchemaVersion} verification pass`):out.replace(/Service \*\*v\d+\.\d+\.\d+\*\* is the current compatibility\/operations baseline:/,'The current product identity is defined by the machine-generated contract block below:').replace(/codex-review-service-\d+\.\d+\.\d+\.tgz/g,`codex-review-service-${contract.serviceVersion}.tgz`).replace(/Service v\d+\.\d+ does not change the shared review protocol/g,`Service v${contract.serviceVersion.split('.').slice(0,2).join('.')} does not change the shared review protocol`).replace(/Schema \d+ verification pass/g,`Schema ${contract.databaseSchemaVersion} verification pass`);return out;}
function productContractDoc(){return `# Product Contract\n\nThis file is generated from \`product-contract.json\` and the exact Safe Core contract. Do not hand-edit version facts.\n\n${block()}\n`;}
function main(){const architecturePath=path.join(root,'docs','ARCHITECTURE.md');fs.writeFileSync(architecturePath,replaceGenerated(fs.readFileSync(architecturePath,'utf8')));fs.writeFileSync(path.join(root,'docs','PRODUCT_CONTRACT.md'),productContractDoc());const readme=path.join(root,'README.md'),readmeZh=path.join(root,'README.zh-CN.md');fs.writeFileSync(readme,ensureReadmeBlock(fs.readFileSync(readme,'utf8')));fs.writeFileSync(readmeZh,ensureReadmeBlock(fs.readFileSync(readmeZh,'utf8'),{zh:true}));}
if(require.main===module)main();
module.exports={START,END,contractLines,block,readmeBlock,replaceGenerated,ensureReadmeBlock,productContractDoc};
