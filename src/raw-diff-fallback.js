'use strict';

const MAX_TEXT_BYTES=256*1024;
const MAX_LINES=4096;
const MAX_CELLS=16*1024*1024;

function bytes(value){return Buffer.byteLength(String(value||''),'utf8');}
function textLines(value){const lines=String(value).split('\n');if(lines.length&&lines.at(-1)==='')lines.pop();return lines;}
function textSafe(value){return typeof value==='string'&&!value.includes('\0')&&!value.includes('\uFFFD');}
function safePath(value){const path=String(value||'');return Boolean(path)&&!path.startsWith('/')&&!path.split('/').some(part=>part===''||part==='.'||part==='..')&&!/[\0\r\n]/.test(path);}
function sha(value){return /^[0-9a-f]{40}$/i.test(String(value||''));}

function editScript(oldLines,newLines){const n=oldLines.length,m=newLines.length,cells=(n+1)*(m+1);if(n>MAX_LINES||m>MAX_LINES||cells>MAX_CELLS)return null;const direction=new Uint8Array(cells),width=m+1;let next=new Uint32Array(width),current=new Uint32Array(width);for(let i=n-1;i>=0;i-=1){for(let j=m-1;j>=0;j-=1){const index=i*width+j;if(oldLines[i]===newLines[j]){current[j]=next[j+1]+1;direction[index]=0;}else if(next[j]>=current[j+1]){current[j]=next[j];direction[index]=1;}else{current[j]=current[j+1];direction[index]=2;}}[current,next]=[next,current];current.fill(0);}const out=[];let i=0,j=0,oldLine=1,newLine=1;while(i<n||j<m){if(i<n&&j<m&&direction[i*width+j]===0){out.push({kind:' ',text:oldLines[i],oldLine,newLine});i+=1;j+=1;oldLine+=1;newLine+=1;continue;}if(i<n&&(j===m||direction[i*width+j]===1)){out.push({kind:'-',text:oldLines[i],oldLine,newLine});i+=1;oldLine+=1;continue;}out.push({kind:'+',text:newLines[j],oldLine,newLine});j+=1;newLine+=1;}return out;}

function hunkText(edits){const changed=[];for(let i=0;i<edits.length;i+=1)if(edits[i].kind!==' ')changed.push(i);if(!changed.length)return'';const groups=[];for(const index of changed){const start=Math.max(0,index-3),end=Math.min(edits.length,index+4),last=groups.at(-1);if(last&&start<=last.end+1)last.end=Math.max(last.end,end);else groups.push({start,end});}return groups.map(group=>{const values=edits.slice(group.start,group.end),first=values[0],oldCount=values.filter(item=>item.kind!=='+' ).length,newCount=values.filter(item=>item.kind!=='-').length,oldStart=first.oldLine,newStart=first.newLine,header=`@@ -${oldStart}${oldCount===1?'':`,`+oldCount} +${newStart}${newCount===1?'':`,`+newCount} @@`;return [header,...values.map(item=>item.kind+item.text)].join('\n');}).join('\n');}

function createRawTextDiff({oldText,newText,maxDiffBytes}){if(!textSafe(oldText)||!textSafe(newText))return{status:'not_text'};const oldBytes=bytes(oldText),newBytes=bytes(newText);if(oldBytes>MAX_TEXT_BYTES||newBytes>MAX_TEXT_BYTES||oldBytes+newBytes>MAX_TEXT_BYTES*2)return{status:'source_too_large',oldBytes,newBytes};if(oldText===newText)return{status:'no_hunks',oldBytes,newBytes};const edits=editScript(textLines(oldText),textLines(newText));if(!edits)return{status:'generation_failed',oldBytes,newBytes};const diffText=hunkText(edits),diffBytes=bytes(diffText);if(!diffText)return{status:'no_hunks',oldBytes,newBytes};if(diffBytes>Number(maxDiffBytes||0))return{status:'diff_too_large',oldBytes,newBytes,diffBytes};return{status:'available',oldBytes,newBytes,diffBytes,diffText};}

module.exports=Object.freeze({MAX_TEXT_BYTES,MAX_LINES,MAX_CELLS,bytes,textSafe,safePath,sha,createRawTextDiff});
