'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const{syncOperations,syncSecurity}=require('../scripts/sync-operational-docs');

test('operations sync replaces the whole prior identity sentence without leaving semver fragments',()=>{
  const input='From v5.0.0 onward. Service 7.4.3 keeps Config Schema 7 and Database Schema 8 while consuming Runtime/Provider Contract v3; no DB/config schema migration is introduced by 7.4.3. Service 7.2.x used Config Schema 6 for responsibility delivery.';
  const output=syncOperations(input);
  assert.match(output,/Service 7\.5\.0 uses Config Schema 8 and Database Schema 8 while consuming Runtime\/Provider Contract v3 and Model Routing Contract v1/);
  assert.doesNotMatch(output,/\.4\.3\./);
  assert.equal((output.match(/Service 7\.2\.x/g)||[]).length,1);
});

test('operations sync repairs the previously generated partial-version artifact and is idempotent',()=>{
  const malformed='From v5.0.0 onward. Service 7.5.0 uses Config Schema 8 and Database Schema 8 while consuming Runtime/Provider Contract v3 and Model Routing Contract v1; the hard cut retires `codex.model`/`codex.fastModel`.4.3. Service 7.2.x used Config Schema 6 for responsibility delivery.';
  const repaired=syncOperations(malformed);
  assert.doesNotMatch(repaired,/\.4\.3\./);
  assert.equal(syncOperations(repaired),repaired);
});

test('security sync upgrades stale release/schema routing identity and is idempotent',()=>{
  const current=fs.readFileSync(path.join(__dirname,'..','SECURITY.md'),'utf8');
  const stale=current
    .replace('Codex Review Service **7.5.0**','Codex Review Service **7.4.3**')
    .replace('Database Schema 8, Config Schema 8, Policy Schema 4, Review Receipt 5, Safe Contract 2, Runtime/Provider Contract v3, Model Routing Contract v1','Database Schema 8, Config Schema 7, Policy Schema 4, Review Receipt 5, Safe Contract 2, Runtime/Provider Contract v3')
    .replace('**Config Schema 8**','**Config Schema 7**')
    .replace('Config Schema 8 consumes Provider Contract v3 and Model Routing Contract v1.','Config Schema 7 consumes Provider Contract v3 controls:');
  const repaired=syncSecurity(stale);
  assert.equal(repaired,current);
  assert.equal(syncSecurity(repaired),repaired);
});
