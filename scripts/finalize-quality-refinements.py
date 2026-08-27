#!/usr/bin/env python3
from pathlib import Path

# Refine Service Quality Platform integration after the main 5.2 finalizer.
q=Path('src/quality.js')
s=q.read_text()
if "function anchorAnalyzerFindings" not in s:
    s=s.replace("function qualityContextBlocks(evidence){", "function anchorAnalyzerFindings(snapshot,findings=[]){const byPath=new Map((snapshot?.files||[]).filter(file=>!file.skipped).map(file=>[String(file.path||'').replace(/\\\\/g,'/'),file])),out=[];for(const item of findings||[]){const file=byPath.get(String(item.file||'').replace(/\\\\/g,'/'));if(!file)continue;const line=Number(item.line||0);let side='';if(file.changedLines?.new?.includes(line))side='new';else if(file.changedLines?.old?.includes(line))side='old';if(!side)continue;const anchor=String(file.changedLines?.anchors?.[side]?.[line]||'');out.push(Object.freeze({severity:item.severity,category:item.category,file:file.path,side,line,endLine:line,title:`${item.tool}/${item.ruleId}`.slice(0,160),description:String(item.message||'').slice(0,1200),suggestion:String(item.suggestion||'').slice(0,1200),confidence:Number(item.confidence??1),anchorHash:require('node:crypto').createHash('sha256').update(`${file.path}\\n${side}\\n${anchor}`).digest('hex'),fingerprint:String(item.fingerprint||'')}));}return Object.freeze(out);}\nfunction qualityContextBlocks(evidence){",1)
export_old="module.exports = Object.freeze({ unifiedDiffText, textCandidate, cheapScore, collectImpact, loadSarif, collectServiceQualityEvidence, qualityContextBlocks });"
export_new="module.exports = Object.freeze({ unifiedDiffText, textCandidate, cheapScore, collectImpact, loadSarif, collectServiceQualityEvidence, qualityContextBlocks, anchorAnalyzerFindings });"
if export_old in s:
    s=s.replace(export_old,export_new,1)
elif export_new not in s:
    raise SystemExit('quality export marker missing; refusing to leave anchorAnalyzerFindings private')
q.write_text(s)

p=Path('src/service.js')
s=p.read_text()
s=s.replace("const{collectServiceQualityEvidence,qualityContextBlocks}=require('./quality');","const{collectServiceQualityEvidence,qualityContextBlocks,anchorAnalyzerFindings}=require('./quality');",1)
s=s.replace("const qualityEvidence=await collectServiceQualityEvidence(this.gitlab,mr,fullDiffs,this.config),profile=qualityEvidence.profile||resolveReviewProfile(this.config.reviewProfile||'standard');", "const qualityEvidence=await collectServiceQualityEvidence(this.gitlab,mr,fullDiffs,this.config),profile=qualityEvidence.profile||resolveReviewProfile(this.config.reviewProfile||'standard');",1)
s=s.replace("context.blocks=[...(context.blocks||[]),...qualityContextBlocks(qualityEvidence)];context.bytes=(context.bytes||0)+qualityContextBlocks(qualityEvidence).reduce((n,v)=>n+Buffer.byteLength(v,'utf8'),0);", "const globalQualityBlocks=chunk.index===0?qualityContextBlocks(qualityEvidence):[];context.blocks=[...(context.blocks||[]),...globalQualityBlocks];context.bytes=(context.bytes||0)+globalQualityBlocks.reduce((n,v)=>n+Buffer.byteLength(v,'utf8'),0);",1)
s=s.replace("let review=consolidateReviews(reviewSnapshot,results,policy);review=mergeCarriedFindings(review,incremental?.carriedFindings||[],policy);", "let review=consolidateReviews(reviewSnapshot,results,policy);review=mergeCarriedFindings(review,anchorAnalyzerFindings(fullSnapshot,qualityEvidence.analyzerFindings),policy);review=mergeCarriedFindings(review,incremental?.carriedFindings||[],policy);",1)
log_old="this.logger.error?.({event:shouldRetry?'review_retry':'review_failed',traceId:job.trace_id,jobId:job.id,projectId:job.project_id,mrIid:job.mr_iid,attempt:job.attempt,code,status:error?.status||null});"
log_new="this.logger.error?.({event:shouldRetry?'review_retry':'review_failed',traceId:job.trace_id,jobId:job.id,projectId:job.project_id,mrIid:job.mr_iid,attempt:job.attempt,code,status:error?.status||null,message:String(error?.message||'').slice(0,500)});"
if log_old in s:
    s=s.replace(log_old,log_new,1)
elif log_new not in s:
    raise SystemExit('service bounded error telemetry marker missing')
p.write_text(s)
