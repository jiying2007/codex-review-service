# Changelog

## 6.0.1 - 2026-08-28

### CI hygiene patch

- Remove the trailing blank line in `OPERATIONS.md` that caused the post-merge `git diff --check HEAD^ HEAD` gate to fail.
- Require six consecutive authenticated GitLab API probes before the real-provider mutating contract begins, preventing freshly restarted Workhorse/Rails components from producing startup-only 502 flakes without masking persistent provider failures.
- Preserve the complete v6.0.0 Reviewer-native trigger behavior, Config Schema 2, database schema, Safe Core pin, and GitLab runtime contracts unchanged.

## 6.0.0 - 2026-08-28

### Reviewer-native GitLab trigger contract

- Hard-cut Config Schema 2 from the Assignee-only trigger fields to one typed `review.triggerAssignment` contract with `reviewer`, `assignee`, `either`, and `always` modes.
- Make GitLab Reviewer the default automatic-review role; empty `userIds` means any current Reviewer, while configured IDs restrict triggering to explicit GitLab users.
- Trigger an already-open MR when a matching Reviewer is added even without a source-code push; Reviewer removal and unrelated MR metadata changes remain non-triggering.
- Keep source push/open/reopen automatic runs assignment-gated, and keep `/codex review` as an explicit assignment-gate bypass subject to existing Project, access-level, self-trigger and safety checks.
- Reuse the same assignment policy for webhook intake and reconciliation/restart compensation so real-time and durable recovery behavior cannot diverge.
- Remove `requiredAssigneeUserIds`, `manualReviewBypassAssignee`, and the Assignee-only runtime matcher; Config Schema 1 is rejected rather than dual-read or silently translated.
- Document the explicit v5 Config Schema 1 -> v6 Config Schema 2 operator migration and rollback boundary while preserving Database Schema 6 and the exact Safe Core pin.

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
