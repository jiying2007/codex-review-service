'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {storageCapabilities,assessHaNeed,HA_UPGRADE_THRESHOLDS}=require('../src/storage');

test('SQLite remains the single shipped backend behind an explicit replacement boundary',()=>{
  const caps=storageCapabilities();
  assert.equal(caps.backend,'sqlite');
  assert.equal(caps.migrations,true);
  assert.equal(caps.currentSchemaVersion,6);
  assert.equal(caps.multiControllerHa,false);
  assert.equal(caps.replacementBoundary,'createStorage');
});

test('HA recommendation is threshold driven rather than unconditional infrastructure',()=>{
  assert.equal(assessHaNeed({repositories:10,workers:2,reviewsPerDay:1000}).haRecommended,false);
  assert.deepEqual(assessHaNeed({repositories:HA_UPGRADE_THRESHOLDS.repositoriesPerInstance+1}).reasons,['repository_count']);
  assert.ok(assessHaNeed({crossAzRequired:true}).reasons.includes('cross_az'));
  assert.ok(assessHaNeed({zeroSingleNodeDowntimeRequired:true}).reasons.includes('single_node_downtime'));
});
