'use strict';

function normalizeFingerprint(value) { return String(value?.fingerprint || value || '').trim(); }
function claimState(value) { return String(value?.claimState || value?.claim_state || 'legacy'); }
function knownClaim(value) { return claimState(value) === 'known' && Boolean(String(value?.claimFingerprint || value?.claim_fingerprint || '').trim()); }

function classifyFindingLifecycle(currentFindings, historicalFindings) {
  const current = new Map((currentFindings || []).map(item => [normalizeFingerprint(item), item]).filter(([fingerprint]) => fingerprint));
  const historyByRun = new Map();
  for (const item of historicalFindings || []) {
    const fingerprint = normalizeFingerprint(item);
    const runId = Number(item?.run_id || 0);
    if (!fingerprint || !Number.isInteger(runId) || runId <= 0) continue;
    if (!historyByRun.has(runId)) historyByRun.set(runId, new Map());
    historyByRun.get(runId).set(fingerprint, item);
  }
  const runs = [...historyByRun.keys()].sort((a, b) => b - a);
  const immediate = runs.length ? historyByRun.get(runs[0]) : new Map();
  const everKnown = new Set([...historyByRun.values()].flatMap(values => [...values].filter(([, item]) => knownClaim(item)).map(([fingerprint]) => fingerprint)));

  const entries = [];
  for (const [fingerprint, finding] of current) {
    if (!knownClaim(finding)) { entries.push(Object.freeze({ fingerprint, state: 'unclassified', finding })); continue; }
    const immediateFinding = immediate.get(fingerprint);
    const state = knownClaim(immediateFinding) ? 'persistent' : everKnown.has(fingerprint) ? 'regressed' : 'new';
    entries.push(Object.freeze({ fingerprint, state, finding }));
  }
  for (const [fingerprint, historicalFinding] of immediate) {
    if (knownClaim(historicalFinding) && !current.has(fingerprint)) entries.push(Object.freeze({ fingerprint, state: 'resolved', finding: null, historicalFinding }));
  }

  const counts = Object.freeze(entries.reduce((acc, item) => {
    acc[item.state] = (acc[item.state] || 0) + 1;
    return acc;
  }, { new: 0, persistent: 0, resolved: 0, regressed: 0, unclassified: 0 }));

  return Object.freeze({
    previousRunId: runs[0] || null,
    counts,
    entries: Object.freeze(entries)
  });
}

module.exports = { classifyFindingLifecycle };
