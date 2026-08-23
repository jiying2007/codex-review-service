# Changelog

## 4.0.3

- Make direct runtime defaults rootless: config follows XDG config home and persistent state follows XDG state home.
- Keep system-level deployment deterministic by explicitly pinning `/etc/codex-review/config.json` in both systemd units and `/var/lib/codex-review` in the production config example.
- Add regression coverage for XDG overrides, relative-XDG fallback, and default state resolution.


## 4.0.2 - 2026-08-23

### Runtime hygiene

- Remove obsolete Review Receipt version labels from current runtime errors; Receipt v4 remains enforced by the canonical contract.

## 4.0.1 - 2026-08-23

### Final Family v4 closure

- Integrate the deterministic finding lifecycle ledger into the production ReviewService path and persisted run result.
- Publish lifecycle counts (`new`, `persistent`, `resolved`, `regressed`) in the GitLab review summary.

## 4.0.0 - 2026-08-23

### Codex Safe Family v4 terminal baseline

- Pin Safe Core 4.0.0 and hard-switch GitLab MR Review Receipt to v4 with complete protocol/prompt/model/Codex provenance.
- Add project-fair queue scheduling, fail-closed isolated Runner capability negotiation, and deterministic new/persistent/resolved/regressed finding lifecycle ledger.
- Preserve stale-snapshot cancellation, bounded retries, poison-job cutoff, durable SQLite Outbox and provider isolation.
- Add Scorecard plus immutable TGZ/SPDX-SBOM/SHA256/provenance release assets.

## 3.0.0 - 2026-08-22

### Codex Safe Family v3 convergence

- Pinned `codex-safe-core` 3.0.1 at `e6e25b502aa35a079f660346785cf283fe293b6d` and delegated shared Codex/process Safe Runtime to Core for both inline and isolated Runner modes.
- Hard-switched repository policy to target-branch `.codex-safe.json` Policy Schema v3; removed the Service-only `.codex-review.json` parser/file-name configuration and all Policy v2 fallback behavior.
- Unified deterministic `review.rules` through Core, including forbidden-path and code-without-test gates, with Service findings retaining exact GitLab old/new changed-line anchors.
- Replaced Service-owned diff chunking with Core coverage-preserving Review Evidence chunks while retaining immutable GitLab `start_sha`/`head_sha` provider evidence acquisition.
- Added GitLab-MR Review Receipt v3 and SQLite schema 4; receipt, findings, run metadata, and publication Outbox are committed atomically.
- Preserved durable multi-repository Project/Group discovery, per-MR serialization, transactional Outbox publication, rate limiting, circuit breaking, token budgets, and scope-removal publication cancellation.
- Added Family v3 permanent boundary checks proving the exact Core pin, zero legacy runtime inputs, Policy/Receipt versions, schema 4, and deterministic rule wiring.
- Added immutable release governance: Node 22.13/24 validation, explicit runtime TGZ allowlist, SHA256, provenance attestation, non-recursive tag creation, no release-asset overwrite, missing-tag recovery, and OWNER-only `/release-retry` recovery.

## 2.0.0 - 2026-08-22

### Terminal configuration and repository-hygiene model

- Made `/etc/codex-review/config.json` mandatory and the single source of all non-secret product configuration for both Controller and isolated Runner.
- Reduced supported environment inputs to optional `CODEX_REVIEW_CONFIG_FILE`, required `GITLAB_API_TOKEN`, required `GITLAB_WEBHOOK_SIGNING_TOKEN`, and optional `OPENAI_API_KEY`.
- Removed v1 compatibility paths: `GITLAB_PROJECT_ALLOWLIST`, wildcard webhook-only scope, non-secret environment overrides, implicit Runner mode/socket environment behavior, and Legacy `X-Gitlab-Token` webhook authentication.
- Raised the supported GitLab baseline to 19.1+ and require Standard Webhooks Signing Token semantics.
- Kept only explicit `gitlab.projects` / `gitlab.groups` scope with complete-discovery atomic replacement and out-of-scope publication cancellation.
- Made Hardened Runner read the same canonical config file instead of a separate non-secret environment configuration surface.
- Upgraded GitHub Actions checkout/setup-node to reviewed current major releases while preserving immutable full-SHA pins.
- Removed Dependabot configuration because automated tag-oriented Actions PRs conflict with the repository's manual full-SHA supply-chain policy; Action upgrades are reviewed deliberately.
- Rewrote bilingual deployment, operations, security, architecture and long-term-asset documentation around the zero-compatibility v2 contract.
- Upgraded package version to 2.0.0 and added regression tests proving old environment settings no longer alter runtime configuration.

