# Changelog

## 5.2.2 - 2026-08-27

### Migration safety patch

- Verify every Schema 5 migration backup independently with a read-only SQLite handle, `integrity_check`, and source `user_version` before Schema 6 DDL begins.
- Close backup verification handles deterministically so Windows does not retain a file lock after validation; add a cross-platform regression test for cleanup and schema-mismatch failure.

## 5.2.1 - 2026-08-27

### Supply-chain patch

- Repin the exact Safe Core 4.4.1 immutable-release publication patch; Service runtime, DB Schema 6, Config Schema 1 and Review Receipt v4 remain unchanged.
- Publish new package/OCI/SBOM/checksum assets only under repository-level immutable Releases and verify the resulting immutable Release in CI.

## 5.2.0 - 2026-08-27

### Quality Platform and durable database evolution

- Add explicit SQLite Schema 5 -> 6 migration with pre/post integrity checks, mode-0600 backup and fault-tested transactional rollback.
- Add append-only human finding-resolution history and Admin CLI metrics without automatic prompt/model learning.
- Adopt Safe Core 4.4 operator review profiles, exact-head Impact Evidence, pre-generated SARIF evidence and GenAI semantic token telemetry.
- Add a real storage replacement boundary and governed HA thresholds while intentionally keeping SQLite as the only shipped backend.
- Generate current product-contract facts in Architecture and both READMEs from machine contracts to eliminate version/Core/DB documentation drift.

## 5.1.1 - 2026-08-26

### Family governance and durable-state verification

- Pin the Service to formally released Codex Safe Core v4.2.1 and adopt the shared Actions-pin, non-goal, diagnostics, dependency-review and release-guard governance gates.
- Add cross-platform fault-injection coverage for incompatible SQLite schema handle release plus publication/notification outbox crash-and-reopen recovery.
- Govern the additional Core contract/diagnostic files in the exact release-package allowlist while retaining the existing rootless Docker and immutable release boundaries.
- Preserve Database Schema 5, Config Schema 1, Policy Schema 3, Review Receipt 4, Safe Contract 2 and the GitLab 14.6.1 / 17.11.7 / 19.3.0 provider compatibility profiles; this patch changes governance and verification only.

## 5.1.0 - 2026-08-25

### Enterprise GitLab compatibility without weakening review evidence

- Lower the native/systemd Node compatibility floor to Node 22.22.2 while retaining Node 24.19.0 as the canonical Docker/runtime line; Node 23 remains intentionally unsupported and CI/Release validate both supported LTS lines.
- Lower the GitLab Self-Managed compatibility floor to 14.6.1 through a centralized capability selector rather than scattered version fallbacks.
- Add a first-class **Classic GitLab profile** for 14.6.1 through <15.7 using `/merge_requests/:iid/changes`; trusted review is allowed only when GitLab explicitly reports `overflow: false`, otherwise diff acquisition fails closed before Codex.
- Retain the **Modern GitLab profile** for >=15.7 using paginated `/diffs` plus `/versions` and exact `real_size` coverage proof.
- Add real GitLab CE 14.6.1, 17.11.7 and 19.3.0 provider system gates covering authenticated API, Group/Project/MR lifecycle, diff coverage, repository reads, notes, discussions, resolution and commit status.
- Make Doctor report detected GitLab version/profile/completeness strategy and keep profile selection non-configurable so operators cannot bypass evidence guarantees.
- Separate GitLab **compatibility** from lifecycle **recommendation**: existing 14.6.1+ enterprise instances can deploy the Service, while operators are still advised to run a vendor-supported GitLab release and treat GitLab upgrades as an independent infrastructure/security project.
- Preserve Database Schema 5, Config Schema 1, Safe Contract 2, Review Receipt 4 and exact Safe Core commit `7ffbf6f1791e17ba74faf0922e7a702bdac72059`; v5.1 changes only Service runtime/provider compatibility boundaries.

## 5.0.1 - 2026-08-25

### OCI runtime security closure

