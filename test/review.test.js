'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const{buildSnapshot,buildPrompt,outputSchema,validateChunkResult,consolidateReviews,parseChangedLines,metadataOnlyDiff,formatSummary,formatReviewPreview,conservativeClaimAudit}=require('../src/review');
const policy={language:'en',maxDiffBytes:100,maxReviewChunks:2,maxFindings:10,maxPublishedFindings:10,minConfidence:0.7,severityThreshold:'info',blockingSeverity:'high',extraInstructions:'',skipGeneratedFiles:true,blockUnreviewableFiles:false};
const mr={iid:1,project_id:7,source_project_id:7,target_project_id:7,source_branch:'feat',target_branch:'main',diff_refs:{base_sha:'b',start_sha:'s',head_sha:'h'}};

test('tracks added/removed lines and stable source anchors',()=>{const changed=parseChangedLines('@@ -10,2 +10,2 @@ fn\n-old\n+new\n same');assert.deepEqual(changed.new,[10]);assert.deepEqual(changed.old,[10]);assert.match(changed.anchors.new[10],/fn\|new/);assert.match(changed.anchors.old[10],/fn\|old/);});
test('structured review schema requires every finding property and represents unknown semantic identity explicitly',()=>{const item=outputSchema(10).properties.findings.items;assert.deepEqual([...item.required].sort(),Object.keys(item.properties).sort());assert.equal(item.properties.rootCauseKey.pattern,'^(?:|[a-z][a-z0-9_]{2,95})$');assert.equal(item.properties.claimClass.pattern,'^(?:|[a-z][a-z0-9_]{2,95})$');const prompt=buildPrompt({...mr,title:'x',description:'',chunks:[{index:0,files:[]}]},{index:0,files:[],diffText:''},{...policy,language:'en'});assert.match(prompt,/empty strings/i);});
test('GitLab hunk-only diff is adapted to a canonical Core chunk with the original path',()=>{const snapshot=buildSnapshot(mr,{complete:true,items:[{old_path:'src/a.js',new_path:'src/a.js',diff:'@@ -1 +1 @@\n-old\n+new'}]},{...policy,maxDiffBytes:4096,maxReviewChunks:8});assert.equal(snapshot.coverageComplete,true);assert.equal(snapshot.chunks.length,1);assert.deepEqual(snapshot.chunks[0].files.map(f=>f.path),['src/a.js']);assert.match(snapshot.chunks[0].diffText,/^diff --git "a\/src\/a\.js" "b\/src\/a\.js"/m);assert.match(snapshot.chunks[0].diffText,/@@ -1 \+1 @@/);});
test('known binary is advisory by default instead of false coverage failure',()=>{const snapshot=buildSnapshot(mr,{complete:true,items:[{old_path:'a.js',new_path:'a.js',diff:'@@ -1 +1 @@\n-a\n+b'},{old_path:'image.png',new_path:'image.png',diff:''}]},policy);assert.equal(snapshot.chunks.length,1);assert.equal(snapshot.coverageComplete,true);assert.equal(snapshot.files.find(f=>f.path==='image.png').coverageState,'unreviewable');assert.deepEqual(snapshot.advisories,['image.png:binary_file']);});
test('unknown unavailable diff still fails closed',()=>{const snapshot=buildSnapshot(mr,{complete:true,items:[{old_path:'data.unknown',new_path:'data.unknown',diff:''}]},policy);assert.equal(snapshot.coverageComplete,false);assert.match(snapshot.coverageGaps[0],/unavailable_unknown/);});
test('metadata-only rename does not create a false block',()=>{const diff='similarity index 100%\nrename from a.js\nrename to b.js';assert.equal(metadataOnlyDiff(diff),true);const snapshot=buildSnapshot(mr,{complete:true,items:[{old_path:'a.js',new_path:'b.js',renamed_file:true,diff}]},policy);assert.equal(snapshot.coverageComplete,true);assert.equal(snapshot.files[0].coverageState,'metadata_only');});
test('generated file can be policy-excluded without reducing provider coverage',()=>{const snapshot=buildSnapshot(mr,{complete:true,items:[{old_path:'gen.js',new_path:'gen.js',generated_file:true,diff:'@@ -1 +1 @@\n-a\n+b'}]},policy);assert.equal(snapshot.coverageComplete,true);assert.equal(snapshot.files[0].coverageState,'policy_excluded');});
test('findings require exact changed line and use code anchor identity',()=>{const snapshot=buildSnapshot(mr,{complete:true,items:[{old_path:'a.js',new_path:'a.js',diff:'@@ -10 +10 @@ risky\n-danger()\n+safe()'}]},{...policy,maxDiffBytes:4096});const accepted=validateChunkResult({summary:'s',findings:[{severity:'high',category:'correctness',file:'a.js',side:'old',line:10,endLine:10,title:'Removed guard',description:'A guard was removed.',suggestion:'Restore it.',confidence:0.9}]},snapshot.chunks[0],policy);assert.equal(accepted.findings.length,1);assert.match(accepted.findings[0].anchorHash,/^[0-9a-f]{64}$/);assert.match(accepted.findings[0].fingerprint,/^[0-9a-f]{64}$/);const rejected=validateChunkResult({summary:'s',findings:[{severity:'high',category:'correctness',file:'a.js',side:'old',line:11,endLine:11,title:'Wrong line',description:'x',suggestion:'',confidence:0.9}]},snapshot.chunks[0],policy);assert.equal(rejected.findings.length,0);assert.equal(rejected.rejected,1);});
test('same anchored semantic claim keeps fingerprint when prose changes',()=>{const snapshot=buildSnapshot(mr,{complete:true,items:[{old_path:'a.js',new_path:'a.js',diff:'@@ -1 +1 @@ fn\n-old\n+new'}]},{...policy,maxDiffBytes:4096}),chunk=snapshot.chunks[0],base={severity:'high',category:'correctness',file:'a.js',side:'new',line:1,endLine:1,rootCauseKey:'state_transition_regression',claimClass:'state_machine_correctness',description:'d',suggestion:'',confidence:0.9};const a=validateChunkResult({summary:'',findings:[{...base,title:'Potential regression'}]},chunk,policy).findings[0],b=validateChunkResult({summary:'',findings:[{...base,title:'Regression possible'}]},chunk,policy).findings[0];assert.equal(a.claimState,'known');assert.equal(a.fingerprint,b.fingerprint);});
test('unknown semantic claims use required empty identity fields and never authorize prose-based reuse',()=>{const snapshot=buildSnapshot(mr,{complete:true,items:[{old_path:'a.js',new_path:'a.js',diff:'@@ -1 +1 @@ fn\n-old\n+new'}]},{...policy,maxDiffBytes:4096}),chunk=snapshot.chunks[0],base={severity:'high',category:'correctness',file:'a.js',side:'new',line:1,endLine:1,rootCauseKey:'',claimClass:'',description:'d',suggestion:'',confidence:0.9},a=validateChunkResult({summary:'',findings:[{...base,title:'Potential regression'}]},chunk,policy).findings[0],b=validateChunkResult({summary:'',findings:[{...base,title:'Different claim'}]},chunk,policy).findings[0];assert.equal(a.claimState,'unknown');assert.notEqual(a.fingerprint,b.fingerprint);});
test('structurally rejected model finding makes review incomplete',()=>{const snapshot=buildSnapshot(mr,{complete:true,items:[{old_path:'a.js',new_path:'a.js',diff:'@@ -1 +1 @@\n-a\n+b'}]},{...policy,maxDiffBytes:4096});assert.equal(consolidateReviews(snapshot,[{summary:'s',findings:[],rejected:1,filtered:0,modelFindingCount:1}],policy).verdict,'incomplete');});
test('MAX_FINDINGS is a global retained-output cap without weakening blocking gate',()=>{const snapshot={coverageComplete:true,advisories:[],files:[]},findings=Array.from({length:6},(_,index)=>({severity:index===5?'high':'low',category:'correctness',file:`f${index}.js`,side:'new',line:1,endLine:1,title:`Issue ${index}`,description:'x',suggestion:'',confidence:0.9,fingerprint:`fp-${index}`}));const result=consolidateReviews(snapshot,[{summary:'a',findings:findings.slice(0,3),rejected:0,filtered:0,modelFindingCount:3},{summary:'b',findings:findings.slice(3),rejected:0,filtered:0,modelFindingCount:3}],{...policy,maxFindings:3,forbiddenPathPrefixes:[],requireTestsForCodeChanges:false});assert.equal(result.allFindings.length,3);assert.equal(result.truncatedFindingCount,3);assert.equal(result.verdict,'block');});

