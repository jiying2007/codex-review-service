'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const{loadConfig,CONFIG_SCHEMA_VERSION}=require('../src/config');
function signingToken(){return`whsec_${Buffer.alloc(32,7).toString('base64')}`;}
function withEnv(values,fn){const old={};for(const[key,value]of Object.entries(values)){old[key]=process.env[key];if(value===undefined)delete process.env[key];else process.env[key]=value;}try{return fn();}finally{for(const[key,value]of Object.entries(old)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}}
test('cost-aware review controls have bounded production defaults',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-review-cost-config-')),file=path.join(dir,'config.json');fs.writeFileSync(file,JSON.stringify({schemaVersion:CONFIG_SCHEMA_VERSION,gitlab:{baseUrl:'https://gitlab.test',projects:[7]},runner:{mode:'inline'}}));try{withEnv({CODEX_REVIEW_CONFIG_FILE:file,GITLAB_API_TOKEN:'token',GITLAB_WEBHOOK_SIGNING_TOKEN:signingToken()},()=>{const config=loadConfig();assert.equal(config.maxTotalDiffBytes,config.maxDiffBytes);assert.equal(Object.prototype.hasOwnProperty.call(config,'incrementalReviewEnabled'),false);assert.equal(config.adaptiveContextEnabled,true);assert.equal(config.mrMaxTokenBudget,250000);assert.equal(config.projectDailyTokenBudget,5000000);assert.equal(config.codexFastModel,'');});}finally{fs.rmSync(dir,{recursive:true,force:true});}});
