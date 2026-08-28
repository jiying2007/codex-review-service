'use strict';

function memberIds(value){return(Array.isArray(value)?value:[]).map(item=>Number(item?.id)).filter(Number.isInteger);}
function currentAssignments(payload,attrs={}){
  const assignees=Array.isArray(payload.assignees)?payload.assignees:Array.isArray(attrs.assignees)?attrs.assignees:(payload.assignee?[payload.assignee]:[]);
  const reviewers=Array.isArray(payload.reviewers)?payload.reviewers:Array.isArray(attrs.reviewers)?attrs.reviewers:[];
  return{assignees,reviewers};
}
function roleMatch(value,userIds){const ids=memberIds(value),required=Array.isArray(userIds)?userIds:[];return required.length?required.some(id=>ids.includes(id)):ids.length>0;}
function assignmentMatch(assignments,policy={mode:'reviewer',userIds:[]}){const mode=policy?.mode||'reviewer',userIds=policy?.userIds||[];if(mode==='always')return true;if(mode==='reviewer')return roleMatch(assignments.reviewers,userIds);if(mode==='assignee')return roleMatch(assignments.assignees,userIds);if(mode==='either')return roleMatch(assignments.reviewers,userIds)||roleMatch(assignments.assignees,userIds);return false;}
function assignmentChangeRelevant(changes,mode='reviewer'){if(mode==='always'||!changes||typeof changes!=='object'||Array.isArray(changes))return false;const has=key=>Object.prototype.hasOwnProperty.call(changes,key),reviewerChanged=has('reviewers')||has('reviewer_ids'),assigneeChanged=has('assignees')||has('assignee')||has('assignee_id')||has('assignee_ids');if(mode==='reviewer')return reviewerChanged;if(mode==='assignee')return assigneeChanged;if(mode==='either')return reviewerChanged||assigneeChanged;return false;}
module.exports={memberIds,currentAssignments,roleMatch,assignmentMatch,assignmentChangeRelevant};