- Treat the failed v5.0.0 OCI publication as a blocked release candidate after Trivy found CVE-2026-59873 in the Node base image's bundled npm `tar@7.5.16`; no GitHub Release assets were published for v5.0.0.
- Strip npm, npx, yarn, corepack and npm cache from the final production container after build-time installation while retaining `node` and the pinned Codex CLI runtime.
- Make Docker smoke derive the service version from `product-contract.json` instead of hard-coding it, and permanently verify the final image exposes `node`/`codex` but no package-manager executables.
- Preserve Database Schema 5, Config Schema 1, Safe Contract 2 and the exact Safe Core commit; this patch changes delivery/runtime attack surface only.

## 5.0.0 - 2026-08-25

### Production operations complete

- Establish `product-contract.json` as the machine-checked source for Service 5.0.0, Database Schema 5, Config Schema 1, Policy Schema 3, Review Receipt 4, Safe Contract 2, exact Safe Core commit, Node >=24.19.0 <25, and GitLab >=19.1.0.
- Hard-cut the unreleased configuration surface to explicit Config Schema 1 and move the production runtime to the Node 24 LTS line; Safe Core remains exact commit-pinned and unchanged by Service-only productization.
- Add file-backed `*_FILE` secret resolution for GitLab, OpenAI and notification credentials with direct/file ambiguity rejected fail-closed.
- Turn Docker into a real release artifact: digest-pinned Node base image, canonical multi-arch GHCR image, BuildKit SBOM/provenance, vulnerability scan, `IMAGE_DIGEST.txt`, and digest-pinned `compose.release.yaml`.
- Add an operator Admin CLI for metadata-only status/diagnostics, failed Publication/Notification retry, reconciliation, drain, integrity checks, Node SQLite online backup, backup verification and restore checks without ad-hoc SQL repair.
- Split safe webhook intake readiness from external GitLab/Project-Scope dependency health; add `/health/dependencies`, `/version`, product identity metrics, and oldest queue/publication/notification age SLO primitives.
- Treat unknown `unhandledRejection` and `uncaughtException` as fatal integrity events with graceful owned-resource shutdown, SQLite checkpoint/close, non-zero exit and durable restart recovery.
- Add permanent Docker smoke, backup/recovery, Dependency Review, CodeQL and real GitLab CE provider matrix gates covering the minimum supported 19.1 line and a current certified line.
- Define one Service instance as one administrative/security trust domain; retain PostgreSQL/HA, additional SCM providers and Web UI as explicit future replacement/expansion boundaries rather than adding premature distributed-system complexity.
- Freeze the post-v5 upgrade contract: released DB/Config schema evolution must use explicit migration fixtures/tests and documented rollback boundaries; first-release hard-cut recreation is no longer a valid normal upgrade strategy.
- Rewrite deployment, operations, architecture, security, support and bilingual product-entry documentation around canonical release artifacts, file secrets, Admin/DR, SLO/capacity, trust-domain and migration invariants.

## 4.1.0 - 2026-08-24

### Durable IM notifications and container deployment

- Add deterministic Feishu/Lark and WeCom review cards with Project/Group routing and secret-ref based webhook credentials.
- Add an independent durable `notification_outbox` extension with idempotency, bounded retries, terminal failed state, restart recovery, and notification metrics/readiness.
- Persist successful Review evidence, GitLab publication actions, and IM notification actions in the same SQLite transaction; notification delivery failures never change the Review verdict or rerun Codex.
- Add `review.blocked`, `review.failed`, `review.completed`, `service.degraded`, and `service.recovered` notification events with quiet defaults.
- Add rootless Docker/Compose deployment with read-only root filesystem, dropped capabilities, healthcheck, resource bounds, persistent state/Codex home, and pinned Codex CLI default.
- Add dedicated GitLab setup and bilingual IM notification documentation.
- Hard-cut the first production database contract at Schema 5: no pre-release migration/backfill compatibility; incompatible development databases fail closed.

## 4.0.4 - 2026-08-24

### Terminal deployment and supply-chain polish

- Make the root `config.example.json` user-neutral so direct execution naturally uses the XDG state default without requiring users to delete a system path first.
- Add `deploy/systemd/config.example.json` as the explicit system-level deployment template with `/var/lib/codex-review` state while both systemd units continue to pin `/etc/codex-review/config.json`.
- Repin the Service and policy-schema provenance to the coordinated Safe Core maintenance commit.
- Add consumer-side SHA256 plus GitHub artifact-attestation verification guidance and review-only Renovate dependency governance.
- Permanently verify that user/system config examples differ only by the explicit system state directory.

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
