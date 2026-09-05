## 7.5.2

- Repin to Codex Safe Core 4.17.0 because the shipped Core runtime digest changed to `a41fa0e2c02d1977d6f1f8e0b7efff0a3d220d1149498c3d4d5a4ecbb1b03808`; publish a new immutable product release and distribution receipt.
- Refresh Product Contract v2 and generated/current-state Family identity for the exact Core pin.

## 7.5.1

- Repin to Codex Safe Core 4.16.0 because the shipped Core runtime digest changed to `3ea979b7903eac7740f5357e9346af5741ccb4090c2441146b2e8707642463bd`; publish a new immutable product release and distribution receipt.
- Refresh Product Contract v2 and generated/current-state Family identity for the exact Core pin.

## 7.4.3

- Repin to Codex Safe Core 4.15.0 as a new immutable product release; no compatibility shim or stale artifact reuse is permitted.
- Refresh generated/current-state Family identity and release evidence for the exact Core pin.

## 7.4.2

- Repin to Codex Safe Core 4.14.4 as a new immutable product release; no compatibility shim or stale artifact reuse is permitted.
- Refresh generated/current-state Family identity and release evidence for the exact Core pin.

## 7.4.1 - 2026-09-03

- Repin to immutable Codex Safe Core 4.13.1 so local structured Review JSONL keeps a bounded capture tail while retaining an independent fail-closed total transcript ceiling.
- Remove the obsolete Service-specific 6 MiB structured stdout workaround; Core now owns transcript/capture separation consistently.
- Enforce the isolated-runner controller response ceiling in UTF-8 bytes rather than JavaScript character count, with a multibyte regression test.
- Stream and byte-bound GitLab API responses at 8 MiB and Feishu/WeCom response bodies at 64 KiB so chunked or malformed peers cannot force unbounded buffering.
- Strictly validate isolated-runner request fields before model execution and remove duplicate `inspectRuntimeFromConfig` exports; no Review judgment, database, notification payload or receipt semantics change.

## 7.4.0 - 2026-09-03

- Adopt immutable Codex Safe Core 4.13.0 and Runtime/Provider Contract v3 with `codex.providerMode=auto` as the normal path.
- Reuse machine/container Family Runtime or Codex config/auth for zero-configuration OpenAI-compatible relays, including literal private-IP HTTP with Doctor plaintext warnings while public/non-IP HTTP remains fail-closed.
- Preserve Service secret isolation: only the resolved provider credential may enter the Codex child process; GitLab and notification credentials remain filtered.
- Extend Doctor with runtime provenance, endpoint/transport and credential-presence diagnostics without exposing secret values.
- Preserve Database Schema 8, Config Schema 7, Review Receipt 5 and GitLab provider compatibility behavior unchanged.

## 7.3.0 - 2026-09-01

- Pin Codex Safe Core 4.12.0 and consume Codex Runtime / Provider Contract v2.
- Hard-cut Config Schema 6 to Config Schema 7 while preserving Database Schema 8 and the full 7.2.1 notification/product line.
- Add `codex.credentialSource` with `auto`, `env`, and `auth-json`; `auto` prefers the configured environment variable and otherwise resolves the API key from the configured Codex home, `CODEX_HOME`, or the OS user Codex home.
- Accept `auth.json` only for `auth_mode=apikey` with a non-empty `OPENAI_API_KEY`; resolved secrets remain child-process-only and are excluded from argv, receipts, settings, and diagnostics.
- Add explicit `codex.allowInsecureHttp` for trusted private-network OpenAI-compatible relays; HTTPS remains the default and repository policy cannot enable insecure transport.

## 7.2.1 - 2026-09-01

- Show the GitLab repository path on Review and Flow notification cards so multi-repository notifications are distinguishable.
- Record direct-message delivery as provider acceptance rather than an unsupported user-read claim.

## 7.2.0 - 2026-09-01

- Add Config Schema 6 responsible-owner notification delivery: strict GitLab-to-Feishu identity mappings, bounded Reviewer → Assignee → Author resolution, safe group-card mentions, and optional per-owner direct messages.
- Keep durable Feishu group status cards unchanged: only terminal group cards mention owners; direct messages are independently deduplicated terminal cards and cannot affect a Review Verdict or group-card delivery.

## 7.1.0 - 2026-09-01

