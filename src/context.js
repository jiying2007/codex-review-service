'use strict';

function lineWindow(text, lines, radius) {
  const rows=String(text||'').split(/\r?\n/); if(!rows.length||!lines?.length)return'';
  const ranges=[]; for(const line of lines){const start=Math.max(1,line-radius),end=Math.min(rows.length,line+radius);const last=ranges.at(-1);if(last&&start<=last[1]+1)last[1]=Math.max(last[1],end);else ranges.push([start,end]);}
  return ranges.map(([start,end])=>{const body=rows.slice(start-1,end).map((value,index)=>`${start+index}: ${value}`).join('\n');return `@@ context ${start}-${end} @@\n${body}`;}).join('\n');
}

async function buildReviewContext(gitlab,mr,chunk,config){
  if(!config.contextEnabled||!config.maxContextBytes||!config.maxContextFiles)return{blocks:[],bytes:0,complete:true};
  const blocks=[];let bytes=0,complete=true,files=0;
  const sourceProjectId=Number(mr.source_project_id||mr.project_id),targetProjectId=Number(mr.target_project_id||mr.project_id);
  const headSha=String(mr.diff_refs?.head_sha||mr.sha||''),startSha=String(mr.diff_refs?.start_sha||'');
  for(const file of chunk.files){
    if(files>=config.maxContextFiles)break;
    const sides=[];
    if(!file.deleted_file&&sourceProjectId&&headSha&&file.new_path)sides.push({label:'SOURCE_HEAD',projectId:sourceProjectId,path:file.new_path,ref:headSha,lines:file.changedLines?.new||[]});
    if(!file.new_file&&targetProjectId&&startSha&&file.old_path)sides.push({label:'TARGET_START',projectId:targetProjectId,path:file.old_path,ref:startSha,lines:file.changedLines?.old||[]});
    for(const side of sides){
      if(!side.lines.length)continue;
      let raw;try{raw=await gitlab.getRepositoryFileRaw(side.projectId,side.path,side.ref);}catch{complete=false;continue;}
      if(raw===null){complete=false;continue;}
      const window=lineWindow(raw,side.lines,config.contextLines);if(!window)continue;
      const block=`--- ${side.label}: ${side.path} @ ${side.ref.slice(0,12)} ---\n${window}`;
      const size=Buffer.byteLength(block,'utf8');
      if(bytes+size>config.maxContextBytes){complete=false;return{blocks,bytes,complete,reason:'context_budget'};}
      blocks.push(block);bytes+=size;files+=1;if(files>=config.maxContextFiles)break;
    }
  }
  return{blocks,bytes,complete};
}

module.exports={buildReviewContext,lineWindow};
