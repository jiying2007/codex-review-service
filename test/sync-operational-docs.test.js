'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const{syncOperations,syncSecurity,syncLongTermAsset}=require('../scripts/sync-operational-docs');

test('operations sync replaces the whole prior identity sentence without leaving semver fragments',()=>{
  const input='From v5.0.0 onward. Service 7.4.3 keeps Config Schema 7 and Database Schema 8 while consuming Runtime/Provider Contract v3; no DB/config schema migration is introduced by 7.4.3. Service 7.2.x used Config Schema 6 for responsibility delivery.';
  const output=syncOperations(input);
  assert.match(output,/Service 7\.5\.3 uses Config Schema 8 and Database Schema 8 while consuming Runtime\/Provider Contract v3 and Model Routing Contract v1/);
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
    .replace('Codex Review Service **7.5.3**','Codex Review Service **7.4.3**')
    .replace('Database Schema 8, Config Schema 8, Policy Schema 4, Review Receipt 5, Safe Contract 2, Runtime/Provider Contract v3, Model Routing Contract v1','Database Schema 8, Config Schema 7, Policy Schema 4, Review Receipt 5, Safe Contract 2, Runtime/Provider Contract v3')
    .replace('**Config Schema 8**','**Config Schema 7**')
    .replace('Config Schema 8 consumes Provider Contract v3 and Model Routing Contract v1.','Config Schema 7 consumes Provider Contract v3 controls:');
  const repaired=syncSecurity(stale);
  assert.equal(repaired,current);
  assert.equal(syncSecurity(repaired),repaired);
});

test('long-term asset sync upgrades stale product identity and is idempotent',()=>{
  const current=fs.readFileSync(path.join(__dirname,'..','LONG_TERM_ASSET.md'),'utf8');
  const stale=current
    .replace('Service **v7.5.3** is the current production-operations baseline','Service **v7.3.0** is the current production-operations baseline')
    .replace(/`product-contract\.json` is the machine-checked product fact source:[^\n]+/,'`product-contract.json` is the machine-checked product fact source: Service 7.3.0, Database Schema 8, Config Schema 7, Policy Schema 4, Review Receipt 5, Safe Contract 2, Runtime Contract 2, Provider Contract 2, Profile Pack 1, Test Impact 1, Analyzer Adapter 1, Judgment Lifecycle 1, exact Safe Core commit `7878dae982088746c06e4fe747b2468e6af274a2`, Node 22.22.2+/24.19.0+ LTS support and GitLab >=14.6.1 compatibility.')
    .replace('Current runtime accepts **Config Schema 8** only','Current runtime accepts **Config Schema 7** only')
    .replace(/^31\..+$/m,'31. Service 7.3.0 makes Config Schema 6 -> 7 a documented configuration hard cut for Provider Contract v2. Service 7.2.0 made Config Schema 5 -> 6 the responsibility-notification hard cut, and Service 7.0.0 made Config Schema 4 -> 5 the Judgment Lifecycle hard cut. Rollback across database/config boundaries requires the matching verified backup and target-release configuration; runtime translation or in-place Schema downgrade is forbidden.')
    .replace(/^40\..+$/m,'40. Current documentation must describe Service v7.3.0, Database Schema 8, Config Schema 7, Review Receipt 5, Runtime/Provider Contract v2 and exact Safe Core 4.12.0 accurately; historical labels belong only in changelog/migration history.')
    .replace('shared review/safety/Judgment Lifecycle/Runtime/Provider/Model Routing semantics','shared review/safety/Judgment Lifecycle/Runtime/Provider semantics')
    .replace('README/README.zh-CN/OPERATIONS/SECURITY/ARCHITECTURE/LONG_TERM_ASSET','README/README.zh-CN/OPERATIONS/SECURITY/ARCHITECTURE');
  const repaired=syncLongTermAsset(stale);
  assert.equal(repaired,current);
  assert.equal(syncLongTermAsset(repaired),repaired);
});
