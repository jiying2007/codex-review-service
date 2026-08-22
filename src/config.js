'use strict';

const path=require('node:path');
const SEVERITIES=Object.freeze(['critical','high','medium','low','info']);
function intEnv(name,fallback,min,max){const raw=process.env[name];if(raw===undefined||raw==='')return fallback;const value=Number(raw);if(!Number.isInteger(value)||value<min||value>max)throw new Error(`${name} must be an integer between ${min} and ${max}`);return value;}
function numberEnv(name,fallback,min,max){const raw=process.env[name];if(raw===undefined||raw==='')return fallback;const value=Number(raw);if(!Number.isFinite(value)||value<min||value>max)throw new Error(`${name} must be a number between ${min} and ${max}`);return value;}
function boolEnv(name,fallback){const raw=process.env[name];if(raw===undefined||raw==='')return fallback;const value=raw.toLowerCase();if(['1','true','yes','on'].includes(value))return true;if(['0','false','no','off'].includes(value))return false;throw new Error(`${name} must be a boolean`);}
function stringEnv(name,fallback='',maxLength=4096){const value=String(process.env[name]??fallback).trim();if(value.length>maxLength||/[\r\n\0]/.test(value))throw new Error(`${name} is invalid`);return value;}
function required(name){const value=stringEnv(name,'');if(!value)throw new Error(`${name} is required`);return value;}
function normalizeBaseUrl(value,name){let url;try{url=new URL(value);}catch{throw new Error(`${name} must be a valid URL`);}if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error(`${name} must be an http(s) base URL without credentials, query, or fragment`);return url.toString().replace(/\/$/,'');}
function parseProjectAllowlist(raw){const value=String(raw||'').trim();if(!value)throw new Error('GITLAB_PROJECT_ALLOWLIST is required; use * or a comma-separated list of numeric project IDs');if(value==='*')return null;const ids=new Set();for(const token of value.split(',').map(v=>v.trim()).filter(Boolean)){if(!/^\d+$/.test(token)||Number(token)<=0)throw new Error('GITLAB_PROJECT_ALLOWLIST contains an invalid project ID');ids.add(Number(token));}if(!ids.size)throw new Error('GITLAB_PROJECT_ALLOWLIST must not be empty');return ids;}
function validateSigningToken(value){if(!value)return'';if(!value.startsWith('whsec_'))throw new Error('GITLAB_WEBHOOK_SIGNING_TOKEN must start with whsec_');const encoded=value.slice(6),key=Buffer.from(encoded,'base64');if(key.length!==32)throw new Error('GITLAB_WEBHOOK_SIGNING_TOKEN must encode exactly 32 bytes');if(encoded.replace(/=+$/,'')!==key.toString('base64').replace(/=+$/,''))throw new Error('GITLAB_WEBHOOK_SIGNING_TOKEN contains invalid base64');return value;}
function severityEnv(name,fallback){const value=stringEnv(name,fallback,32).toLowerCase();if(!SEVERITIES.includes(value))throw new Error(`${name} must be one of: ${SEVERITIES.join(', ')}`);return value;}
function enumEnv(name,fallback,allowed){const value=stringEnv(name,fallback,64);if(!allowed.includes(value))throw new Error(`${name} must be one of: ${allowed.join(', ')}`);return value;}

