'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {qualityContextForChunk}=require('../src/quality');

test('each chunk receives only its related dependency and analyzer evidence',()=>{
 const evidence={
   profile:{packName:'embedded-mcu',packVersion:1,baseProfile:'realtime',checks:['Verify ISR lifetimes'],focusCategories:['concurrency']},
   impact:{edges:[{from:'src/motor.c',to:'include/motor.h',type:'include-target'}],
     nodes:[{path:'include/motor.h',score:70,content:'MOTOR_API_CONTRACT'},
       {path:'src/unrelated.c',score:35,content:'UNRELATED_INTERNAL_CODE'}]},
   analyzerFindings:[
     {tool:'cppcheck',ruleId:'m1',severity:'high',category:'concurrency',file:'src/motor.c',line:10,endLine:10,message:'motor race',confidence:1},
     {tool:'cppcheck',ruleId:'m2',severity:'high',category:'concurrency',file:'src/unrelated.c',line:20,endLine:20,message:'unrelated race',confidence:1}],
   analyzerMetadata:[],testImpactEvidence:{text:'Related tests are advisory, not proof of execution.'}
 };
 const motor=qualityContextForChunk(evidence,{index:1,files:[{path:'src/motor.c'}]});
 const value=motor.blocks.join('\n');
 assert.match(value,/ISR lifetimes/);
 assert.match(value,/MOTOR_API_CONTRACT/);
 assert.match(value,/motor race/);
 assert.doesNotMatch(value,/UNRELATED_INTERNAL_CODE|unrelated race/);
 assert.equal(motor.relatedImpactNodes,1);
 assert.equal(motor.relatedAnalyzerFindings,1);
 const unrelated=qualityContextForChunk(evidence,{index:2,files:[{path:'src/unrelated.c'}]});
 assert.doesNotMatch(unrelated.blocks.join('\n'),/MOTOR_API_CONTRACT|motor race/);
});

test('chunk quality evidence stays under byte cap and reports truncation',()=>{
 const result=qualityContextForChunk({impact:{edges:[{from:'src/a.c',to:'include/a.h'}],
   nodes:[{path:'include/a.h',score:10,content:'X'.repeat(30000)}]}},
   {index:1,files:[{path:'src/a.c'}]},{maxBytes:8192});
 assert.ok(result.bytes<=8192);
 assert.equal(result.truncated,true);
 assert.match(result.blocks.join('\n'),/impact node clipped/);
});
