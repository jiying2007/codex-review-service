# Quality Platform

Codex Review Service 6.2 consumes Safe Core 4.8 Quality Platform v2, Review Profile Pack v1, Impact Evidence v2, Test Impact v1 and Analyzer Finding v1. All quality inputs are bound to the immutable MR head SHA. Repository content, CI reports and analyzer messages are untrusted evidence and never executable instructions.

## Review Profile Packs

`review.profile` is now a versioned engineering Profile Pack rather than a low-level execution preset. Supported packs are `general`, `backend`, `frontend`, `security`, `cpp`, `embedded-linux`, `embedded-mcu`, `driver`, `kernel`, and `realtime`. The Pack is resolved by Safe Core and adds bounded trusted review emphasis to the first model chunk. It cannot grant tools, network access, SCM mutations or weaken the Safe Contract.

## Analyzer Adapter Hub

Config Schema 3 replaces the former repository-file-only `sarifFiles` setting with `review.analyzerReports`. Reports are acquired from the exact head pipeline through GitLab Job Artifact APIs and parsed by product-owned bounded adapters. Supported formats are:

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

## Human resolution boundary

Human finding resolutions are append-only operational feedback (`fixed`, `false_positive`, `accepted_risk`, `duplicate`, `obsolete`, `not_applicable`, `policy_exception`). They are observable metrics only and never auto-train a model, mutate prompts, or create a self-training loop.