function loadConfig(){
  const dataDir=path.resolve(process.env.CODEX_REVIEW_DATA_DIR||'.data');
  const gitlabBaseUrl=normalizeBaseUrl(required('GITLAB_BASE_URL'),'GITLAB_BASE_URL');
  const gitlabToken=required('GITLAB_API_TOKEN');
  const webhookSigningToken=validateSigningToken(stringEnv('GITLAB_WEBHOOK_SIGNING_TOKEN'));
  const webhookSecretToken=stringEnv('GITLAB_WEBHOOK_SECRET_TOKEN','',8192);
  if(!webhookSigningToken&&!webhookSecretToken)throw new Error('GITLAB_WEBHOOK_SIGNING_TOKEN or GITLAB_WEBHOOK_SECRET_TOKEN is required');
  const language=enumEnv('REVIEW_LANGUAGE','zh-CN',['zh-CN','en']);
  return Object.freeze({
    host:stringEnv('HOST','127.0.0.1',255)||'127.0.0.1',port:intEnv('PORT',8787,1,65535),dataDir,dbPath:path.join(dataDir,'review-service.sqlite'),
    gitlabBaseUrl,gitlabApiUrl:`${gitlabBaseUrl}/api/v4`,gitlabToken,gitlabProjectAllowlist:parseProjectAllowlist(process.env.GITLAB_PROJECT_ALLOWLIST),
    gitlabRequestTimeoutMs:intEnv('GITLAB_REQUEST_TIMEOUT_MS',30000,1000,120000),gitlabMaxPages:intEnv('GITLAB_MAX_PAGES',200,1,1000),gitlabStatusRetries:intEnv('GITLAB_STATUS_RETRIES',5,1,10),
    gitlabRequestsPerSecond:intEnv('GITLAB_REQUESTS_PER_SECOND',20,1,200),gitlabCircuitFailureThreshold:intEnv('GITLAB_CIRCUIT_FAILURE_THRESHOLD',8,2,100),gitlabCircuitResetMs:intEnv('GITLAB_CIRCUIT_RESET_MS',30000,1000,600000),
    statusName:stringEnv('GITLAB_STATUS_NAME','codex-review',255)||'codex-review',statusTargetUrl:stringEnv('GITLAB_STATUS_TARGET_URL','',255),bindStatusPipeline:boolEnv('GITLAB_BIND_STATUS_PIPELINE',true),
    webhookSigningToken,webhookSecretToken,webhookExpectedInstance:normalizeBaseUrl(stringEnv('GITLAB_WEBHOOK_EXPECTED_INSTANCE',gitlabBaseUrl,2048)||gitlabBaseUrl,'GITLAB_WEBHOOK_EXPECTED_INSTANCE'),requireInstanceHeader:boolEnv('REQUIRE_GITLAB_INSTANCE_HEADER',true),webhookMaxSkewSeconds:intEnv('WEBHOOK_MAX_SKEW_SECONDS',300,30,3600),webhookMaxBodyBytes:intEnv('WEBHOOK_MAX_BODY_BYTES',1024*1024,4096,10*1024*1024),
    botUsername:stringEnv('GITLAB_BOT_USERNAME','',255),manualMinAccessLevel:intEnv('MANUAL_REVIEW_MIN_ACCESS_LEVEL',30,0,50),
    language,codexPath:stringEnv('CODEX_PATH','codex',1024)||'codex',codexModel:stringEnv('CODEX_MODEL','',128),codexHome:stringEnv('CODEX_HOME','',2048),
    codexVersionPolicy:enumEnv('CODEX_VERSION_POLICY','warn',['off','warn','strict']),codexAllowedVersionPattern:stringEnv('CODEX_ALLOWED_VERSION_PATTERN','',256),
    reviewTimeoutSeconds:intEnv('REVIEW_TIMEOUT_SECONDS',180,30,900),jobTimeoutSeconds:intEnv('JOB_TIMEOUT_SECONDS',900,60,7200),maxJobAttempts:intEnv('MAX_JOB_ATTEMPTS',3,1,10),retryBaseDelayMs:intEnv('RETRY_BASE_DELAY_MS',1000,100,60000),retryMaxDelayMs:intEnv('RETRY_MAX_DELAY_MS',60000,1000,15*60*1000),
    maxDiffBytes:intEnv('MAX_DIFF_BYTES',1024*1024,4096,4*1024*1024),maxReviewChunks:intEnv('MAX_REVIEW_CHUNKS',8,1,32),maxFindings:intEnv('MAX_FINDINGS',40,1,100),maxPublishedFindings:intEnv('MAX_PUBLISHED_FINDINGS',40,1,100),minConfidence:numberEnv('MIN_CONFIDENCE',0.7,0,1),blockingSeverity:severityEnv('BLOCKING_SEVERITY','high'),
    contextEnabled:boolEnv('REVIEW_CONTEXT_ENABLED',true),maxContextBytes:intEnv('MAX_CONTEXT_BYTES',256*1024,0,2*1024*1024),maxContextFiles:intEnv('MAX_CONTEXT_FILES',12,0,100),contextLines:intEnv('CONTEXT_LINES',20,0,200),
    blockUnreviewableFiles:boolEnv('BLOCK_UNREVIEWABLE_FILES',false),skipGeneratedFiles:boolEnv('SKIP_GENERATED_FILES',true),reviewDraftMergeRequests:boolEnv('REVIEW_DRAFT_MERGE_REQUESTS',false),reviewDebounceMs:intEnv('REVIEW_DEBOUNCE_MS',3000,0,60000),
    mrMaxTokenBudget:intEnv('MR_MAX_TOKEN_BUDGET',0,0,1000000000),projectDailyTokenBudget:intEnv('PROJECT_DAILY_TOKEN_BUDGET',0,0,1000000000),
    workerConcurrency:intEnv('WORKER_CONCURRENCY',2,1,8),pollIntervalMs:intEnv('WORKER_POLL_INTERVAL_MS',1000,100,60000),maxQueueDepth:intEnv('MAX_QUEUE_DEPTH',200,1,10000),
    publisherConcurrency:intEnv('PUBLISHER_CONCURRENCY',2,1,8),publisherPollIntervalMs:intEnv('PUBLISHER_POLL_INTERVAL_MS',500,50,60000),maxPublishAttempts:intEnv('MAX_PUBLISH_ATTEMPTS',8,1,50),
    dataRetentionDays:intEnv('DATA_RETENTION_DAYS',30,1,3650),webhookRetentionDays:intEnv('WEBHOOK_RETENTION_DAYS',7,1,3650),maintenanceIntervalMs:intEnv('MAINTENANCE_INTERVAL_MS',60*60*1000,60*1000,24*60*60*1000),reconcileIntervalMs:intEnv('RECONCILE_INTERVAL_MS',5*60*1000,60*1000,24*60*60*1000),readinessCacheMs:intEnv('READINESS_CACHE_MS',5000,500,60000),
    projectPolicyEnabled:boolEnv('PROJECT_POLICY_ENABLED',true),projectPolicyFile:stringEnv('PROJECT_POLICY_FILE','.codex-review.json',1024)||'.codex-review.json',projectPolicyMaxBytes:intEnv('PROJECT_POLICY_MAX_BYTES',64*1024,1024,1024*1024),
    autoResolveObsolete:boolEnv('AUTO_RESOLVE_OBSOLETE',true),triggerOnOpen:boolEnv('TRIGGER_ON_OPEN',true),triggerOnPush:boolEnv('TRIGGER_ON_PUSH',true),triggerOnReopen:boolEnv('TRIGGER_ON_REOPEN',true)
  });
}
module.exports={loadConfig,intEnv,numberEnv,boolEnv,parseProjectAllowlist,validateSigningToken,normalizeBaseUrl,SEVERITIES,enumEnv};
