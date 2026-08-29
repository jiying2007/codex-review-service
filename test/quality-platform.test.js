'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {unifiedDiffText,cheapScore,collectImpact,collectAnalyzerReports,qualityContextBlocks}=require('../src/quality');
const {resolveReviewProfile}=require('../src/codex-safe-core/quality-platform');

const headSha='a'.repeat(40);
const mr={project_id:1,source_project_id:1,diff_refs:{head_sha:headSha}};
const diffResult={items:[{old_path:'src/a.c',new_path:'src/a.c',diff:'@@ -1 +1,2 @@\n #include "a.h"\n+int motor_stop(void){return 0;}'}]};

test('Service Impact Evidence is fetched only from the exact MR head SHA',async()=>{
  const calls=[];
  const gitlab={
    async listRepositoryTree(projectId,ref){calls.push(['tree',projectId,ref]);return{complete:true,items:[{type:'blob',path:'src/a.h'},{type:'blob',path:'src/motor.c'},{type:'blob',path:'assets/logo.png'}]};},
    async getRepositoryFileRaw(projectId,file,ref){calls.push(['file',projectId,file,ref]);return file.endsWith('.h')?'int motor_stop(void);':'int motor_stop(void){return 0;}';}
  };
  const graph=await collectImpact(gitlab,mr,diffResult,resolveReviewProfile('embedded'));
  assert.ok(graph.nodes.length>=1);
  assert.ok(calls.every(call=>call.at(-1)===headSha));
  assert.match(graph.text,/IMPACT EVIDENCE GRAPH/);
});

test('pre-generated SARIF is acquired from exact head pipeline and normalized without analyzer execution',async()=>{
  const sarif=JSON.stringify({version:'2.1.0',runs:[{tool:{driver:{name:'Semgrep',rules:[{id:'CWE-78',properties:{tags:['security']}}]}},results:[{ruleId:'CWE-78',level:'error',message:{text:'command injection'},locations:[{physicalLocation:{artifactLocation:{uri:'src/a.c'},region:{startLine:2}}}]}]}]});
  const calls=[];
  const pipelineMr={...mr,head_pipeline:{id:77,project_id:1,sha:headSha}};
  const gitlab={
    async listPipelineJobs(projectId,pipelineId){calls.push(['jobs',projectId,pipelineId]);return{complete:true,items:[{id:9,name:'security-sast'}]};},
    async getJobArtifactFile(projectId,jobId,file){calls.push(['artifact',projectId,jobId,file]);return sarif;}
  };
  const result=await collectAnalyzerReports(gitlab,pipelineMr,{analyzerReports:[{format:'sarif',job:'security-*',path:'reports/security.sarif',required:true,maxBytes:4194304}]});
  assert.equal(result.complete,true);
  assert.equal(result.findings.length,1);
  assert.equal(result.findings[0].category,'security');
  assert.equal(result.findings[0].file,'src/a.c');
  assert.deepEqual(calls,[['jobs',1,77],['artifact',1,9,'reports/security.sarif']]);
});

test('quality evidence blocks are bounded evidence and not execution directives',()=>{
  assert.match(unifiedDiffText(diffResult),/diff --git a\/src\/a.c b\/src\/a.c/);
  assert.ok(cheapScore('src/a.h',{paths:['src/a.c'],includes:['a.h'],modules:[],changedStems:['a'],symbols:[],configs:[],labels:[]})>0);
  assert.deepEqual(qualityContextBlocks({impact:{text:'impact'},analyzerEvidence:{text:'sarif'}}),['impact','sarif']);
});
