'use strict';

function scopeError(message,code='EPROJECTSCOPE'){const error=new Error(message);error.code=code;return error;}

async function resolveProjectScope(gitlab,config){
  if(config.gitlabScopeWildcard)return{projects:null,mode:'webhook-only-wildcard',explicitProjects:0,groups:0,discoveredProjects:0};
  const projects=new Set(config.gitlabProjectAllowlist||[]),explicitProjects=projects.size;
  for(const group of config.gitlabGroups||[]){
    let result;
    try{result=await gitlab.listGroupProjects(group.id,{includeSubgroups:group.includeSubgroups});}
    catch(cause){const error=scopeError(`Failed to discover projects for GitLab group ${group.id}`);error.cause=cause;throw error;}
    if(!result?.complete)throw scopeError(`GitLab group ${group.id} project discovery was incomplete`,'EPROJECTSCOPEPAGINATION');
    for(const project of result.items||[]){const id=Number(project?.id||0);if(Number.isInteger(id)&&id>0)projects.add(id);}
  }
  if(!projects.size)throw scopeError('Resolved GitLab project scope is empty');
  return{projects,mode:(config.gitlabGroups||[]).length?'projects+groups':'projects',explicitProjects,groups:(config.gitlabGroups||[]).length,discoveredProjects:projects.size-explicitProjects};
}

function applyResolvedScope(config,resolved){return Object.freeze({...config,gitlabProjectAllowlist:resolved.projects,gitlabScopeMode:resolved.mode,gitlabScopeStats:Object.freeze({explicitProjects:resolved.explicitProjects,groups:resolved.groups,discoveredProjects:resolved.discoveredProjects,totalProjects:resolved.projects?.size||0})});}

module.exports={resolveProjectScope,applyResolvedScope,scopeError};
