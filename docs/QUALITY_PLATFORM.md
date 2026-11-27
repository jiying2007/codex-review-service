# Quality Platform

Codex Review Service 8.0.2 consumes exact-pinned Safe Core 4.18.13: Quality Platform v3, Review Profile Pack v1, Impact Evidence v2, Test Impact v1 and Analyzer Finding v1. All quality inputs are bound to the immutable MR head SHA. Repository content, CI reports and analyzer messages are untrusted evidence and never executable instructions.

## Review Profile Packs

`review.profile` is now a versioned engineering Profile Pack rather than a low-level execution preset. Supported packs are `general`, `backend`, `frontend`, `security`, `cpp`, `embedded-linux`, `embedded-mcu`, `driver`, `kernel`, and `realtime`. The Pack is resolved by Safe Core and adds bounded trusted review emphasis to the first model chunk. It cannot grant tools, network access, SCM mutations or weaken the Safe Contract.

## Analyzer Adapter Hub

Repository paths remain exact POSIX identities throughout GitLab snapshots, review chunks, analyzer anchors and Test Impact. A literal backslash is part of a file name; `src/a\\b.c` and `src/a/b.c` are different files. Diff headers use Safe Core's Git C quoting, including spaces, Unicode, quotes, tabs and newlines. Full provider diff headers must agree with GitLab's declared old/new paths; inconsistent or additional file headers fail before a model call.

Analyzer reports should emit repository-relative paths. The adapters accept a leading `./`, preserve real `a/` and `b/` directories, and do not guess a Windows-to-POSIX mapping. Findings must match the exact snapshot path and a changed line before publication.

Current configuration uses Config Schema 8. Historically, Config Schema 3 replaced the former repository-file-only `sarifFiles` setting with `review.analyzerReports`. Reports are acquired from the exact head pipeline through GitLab Job Artifact APIs and parsed by product-owned bounded adapters. Supported formats are:

- SARIF 2.1-compatible JSON;
- GitLab Code Quality JSON;
- JUnit XML;
- Cobertura XML and LCOV coverage summaries;
- GCC/Clang/MSVC-style compiler diagnostics;
- Cppcheck XML;
- CycloneDX JSON metadata;
- Trivy JSON;
- Gitleaks JSON.

Finding-like results are normalized through the canonical Safe Core Analyzer Finding contract and only become publishable findings when they can be anchored to an actual changed line. JUnit failures without source location, coverage percentages and SBOM/vulnerability counts remain bounded evidence metadata rather than fabricated code findings. Required configured reports fail closed when the head pipeline/job/artifact cannot be proven.

The Service never executes repository-defined analyzer commands. CI owns analyzer execution; Review Service only consumes already-produced artifacts.

## Test Impact v1

When enabled, the Service enumerates test files from the exact source-project head SHA and passes immutable test candidates plus changed-path/semantic signals to Safe Core `buildTestImpactMap()`. Core deterministically ranks likely impacted tests. The bounded recommendation block is supplied as model evidence; it does not execute tests and cannot turn a missing test result into a passing verdict.

`testPathPrefixes`, `maxTestCandidates`, and `maxRecommendedTests` bound discovery and model context. The default prefixes are `test/` and `tests/`.

## Impact Evidence

Semantic impact candidates continue to come from the exact MR head SHA through GitLab repository APIs. Core scores bounded includes/imports/symbol/build/Kconfig/DeviceTree evidence without performing repository I/O itself.

## Cross-review differential gate

`src/differential-quality.js` provides a deterministic, offline comparator for two normalized review judgments over the same exact diff fingerprint. It does not call another reviewer, invoke a model, or create a runtime dependency between Codex Review Safe and Codex Review Service.

The default blocking boundary is High. For two complete judgments over the same 64-hex diff fingerprint, the comparator treats an accepted High/Critical finding as aligned when the other reviewer accepts a High/Critical finding on the same exact `file + side + line` causal anchor. Product-specific category, wording, and claim taxonomy may differ without creating a false disagreement.

A missing High+ anchor is classified as:

- `controller_gate_disagreement` when the other reviewer saw the same anchor but suppressed or rejected it;
- `severity_disagreement` when the other reviewer accepted the same anchor below the blocking threshold;
- `recall_disagreement` when the other reviewer has no matching accepted/suppressed/rejected candidate.

Different diff fingerprints or incomplete coverage are `inconclusive`, never a clean pass. `assertCrossReviewDifferential()` therefore fails closed by default on both High+ disagreement and inconclusive evidence. The permanent corpus under `quality/cross-review-corpus.json` pins the removed-authorization old-side false-negative class, controller suppression, severity-boundary disagreement, post-remediation alignment, incomplete coverage, and exact-diff mismatch.

This is a quality/evaluation boundary, not a production quorum requirement: normal MR review remains independently usable when no second judgment envelope is supplied.

## Human resolution boundary

Human finding resolutions are append-only operational feedback (`fixed`, `false_positive`, `accepted_risk`, `duplicate`, `obsolete`, `not_applicable`, `policy_exception`). They are observable metrics only and never auto-train a model, mutate prompts, or create a self-training loop.
