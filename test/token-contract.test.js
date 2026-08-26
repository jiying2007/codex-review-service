'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const{outputSchema,buildPrompt,deterministicSummary}=require('../src/review');

test('structured model contract returns findings only',()=>{const schema=outputSchema(5);assert.deepEqual(schema.required,['findings']);assert.equal(schema.properties.summary,undefined);assert.equal(schema.properties.findings.maxItems,5);});
test('stable MR metadata precedes chunk-specific prompt content for cache reuse',()=>{const snapshot={title:'T',description:'D',chunks:[{},{}]},chunk={index:0,files:[{path:'a.js'}],diffText:'diff --git a/a.js b/a.js\n@@ -1 +1 @@\n-a\n+b'},policy={language:'en',extraInstructions:'focus'},prompt=buildPrompt(snapshot,chunk,policy,{blocks:[]});assert.ok(prompt.indexOf('MR title')<prompt.indexOf('Chunk:'));assert.ok(prompt.indexOf('TARGET-BRANCH REVIEW EMPHASIS')<prompt.indexOf('Chunk:'));assert.match(prompt,/controller generates the review summary deterministically/i);});
test('controller summary is deterministic',()=>{const findings=[{severity:'high'},{severity:'medium'}],a=deterministicSummary(findings,{language:'en'}),b=deterministicSummary(findings,{language:'en'});assert.equal(a,b);assert.match(a,/Validated 2 finding/);});
