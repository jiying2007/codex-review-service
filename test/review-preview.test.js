'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {previewFromDocument}=require('../scripts/review-preview');
const policy={language:'en',maxDiffBytes:4096,maxReviewChunks:4,maxFindings:10,maxPublishedFindings:10,
 minConfidence:0.7,severityThreshold:'info',blockingSeverity:'high',extraInstructions:'',
 skipGeneratedFiles:true,blockUnreviewableFiles:false};
test('offline fixture preview selects real MR changed files without calling a model',()=>{
 const doc={mr:{iid:5,project_id:2,diff_refs:{head_sha:'a'.repeat(40)}},
  diffResult:{complete:true,items:[
   {old_path:'src/motor.c',new_path:'src/motor.c',diff:'@@ -1 +1 @@\n-old\n+#include "motor.h"'},
   {old_path:'include/motor.h',new_path:'include/motor.h',diff:'@@ -1 +1 @@\n-old\n+int motor_run(void);'},
   {old_path:'img/logo.png',new_path:'img/logo.png',diff:''}
  ]},policy};
 const result=JSON.parse(previewFromDocument(doc));
 assert.equal(result.modelCalls,0);
 assert.equal(result.fileCount,undefined);
 assert.equal(result.reviewableFiles,2);
 assert.equal(result.plannedFiles,2);
 assert.equal(result.unplannedFiles,0);
 assert.equal(result.items.find(x=>x.path==='img/logo.png').state,'unreviewable');
 assert.deepEqual(result.groups[0].paths,['src/motor.c','include/motor.h']);
 assert.ok(result.complete);
});
test('preview refuses malformed files instead of inventing model readiness',()=>{
 assert.throws(()=>previewFromDocument({}),/Expected/);
 assert.throws(()=>previewFromDocument({mr:{iid:1},diffResult:{complete:true,items:[]}}),/Expected/);
});
