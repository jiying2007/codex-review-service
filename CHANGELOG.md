# Changelog

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
