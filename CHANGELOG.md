# Changelog

## 1.0.0 - 2026-08-22

### Mature service baseline

- Made webhook ingestion fully asynchronous: no GitLab API or Codex work in the delivery request.
- Added expected GitLab instance validation, explicit project allowlist, code-update-only MR triggering, and Developer+ manual-command authorization.
- Added additive SQLite schema migration, per-MR serialization, configurable cross-MR worker concurrency, bounded queue, exponential backoff, restart recovery, retention, and WAL maintenance.
- Added target+source snapshot identity (`start_sha` + `head_sha`) and periodic reconciliation for explicit project scopes.
- Added paginated GitLab API completeness detection, target-branch project policy, effective membership lookup, discussion-state inspection, and source-ref commit statuses.
- Added bounded multi-chunk review, old/new diff-side findings, fail-closed binary/large/collapsed/pagination handling, and fail-closed validation of unverifiable model findings.
- Strengthened stale-result handling, discussion reuse/resolve semantics, Codex process timeout/output handling, and Safe Contract isolation.
- Added richer readiness/Prometheus metrics, doctor command, hardened systemd unit, Operations runbook, bilingual mature-state documentation, Dependabot, and minimum-runtime CI.

## 0.1.0 - 2026-08-21

- Initial persistent GitLab Merge Request review service.
