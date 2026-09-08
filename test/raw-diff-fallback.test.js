'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const{createRawTextDiff,MAX_TEXT_BYTES}=require('../src/raw-diff-fallback');
const{parseChangedLines}=require('../src/review');

test('raw text fallback creates exact changed-line hunks without retaining source outside the result',()=>{const result=createRawTextDiff({oldText:'one\ntwo\nthree\n',newText:'one\nTWO\nthree\nfour\n',maxDiffBytes:4096});assert.equal(result.status,'available');assert.match(result.diffText,/^-two$/m);assert.match(result.diffText,/^\+TWO$/m);assert.match(result.diffText,/^\+four$/m);const changed=parseChangedLines(result.diffText);assert.deepEqual(changed.old,[2]);assert.deepEqual(changed.new,[2,4]);});
test('raw text fallback fails closed for binary, unchanged, source-size and diff-size boundaries',()=>{assert.equal(createRawTextDiff({oldText:'a\0',newText:'b',maxDiffBytes:4096}).status,'not_text');assert.equal(createRawTextDiff({oldText:'same',newText:'same',maxDiffBytes:4096}).status,'no_hunks');assert.equal(createRawTextDiff({oldText:'a'.repeat(MAX_TEXT_BYTES+1),newText:'b',maxDiffBytes:4096}).status,'source_too_large');assert.equal(createRawTextDiff({oldText:'a\n',newText:`${'b'.repeat(128)}\n`,maxDiffBytes:8}).status,'diff_too_large');});
