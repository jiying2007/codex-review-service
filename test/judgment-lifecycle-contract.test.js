'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const core=require('../src/codex-safe-core');
const contract=require('../product-contract.json');

test('Service 7 hard-cuts persistent judgment reuse from the product surface',()=>{
  assert.equal(contract.judgmentLifecycleVersion,core.JUDGMENT_LIFECYCLE_VERSION);
  assert.equal(contract.reviewReceiptVersion,core.REVIEW_RECEIPT_SCHEMA_VERSION);
  assert.equal(contract.judgmentLifecycleVersion,1);
  assert.equal(contract.reviewReceiptVersion,5);
  const config=fs.readFileSync(path.join(__dirname,'../src/config.js'),'utf8');
  const service=fs.readFileSync(path.join(__dirname,'../src/service.js'),'utf8');
  assert.doesNotMatch(config,/incrementalReviewEnabled/);
  assert.doesNotMatch(service,/prepareIncremental|latestBaseline|carryForwardFindings|mergeCarriedFindings/);
  const planner=require('../src/cost-planner');
  for(const name of ['changedPathsFromCompare','subsetDiffResult','carryForwardFindings','mergeCarriedFindings'])assert.equal(Object.hasOwn(planner,name),false,`${name} must remain retired`);
});

test('same-SHA webhook idempotency is delivery-scoped, not judgment-scoped',()=>{
  const service=fs.readFileSync(path.join(__dirname,'../src/service.js'),'utf8');
  assert.match(service,/dedupeKey=`\$\{manual\?'command':'event'\}:\$\{webhookId\}`/);
  assert.match(service,/dedupeKey:`reconcile:\$\{startSha\}:\$\{headSha\}`/);
  assert.doesNotMatch(service,/dedupeKey:`snapshot:/);
});
