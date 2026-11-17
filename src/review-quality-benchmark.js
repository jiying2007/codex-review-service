'use strict';
// Pure offline quality vs token comparison. No Codex, GitLab or network access.
const crypto=require('node:crypto');
const {readJson}=require('./sharded-catalog');
const SEVERITIES=new Set(['critical','high','medium','low']);
const KEY=/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
function fail(message){throw Object.assign(new Error(message),{code:'EQUALITYBENCH'});}
function datasetDigest(cases){
 const canonical=cases.map(c=>({id:c.id,changedFiles:c.changedFiles,
   expected:c.expected.map(x=>({id:x.id,severity:x.severity})).sort((a,b)=>a.id.localeCompare(b.id))
 })).sort((a,b)=>a.id.localeCompare(b.id));
 return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
function validateReport(report){
 if(!report||report.schemaVersion!==1||!Array.isArray(report.cases)||
    report.cases.length<6||report.cases.length>512||
    !/^[a-f0-9]{64}$/.test(String(report.datasetDigest||'')))
   fail('Need six to 512 source-bound cases and an exact dataset digest');
 const ids=new Set(),validated=[];
 for(const c of report.cases){
   if(!c||!KEY.test(String(c.id||''))||ids.has(c.id)||
      !Array.isArray(c.expected)||!Array.isArray(c.detected)||
      c.expected.length>256||c.detected.length>256)
     fail('Invalid or duplicate benchmark case');
   ids.add(c.id);
   if(!Number.isSafeInteger(c.changedFiles)||c.changedFiles<1||c.changedFiles>10000||
      !Number.isSafeInteger(c.reviewedFiles)||c.reviewedFiles<0||
      c.reviewedFiles>c.changedFiles||typeof c.coverageComplete!=='boolean'||
      (c.coverageComplete && c.changedFiles!==c.reviewedFiles))
     fail('Invalid review coverage evidence');
   if(!/^[a-f0-9]{64}$/.test(String(c.sourceReceiptSha256||'')))
     fail('Missing source-bound receipt digest; synthetic reports are not production evidence');
   if(!Number.isSafeInteger(c.durationMs)||c.durationMs<0||c.durationMs>86400000)
     fail('Invalid observed duration');
   const truth=new Set(),found=new Set();
   for(const x of c.expected){
     if(!x||!KEY.test(String(x.id||''))||!SEVERITIES.has(x.severity)||truth.has(x.id))
       fail('Invalid or duplicate ground-truth finding');
     truth.add(x.id);
   }
   for(const id of c.detected){
     if(!KEY.test(String(id||''))||found.has(id))fail('Invalid or duplicate detected finding');
     found.add(id);
   }
   if(!c.usage||typeof c.usage.known!=='boolean'||
      !Number.isSafeInteger(c.usage.inputTokens)||c.usage.inputTokens<0||
      !Number.isSafeInteger(c.usage.outputTokens)||c.usage.outputTokens<0||
      c.usage.inputTokens+c.usage.outputTokens>1000000000)
     fail('Invalid usage evidence');
   if(!c.usage.known&&(c.usage.inputTokens!==0||c.usage.outputTokens!==0))
     fail('Unknown usage must not be disguised as partially observed tokens');
   validated.push(c);
 }
 if(datasetDigest(validated)!==report.datasetDigest)fail('Reported dataset does not match ground truth');
 return validated.sort((a,b)=>a.id.localeCompare(b.id));
}
function score(report){
 const cases=validateReport(report);
 let tp=0,fp=0,fn=0,highTp=0,highFn=0,highExpected=0,
     changed=0,reviewed=0,full=0,tokens=0,unknown=0;
 const duration=[];
 for(const c of cases){
   const truth=new Map(c.expected.map(x=>[x.id,x.severity]));
   const found=new Set(c.detected);
   for(const [id,severity] of truth){
     const high=severity==='critical'||severity==='high';
     if(high)highExpected++;
     if(found.has(id)){tp++;if(high)highTp++;}
     else{fn++;if(high)highFn++;}
   }
   fp+=c.detected.filter(id=>!truth.has(id)).length;
   changed+=c.changedFiles;reviewed+=c.reviewedFiles;
   if(c.coverageComplete)full++;
   duration.push(c.durationMs);
   if(c.usage.known)tokens+=c.usage.inputTokens+c.usage.outputTokens;
   else unknown++;
 }
 duration.sort((a,b)=>a-b);
 const precision=(tp+fp)?tp/(tp+fp):null;
 const recall=(tp+fn)?tp/(tp+fn):null;
 return {cases:cases.length,groundTruth:tp+fn,highExpected,
   truePositives:tp,falsePositives:fp,falseNegatives:fn,
   criticalHighRecall:highExpected?highTp/highExpected:null,
   precision,recall,coverageCompleteCases:full,
   changedFiles:changed,reviewedFiles:reviewed,
   totalKnownTokens:unknown?null:tokens,unknownUsageCases:unknown,
   tokensPerTruePositive:unknown||!tp?null:tokens/tp,
   p95DurationMs:duration[Math.ceil(duration.length*0.95)-1]};
}
function compare(baseline,candidate,{minimumSavingsPercent=5}={}){
 if(!Number.isFinite(minimumSavingsPercent)||minimumSavingsPercent<0||minimumSavingsPercent>100)
   fail('Invalid minimum savings threshold');
 const old=score(baseline),next=score(candidate);
 if(baseline.datasetDigest!==candidate.datasetDigest)
   fail('Benchmark datasets differ');
 const oldIds=baseline.cases.map(c=>c.id).sort().join('|');
 const newIds=candidate.cases.map(c=>c.id).sort().join('|');
 if(oldIds!==newIds)fail('Benchmark case IDs differ');
 const failures=[];
 if(old.highExpected===0)failures.push('no_critical_high_ground_truth');
 if(!baseline.cases.some(c=>c.expected.length===0))failures.push('no_negative_cases');
 if(old.totalKnownTokens===null||next.totalKnownTokens===null)
   failures.push('unknown_token_usage');
 if(old.totalKnownTokens===0||next.totalKnownTokens===0)
   failures.push('invalid_known_token_total');
 if(old.precision===null||next.precision===null||
    next.precision+1e-12<old.precision)failures.push('precision_regression');
 if(old.criticalHighRecall===null||next.criticalHighRecall===null||
    next.criticalHighRecall+1e-12<old.criticalHighRecall)
   failures.push('critical_high_recall_regression');
 if(next.coverageCompleteCases<old.coverageCompleteCases||
    next.reviewedFiles<old.reviewedFiles)failures.push('coverage_regression');
 const savings=old.totalKnownTokens&&next.totalKnownTokens!==null?
   100*(old.totalKnownTokens-next.totalKnownTokens)/old.totalKnownTokens:null;
 if(savings===null||savings+1e-12<minimumSavingsPercent)
   failures.push('insufficient_token_savings');
 return {schemaVersion:1,kind:'offline_quality_token_comparison',datasetDigest:baseline.datasetDigest,
   baseline:old,candidate:next,tokenSavingsPercent:savings,minimumSavingsPercent,
   researchGatePassed:failures.length===0,productionQualified:false,
   warnings:['Receipt format and dataset SHA are checked, not independently attested.',
     'Offline comparisons never replace fresh production MR, ASR, or human-ground-truth validation.'],
   failures};
}
function main(args=process.argv.slice(2)){
 if(args.length<2||args.length>3)fail('Usage: node src/review-quality-benchmark.js baseline.json candidate.json [minimumSavingsPercent]');
 const a=readJson(args[0]),b=readJson(args[1]);
 const result=compare(a,b,{minimumSavingsPercent:args.length===3?Number(args[2]):5});
 process.stdout.write(JSON.stringify(result,null,2)+'\n');
 if(!result.researchGatePassed)process.exitCode=2;
}
if(require.main===module){try{main();}catch(e){process.stderr.write(JSON.stringify({error:e.code||'EQUALITYBENCH'})+'\n');process.exitCode=2;}}
module.exports={datasetDigest,validateReport,score,compare,main};
