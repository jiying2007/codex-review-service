'use strict';

const { SEVERITIES } = require('./config');
const { POLICY_FILE, parsePolicyDocument } = require('./codex-safe-core/policy');
const { fingerprintPolicy } = require('./codex-safe-core/safe-contract');

const SEVERITY_ORDER = Object.freeze({critical:5,high:4,medium:3,low:2,info:1});

function policyError(message, cause) { const error=new Error(message);error.code='EPROJECTPOLICY';if(cause)error.cause=cause;return error; }
function boundedInteger(value,fallback,min,max){return value===undefined?fallback:Math.max(min,Math.min(max,value));}

async function getEffectivePolicy(gitlab, projectId, mr, config) {
  const defaults = {
    language:config.language,
    maxDiffBytes:config.maxDiffBytes,
    maxFindings:config.maxFindings,
    severityThreshold:'info',
    timeoutSeconds:config.reviewTimeoutSeconds,
    extraInstructions:'',
    blockingSeverity:config.blockingSeverity,
    maxReviewChunks:config.maxReviewChunks,
    maxPublishedFindings:config.maxPublishedFindings,
    minConfidence:config.minConfidence,
    skipGeneratedFiles:config.skipGeneratedFiles,
    blockUnreviewableFiles:config.blockUnreviewableFiles,
    maxContextBytes:config.maxContextBytes,
    maxContextFiles:config.maxContextFiles,
    contextLines:config.contextLines,
    reviewRules:Object.freeze({})
  };
  if (!config.projectPolicyEnabled) return Object.freeze({...defaults,source:'service-default',fingerprint:fingerprintPolicy(defaults)});
  const policyRef=String(mr.diff_refs?.start_sha||'').trim();
  if (!policyRef) throw policyError('Merge request diff_refs.start_sha is unavailable for repository policy snapshot');
  const raw=await gitlab.getRepositoryFileRaw(projectId,POLICY_FILE,policyRef);
  if (raw===null) return Object.freeze({...defaults,source:'target-default',fingerprint:fingerprintPolicy(defaults)});
  if (Buffer.byteLength(raw,'utf8')>config.projectPolicyMaxBytes) throw policyError(`${POLICY_FILE} exceeds configured project policy byte limit`);
  let document;
  try { document=parsePolicyDocument(raw); }
  catch(cause) { throw policyError(`${POLICY_FILE} is not valid Policy Schema v4: ${cause.message}`,cause); }
  const review=document.review||{},service=document.reviewService||{};
  if (review.severityThreshold!==undefined && SEVERITY_ORDER[review.severityThreshold]>SEVERITY_ORDER[config.blockingSeverity]) {
    throw policyError(`review.severityThreshold cannot hide globally blocking ${config.blockingSeverity} findings`);
  }
  const effective={
    ...defaults,
    language:review.language??defaults.language,
    maxDiffBytes:Math.min(review.maxDiffBytes??defaults.maxDiffBytes,config.maxDiffBytes),
    maxFindings:Math.min(review.maxFindings??defaults.maxFindings,config.maxFindings),
    severityThreshold:review.severityThreshold??defaults.severityThreshold,
    timeoutSeconds:Math.min(review.timeoutSeconds??defaults.timeoutSeconds,config.reviewTimeoutSeconds),
    extraInstructions:review.extraInstructions??defaults.extraInstructions,
    minConfidence:Math.max(review.confidenceThreshold??defaults.minConfidence,config.minConfidence),
    maxContextBytes:Math.min(service.maxContextBytes??defaults.maxContextBytes,config.maxContextBytes),
    maxContextFiles:Math.min(service.maxContextFiles??defaults.maxContextFiles,config.maxContextFiles),
    contextLines:Math.min(service.contextLines??defaults.contextLines,config.contextLines),
    skipGeneratedFiles:service.skipGeneratedFiles===undefined?defaults.skipGeneratedFiles:Boolean(service.skipGeneratedFiles),
    blockUnreviewableFiles:Boolean(defaults.blockUnreviewableFiles||service.blockUnreviewableFiles),
    reviewRules:Object.freeze({...review.rules}),
    source:`target:${POLICY_FILE}@${policyRef.slice(0,12)}`
  };
  effective.fingerprint=fingerprintPolicy({...effective,source:undefined});
  return Object.freeze(effective);
}

module.exports={POLICY_FILE,SEVERITY_ORDER,getEffectivePolicy,policyError};
