'use strict';

const crypto = require('node:crypto');

const DIFFERENTIAL_SCHEMA_VERSION = 1;
const SEVERITY_ORDER = Object.freeze({ info: 1, low: 2, medium: 3, high: 4, critical: 5 });
const VALID_SIDES = new Set(['new', 'old']);
const VALID_CATEGORIES = new Set(['correctness','security','concurrency','resource','performance','robustness','maintainability','api','test','other']);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  return value;
}
function canonicalJson(value) { return JSON.stringify(canonicalize(value)); }
function sha256(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex'); }
function normalizePath(value) { return String(value || ''); }
function normalizeText(value, max = 256) { return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max); }
function normalizeSeverity(value) { const severity = String(value || '').toLowerCase(); return Object.prototype.hasOwnProperty.call(SEVERITY_ORDER, severity) ? severity : 'info'; }
function normalizeCategory(value) { const category = String(value || '').toLowerCase(); return VALID_CATEGORIES.has(category) ? category : 'other'; }
function normalizeSide(value) { const side = String(value || '').toLowerCase(); return VALID_SIDES.has(side) ? side : 'new'; }
function normalizeLine(value) { const line = Math.floor(Number(value) || 0); return line > 0 ? line : 0; }
function validDiffFingerprint(value) { return /^[0-9a-f]{64}$/i.test(String(value || '')); }
function severityPasses(severity, threshold = 'high') { return SEVERITY_ORDER[normalizeSeverity(severity)] >= SEVERITY_ORDER[normalizeSeverity(threshold)]; }

