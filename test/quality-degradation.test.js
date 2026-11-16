'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {collectServiceQualityEvidence}=require('../src/quality');

const mr={project_id:5,source_project_id:5,iid:11,diff_refs:{head_sha:'b'.repeat(40),start_sha:'a'.repeat(40)}};
const diff={items:[{old_path:'src/motor.c',new_path:'src/motor.c',
 diff:'@@ -1 +1 @@\n-old\n+#include "motor.h"'}]};

test('optional degraded impact is represented in evidence without fabricating completeness',async()=>{
 const gitlab={listRepositoryTree:async()=>({complete:false,items:[
   {type:'blob',path:'include/motor.h'}]}),
   getRepositoryFileRaw:async()=>('int motor(void);')};
 const result=await collectServiceQualityEvidence(gitlab,mr,diff,{
   reviewProfile:'embedded-mcu',analyzerReports:[],testImpactEnabled:false
 });
 assert.equal(result.impact.complete,false);
 assert.ok(result.degradationReasons.includes('impact_tree_pagination'));
 assert.ok(result.degradationReasons.includes('impact_incomplete'));
 assert.equal(result.analyzerComplete,true);
});

test('optional analyzer pipeline unavailable is visibly degraded, required report remains enforced',async()=>{
 const gitlab={listRepositoryTree:async()=>({complete:true,items:[]}),
   listProjectPipelines:async()=>({complete:true,items:[]})};
 const config={reviewProfile:'general',testImpactEnabled:false,analyzerReports:[{
   format:'sarif',job:'scan',path:'scan.sarif',required:false,maxBytes:4096
 }]};
 const optional=await collectServiceQualityEvidence(gitlab,mr,diff,config);
 assert.equal(optional.analyzerComplete,false);
 assert.ok(optional.degradationReasons.includes('optional_analyzer_incomplete'));
 await assert.rejects(
   collectServiceQualityEvidence(gitlab,mr,diff,{...config,
     analyzerReports:config.analyzerReports.map(item=>({...item,required:true}))}),
   error=>error.code==='EANALYZERPIPELINE'
 );
});
