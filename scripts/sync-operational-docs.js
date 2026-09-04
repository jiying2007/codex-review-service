'use strict';

const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const contract=require('../product-contract.json');

function replaceRequired(text,pattern,replacement,label){if(!pattern.test(text))throw new Error(`Missing operational-doc anchor: ${label}`);return text.replace(pattern,replacement);}
function routingFields(indent='    '){return[
  `${indent}"selectionStrategy": "auto",`,
  `${indent}"fixedModel": "",`,
  `${indent}"candidates": [],`,
  `${indent}"compatibilityPolicy": "strict",`,
  `${indent}"scoutEnabled": false,`,
  `${indent}"adjudicatorEnabled": false,`,
  `${indent}"adjudicatorMinSeverity": "high",`,
  `${indent}"shadowCandidate": "",`
].join('\n');}
function syncDeployment(text,{zh=false}={}){
  let out=text;
  out=out.replace(/Codex Review Service \d+\.\d+\.\d+/g,`Codex Review Service ${contract.serviceVersion}`);
  out=out.replace(/\*\*Config Schema \d+\*\*/g,`**Config Schema ${contract.configSchemaVersion}**`);
  out=out.replace(/"schemaVersion": \d+/g,`"schemaVersion": ${contract.configSchemaVersion}`);
  out=out.replace(/## Config Schema \d+ Provider Contract boundary/g,`## Config Schema ${contract.configSchemaVersion} + Model Routing Contract v${contract.modelRoutingContractVersion} boundary`);
  out=out.replace(/## Config Schema \d+ Provider Contract 边界/g,`## Config Schema ${contract.configSchemaVersion} + Model Routing Contract v${contract.modelRoutingContractVersion} 边界`);
  if(!out.includes('"selectionStrategy": "auto"'))out=replaceRequired(out,/(  "codex": \{\n)(\s+"providerMode": "auto")/,`$1${routingFields()}\n$2`,'deployment codex block');
  out=out.replace(/Secrets do not belong in Config Schema \d+ JSON/g,`Secrets do not belong in Config Schema ${contract.configSchemaVersion} JSON`);
  out=out.replace(/Secret 不应进入 Config Schema \d+ JSON/g,`Secret 不应进入 Config Schema ${contract.configSchemaVersion} JSON`);
  out=out.replace(/Rewrite Config Schema \d+/g,`Rewrite Config Schema ${contract.configSchemaVersion}`);
  out=out.replace(/重写 Config Schema \d+/g,`重写 Config Schema ${contract.configSchemaVersion}`);
  out=out.replace(/Service \d+\.\d+\.\d+ keeps the current Config Schema \d+ and Runtime\/Provider Contract v3[^.]*\./g,`Service ${contract.serviceVersion} uses Config Schema ${contract.configSchemaVersion}, Runtime/Provider Contract v3 and Model Routing Contract v${contract.modelRoutingContractVersion}; legacy \`codex.model\`/\`codex.fastModel\` are rejected rather than translated.`);
  out=out.replace(/Service \d+\.\d+\.\d+ 保持当前 Config Schema \d+[^。]*。/g,`Service ${contract.serviceVersion} 使用 Config Schema ${contract.configSchemaVersion}、Runtime/Provider Contract v3 与 Model Routing Contract v${contract.modelRoutingContractVersion}；旧 \`codex.model\`/\`codex.fastModel\` 不做兼容翻译。`);
  const runnerNote=zh?'Isolated Runner 不拥有默认模型；Controller 的 Model Router 每次通过 `/review` 请求传入 resolved model。':'The isolated Runner owns no default model; the Controller Model Router passes the resolved model on each `/review` request.';
  if(!out.includes(runnerNote)){const anchor=zh?'### Isolated Runner':'### Isolated Runner';const index=out.indexOf(anchor);if(index>=0){const lineEnd=out.indexOf('\n',index);out=out.slice(0,lineEnd+1)+'\n'+runnerNote+'\n'+out.slice(lineEnd+1);}}
  return out;
}
function syncOperations(text){
  let out=text;
  out=out.replace(/Codex Review Service \*\*\d+\.\d+\.\d+\*\* is the current production-operations baseline/,`Codex Review Service **${contract.serviceVersion}** is the current production-operations baseline`);
  out=out.replace(/^- Config Schema \d+$/m,`- Config Schema ${contract.configSchemaVersion}`);
  out=out.replace(/\/etc\/codex-review\/config\.json\s+Config Schema \d+, non-secret/,`/etc/codex-review/config.json        Config Schema ${contract.configSchemaVersion}, non-secret`);
  out=out.replace(/Config Schema \d+ remains the current boundary\. Service \d+\.\d+\.\d+[^.]*\./,`Config Schema ${contract.configSchemaVersion} is the current boundary. Service ${contract.serviceVersion} consumes Runtime/Provider Contract v3 and Model Routing Contract v${contract.modelRoutingContractVersion}; legacy \`codex.model\`/\`codex.fastModel\` are rejected rather than translated.`);
  out=out.replace(/Create Config Schema \d+/g,`Create Config Schema ${contract.configSchemaVersion}`);
  out=out.replace(/Service \d+\.\d+\.\d+ keeps Config Schema \d+ and Database Schema 8 while consuming Runtime\/Provider Contract v3;[^.]*\./,`Service ${contract.serviceVersion} uses Config Schema ${contract.configSchemaVersion} and Database Schema ${contract.databaseSchemaVersion} while consuming Runtime/Provider Contract v3 and Model Routing Contract v${contract.modelRoutingContractVersion}; the hard cut retires \`codex.model\`/\`codex.fastModel\`.`);
  out=out.replace(/rewrite Config Schema \d+/g,`rewrite Config Schema ${contract.configSchemaVersion}`);
  if(!out.includes(`- Model Routing Contract ${contract.modelRoutingContractVersion}`))out=out.replace(/(- Config Schema \d+\n)/,`$1- Model Routing Contract ${contract.modelRoutingContractVersion}\n`);
  return out;
}
function syncCompose(text){return text.replace(/(ghcr\.io\/jiying2007\/codex-review-service:)\d+\.\d+\.\d+/g,`$1${contract.serviceVersion}`);}
function main(){const files=[['docs/DEPLOYMENT.md',text=>syncDeployment(text)],['docs/DEPLOYMENT.zh-CN.md',text=>syncDeployment(text,{zh:true})],['OPERATIONS.md',syncOperations],['deploy/docker/compose.yaml',syncCompose]];for(const[file,fn]of files){const target=path.join(root,file);fs.writeFileSync(target,fn(fs.readFileSync(target,'utf8')));}}
if(require.main===module)main();
module.exports={routingFields,syncDeployment,syncOperations,syncCompose};