- Add durable Feishu application-bot Review status cards with Schema 8 message mapping, PATCH completion, restart reconciliation and one-shot fallback.
- Add 30-second Push aggregation and bounded MR-related Push/Pipeline/Review change activity.
- Add branch, severity, author and Reviewer route subscriptions, per-route Chinese/English cards and read-only diagnostics/navigation actions.
- Improve Review/Flow card hierarchy, Top Finding impact display, three-Commit expansion, deterministic truncation and notification delivery metrics.
- Add indexed aggregation metadata, SHA/freshness-bound MR correlation, Feishu token single-flight, 20 RPS throttling, Retry-After handling and a 28,000-byte card safety gate.
- Add dry-run-by-default `smoke-feishu-card`, explicit `--send` create/PATCH acceptance and notification Route diagnostics in Doctor.

## 7.0.0

- Hard-cut persistent model-Finding carry-forward and incremental Judgment reuse; every accepted review event now produces a fresh judgment from current evidence.
- Separate webhook-delivery idempotency from ReviewSubject identity so same-SHA analyzer/pipeline evidence can trigger a new review.
- Adopt Safe Core 4.11.0 Judgment Lifecycle v1 and Review Receipt v5 with Evidence Manifest identity.
- Remove the incrementalReviewEnabled configuration surface; historical findings remain post-fresh lifecycle evidence only.

## 6.5.2

- Repin to immutable Safe Core v4.10.2 (`cd9788f1280a217fbe6d0beb59682a85a8b82c4d`) so Review Service remains on the same Family trust root as the VS Code SCM UI Contract release.
- Preserve Database Schema 7, Config Schema 4, Review Receipt v4, Safe Contract v2, GitLab compatibility boundaries, and service runtime behavior.

## 6.5.1

- Publish the already-validated Review Service main line on immutable Safe Core v4.10.1 (`76418b80533c644e3ab01045290cd3cdd355622c`) and Policy Schema v4.
- Preserve Database Schema 7, Config Schema 4, Review Receipt v4, Safe Contract v2, GitLab capability boundaries, and service runtime behavior.

## 6.5.0

- Add opt-in ordinary GitLab Push/Commit tracking with ref/exclusion/user filters, bounded aggregate commit details, deterministic routing, durable dedupe, and zero Codex token usage.
- Keep Branch create/delete tracking separate so Push Hook lifecycle events are never double-notified.
- Preserve Database Schema 7, Config Schema 4, Core v4.9.6, and GitLab 14.6.1/15.7/19.1 compatibility boundaries.

## 6.4.0

- Add opt-in GitLab Flow Tracking for Pipeline terminal states, MR lifecycle, Tag and Branch create/delete events.
- Add Config Schema 4 with independent flow acquisition filters and existing notification-route delivery filters.
- Add durable SQLite `flow_state` transition projection and safe Schema 6 -> 7 migration with verified backup.
- Pipeline job summaries support deterministic failed-only/all/none filtering without sending raw logs or artifacts.
- Flow Tracking never invokes Codex; model Token cost remains zero.
- Preserve GitLab 14.6.1 Classic, >=15.7 Modern and >=19.1 Standard HMAC capability boundaries.

# Changelog

## 7.5.0 - 2026-09-04

- Consume Core Model Routing Contract v1 in the production GitLab review loop with authoritative Reviewer routing, optional Scout, conditional fail-closed Adjudicator, and shadow evaluation that never affects production verdicts.
- Hard-cut Config Schema 8: retire codex.model/fastModel in favor of Auto/Preference/Fixed routing, role controls, and an explicit same-provider shadow candidate.
- Record Model Evidence, Shadow comparison, and Token Economics in review audit metadata; persist only privacy-safe numeric token calibration in a protected sidecar while Database Schema 8 and Review Receipt v5 remain unchanged.


## 7.3.2 - 2026-09-02

- Release-only patch carrying the exact Codex Safe Core 4.12.4 family pin, refreshed production documentation, and the already validated GitLab 14.6.1 / 17.11.7 / 19.3.0 provider contracts; no service runtime or database/config schema semantics change.

## 7.3.1

- Fix Provider Contract v2 auth.json path portability on Windows by asserting the runtime path with platform-native path semantics, and permanently exercise the provider contract in the three-OS portability matrix.

## 6.3.1 - 2026-08-30

- Bind GitLab MR summaries and review notifications to the exact Review Receipt v4 creation time.
- Label all server-side human timestamps explicitly as UTC so delayed outbox delivery cannot be confused with review execution time.
- Preserve GitLab 14.6.1 Classic, 17.11.7 Modern and 19.3.0 Standard-HMAC compatibility behavior unchanged.