function normalizeCandidate(raw = {}, disposition = 'accepted') {
  const file = normalizePath(raw.file || raw.path);
  const side = normalizeSide(raw.side);
  const line = normalizeLine(raw.line);
  const category = normalizeCategory(raw.category);
  const severity = normalizeSeverity(raw.severity);
  const claimClass = normalizeText(raw.claimClass || raw.rootCauseKey || raw.rootCauseSymbol, 160).toLowerCase();
  const title = normalizeText(raw.title || raw.claim || raw.description, 240);
  const anchorKey = `${file}\n${side}\n${line}`;
  const claimKey = `${anchorKey}\n${category}\n${claimClass}`;
  return Object.freeze({
    severity, category, file, side, line,
    endLine: Math.max(line, normalizeLine(raw.endLine) || line),
    claimClass, title, disposition,
    anchorKey: sha256(anchorKey),
    claimKey: sha256(claimKey)
  });
}
function candidateList(values, disposition) {
  return Object.freeze((Array.isArray(values) ? values : []).map(item => normalizeCandidate(item, disposition)).filter(item => item.file && item.line > 0));
}
function deriveQualityVerdict(raw, findings) {
  const explicit = String(raw?.qualityVerdict || '');
  if (['no_findings','findings_open','blocked'].includes(explicit)) return explicit;
  if (findings.some(item => severityPasses(item.severity, 'high'))) return 'blocked';
  return findings.length ? 'findings_open' : 'no_findings';
}
function normalizeObservation(raw = {}) {
  const findings = candidateList(raw.findings, 'accepted');
  const suppressed = candidateList(raw.suppressedFindings || raw.filteredFindings, 'suppressed');
  const rejected = candidateList(raw.rejectedCandidates, 'rejected');
  const coverageComplete = raw.coverageComplete === true || raw.coverageVerdict === 'complete';
  return Object.freeze({
    source: normalizeText(raw.source || raw.product || 'unknown', 96) || 'unknown',
    diffFingerprint: String(raw.diffFingerprint || '').toLowerCase(),
    coverageComplete,
    coverageVerdict: coverageComplete ? 'complete' : 'incomplete',
    qualityVerdict: deriveQualityVerdict(raw, findings),
    findings, suppressed, rejected,
    modelFindingCount: Math.max(0, Math.floor(Number(raw.modelFindingCount) || 0)),
    rejectedFindingCount: Math.max(0, Math.floor(Number(raw.rejectedFindingCount ?? raw.rejectedFindings?.length) || 0)),
    filteredFindingCount: Math.max(0, Math.floor(Number(raw.filteredFindingCount) || suppressed.length))
  });
}
function observationSummary(observation, threshold) {
  return Object.freeze({
    source: observation.source,
    diffFingerprint: observation.diffFingerprint,
    coverageVerdict: observation.coverageVerdict,
    qualityVerdict: observation.qualityVerdict,
    accepted: observation.findings.length,
    acceptedAtOrAboveThreshold: observation.findings.filter(item => severityPasses(item.severity, threshold)).length,
    suppressed: observation.suppressed.length,
    rejectedCandidates: observation.rejected.length,
    modelFindingCount: observation.modelFindingCount,
    rejectedFindingCount: observation.rejectedFindingCount,
    filteredFindingCount: observation.filteredFindingCount
  });
}
function acceptedMatch(candidate, observation, threshold) {
  const exact = observation.findings.find(item => item.claimKey === candidate.claimKey && severityPasses(item.severity, threshold));
  if (exact) return { kind: 'accepted', match: exact, matchMode: 'claim' };
  const anchor = observation.findings.find(item => item.anchorKey === candidate.anchorKey && severityPasses(item.severity, threshold));
  if (anchor) return { kind: 'accepted', match: anchor, matchMode: 'anchor' };
  const lower = observation.findings.find(item => item.anchorKey === candidate.anchorKey);
  if (lower) return { kind: 'severity', match: lower, matchMode: 'anchor' };
  const suppressed = observation.suppressed.find(item => item.anchorKey === candidate.anchorKey);
  if (suppressed) return { kind: 'suppressed', match: suppressed, matchMode: 'anchor' };
  const rejected = observation.rejected.find(item => item.anchorKey === candidate.anchorKey);
  if (rejected) return { kind: 'rejected', match: rejected, matchMode: 'anchor' };
  return { kind: 'missing', match: null, matchMode: 'none' };
}
function discrepancyFor(candidate, owner, other, threshold) {
  const match = acceptedMatch(candidate, other, threshold);
  if (match.kind === 'accepted') return null;
  let kind = 'recall_disagreement';
  if (match.kind === 'severity') kind = 'severity_disagreement';
  else if (match.kind === 'suppressed' || match.kind === 'rejected') kind = 'controller_gate_disagreement';
  return Object.freeze({
    kind,
    findingSource: owner.source,
    missingSource: other.source,
    severity: candidate.severity,
    category: candidate.category,
    file: candidate.file,
    side: candidate.side,
    line: candidate.line,
    claimClass: candidate.claimClass,
    title: candidate.title,
    otherDisposition: match.kind,
    otherSeverity: match.match?.severity || '',
    matchMode: match.matchMode
  });
}
function uniqueDiscrepancies(values) {
  const map = new Map();
  for (const item of values) {
    const key = `${item.findingSource}\n${item.missingSource}\n${item.file}\n${item.side}\n${item.line}\n${item.kind}`;
    if (!map.has(key)) map.set(key, item);
  }
  return Object.freeze([...map.values()].sort((a,b) => a.file.localeCompare(b.file) || a.line - b.line || a.kind.localeCompare(b.kind)));
}
function evaluateCrossReviewDifferential(leftRaw, rightRaw, options = {}) {
  const threshold = normalizeSeverity(options.blockingSeverity || 'high');
  const left = normalizeObservation(leftRaw), right = normalizeObservation(rightRaw);
  let gate = 'pass', state = 'aligned', reason = 'high_plus_aligned';
  let discrepancies = Object.freeze([]);

  if (!validDiffFingerprint(left.diffFingerprint) || !validDiffFingerprint(right.diffFingerprint) || left.diffFingerprint !== right.diffFingerprint) {
    gate = 'inconclusive'; state = 'inconclusive'; reason = 'exact_diff_mismatch';
  } else if (!left.coverageComplete || !right.coverageComplete) {
    gate = 'inconclusive'; state = 'inconclusive'; reason = 'coverage_incomplete';
  } else {
    const values = [];
    for (const candidate of left.findings.filter(item => severityPasses(item.severity, threshold))) {
      const discrepancy = discrepancyFor(candidate, left, right, threshold); if (discrepancy) values.push(discrepancy);
    }
    for (const candidate of right.findings.filter(item => severityPasses(item.severity, threshold))) {
      const discrepancy = discrepancyFor(candidate, right, left, threshold); if (discrepancy) values.push(discrepancy);
    }
    discrepancies = uniqueDiscrepancies(values);
    if (discrepancies.length) { gate = 'fail'; state = 'high_plus_disagreement'; reason = discrepancies[0].kind; }
  }

  const body = {
    schemaVersion: DIFFERENTIAL_SCHEMA_VERSION,
    blockingSeverity: threshold,
    gate, state, reason,
    diffFingerprint: left.diffFingerprint === right.diffFingerprint ? left.diffFingerprint : '',
    left: observationSummary(left, threshold),
    right: observationSummary(right, threshold),
    discrepancies
  };
  return Object.freeze({ ...body, artifactDigest: sha256(canonicalJson(body)) });
}
function assertCrossReviewDifferential(result, { allowInconclusive = false } = {}) {
  if (result?.gate === 'pass' || (allowInconclusive && result?.gate === 'inconclusive')) return result;
  const error = new Error(result?.gate === 'inconclusive'
    ? `Cross-review differential is inconclusive: ${result?.reason || 'unknown'}`
    : `Cross-review High+ differential failed: ${result?.reason || 'unknown'}`);
  error.code = result?.gate === 'inconclusive' ? 'ECROSSREVIEWINCONCLUSIVE' : 'ECROSSREVIEWDIFF';
  error.differential = result;
  throw error;
}

module.exports = Object.freeze({
  DIFFERENTIAL_SCHEMA_VERSION, SEVERITY_ORDER,
  normalizeCandidate, normalizeObservation, severityPasses,
  evaluateCrossReviewDifferential, assertCrossReviewDifferential
});
