'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {collectImpact,collectServiceQualityEvidence,qualityContextForChunk}=require('../src/quality');
const {verifyFindingEvidence,buildReviewRiskEvidence,buildFunctionImpactEvidence}=require('../src/codex-safe-core/review-evidence-v2');
const {toUnifiedReviewBlock}=require('../src/gitlab-diff');
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
 }],diffText:toUnifiedReviewBlock(diff.items[0])});
 const textMotor=motor.blocks.join('\n');
 assert.match(textMotor,/FUNCTION CALL CANDIDATES/);
 assert.match(textMotor,/motor_loop/);
 assert.doesNotMatch(textMotor,/irq-blocking/);
 const irq=qualityContextForChunk(evidence,{index:1,files:[{
   path:'src/irq.c',changedLines:{new:[8],old:[8]}
 }],diffText:toUnifiedReviewBlock(diff.items[1])});
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

test('shared chunk selector isolates same-file hunk hints and exposes inconsistent evidence',()=>{
 const header='diff --git a/src/irq.c b/src/irq.c\n--- a/src/irq.c\n+++ b/src/irq.c\n';
 const a='@@ -11 +11 @@\n-old_irq();\n+mutex_lock(&first);',b='@@ -106 +106 @@\n-old_irq();\n+mutex_lock(&second);';
 const full=header+a+'\n'+b;
 const evidence={risk:buildReviewRiskEvidence({diff:full}),impact:{functionImpact:buildFunctionImpactEvidence({diff:full})}};
 for(const [part,line] of [[a,11],[b,106]]){
   const result=qualityContextForChunk(evidence,{index:1,files:[{path:'src/irq.c',changedLines:{new:[11,106],old:[11,106]}}],diffText:header+part});
   const hints=result.blocks.join('\n').match(/--- DETERMINISTIC RISK HINTS \(NOT CERTIFIED DEFECTS\) ---\n([^\n]+)\n--- END RISK HINTS ---/);
   assert.ok(hints);assert.deepEqual(JSON.parse(hints[1]).map(h=>h.line),[line]);assert.deepEqual(result.structuralEvidenceGaps,[]);
 }
 const stale=qualityContextForChunk(evidence,{index:1,files:[{path:'src/irq.c'}],diffText:header+a.replace('&first','&changed')});
 assert.ok(stale.structuralEvidenceGaps.includes('risk_text_digest_mismatch'));
 assert.doesNotMatch(stale.blocks.join('\n'),/DETERMINISTIC RISK HINTS/);
});

test('canonical multi-file provider chunks retain risk hints after Core framing correction',()=>{
 const {buildReviewEvidenceChunks}=require('../src/codex-safe-core/context-builder');
 const raw=[
  toUnifiedReviewBlock({old_path:'src/irq.c',new_path:'src/irq.c',diff:'@@ -1 +1 @@\n-old_irq();\n+mutex_lock(&lock);\n'}),
  toUnifiedReviewBlock({old_path:'src/second.c',new_path:'src/second.c',diff:'@@ -1 +1 @@\n-old();\n+new_call();\n'})
 ].map(s=>s.endsWith('\n')?s:s+'\n').join('');
 const evidence={risk:buildReviewRiskEvidence({diff:raw}),impact:{functionImpact:buildFunctionImpactEvidence({diff:raw})}};
 const plan=buildReviewEvidenceChunks({diff:raw,maxBytes:4096,maxChunks:2});
 assert.equal(plan.chunks.length,1);
 const c=plan.chunks[0];
 assert.match(c.text,/\n\ndiff --git/);
 const chunk={index:0,files:c.paths.map(path=>({path})),diffText:c.text};
 const result=qualityContextForChunk(evidence,chunk);
 assert.deepEqual(result.structuralEvidenceGaps,[]);
 assert.match(result.blocks.join('\n'),/irq-blocking/);
 const invalid=qualityContextForChunk(evidence,{...chunk,diffText:c.text.replace('+new_call();','+new_call();\n+extra();')});
 assert.ok(invalid.structuralEvidenceGaps.length>0);
 assert.doesNotMatch(invalid.blocks.join('\n'),/DETERMINISTIC RISK HINTS/);
});
