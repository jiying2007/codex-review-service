# Security Policy

## Product and Safe Core contract

Codex Review Service **6.2.1** owns production operations while shared safety, review-profile, Test Impact and diagnosis primitives remain in exact-pinned Safe Core Family v4.

Machine-checked security identity lives in `product-contract.json`: Database Schema 6, Config Schema 3, Policy Schema 3, Review Receipt 4, Safe Contract 2, Node 22.22.2+/24.19.0+ LTS support, GitLab compatibility floor 14.6.1, and exact Safe Core commit `e75d27d5f157cacc5e8f6b711355dd5cf4ddfe34`.

Service-only GitLab compatibility, CI artifact acquisition, IM, Docker, Admin/DR and deployment semantics must not leak into Safe Core.

## Trust model

One Service instance is one administrative/security **trust domain**. Projects covered by the same instance share Controller state, capacity and normally a GitLab credential domain. Use separate instances for materially different administrators, confidentiality or AI-data-policy domains.

## Configuration boundary

There is one non-secret **Config Schema 3** model. Direct-user mode uses `${XDG_CONFIG_HOME:-$HOME/.config}/codex-review/config.json`; system deployment uses `/etc/codex-review/config.json`. Unknown fields or unsupported schema versions fail closed.

Config Schema 3 removes the retired `review.sarifFiles` surface. Analyzer evidence is configured only through bounded `review.analyzerReports`; profile selection uses the versioned Profile Pack; Test Impact produces recommendations only. Config Schema 2 is not translated at runtime.

Secrets are never stored in JSON or SQLite. Production should use protected `_FILE` inputs such as `GITLAB_API_TOKEN_FILE`, `GITLAB_WEBHOOK_SIGNING_TOKEN_FILE` and `OPENAI_API_KEY_FILE`. Direct and file forms are mutually exclusive.

## Analyzer artifact security boundary

Analyzer Adapter Hub consumes **already-produced GitLab CI artifacts** only. Supported adapters include SARIF, GitLab Code Quality, JUnit, Cobertura, LCOV, compiler diagnostics, Cppcheck, CycloneDX, Trivy and Gitleaks.

The Service never executes repository-defined analyzer commands, scripts or commands embedded in report text. Artifact size is bounded. Finding-like evidence is normalized through the Safe Core Analyzer Finding contract; coverage, SBOM and other metadata-only evidence is not fabricated into source findings. Evidence is bound to the exact MR head pipeline and changed-line validation remains Controller-owned.

## GitLab capability security boundary

Compatibility is capability-driven rather than scattered version fallback code.

### Diff completeness

- GitLab 14.6.1 to <15.7 uses the **Classic** `/changes` contract and proceeds only when GitLab explicitly reports `overflow: false`.
- GitLab >=15.7 uses the **Modern** paginated `/diffs` plus `/versions.real_size` proof.

If the Service cannot prove complete MR coverage, Review fails closed before Codex produces a trusted verdict.

### Webhook authentication

GitLab versions expose two different security capabilities:

- **GitLab <19.1 — Classic token mode.** GitLab sends `X-Gitlab-Token`. The Service compares the configured `GITLAB_WEBHOOK_SIGNING_TOKEN` value in constant time and derives deterministic delivery identity from the event type plus SHA-256 of the exact raw request body. These GitLab versions do not provide the Standard Webhooks timestamp/HMAC replay-window contract, so production should additionally use trusted HTTPS/private ingress and network source restrictions where available.
- **GitLab >=19.1 — Standard HMAC mode.** The Service requires provider delivery identity, timestamp replay window, HMAC-SHA256 over the exact raw body, expected GitLab instance and constant-time signature verification.

Doctor reports `webhookAuth`, `webhookReplayWindow` and provider profile so deployment evidence records the actual security level.

## Project scope and durable acknowledgement

Only explicit `gitlab.projects` and `gitlab.groups` are supported. Group discovery must exhaust pagination before replacing active scope. Failed refresh preserves the last complete scope and degrades dependency health.

SQLite uses a local filesystem with WAL + `synchronous=FULL`. Review execution, GitLab publication and IM notification are independent durable failure domains. Retries never implicitly rerun a persisted Codex Review.

## Codex Safe Contract

Codex runs with the exact Safe Core capability contract, bounded output/time, read-only sandbox and filtered child environment. GitLab credentials are never forwarded to Codex. Untrusted MR, CI-log or analyzer content cannot grant tools, network, credentials or weaken Controller-owned policy.

## Storage, backup, migration and rollback

The Admin CLI is the supported mutation boundary. Current backup acceptance requires `quick_check=ok`, zero foreign-key violations and exact Database Schema 6.

The historical **Schema 5 -> 6 migration** remains an explicit supported migration path with source integrity verification, a mode-0600 verified backup, transactional migration and post-migration verification. From v5.0.0 onward, any DB/Config schema change requires explicit migration/upgrade fixtures and a documented rollback boundary.

Service 6.2.1 also introduces a Config Schema 2 -> 3 configuration hard cut. Rollback to a Config Schema 2 release requires restoring that release's matching configuration file. Never assume an older binary can translate a newer configuration or irreversible database schema.

## Fatal integrity behavior

Unknown `unhandledRejection` and `uncaughtException` events trigger fatal metadata-only logging, graceful owned-resource shutdown, SQLite checkpoint/close and non-zero exit. systemd/Docker restart plus durable recovery owns continuation.

## Deployment hardening

System deployments should use non-login users, protected secret files, trusted TLS ingress and restricted health/metrics access. Docker release images run non-root, drop all capabilities, use `no-new-privileges`, a read-only root filesystem and a digest-pinned Node 24.19 base.

For Classic webhook mode, network controls are particularly important because the upstream GitLab version cannot provide timestamped HMAC replay protection.

## Supply chain

PR/release gates cover Node 22.22.2 and 24.19.0, unit/fuzz/governance tests, Docker build/smoke, backup/recovery, real GitLab CE 14.6.1/17.11.7/19.3.0 provider matrix, dependency audit, CodeQL, OCI vulnerability scanning, SBOM, checksums and provenance attestations.

Production should deploy verified release artifacts or the digest-pinned OCI image, never a mutable convenience tag as final identity.

## Reporting

Do not publish credentials, private source or exploitable details in public issues. Use GitHub private vulnerability reporting/security advisories when available.