test('summary localizes review time while retaining the canonical UTC receipt time',()=>{const previous=process.env.CODEX_SAFE_DISPLAY_TIME_ZONE;process.env.CODEX_SAFE_DISPLAY_TIME_ZONE='Asia/Shanghai';try{const snapshot={headSha:'a'.repeat(40),files:[],coverageGaps:[],advisories:[]},review={verdict:'pass',findings:[],summary:'ok'},text=formatSummary(review,snapshot,{language:'en',source:'test',fingerprint:'f'.repeat(64)},'2026-08-30T13:00:00.000Z');assert.match(text,/\*\*Review time:\*\* 2026-08-30 21:00:00 UTC\+08:00 \(UTC: 2026-08-30T13:00:00\.000Z\)/);}finally{if(previous===undefined)delete process.env.CODEX_SAFE_DISPLAY_TIME_ZONE;else process.env.CODEX_SAFE_DISPLAY_TIME_ZONE=previous;}});


test('chunk-specific anchors reject changed lines not present in the actual evidence chunk',()=>{
 const line='x'.repeat(1700),diff='@@ -1 +1 @@\n-'+line+'\n+'+line+'A'+
   '\n@@ -100 +100 @@\n-'+line+'\n+'+line+'B';
 const snapshot=buildSnapshot(mr,{complete:true,items:[{
   old_path:'src/split.c',new_path:'src/split.c',diff
 }]},{...policy,maxDiffBytes:4096,maxReviewChunks:8});
 assert.equal(snapshot.coverageComplete,true,JSON.stringify(snapshot.coverageGaps));
 assert.equal(snapshot.chunks.length,2);
 assert.deepEqual(snapshot.chunks[0].files[0].changedLines.new,[1]);
 assert.deepEqual(snapshot.chunks[1].files[0].changedLines.new,[100]);
 const finding={severity:'high',category:'correctness',file:'src/split.c',
   side:'new',line:100,endLine:100,title:'Concern',description:'d',
   suggestion:'',confidence:0.95,rootCauseKey:'',claimClass:''};
 const wrong=validateChunkResult({findings:[finding]},snapshot.chunks[0],policy);
 const right=validateChunkResult({findings:[finding]},snapshot.chunks[1],policy);
 assert.equal(wrong.findings.length,0);
 assert.equal(wrong.rejected,1);
 assert.equal(right.findings.length,1);
 assert.equal(snapshot.coverageLedger.unscheduledChangedLines,0);
 assert.equal(snapshot.coverageLedger.scheduledChangedLines,4);
});

