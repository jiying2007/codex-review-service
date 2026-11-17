#!/usr/bin/env node
'use strict';
// Offline-only MR preview from a bounded JSON fixture on stdin.
// Does not connect to GitLab, send webhooks or call any review model.
const {buildSnapshot,formatReviewPreview}=require('../src/review');
const MAX_INPUT_BYTES=8*1024*1024;
function previewFromDocument(document){
 if(!document||typeof document!=='object'||Array.isArray(document)||
    !document.mr||!document.diffResult||!document.policy)
   throw new Error('Expected {mr,diffResult,policy} JSON');
 if(!Array.isArray(document.diffResult.items)||typeof document.diffResult.complete!=='boolean')
   throw new Error('Invalid GitLab Diff fixture');
 const snapshot=buildSnapshot(document.mr,document.diffResult,document.policy);
 return formatReviewPreview(snapshot);
}
async function main(){
 if(process.argv.length!==2)throw new Error('Usage: node scripts/review-preview.js < review-fixture.json');
 let bytes=0,parts=[];
 for await(const chunk of process.stdin){
   const next=Buffer.from(chunk);bytes+=next.length;
   if(bytes>MAX_INPUT_BYTES)throw new Error('Review preview input exceeds 8 MiB');
   parts.push(next);
 }
 const document=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts,bytes)));
 process.stdout.write(previewFromDocument(document)+'\n');
}
if(require.main===module)main().catch(error=>{
 console.error('Review preview failed: '+String(error?.code||'EINPUT'));
 process.exitCode=2;
});
module.exports={previewFromDocument};
