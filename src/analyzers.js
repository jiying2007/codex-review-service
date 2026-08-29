'use strict';

require('./gitlab-evidence');
const crypto = require('node:crypto');
const { evaluateReviewRules } = require('./codex-safe-core/review-rules');

function sha(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function firstAnchor(file) {
  if (!file || file.skipped) return null;
  const side = file.changedLines?.new?.length ? 'new' : file.changedLines?.old?.length ? 'old' : null;
  if (!side) return null;
  const line = file.changedLines[side][0];
  const text = file.changedLines.anchors?.[side]?.[line] || `${file.path}:${side}:${line}`;
  return { side, line, anchorHash: sha(`${file.path}\n${side}\n${text}`) };
}

function finding(file, severity, category, title, description) {
  const anchor = firstAnchor(file);
  if (!anchor) return null;
  return {
    severity,
    category,
    file: file.path,
    side: anchor.side,
    line: anchor.line,
    endLine: anchor.line,
    title,
    description,
    suggestion: '',
    confidence: 1,
    anchorHash: anchor.anchorHash,
    fingerprint: sha(`${category}\n${anchor.anchorHash}`)
  };
}

function runDeterministicAnalyzers(snapshot, policy) {
  const reviewed = snapshot.files.filter(file => !file.skipped);
  const byPath = new Map(reviewed.map(file => [file.path, file]));
  const rules = policy?.reviewRules || {};
  const evaluated = evaluateReviewRules(reviewed.map(file => file.path), rules);
  const findings = [];

  for (const violation of evaluated.violations) {
    const file = byPath.get(violation.path);
    if (!file) continue;
    if (violation.rule === 'forbiddenPathPrefix') {
      const item = finding(file,'high','correctness','Forbidden path changed',`Target-branch review policy forbids changes under ${violation.prefix}.`);
      if (item) findings.push(item);
    } else if (violation.rule === 'requireTestsForCodeChanges') {
      const item = finding(file,'medium','test','Code changed without test changes','Target-branch policy requires a matching test-path change when configured code paths change.');
      if (item) findings.push(item);
    }
  }

  return {summary:'',findings,violations:evaluated.violations,rejected:0,filtered:0,modelFindingCount:0,deterministicFindingCount:findings.length};
}

module.exports = { runDeterministicAnalyzers, firstAnchor };
