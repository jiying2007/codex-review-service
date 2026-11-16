'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {evidenceCoverageLedger}=require('../src/service');

test('coverage ledger distinguishes scheduled evidence from finished model calls',()=>{
 const source={files:[
   {path:'src/a.c',skipped:false,changedLines:{old:[1,5],new:[1,5,8]}},
   {path:'src/b.c',skipped:false,changedLines:{old:[2],new:[2]}},
   {path:'assets/image.png',skipped:true,changedLines:{old:[],new:[]}}
 ]};
 const chunks=[
   {index:0,files:[{path:'src/a.c',changedLines:{old:[1],new:[1]}}]},
   {index:1,files:[{path:'src/a.c',changedLines:{old:[5],new:[5,8]}},
     {path:'src/b.c',changedLines:{old:[2],new:[2]}}]}
 ];
 const complete=evidenceCoverageLedger(source,chunks,2);
 assert.deepEqual({
   changedLines:complete.changedLines,planned:complete.plannedForModel,
   completed:complete.completedByModel,missed:complete.notReviewedChangedLines
 },{changedLines:7,planned:7,completed:7,missed:0});
 const interrupted=evidenceCoverageLedger(source,chunks,1);
 assert.equal(interrupted.plannedForModel,7);
 assert.equal(interrupted.completedByModel,2);
 assert.equal(interrupted.notReviewedChangedLines,5);
 assert.equal(interrupted.plannedChunks,2);
 assert.equal(interrupted.completedChunks,1);
});

test('coverage ledger reports omitted Hunk changes even if other chunks completed',()=>{
 const source={files:[{path:'kernel/driver.c',skipped:false,
   changedLines:{new:[10,50,90],old:[10,50,90]}}]};
 const chunks=[{index:0,files:[{path:'kernel/driver.c',
   changedLines:{new:[10,90],old:[10,90]}}]}];
 const ledger=evidenceCoverageLedger(source,chunks,1);
 assert.equal(ledger.unplannedChangedLines,2);
 assert.equal(ledger.notReviewedChangedLines,2);
 assert.equal(ledger.completedByModel,4);
 assert.equal(ledger.plannedFiles,1);
});


test('single ledger recomputes all scheduled fields after MR budget selection',()=>{
 const snapshot={coverageLedger:{providerComplete:true,plannedEvidenceUnits:3,
   scheduledChangedLines:9,scheduledChunks:3,scheduledEvidenceUnits:3},
   coverageGaps:['mr_diff_budget:omitted'],files:[
     {path:'a.c',skipped:false,changedLines:{new:[1,2],old:[1,2]}},
     {path:'b.c',skipped:false,changedLines:{new:[3],old:[3]}},
     {path:'c.c',skipped:false,changedLines:{new:[4],old:[4]}}
   ]};
 const selected=[{index:0,unitCount:1,files:[{path:'b.c',changedLines:{new:[3],old:[3]}}]}];
 const first=evidenceCoverageLedger(snapshot,selected,0);
 assert.equal(first.changedLines,8);
 assert.equal(first.plannedEvidenceUnits,3);
 assert.equal(first.scheduledEvidenceUnits,1);
 assert.equal(first.scheduledChunks,1);
 assert.equal(first.scheduledChangedLines,2);
 assert.equal(first.plannedForModel,2);
 assert.equal(first.completedByModel,0);
 assert.equal(first.unscheduledChangedLines,6);
 assert.equal(first.coverageGaps,1);
 snapshot.coverageLedger=first;
 snapshot.coverageGaps.push('token_budget_preflight');
 const final=evidenceCoverageLedger(snapshot,selected,1);
 assert.equal(final.coverageGaps,2);
 assert.equal(final.completedByModel,2);
 assert.equal(final.scheduledChangedLines,final.plannedForModel);
 assert.equal(final.unscheduledChangedLines,final.unplannedChangedLines);
 assert.equal(final.scheduledFiles,1);
 assert.equal(final.plannedEvidenceUnits,3);
});

test('repeated source lines across chunks do not inflate model coverage',()=>{
 const source={files:[{path:'a.c',skipped:false,changedLines:{old:[1],new:[2]}}],
   coverageGaps:[],coverageLedger:{providerComplete:true,plannedEvidenceUnits:2}};
 const chunks=Array.from({length:2},(_,index)=>({index,unitCount:1,
   files:[{path:'a.c',changedLines:{old:[1],new:[2]}}]}));
 const incomplete=evidenceCoverageLedger(source,chunks,1);
 assert.equal(incomplete.changedLines,2);
 assert.equal(incomplete.scheduledChangedLines,2);
 assert.equal(incomplete.completedByModel,2);
 assert.equal(incomplete.scheduledEvidenceUnits,2);
 assert.equal(incomplete.completedChunks,1);
});
