'use strict';

const { GitLabClient, encodeProject } = require('./gitlab');

if (typeof GitLabClient.prototype.listPipelineJobs !== 'function') {
  GitLabClient.prototype.listPipelineJobs = function listPipelineJobs(projectId,pipelineId) {
    return this.paginated(`/projects/${encodeProject(projectId)}/pipelines/${encodeURIComponent(String(pipelineId))}/jobs`, { include_retried: true });
  };
}
if (typeof GitLabClient.prototype.getJobArtifactFile !== 'function') {
  GitLabClient.prototype.getJobArtifactFile = async function getJobArtifactFile(projectId,jobId,artifactPath) {
    const clean=String(artifactPath||'').replace(/\\/g,'/').replace(/^\.\//,'');
    if(!clean||clean.startsWith('/')||clean.split('/').includes('..')){const error=new Error('Artifact path must be repository-style relative path');error.code='EARTIFACTPATH';throw error;}
    const response=await this.request('GET',`/projects/${encodeProject(projectId)}/jobs/${encodeURIComponent(String(jobId))}/artifacts/${clean.split('/').map(encodeURIComponent).join('/')}`,{expected:[200,404],accept:'text'});
    return response.status===404?null:response.data;
  };
}

module.exports=Object.freeze({installed:true});
