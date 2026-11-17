'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {collectImpact,collectServiceQualityEvidence,qualityContextForChunk}=require('../src/quality');
const {verifyFindingEvidence}=require('../src/codex-safe-core/review-evidence-v2');
const mr={project_id:7,source_project_id:7,iid:9,diff_refs:{
  start_sha:'b'.repeat(40),head_sha:'a'.repeat(40)
}};
const diff={
 complete:true,items:[
 {old_path:'src/motor.c',new_path:'src/motor.c',
  diff:'@@ -3 +3 @@\n-int motor_update(int rpm) { return rpm; }\n+int motor_update(int rpm) { return rpm * 2; }'},
 {old_path:'src/irq.c',new_path:'src/irq.c',
  diff:'@@ -8 +8 @@\n-old_irq();\n+mutex_lock(&motor_lock);'}
 ]};
function gitlab(){
 const calls=[];
 return {calls,listRepositoryTree:async()=>({complete:true,items:[
   {path:'src/motor.c',type:'blob'},{path:'src/irq.c',type:'blob'}
 ]}),getRepositoryFileRaw:async(project,path,sha)=>{
   calls.push([project,path,sha]);
   return path==='src/motor.c'?
     'int motor_update(int rpm) { return rpm * 2; }\nvoid motor_loop(void) {\n motor_update(2);\n}\n':
     'void irq_handler(void) {\n mutex_lock(&motor_lock);\n}\n';
 }};
}
test('Impact derives bounded exact-head lexical callers, separate from compiler-resolved truth',async()=>{
 const gl=gitlab();
 const result=await collectImpact(gl,mr,diff,{impactDepth:1,maxImpactFiles:12});
 assert.equal(result.sourceHeadSha,mr.diff_refs.head_sha);
 assert.ok(gl.calls.every(x=>x[2]===mr.diff_refs.head_sha));
 assert.equal(result.functionImpact.seeds[0].name,'motor_update');
 assert.ok(result.functionImpact.edges.some(x=>x.from.function==='motor_loop'&&x.verifiedResolution===false));
 assert.equal(result.functionImpact.confidence,'heuristic_only');
});
test('risk and function signals are limited to changed lines in the specific review Chunk',async()=>{
 const gl=gitlab();
 const evidence=await collectServiceQualityEvidence(gl,mr,diff,{
   reviewProfile:'embedded-mcu',analyzerReports:[],testImpactEnabled:false
 });
 assert.ok(evidence.risk.signals.some(x=>x.ruleId==='irq-blocking'));
 const motor=qualityContextForChunk(evidence,{index:0,files:[{
   path:'src/motor.c',changedLines:{new:[3],old:[3]}
 }],diffText:'@@ -3 +3 @@\n-int motor_update(int rpm) { return rpm; }\n+int motor_update(int rpm) { return rpm * 2; }'});
 const textMotor=motor.blocks.join('\n');
 assert.match(textMotor,/FUNCTION CALL CANDIDATES/);
 assert.match(textMotor,/motor_loop/);
 assert.doesNotMatch(textMotor,/irq-blocking/);
 const irq=qualityContextForChunk(evidence,{index:1,files:[{
   path:'src/irq.c',changedLines:{new:[8],old:[8]}
 }],diffText:'@@ -8 +8 @@\n-old_irq();\n+mutex_lock(&motor_lock);'});
 assert.match(irq.blocks.join('\n'),/DETERMINISTIC RISK HINTS/);
 assert.match(irq.blocks.join('\n'),/irq-blocking/);
 assert.doesNotMatch(irq.blocks.join('\n'),/motor_loop/);
 assert.ok(motor.bytes<=32768&&irq.bytes<=32768);
});
test('service Proof results preserve high-risk findings but identify missing or conflicting anchors',()=>{
 const fullDiff=diff.items.map(x=>[
   'diff --git a/'+x.new_path+' b/'+x.new_path,'--- a/'+x.old_path,
   '+++ b/'+x.new_path,x.diff
 ].join('\n')).join('\n');
 const findings=[
   {file:'src/motor.c',side:'new',line:3,endLine:3,category:'correctness'},
   {file:'src/irq.c',side:'new',line:8,endLine:8,category:'concurrency'},
   {file:'src/irq.c',side:'new',line:9,endLine:9,category:'concurrency'}];
 const result=verifyFindingEvidence({diff:fullDiff,findings});
 assert.equal(result.verifiedAnchorCount,2);
 assert.equal(result.incomplete,1);
 assert.equal(result.automaticallyRemoved,0);
 assert.equal(result.findings.length,3);
});