test('increment and decrement code lines beginning +++/--- remain valid changed lines',()=>{
 const diff='@@ -4 +4 @@\n---counter\n+++counter';
 const changed=parseChangedLines(diff);
 assert.deepEqual(changed.old,[4]);
 assert.deepEqual(changed.new,[4]);
});


test('MR summary reports completed model line coverage rather than all planned files',()=>{
 const snapshot={headSha:'a'.repeat(40),
   files:[{path:'src/a.c',skipped:false},{path:'src/b.c',skipped:false}],
   coverageGaps:['token_budget_preflight'],advisories:['context:context_budget']};
 const review={verdict:'incomplete',findings:[],summary:'',
   modelCoverage:{changedLines:20,completedByModel:5,plannedChunks:2,completedChunks:1},
   contextCoverage:{omittedSlices:3},saturatedChunks:[]};
 const rendered=formatSummary(review,snapshot,{language:'en',source:'fixture',fingerprint:'b'.repeat(64)});
 assert.match(rendered,/5\/20 changed lines completed by model/);
 assert.match(rendered,/1\/2 chunks/);
 assert.match(rendered,/Context slices omitted: 3/);
 assert.doesNotMatch(rendered,/2 text files reviewed/);
});


test('model finding line positions reject rounding and out-of-chunk end ranges',()=>{
 const snapshot=buildSnapshot(mr,{complete:true,items:[{old_path:'motor.c',
   new_path:'motor.c',diff:'@@ -2,2 +2,2 @@\n-a\n-b\n+c\n+d'}]},
   {...policy,maxDiffBytes:4096,maxReviewChunks:2});
 const base={severity:'high',category:'correctness',file:'motor.c',side:'new',
   line:2,endLine:3,title:'Risk',description:'Evidence-based concern',
   suggestion:'Repair',confidence:0.9,rootCauseKey:'',claimClass:''};
 const valid=validateChunkResult({findings:[base]},snapshot.chunks[0],policy);
 assert.equal(valid.findings.length,1);
 for(const change of [{line:2.4},{line:'2'},{endLine:3.4},{endLine:99},{endLine:1}]){
   const bad=validateChunkResult({findings:[{...base,...change}]},snapshot.chunks[0],policy);
   assert.equal(bad.findings.length,0,JSON.stringify(change));
   assert.equal(bad.rejected,1);
 }
});


