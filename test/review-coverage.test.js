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
