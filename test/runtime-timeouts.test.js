'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const{runtimeSelectionFromConfig}=require('../src/runtime');

test('provider request timeout defaults to the review operation budget',()=>{
  const selection=runtimeSelectionFromConfig({reviewTimeoutSeconds:30});
  assert.equal(selection.timeouts.operationMs,30000);
  assert.equal(selection.timeouts.requestMs,30000);
});

test('provider request timeout cannot exceed the review operation budget',()=>{
  const selection=runtimeSelectionFromConfig({reviewTimeoutSeconds:30,codexRequestTimeoutSeconds:180});
  assert.equal(selection.timeouts.operationMs,30000);
  assert.equal(selection.timeouts.requestMs,30000);
});

test('provider request timeout remains independently smaller when configured below the operation budget',()=>{
  const selection=runtimeSelectionFromConfig({reviewTimeoutSeconds:180,codexRequestTimeoutSeconds:45});
  assert.equal(selection.timeouts.operationMs,180000);
  assert.equal(selection.timeouts.requestMs,45000);
});
