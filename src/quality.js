'use strict';

const path = require('node:path');
const {
  resolveReviewProfile,
  extractImpactSignals,
  buildImpactEvidenceGraph,
  normalizeSarif,
  dedupeAnalyzerFindings,
  formatAnalyzerEvidence
} = require('./codex-safe-core/quality-platform');

const MAX_TREE_ITEMS = 20000;
const MAX_READ_CANDIDATES = 64;
const MAX_FILE_BYTES = 96 * 1024;
const MAX_SARIF_BYTES = 4 * 1024 * 1024;

function unifiedDiffText(diffResult) {
  return (diffResult?.items || []).map(entry => {
    const oldPath = String(entry.old_path || entry.new_path || '').replace(/\\/g, '/');
    const newPath = String(entry.new_path || entry.old_path || '').replace(/\\/g, '/');
    const raw = String(entry.diff || '');
    if (/^diff --git /m.test(raw)) return raw;
    return [`diff --git a/${oldPath} b/${newPath}`, `--- a/${oldPath}`, `+++ b/${newPath}`, raw].join('\n');
  }).join('\n');
}
function textCandidate(file) {
  return !/(?:^|\/)(?:node_modules|dist|build|vendor)\//i.test(file) &&
    !/\.(?:png|jpe?g|gif|webp|pdf|zip|gz|xz|7z|bin|so|dll|exe|woff2?)$/i.test(file);
}
function cheapScore(file, signals) {
  const low = String(file).toLowerCase(), base = path.posix.basename(low), stem = base.replace(/\.[^.]+$/, '');
  let score = 0;
  if (signals.paths.includes(file)) score += 100;
  for (const inc of signals.includes) if (low.endsWith(String(inc).toLowerCase())) score += 40;
  for (const mod of signals.modules) {
    const normalized = String(mod).replace(/^\.\//, '').replace(/\./g, '/').toLowerCase();
    if (normalized && (low.includes(normalized) || base.startsWith(path.posix.basename(normalized)))) score += 30;
  }
  if (signals.changedStems.includes(stem)) score += 10;
  if (/^(?:cmakelists\.txt|makefile|kconfig|meson\.build|build(?:\.bazel)?)$/i.test(base)) score += 8;
  return score;
}
async function collectImpact(gitlab, mr, diffResult, profile) {
  if (!profile || profile.impactDepth <= 0 || profile.maxImpactFiles <= 0 || typeof gitlab.listRepositoryTree !== 'function') {
    return Object.freeze({ nodes: [], edges: [], text: '', bytes: 0, complete: true, truncated: false });
  }
  const sourceProjectId = Number(mr.source_project_id || mr.project_id);
  const headSha = String(mr.diff_refs?.head_sha || mr.sha || '');
  if (!sourceProjectId || !headSha) return Object.freeze({ nodes: [], edges: [], text: '', bytes: 0, complete: false, truncated: true });
  const diff = unifiedDiffText(diffResult), signals = extractImpactSignals(diff);
  let tree; try { tree = await gitlab.listRepositoryTree(sourceProjectId, headSha); } catch { return Object.freeze({ nodes: [], edges: [], text: '', bytes: 0, complete: false, truncated: true }); }
  if (!tree || !Array.isArray(tree.items)) return Object.freeze({ nodes: [], edges: [], text: '', bytes: 0, complete: false, truncated: true });
  const ranked = tree.items.slice(0, MAX_TREE_ITEMS).filter(item => item?.type === 'blob' && textCandidate(String(item.path || '')))
    .map(item => ({ path: String(item.path), score: cheapScore(String(item.path), signals) }))
    .sort((a,b) => b.score - a.score || a.path.localeCompare(b.path));
  const candidates = [];
  for (const item of ranked.slice(0, MAX_READ_CANDIDATES)) {
    if (item.score <= 0) break;
    let raw; try { raw = await gitlab.getRepositoryFileRaw(sourceProjectId, item.path, headSha); } catch { continue; }
    if (raw === null || Buffer.byteLength(String(raw), 'utf8') > MAX_FILE_BYTES) continue;
    candidates.push({ path: item.path, content: String(raw) });
  }
  const graph = buildImpactEvidenceGraph({ diff, candidates, maxNodes: profile.maxImpactFiles, maxEdges: Math.max(32, profile.maxImpactFiles * 6), maxBytes: Math.min(256 * 1024, Math.max(32 * 1024, profile.maxImpactFiles * 12 * 1024)) });
  return Object.freeze({ ...graph, complete: graph.complete && tree.complete });
}
async function loadSarif(gitlab, mr, files = []) {
  const sourceProjectId = Number(mr.source_project_id || mr.project_id), headSha = String(mr.diff_refs?.head_sha || mr.sha || '');
  const findings = [];
  for (const file of files || []) {
    const relative = String(file || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (!relative || relative.startsWith('/') || relative.split('/').includes('..')) throw Object.assign(new Error(`Invalid SARIF repository path: ${file}`), { code: 'ESARIFPATH' });
    const raw = await gitlab.getRepositoryFileRaw(sourceProjectId, relative, headSha);
    if (raw === null) continue;
    if (Buffer.byteLength(String(raw), 'utf8') > MAX_SARIF_BYTES) throw Object.assign(new Error(`SARIF file exceeds ${MAX_SARIF_BYTES} bytes: ${relative}`), { code: 'ESARIFSIZE' });
    findings.push(...normalizeSarif(String(raw)));
  }
  return dedupeAnalyzerFindings(findings);
}
async function collectServiceQualityEvidence(gitlab, mr, diffResult, config) {
  const profile = resolveReviewProfile(config.reviewProfile || 'standard');
  const [impact, analyzerFindings] = await Promise.all([
    collectImpact(gitlab, mr, diffResult, profile),
    loadSarif(gitlab, mr, config.sarifFiles || [])
  ]);
  const analyzerEvidence = formatAnalyzerEvidence(analyzerFindings, { maxFindings: 80, maxBytes: 64 * 1024 });
  return Object.freeze({ profile, impact, analyzerFindings, analyzerEvidence });
}
function anchorAnalyzerFindings(snapshot,findings=[]){const byPath=new Map((snapshot?.files||[]).filter(file=>!file.skipped).map(file=>[String(file.path||'').replace(/\\/g,'/'),file])),out=[];for(const item of findings||[]){const file=byPath.get(String(item.file||'').replace(/\\/g,'/'));if(!file)continue;const line=Number(item.line||0);let side='';if(file.changedLines?.new?.includes(line))side='new';else if(file.changedLines?.old?.includes(line))side='old';if(!side)continue;const anchor=String(file.changedLines?.anchors?.[side]?.[line]||'');out.push(Object.freeze({severity:item.severity,category:item.category,file:file.path,side,line,endLine:line,title:`${item.tool}/${item.ruleId}`.slice(0,160),description:String(item.message||'').slice(0,1200),suggestion:String(item.suggestion||'').slice(0,1200),confidence:Number(item.confidence??1),anchorHash:require('node:crypto').createHash('sha256').update(`${file.path}\n${side}\n${anchor}`).digest('hex'),fingerprint:String(item.fingerprint||'')}));}return Object.freeze(out);}
function qualityContextBlocks(evidence) {
  return Object.freeze([String(evidence?.impact?.text || ''), String(evidence?.analyzerEvidence?.text || '')].filter(Boolean));
}

module.exports = Object.freeze({ unifiedDiffText, textCandidate, cheapScore, collectImpact, loadSarif, collectServiceQualityEvidence, qualityContextBlocks, anchorAnalyzerFindings });
