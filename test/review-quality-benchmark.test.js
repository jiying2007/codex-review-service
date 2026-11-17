'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {datasetDigest,compare,score,validateReport}=require('../src/review-quality-benchmark');
function fixture(tokens=100,changes={}){
 const cases=Array.from({length:6},(_,i)=>({
   id:'case-'+i,sourceReceiptSha256:'a'.repeat(64),
   changedFiles:2,reviewedFiles:2,coverageComplete:true,
   expected:i===0?[{id:'defect-high',severity:'high'}]:
     i===1?[{id:'defect-medium',severity:'medium'}]:[],
   detected:i===0?['defect-high']:i===1?['defect-medium']:[],
   usage:{known:true,inputTokens:tokens-10,outputTokens:10},durationMs:1000+i
 }));
 Object.assign(cases[0],changes);
 return {schemaVersion:1,datasetDigest:datasetDigest(cases),cases};
}
test('trusted offline comparison requires equal ground truth and nonregression',()=>{
 const before=fixture(100),after=fixture(90);
 const result=compare(before,after);
 assert.equal(result.researchGatePassed,true);
 assert.equal(result.productionQualified,false);
 assert.equal(result.baseline.criticalHighRecall,1);
 assert.equal(result.candidate.unknownUsageCases,0);
 assert.equal(result.tokenSavingsPercent,10);
 assert.equal(result.baseline.p95DurationMs,1005);
});
test('critical recall, precision, coverage and unknown token regression fail closed',()=>{
 const baseline=fixture(100);
 const poor=fixture(70,{detected:[]});
 assert.ok(compare(baseline,poor).failures.includes('critical_high_recall_regression'));
 const imprecise=fixture(70,{detected:['defect-high','false-positive']});
 assert.ok(compare(baseline,imprecise).failures.includes('precision_regression'));
 const incomplete=fixture(70,{reviewedFiles:1,coverageComplete:false});
 assert.ok(compare(baseline,incomplete).failures.includes('coverage_regression'));
 const unknown=fixture(70,{usage:{known:false,inputTokens:0,outputTokens:0}});
 assert.ok(compare(baseline,unknown).failures.includes('unknown_token_usage'));
 assert.ok(compare(baseline,fixture(99)).failures.includes('insufficient_token_savings'));
});
test('rejects forged dataset fingerprints, duplicate finding IDs and incompatible cases',()=>{
 const before=fixture(100);
 assert.throws(()=>validateReport({...before,datasetDigest:'b'.repeat(64)}),/dataset/);
 assert.throws(()=>score(fixture(100,{detected:['defect-high','defect-high']})),/duplicate/);
 const other=fixture(90);other.cases[0].id='different-case';
 other.datasetDigest=datasetDigest(other.cases);
 assert.throws(()=>compare(before,other),/datasets differ|IDs differ/);
 assert.throws(()=>compare(before,fixture(80),{minimumSavingsPercent:101}),/threshold/);
});
