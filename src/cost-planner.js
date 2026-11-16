'use strict';

const core=require('./codex-safe-core');

function estimateTextTokens(value,bytesPerToken=2){return core.estimateTextTokens(value,bytesPerToken);}
function estimateChunkTokens(prompt,maxFindings=1,bytesPerToken=2){const estimatedOutputTokens=Math.max(96,96+Math.max(1,Number(maxFindings)||1)*180),estimate=core.estimateRequestTokens(prompt,{estimatedOutputTokens,bytesPerToken});return Object.freeze({input:estimate.inputTokens,output:estimate.outputTokens,total:estimate.totalTokens});}
function scoreChunkRisk(chunk){return core.scoreEvidenceRisk({paths:(chunk?.files||[]).map(file=>String(file.path||'')),text:String(chunk?.diffText||'')});}
function adaptiveContextConfig(config,policy,chunk){const riskScore=scoreChunkRisk(chunk),enabled=Boolean(config.contextEnabled)&&Number(policy.maxContextBytes||0)>0;if(!enabled)return{...config,...policy,contextEnabled:false,maxContextBytes:0,maxContextFiles:0,contextLines:0,riskScore};if(config.adaptiveContextEnabled===false)return{...config,...policy,riskScore};return{...config,...policy,riskScore,maxContextBytes:core.adaptiveBudget(policy.maxContextBytes,riskScore,{min:16*1024}),maxContextFiles:core.adaptiveBudget(policy.maxContextFiles,riskScore,{min:1}),contextLines:core.adaptiveBudget(policy.contextLines,riskScore,{min:4})};}
function selectChunksWithinByteBudget(chunks,maxBytes){return core.selectChunksWithinByteBudget(chunks,maxBytes,{riskFn:scoreChunkRisk});}

function planChunkFindingCapacity(maxFindings,chunkCount,riskScore=0){
 const cap=Math.max(1,Math.floor(Number(maxFindings)||1));
 const count=Math.max(1,Math.floor(Number(chunkCount)||1));
 const base=Math.min(cap,Math.max(8,Math.ceil(cap/Math.max(1,Math.ceil(count/2)))));
 const bonus=Number(riskScore)>=10?8:Number(riskScore)>=5?4:0;
 return Math.max(1,Math.min(cap,base+bonus));
}

// Allocate a bounded MR-level candidate budget rather than independently
// allowing every chunk to use a large, risk-inflated output quota.
function allocateFindingCapacities(chunks,maxFindings,{riskFn=scoreChunkRisk}={}){
 const values=Array.isArray(chunks)?chunks:[];
 if(!values.length)return Object.freeze([]);
 const finalCap=Math.max(1,Math.floor(Number(maxFindings)||1));
 const budget=Math.max(values.length,Math.min(finalCap*2,Math.ceil(finalCap*1.5)));
 const perChunkCeiling=Math.min(finalCap,Math.max(1,Math.ceil(2*budget/values.length)));
 const capacities=values.map(()=>1);
 const weights=values.map(chunk=>1+Math.max(0,Math.min(12,Number(riskFn(chunk))||0)));
 let remaining=budget-values.length;
 while(remaining>0){
   let chosen=-1,priority=-1;
   for(let i=0;i<capacities.length;i++){
     if(capacities[i]>=perChunkCeiling)continue;
     const value=weights[i]/(capacities[i]+1);
     if(value>priority){priority=value;chosen=i;}
   }
   if(chosen<0)break;
   capacities[chosen]++;remaining--;
 }
 return Object.freeze(capacities);
}

module.exports={estimateTextTokens,estimateChunkTokens,scoreChunkRisk,adaptiveContextConfig,selectChunksWithinByteBudget,planChunkFindingCapacity,allocateFindingCapacities,TokenBudgetLedger:core.TokenBudgetLedger,TokenEstimatorCalibration:core.TokenEstimatorCalibration};
