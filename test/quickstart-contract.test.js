'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const contract = require('../product-contract.json');
const root = path.resolve(__dirname, '..');

for (const name of ['README.md', 'README.zh-CN.md']) {
  test(`${name} quickstart configuration matches the executable product contract`, () => {
    const text = fs.readFileSync(path.join(root, name), 'utf8');
    const quickstart = [...text.matchAll(/schemaVersion:\s*(\d+)/g)];
    assert.ok(quickstart.length > 0, 'quickstart must state a concrete configuration schema');
    for (const match of quickstart) assert.equal(Number(match[1]), contract.configSchemaVersion);
    const currentQuickstart = text.split(/## GitLab Flow Tracking|## GitLab 流程跟踪/)[0];
    for (const match of currentQuickstart.matchAll(/Config Schema (\d+)/g)) assert.equal(Number(match[1]), contract.configSchemaVersion);
    assert.match(text, /Config Schema 7/, 'Flow Tracking historical introduction must remain visible');
    const backup = name.endsWith('zh-CN.md') ? /Schema (\d+) 全部通过才接受备份/ : /Schema (\d+) verification pass/;
    const match = text.match(backup);
    assert.ok(match, 'backup verification must state the current database schema');
    assert.equal(Number(match[1]), contract.databaseSchemaVersion);
    assert.match(text, /Schema 5/, 'historical first-production persistence boundary must remain documented');
  });
}

for (const name of ['config.example.json', 'deploy/systemd/config.example.json', 'deploy/docker/config.example.json']) {
  test(`${name} uses the same configuration schema as the quickstart`, () => {
    const config = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
    assert.equal(config.schemaVersion, contract.configSchemaVersion);
  });
}
