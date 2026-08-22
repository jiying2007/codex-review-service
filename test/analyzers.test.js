'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const{runDeterministicAnalyzers}=require('../src/analyzers');
function file(path,line=1){return{path,skipped:false,changedLines:{new:[line],old:[],anchors:{new:{[line]:`${path}:${line}`},old:{}}}};}

test('forbidden target-policy path produces deterministic blocking finding',()=>{const result=runDeterministicAnalyzers({files:[file('infra/prod.yml')]},{forbiddenPathPrefixes:['infra/'],requireTestsForCodeChanges:false});assert.equal(result.findings.length,1);assert.equal(result.findings[0].severity,'high');assert.equal(result.findings[0].confidence,1);});

test('code change without configured test path produces deterministic test finding',()=>{const result=runDeterministicAnalyzers({files:[file('src/a.js')]},{forbiddenPathPrefixes:[],requireTestsForCodeChanges:true,codePathPrefixes:['src/'],testPathPrefixes:['test/']});assert.equal(result.findings.length,1);assert.equal(result.findings[0].category,'test');});

test('test change satisfies deterministic code/test rule',()=>{const result=runDeterministicAnalyzers({files:[file('src/a.js'),file('test/a.test.js')]},{forbiddenPathPrefixes:[],requireTestsForCodeChanges:true,codePathPrefixes:['src/'],testPathPrefixes:['test/']});assert.equal(result.findings.length,0);});