## 6.3.0

- Adopt immutable Safe Core v4.9.0 and Product Contract v1 with Atomic Family/Manifest v3 compatibility.
- Add bounded provider/model token-estimator calibration using actual input-token telemetry without persisting prompt/source text.
- Export current OpenTelemetry GenAI client operation-duration and token-usage metrics while preserving existing Prometheus counters.
- Harden analyzer ingestion with deterministic seeded fuzz/property coverage and normalized fail-closed SARIF format errors.
- Document SLSA v1.2 Build provenance alignment; no SCM authority or review semantics are expanded.

## 6.2.2

- Maintenance-only Family release on immutable Codex Safe Core v4.8.1; product behavior and protocol/schema contracts are unchanged.

## 6.2.1 - 2026-08-29

- Maintenance-only supply-chain refresh; product behavior and schemas are unchanged.
- Update actions/setup-node to the verified 94196ee commit.
- Update actions/dependency-review-action to v5.0.0 at verified a1d282b commit.
- Update CodeQL init/analyze together to v4.37.9 at verified cdf488f commit and synchronize the governance pin.
- Preserve exact Codex Safe Core v4.8.0 pin e75d27d5f157cacc5e8f6b711355dd5cf4ddfe34.

## 6.2.0 - 2026-08-29

### Analyzer evidence, engineering profiles and test impact

- Hard-cut Config Schema 3 from the single repository `sarifFiles` surface to structured operator-controlled `analyzerReports`; no compatibility translation or repository-defined analyzer command execution remains.
- Add the Analyzer Adapter Hub for already-produced GitLab CI artifacts: SARIF, GitLab Code Quality, JUnit, Cobertura, LCOV, GCC/Clang/MSVC diagnostics, Cppcheck, CycloneDX, Trivy and Gitleaks. Finding-like evidence is normalized through Safe Core while coverage/SBOM/test metadata remains evidence rather than fabricated source findings.
- Adopt released Safe Core v4.8.0 Review Profile Pack v1 and expose bounded engineering profiles including general, security, C++, embedded Linux/MCU, driver, kernel and realtime without weakening Safe Contract, coverage or changed-line anchoring.
- Add deterministic Test Impact v1 candidate acquisition/ranking from the exact MR head SHA. The Service recommends impacted tests only; it never executes tests or treats recommendations as test-pass evidence.
- Repin the complete runtime/release package and Family Release Guard to exact Safe Core `e75d27d5f157cacc5e8f6b711355dd5cf4ddfe34`, preserving Safe Contract v2, Policy Schema v3 and Review Receipt v4.
- Keep PR/MR narrative generation and SCM-side MR creation outside the product boundary.

## 6.1.1 - 2026-08-28

- Publish the complete bilingual Codex Provider/relay deployment guide and include it in the immutable service package; runtime, schemas, Safe Contract and Core pin are unchanged.

## 6.1.0 - 2026-08-28

- Consume Core v4.6 Codex Runtime/Provider Contract. Add explicit OpenAI-compatible relay configuration, HTTP/SSE transport, dedicated provider secret bridging, live doctor probes for inline/isolated runners, split request/runtime timeouts and provider-aware diagnostics.

## 6.0.1 - 2026-08-28

### CI hygiene patch

- Remove the trailing blank line in `OPERATIONS.md` that caused the post-merge `git diff --check HEAD^ HEAD` gate to fail.
- Preserve the complete v6.0.0 Reviewer-native trigger behavior, Config Schema 2, database schema, Safe Core pin, and GitLab provider contracts unchanged.

## 6.0.0 - 2026-08-28

### Reviewer-native GitLab trigger contract

- Hard-cut Config Schema 2 from the Assignee-only trigger fields to one typed `review.triggerAssignment` contract with `reviewer`, `assignee`, `either`, and `always` modes.
- Make GitLab Reviewer the default automatic-review role; empty `userIds` means any current Reviewer, while configured IDs restrict triggering to explicit GitLab users.
- Treat a matching Reviewer/Assignee assignment update on an already-open MR as a review trigger without requiring a source push; removals and unrelated metadata updates do not trigger.
- Keep `/codex review` as an explicit assignment-bypass command while preserving project, identity/access, self-trigger, evidence, publication, and safety gates.
- Remove `requiredAssigneeUserIds`, `manualReviewBypassAssignee`, and the Assignee-specific test surface with no compatibility translation or residual runtime path.

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