## 1.2.0 - 2026-08-22

### Simpler deployment and first-class multi-repository scope

- Added strict `/etc/codex-review/config.json` structured configuration for non-secret deployment settings.
- Made Standard Deployment the default product path: one `codex-review-service` process with inline Codex; the isolated Unix-socket Runner remains the Hardened Deployment option.
- Added first-class multi-repository scope through explicit `gitlab.projects` plus GitLab `gitlab.groups` discovery with optional subgroup expansion.
- Group discovery uses GitLab's paginated Group Projects API, excludes archived projects, requires Merge Requests support, merges/deduplicates explicit and discovered projects, and refreshes on the reconciliation cadence.
- Project discovery is fail-closed: incomplete/failed discovery does not replace the last complete scope and makes readiness unhealthy.
- Kept legacy `GITLAB_PROJECT_ALLOWLIST` as an explicit compatibility input; when set it overrides structured project/group scope. `*` remains webhook-only.
- Added project-scope health/counts to Doctor, readiness, metrics, startup logs and reconciliation behavior.
- Reduced the default environment template to credentials plus optional overrides; advanced tuning remains available without being required for first deployment.
- Added strict config schema/precedence and project/group discovery regression tests.

## 1.1.0 - 2026-08-22

### Long-term production asset

- Changed SQLite webhook/review durability to WAL + `synchronous=FULL`, so an acknowledged local queue transaction is power-loss durable.
- Split review execution from GitLab publication with a transactional persistent outbox, independent publisher recovery/retry, idempotent fingerprint discovery, and terminal-status monotonicity protection.
- Added source-project and exact `pipeline_id` binding for external commit status when GitLab exposes a compatible pipeline; superseded/cancelled reviews now close status as `canceled`.
- Added GitLab request rate limiting, transient-failure circuit breaker, RFC Link pagination, hard diff-version completeness checks, and richer provider health.
- Replaced model-title fingerprints and line-number repair with exact changed-line validation plus stable source anchor hashes.
- Classified provider/local coverage gaps separately from metadata-only, generated-policy exclusions, and known binary advisories.
- Added immutable bounded context fetched from exact source `head_sha` and target `start_sha` without cloning or executing the reviewed repository.
- Added target-policy deterministic analyzers for forbidden paths and code-without-test changes; findings share the same gate/outbox lifecycle as Codex findings.
- Captured Codex JSONL token usage, added per-MR and per-project token budgets, and added optional strict production Codex version policy.
- Added draft-MR suppression, push debounce, publication workers, richer readiness/Prometheus metrics, optional OTLP/HTTP traces, and production invariants documentation.
- Added durability/outbox/context/provider/analyzer/fuzz regression tests and pinned GitHub Actions to immutable commit SHAs.

## 1.0.0 - 2026-08-22

### Mature service baseline

- Made webhook ingestion fully asynchronous: no GitLab API or Codex work in the delivery request.
- Added expected GitLab instance validation, explicit project allowlist, code-update-only MR triggering, and Developer+ manual-command authorization.
- Added additive SQLite schema migration, per-MR serialization, configurable cross-MR worker concurrency, bounded queue, exponential backoff, restart recovery, retention, and WAL maintenance.
- Added target+source snapshot identity (`start_sha` + `head_sha`) and periodic reconciliation for explicit project scopes.
- Added paginated GitLab API completeness detection, target-branch project policy, effective membership lookup, discussion-state inspection, and source-ref commit statuses.
- Added bounded multi-chunk review, old/new diff-side findings, fail-closed large/collapsed/pagination handling, and fail-closed validation of unverifiable model findings.
- Strengthened stale-result handling, discussion reuse/resolve semantics, Codex process timeout/output handling, and Safe Contract isolation.
- Added richer readiness/Prometheus metrics, doctor command, hardened systemd unit, Operations runbook, bilingual mature-state documentation, Dependabot, and minimum-runtime CI.

## 0.1.0 - 2026-08-21

- Initial persistent GitLab Merge Request review service.
