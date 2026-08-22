'use strict';

const crypto=require('node:crypto');
function sha(value){return crypto.createHash('sha256').update(String(value)).digest('hex');}
function firstAnchor(file){if(!file||file.skipped)return null;const side=file.changedLines?.new?.length?'new':file.changedLines?.old?.length?'old':null;if(!side)return null;const line=file.changedLines[side][0],text=file.changedLines.anchors?.[side]?.[line]||`${file.path}:${side}:${line}`;return{side,line,anchorHash:sha(`${file.path}\n${side}\n${text}`)};}
function startsWithAny(path,prefixes){return(prefixes||[]).some(prefix=>String(path).startsWith(prefix));}
function finding(file,severity,category,title,description){const anchor=firstAnchor(file);if(!anchor)return null;return{severity,category,file:file.path,side:anchor.side,line:anchor.line,endLine:anchor.line,title,description,suggestion:'',confidence:1,anchorHash:anchor.anchorHash,fingerprint:sha(`${category}\n${anchor.anchorHash}\n${title}`)};}
function runDeterministicAnalyzers(snapshot,policy){const findings=[];const reviewed=snapshot.files.filter(file=>!file.skipped);for(const file of reviewed){if(startsWithAny(file.path,policy.forbiddenPathPrefixes)){const item=finding(file,'high','correctness','Forbidden path changed',`Target-branch review policy forbids changes under ${policy.forbiddenPathPrefixes.find(prefix=>file.path.startsWith(prefix))}.`);if(item)findings.push(item);}}
  if(policy.requireTestsForCodeChanges){const code=reviewed.filter(file=>startsWithAny(file.path,policy.codePathPrefixes)&&!startsWithAny(file.path,policy.testPathPrefixes)),hasTests=reviewed.some(file=>startsWithAny(file.path,policy.testPathPrefixes));if(code.length&&!hasTests){const item=finding(code[0],'medium','test','Code changed without test changes','Target-branch policy requires a matching test change when configured code paths change.');if(item)findings.push(item);}}
  return{summary:'',findings,rejected:0,filtered:0,modelFindingCount:0,deterministicFindingCount:findings.length};
}
module.exports={runDeterministicAnalyzers,firstAnchor,startsWithAny};
