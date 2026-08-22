'use strict';

function normalizeFingerprint(value) { return String(value?.fingerprint || value || '').trim(); }

function classifyFindingLifecycle(currentFindings, historicalFindings) {
  const current = new Map((currentFindings || []).map(item => [normalizeFingerprint(item), item]).filter(([fingerprint]) => fingerprint));
  const historyByRun = new Map();
  for (const item of historicalFindings || []) {
    const fingerprint = normalizeFingerprint(item);
    const runId = Number(item?.run_id || 0);
    if (!fingerprint || !Number.isInteger(runId) || runId <= 0) continue;
    if (!historyByRun.has(runId)) historyByRun.set(runId, new Set());
    historyByRun.get(runId).add(fingerprint);
  }
  const runs = [...historyByRun.keys()].sort((a, b) => b - a);
  const immediate = runs.length ? historyByRun.get(runs[0]) : new Set();
  const ever = new Set([...historyByRun.values()].flatMap(set => [...set]));

  const entries = [];
  for (const [fingerprint, finding] of current) {
    const state = immediate.has(fingerprint) ? 'persistent' : ever.has(fingerprint) ? 'regressed' : 'new';
    entries.push(Object.freeze({ fingerprint, state, finding }));
  }
  for (const fingerprint of immediate) {
    if (!current.has(fingerprint)) entries.push(Object.freeze({ fingerprint, state: 'resolved', finding: null }));
  }

  const counts = Object.freeze(entries.reduce((acc, item) => {
    acc[item.state] = (acc[item.state] || 0) + 1;
    return acc;
  }, { new: 0, persistent: 0, resolved: 0, regressed: 0 }));

  return Object.freeze({
    previousRunId: runs[0] || null,
    counts,
    entries: Object.freeze(entries)
  });
}

module.exports = { classifyFindingLifecycle };
