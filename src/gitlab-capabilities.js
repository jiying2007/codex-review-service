'use strict';

const {MINIMUM_GITLAB_VERSION,MODERN_GITLAB_PROFILE_MINIMUM_VERSION,STANDARD_WEBHOOK_MINIMUM_GITLAB_VERSION}=require('./product-contract');

function parseVersion(value){
  const match=String(value||'').trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if(!match)return null;
  return match.slice(1,4).map(Number);
}

function compareVersions(left,right){
  const a=parseVersion(left),b=parseVersion(right);
  if(!a||!b)return null;
  for(let i=0;i<3;i++){
    if(a[i]>b[i])return 1;
    if(a[i]<b[i])return -1;
  }
  return 0;
}

function versionAtLeast(value,minimum){
  const result=compareVersions(value,minimum);
  return result!==null&&result>=0;
}

function selectGitLabCapabilities(version){
  if(!parseVersion(version)){
    const error=new Error(`GitLab returned an invalid version: ${String(version||'unknown')}`);
    error.code='EGITLABVERSION';
    throw error;
  }
  if(!versionAtLeast(version,MINIMUM_GITLAB_VERSION)){
    const error=new Error(`GitLab ${version} is below the supported minimum ${MINIMUM_GITLAB_VERSION}`);
    error.code='EGITLABVERSION';
    error.version=version;
    error.minimumVersion=MINIMUM_GITLAB_VERSION;
    throw error;
  }
  const modernDiff=versionAtLeast(version,MODERN_GITLAB_PROFILE_MINIMUM_VERSION);
  const standardWebhook=versionAtLeast(version,STANDARD_WEBHOOK_MINIMUM_GITLAB_VERSION);
  return Object.freeze({
    version,
    profile:modernDiff?'modern':'classic',
    mergeRequestDiffs:modernDiff?'diffs':'changes',
    diffCompleteness:modernDiff?'versions-real-size':'changes-overflow',
    webhookAuth:standardWebhook?'standard-hmac':'classic-token',
    webhookDeliveryIdentity:standardWebhook?'provider-id':'body-sha256',
    webhookReplayWindow:standardWebhook,
    webhookInstanceHeader:standardWebhook,
  });
}

function applyGitLabCapabilities(config,capabilities){
  const classic=capabilities.webhookAuth==='classic-token';
  const secret=classic?config.webhookClassicToken:config.webhookSigningToken;
  if(!secret){
    const error=new Error(classic?'GITLAB_WEBHOOK_CLASSIC_TOKEN is required for this GitLab version':'GITLAB_WEBHOOK_SIGNING_TOKEN is required for this GitLab version');
    error.code='EWEBHOOKSECRET';
    throw error;
  }
  return Object.freeze({...config,gitlabCapabilities:capabilities,webhookAuthMode:capabilities.webhookAuth,requireInstanceHeader:classic?false:config.requireInstanceHeader});
}

module.exports={parseVersion,compareVersions,versionAtLeast,selectGitLabCapabilities,applyGitLabCapabilities};
