'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {unifiedDiffText,cheapScore,collectImpact,loadSarif,qualityContextBlocks}=require('../src/quality');
const {resolveReviewProfile}=require('../src/codex-safe-core/quality-platform');

const mr={project_id:1,source_project_id:1,diff_refs:{head_sha:'a'.repeat(40)}};
const diffResult={items:[{old_path:'src/a.c',new_path:'src/a.c',diff:'@@ -1 +1,2 @@\n #include "a.h"\n+int motor_stop(void){return 0;}'}]};

test('Service Impact Evidence is fetched only from the exact MR head SHA',async()=>{
  const calls=[];
  const gitlab={
    async listRepositoryTree(projectId,ref){calls.push(['tree',projectId,ref]);return{complete:true,items:[{type:'blob',path:'src/a.h'},{type:'blob',path:'src/motor.c'},{type:'blob',path:'assets/logo.png'}]};},
    async getRepositoryFileRaw(projectId,file,ref){calls.push(['file',projectId,file,ref]);return file.endsWith('.h')?'int motor_stop(void);':'int motor_stop(void){return 0;}';}
  };
  const graph=await collectImpact(gitlab,mr,diffResult,resolveReviewProfile('embedded'));
  assert.ok(graph.nodes.length>=1);
  assert.ok(calls.every(call=>call.at(-1)==='a'.repeat(40)));
  assert.match(graph.text,/IMPACT EVIDENCE GRAPH/);
});

test('pre-generated SARIF is normalized without analyzer execution',async()=>{
  const sarif=JSON.stringify({version:'2.1.0',runs:[{tool:{driver:{name:'Semgrep',rules:[{id:'CWE-78',properties:{tags:['security']}}]}},results:[{ruleId:'CWE-78',level:'error',message:{text:'command injection'},locations:[{physicalLocation:{artifactLocation:{uri:'src/a.c'},region:{startLine:2}}}]}]}]});
  const calls=[];
  const gitlab={async getRepositoryFileRaw(projectId,file,ref){calls.push({projectId,file,ref});return sarif;}};
  const findings=await loadSarif(gitlab,mr,['reports/security.sarif']);
  assert.equal(findings.length,1);
  assert.equal(findings[0].category,'security');
  assert.equal(findings[0].file,'src/a.c');
  assert.deepEqual(calls,[{projectId:1,file:'reports/security.sarif',ref:'a'.repeat(40)}]);
});

test('quality evidence blocks are bounded evidence and not execution directives',()=>{
  assert.match(unifiedDiffText(diffResult),/diff --git a\/src\/a.c b\/src\/a.c/);
  assert.ok(cheapScore('src/a.h',{paths:['src/a.c'],includes:['a.h'],modules:[],changedStems:['a'],symbols:[],configs:[],labels:[]})>0);
  assert.deepEqual(qualityContextBlocks({impact:{text:'impact'},analyzerEvidence:{text:'sarif'}}),['impact','sarif']);
});
