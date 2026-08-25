'use strict';

const {MINIMUM_GITLAB_VERSION,MODERN_GITLAB_PROFILE_MINIMUM_VERSION}=require('./product-contract');

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
  const modern=versionAtLeast(version,MODERN_GITLAB_PROFILE_MINIMUM_VERSION);
  return Object.freeze({
    version,
    profile:modern?'modern':'classic',
    mergeRequestDiffs:modern?'diffs':'changes',
    diffCompleteness:modern?'versions-real-size':'changes-overflow',
  });
}

module.exports={parseVersion,compareVersions,versionAtLeast,selectGitLabCapabilities};
