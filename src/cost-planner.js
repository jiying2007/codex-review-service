'use strict';

const core=require('./codex-safe-core');

function estimateTextTokens(value,bytesPerToken=2){return core.estimateTextTokens(value,bytesPerToken);}
function estimateChunkTokens(prompt,maxFindings=1,bytesPerToken=2){const estimatedOutputTokens=Math.max(96,96+Math.max(1,Number(maxFindings)||1)*180),estimate=core.estimateRequestTokens(prompt,{estimatedOutputTokens,bytesPerToken});return Object.freeze({input:estimate.inputTokens,output:estimate.outputTokens,total:estimate.totalTokens});}
function scoreChunkRisk(chunk){return core.scoreEvidenceRisk({paths:(chunk?.files||[]).map(file=>String(file.path||'')),text:String(chunk?.diffText||'')});}
function adaptiveContextConfig(config,policy,chunk){const riskScore=scoreChunkRisk(chunk),enabled=Boolean(config.contextEnabled)&&Number(policy.maxContextBytes||0)>0;if(!enabled)return{...config,...policy,contextEnabled:false,maxContextBytes:0,maxContextFiles:0,contextLines:0,riskScore};if(config.adaptiveContextEnabled===false)return{...config,...policy,riskScore};return{...config,...policy,riskScore,maxContextBytes:core.adaptiveBudget(policy.maxContextBytes,riskScore,{min:16*1024}),maxContextFiles:core.adaptiveBudget(policy.maxContextFiles,riskScore,{min:1}),contextLines:core.adaptiveBudget(policy.contextLines,riskScore,{min:4})};}
function selectChunksWithinByteBudget(chunks,maxBytes){return core.selectChunksWithinByteBudget(chunks,maxBytes,{riskFn:scoreChunkRisk});}

module.exports={estimateTextTokens,estimateChunkTokens,scoreChunkRisk,adaptiveContextConfig,selectChunksWithinByteBudget,TokenBudgetLedger:core.TokenBudgetLedger,TokenEstimatorCalibration:core.TokenEstimatorCalibration};
