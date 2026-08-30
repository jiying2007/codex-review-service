'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const{FORMATS,parseAnalyzerArtifact}=require('../src/analyzer-adapters');

function prng(seed=0x5afe2026){let state=seed>>>0;return()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/0x100000000;};}
function mutate(base,random){let text=String(base);const weird=['\u0000','\u202e','../../','${{ secrets.TOKEN }}','<script>','&amp;','\\\\server\\share','💥','"__proto__"','A'.repeat(128)];for(let i=0;i<6;i++){const op=Math.floor(random()*4),at=Math.floor(random()*(text.length+1)),token=weird[Math.floor(random()*weird.length)];if(op===0)text=text.slice(0,at)+token+text.slice(at);else if(op===1&&text.length)text=text.slice(0,at)+text.slice(Math.min(text.length,at+1+Math.floor(random()*8)));else if(op===2)text=text.slice(0,Math.floor(random()*(text.length+1)));else text=text.slice(0,at)+String.fromCharCode(Math.floor(random()*0x80))+text.slice(at);}return text;}
const seeds={
  sarif:'{"version":"2.1.0","runs":[]}',
  'gitlab-codequality':'[]',
  junit:'<testsuites><testsuite tests="1"><testcase name="ok"/></testsuite></testsuites>',
  cobertura:'<coverage line-rate="0.5" branch-rate="0.25"/>',
  lcov:'SF:src/a.c\nLF:2\nLH:1\nend_of_record\n',
  compiler:'src/a.c:1:1: warning: bounded warning\n',
  cppcheck:'<results><errors/></results>',
  'cyclonedx-json':'{"bomFormat":"CycloneDX","specVersion":"1.6","components":[]}',
  'trivy-json':'{"Results":[]}',
  'gitleaks-json':'[]'
};
function assertBounded(result){assert.ok(result&&FORMATS.includes(result.format));assert.ok(Number.isInteger(result.bytes)&&result.bytes>=0&&result.bytes<=64*1024);assert.ok(Array.isArray(result.findings));for(const finding of result.findings){assert.equal(typeof finding.file,'string');assert.ok(finding.file.length<=1024);assert.ok(Number.isInteger(finding.line)&&finding.line>=1);assert.ok(['critical','high','medium','low','info'].includes(finding.severity));assert.equal(typeof finding.message,'string');assert.ok(finding.message.length<=2000);}}

test('all analyzer adapters survive deterministic malformed/mutated artifacts without unbounded output',()=>{const random=prng();for(const format of FORMATS){for(let i=0;i<40;i++){const content=mutate(seeds[format],random);try{assertBounded(parseAnalyzerArtifact({format,content,maxBytes:64*1024}));}catch(error){assert.ok(['EANALYZERFORMAT','EANALYZERSIZE'].includes(error.code)||error instanceof TypeError,`${format} leaked unexpected error: ${error.code||error.name}: ${error.message}`);}}}});
test('oversized mutation always fails before parsing',()=>{for(const format of FORMATS)assert.throws(()=>parseAnalyzerArtifact({format,content:'x'.repeat(2049),maxBytes:1024}),error=>error.code==='EANALYZERSIZE');});
test('artifact text remains data and never becomes executable configuration',()=>{const payload='src/a.c:7:1: error: $(touch /tmp/codex-safe-fuzz-owned) && curl http://127.0.0.1/\n';const result=parseAnalyzerArtifact({format:'compiler',content:payload});assert.equal(result.findings.length,1);assert.match(result.findings[0].message,/touch/);assert.equal(require('node:fs').existsSync('/tmp/codex-safe-fuzz-owned'),false);});
