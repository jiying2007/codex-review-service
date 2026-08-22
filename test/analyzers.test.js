'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const{runDeterministicAnalyzers}=require('../src/analyzers');
function file(path,line=1){return{path,skipped:false,changedLines:{new:[line],old:[],anchors:{new:{[line]:`${path}:${line}`},old:{}}}};}
function policy(reviewRules){return{reviewRules};}

test('Policy v3 forbidden path produces deterministic blocking finding',()=>{const result=runDeterministicAnalyzers({files:[file('infra/prod.yml')]},policy({forbiddenPathPrefixes:['infra/'],requireTestsForCodeChanges:false}));assert.equal(result.findings.length,1);assert.equal(result.findings[0].severity,'high');assert.equal(result.findings[0].confidence,1);assert.equal(result.violations[0].rule,'forbiddenPathPrefix');});

test('Policy v3 code change without configured test path produces deterministic test finding',()=>{const result=runDeterministicAnalyzers({files:[file('src/a.js')]},policy({forbiddenPathPrefixes:[],requireTestsForCodeChanges:true,codePathPrefixes:['src/'],testPathPrefixes:['test/']}));assert.equal(result.findings.length,1);assert.equal(result.findings[0].category,'test');assert.equal(result.violations[0].rule,'requireTestsForCodeChanges');});

test('Policy v3 test change satisfies deterministic code/test rule',()=>{const result=runDeterministicAnalyzers({files:[file('src/a.js'),file('test/a.test.js')]},policy({forbiddenPathPrefixes:[],requireTestsForCodeChanges:true,codePathPrefixes:['src/'],testPathPrefixes:['test/']}));assert.equal(result.findings.length,0);assert.equal(result.violations.length,0);});

test('absent Policy v3 review.rules does not invent a deterministic violation',()=>{const result=runDeterministicAnalyzers({files:[file('src/a.js')]},{reviewRules:{}});assert.equal(result.findings.length,0);assert.equal(result.violations.length,0);});
