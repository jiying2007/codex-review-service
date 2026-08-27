'use strict';

const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const contract=require('../product-contract.json');
const core=require('../src/codex-safe-core/core-contract.json');
const START='<!-- BEGIN GENERATED PRODUCT CONTRACT -->';
const END='<!-- END GENERATED PRODUCT CONTRACT -->';

function block(){return [
  START,
  '',
  `Codex Review Service **${contract.serviceVersion}** owns production operations and GitLab compatibility profiles while consuming the exact-pinned Safe Core quality/review platform. \`product-contract.json\` is the machine-checked product identity:`,
  '',
  '```text',
  `Service ${contract.serviceVersion}`,
  `DB Schema ${contract.databaseSchemaVersion}`,
  `Config Schema ${contract.configSchemaVersion}`,
  `Policy Schema ${contract.policySchemaVersion}`,
  `Review Receipt ${contract.reviewReceiptVersion}`,
  `Safe Contract ${contract.safeContractVersion}`,
  `Safe Core ${contract.safeCoreCommit}`,
  `Quality Platform ${core.qualityPlatformVersion}`,
  `Review Profile ${core.reviewProfileVersion}`,
  `Impact Evidence ${core.impactEvidenceVersion}`,
  `Analyzer Finding ${core.analyzerFindingVersion}`,
  `Native Node: 22 LTS >=${contract.minimumNodeVersion} OR 24 LTS >=${contract.canonicalNodeVersion}`,
  `Canonical Docker Node: ${contract.canonicalNodeVersion}`,
  `GitLab compatibility floor: ${contract.minimumGitLabVersion}`,
  `GitLab recommendation: ${contract.recommendedGitLabPolicy} release`,
  '```',
  '',
  END
].join('\n');}
function replaceGenerated(text){const start=text.indexOf(START),end=text.indexOf(END);if(start<0||end<start)throw new Error('Generated product-contract markers are missing from docs/ARCHITECTURE.md');return text.slice(0,start)+block()+text.slice(end+END.length);}
function productContractDoc(){return `# Product Contract\n\nThis file is generated from \`product-contract.json\` and the exact Safe Core contract. Do not hand-edit version facts.\n\n${block()}\n`;}
function main(){const architecturePath=path.join(root,'docs','ARCHITECTURE.md');fs.writeFileSync(architecturePath,replaceGenerated(fs.readFileSync(architecturePath,'utf8')));fs.writeFileSync(path.join(root,'docs','PRODUCT_CONTRACT.md'),productContractDoc());}
if(require.main===module)main();
module.exports={START,END,block,replaceGenerated,productContractDoc};
