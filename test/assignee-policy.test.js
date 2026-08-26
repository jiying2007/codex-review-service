'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {normalizeEvent}=require('../src/webhook');
const config={gitlabProjectAllowlist:new Set([7]),requiredAssigneeUserIds:[8],manualReviewBypassAssignee:true,triggerOnOpen:true,triggerOnPush:true,triggerOnReopen:true,botUsername:'bot'};
function mr(assignees){return{object_kind:'merge_request',project:{id:7},assignees,object_attributes:{iid:9,action:'open',last_commit:{id:'head'}}};}
test('automatic review requires a configured assignee',()=>{assert.equal(normalizeEvent(mr([{id:8}]),{},config).shouldReview,true);assert.equal(normalizeEvent(mr([{id:9}]),{},config).shouldReview,false);assert.equal(normalizeEvent(mr([]),{},config).shouldReview,false);});
test('manual review bypass is explicit and configurable',()=>{const event={object_kind:'note',project:{id:7},user:{id:12,username:'alice'},merge_request:{iid:9,assignees:[{id:9}]},object_attributes:{action:'create',note:'/codex review'}};assert.equal(normalizeEvent(event,{},config).shouldReview,true);assert.equal(normalizeEvent(event,{}, {...config,manualReviewBypassAssignee:false}).shouldReview,false);});