test('Core semantic plan keeps linked implementation/header/tests together and previews without a model',()=>{
 const changes=[
  {old_path:'src/motor.c',new_path:'src/motor.c',diff:'@@ -1 +1 @@\n-old\n+#include "motor.h"'},
  {old_path:'docs/readme.md',new_path:'docs/readme.md',diff:'@@ -1 +1 @@\n-old\n+new'},
  {old_path:'include/motor.h',new_path:'include/motor.h',diff:'@@ -1 +1 @@\n-old\n+int motor_run(void);'},
  {old_path:'tests/motor_test.c',new_path:'tests/motor_test.c',diff:'@@ -1 +1 @@\n-old\n+assert(motor_run()==0);'}
 ];
 const snapshot=buildSnapshot(mr,{complete:true,items:changes},{...policy,maxDiffBytes:4096,maxReviewChunks:8});
 assert.equal(snapshot.coverageComplete,true,JSON.stringify(snapshot.coverageGaps));
 assert.deepEqual(snapshot.semanticGroups[0].paths,['src/motor.c','include/motor.h','tests/motor_test.c']);
 assert.equal(snapshot.preview.modelCalls,0);
 assert.equal(snapshot.preview.unplannedFiles,0);
 assert.equal(snapshot.preview.plannedFiles,4);
 assert.equal(snapshot.preview.complete,true);
 const prompt=buildPrompt(snapshot,snapshot.chunks[0],policy);
 assert.match(prompt,/TRUSTED FILE-SCOPED CHECKS/);
 assert.match(prompt,/motor-control/);
 const presentation=JSON.parse(formatReviewPreview(snapshot));
 assert.equal(presentation.modelCalls,0);
 assert.equal(presentation.plannedFiles,4);
 assert.equal(presentation.groups.length,2);
});

test('review preview reports exact nonreviewable and unplanned paths with no false complete',()=>{
 const diff={complete:true,items:[
  {old_path:'src/a.js',new_path:'src/a.js',diff:'@@ -1 +1 @@\n-a\n+b'},
  {old_path:'firmware/large.c',new_path:'firmware/large.c',diff:'@@ -1 +1 @@\n-a\n+'+'z'.repeat(6000)},
  {old_path:'public/asset.png',new_path:'public/asset.png',diff:''}
 ]};
 const snapshot=buildSnapshot(mr,diff,{...policy,maxDiffBytes:4096,maxReviewChunks:1});
 assert.equal(snapshot.preview.complete,false);
 assert.ok(snapshot.preview.coverageGaps.length>0);
 assert.equal(snapshot.preview.modelCalls,0);
 assert.equal(snapshot.preview.items.find(x=>x.path==='public/asset.png').state,'unreviewable');
 assert.equal(JSON.parse(formatReviewPreview(snapshot)).complete,false);
});

test('claim fact audit reports literal conflicts without deleting even high risk review findings',()=>{
 const diff={complete:true,items:[{old_path:'src/a.c',new_path:'src/a.c',
   diff:'@@ -1 +1 @@\n-old\n+if (!ptr) return;'}]};
 const snapshot=buildSnapshot(mr,diff,{...policy,maxDiffBytes:4096,maxReviewChunks:2});
 const claims=[
 {file:'src/a.c',category:'correctness',claimedAbsentLiteral:'if (!ptr)'},
 {file:'src/a.c',category:'resource',claimedAbsentLiteral:'if (!ptr)'}
 ];
 const audit=conservativeClaimAudit(claims,snapshot);
 assert.equal(audit.automaticallyRemoved,0);
 assert.equal(audit.findings.length,2);
 assert.deepEqual(audit.warnings.map(x=>x.index),[0]);
});
