# Security Policy

## Product and Safe Core contract

Codex Review Service **5.0.0** owns production operations while shared Codex/process execution remains in exact-pinned Safe Core Family v4.

Machine-checked security-relevant identity lives in `product-contract.json`: Database Schema 5, Config Schema 1, Policy Schema 3, Review Receipt 4, Safe Contract 2, Node >=24.19.0 <25 and GitLab >=19.1.0.

Service-only IM, Docker, Admin/DR and deployment semantics must not leak into Safe Core.

## Trust model

One Service instance is one administrative/security trust domain. Projects covered by the same instance share the Controller, durable state, resource pool and normally a GitLab credential domain.

Use separate instances for materially different administrator, confidentiality or AI-data-policy domains. Isolated Runner separates GitLab credentials from Codex/OpenAI credentials; it is not multi-tenant isolation.

## Deployment trust levels

- **Direct user mode**: invoking user owns XDG config/state and Codex credentials.
- **Standard system deployment**: one non-login Controller user owns GitLab credentials/state and runs inline Codex with a strict child environment allowlist.
- **Hardened system deployment**: Controller and Codex Runner are separate Unix users/processes over a local Unix socket; Runner owns Codex/OpenAI credentials and has no GitLab credential.
- **Docker/Compose**: canonical release OCI digest with non-root/read-only/capability-drop boundary and Compose secret files.

## Configuration boundary

There is exactly one non-secret Config Schema 1 JSON model:

```text
Direct user mode:
${XDG_CONFIG_HOME:-$HOME/.config}/codex-review/config.json

System-level systemd:
/etc/codex-review/config.json
```

Direct user state defaults to `${XDG_STATE_HOME:-$HOME/.local/state}/codex-review`. Production system config explicitly uses `/var/lib/codex-review`.

The JSON root must declare `schemaVersion: 1`. Unknown sections/fields, unsupported schema versions, invalid values, missing config, empty Project/Group scope and invalid Signing Token fail closed.

Runtime does not infer root/sudo/systemd or accept hidden non-secret environment override layers.

## Secret boundary

Secrets are never stored in JSON or SQLite. Supported secret families accept either a direct environment value or a matching `_FILE` path, never both.

Production should use protected files:

```text
GITLAB_API_TOKEN_FILE
GITLAB_WEBHOOK_SIGNING_TOKEN_FILE
OPENAI_API_KEY_FILE
CODEX_REVIEW_NOTIFY_<REF>_WEBHOOK_FILE
CODEX_REVIEW_NOTIFY_<REF>_SIGNING_SECRET_FILE
```

Secret file paths must be absolute, regular files and <=64 KiB. The service rejects ambiguous direct+file configuration. Docker maps secrets from `/run/secrets/*`; systemd deployments should use owner/group-protected local files.

Codex child processes receive only the explicitly filtered execution environment. GitLab credentials are never forwarded to Codex. In isolated mode, OpenAI/Codex credentials belong only to Runner.

## Webhook authentication

GitLab Self-Managed 19.1+ Standard Webhooks Signing Token semantics are required. The receiver validates delivery identity, timestamp replay window, HMAC-SHA256 over the exact raw body, multiple standard signatures safely, expected GitLab instance and constant-time comparison.

Plain-text `X-Gitlab-Token` is intentionally unsupported. Webhook work is durably accepted before asynchronous GitLab/Codex processing.

## Project scope

Only explicit `gitlab.projects` and `gitlab.groups` are supported. Group discovery must exhaust pagination before a new scope is accepted. Failed/incomplete refresh preserves the last complete Set and marks **dependency health** degraded. It does not automatically remove a local receiver that can still safely durably accept webhook traffic.

Initial startup still fails closed because first scope resolution happens before the HTTP listener starts. If a Project leaves the accepted scope, queued/new work is rejected and pending GitLab publication is canceled before another mutation.

## Codex Safe Contract

Codex runs in a fresh temporary directory with no approval prompts, ephemeral execution, ignored user/repository rules, read-only sandbox, disabled web/shell/unified execution/apps/multi-agent/plugins/hooks/goals/memories/dependency installation, bounded output/time, process-tree cancellation, capability validation and optional CLI version policy.

Untrusted MR title/description, filenames, diffs, source text, comments, generated content, target-policy extra instructions and model output cannot grant tools/network/credentials or weaken Controller-owned deterministic policy.

## Immutable policy and context

`.codex-safe.json` is read only from immutable target `diff_refs.start_sha`. Repository policy may narrow ceilings/add deterministic checks but cannot weaken global blocking threshold, confidence floor, Safe Contract, credentials, Project Scope or service capacity.

Bounded context is fetched through GitLab Repository API at exact source `head_sha` and target `start_sha`. The service does not clone or execute reviewed repositories. Context cannot fabricate inline positions outside the diff.

## Durable acknowledgement and failure domains

SQLite uses local-filesystem `WAL + synchronous=FULL`. Review execution, GitLab publication and IM notification are distinct durable domains.

Review Run/findings/receipt and publication/notification plans are persisted before downstream delivery. A GitLab/IM retry or restart cannot cause an implicit second Codex review for an already persisted result.

Stale actions revalidate current MR snapshot; delayed `running` cannot overwrite terminal state; superseded/closed reviews terminate as canceled; out-of-scope actions are canceled locally.

## Fatal integrity behavior

Unknown asynchronous runtime corruption is not tolerated as “log and continue”. `unhandledRejection` and `uncaughtException` trigger metadata-only fatal logging, stop HTTP intake, stop workers, flush telemetry, checkpoint/close SQLite and exit non-zero. systemd/Docker restart plus durable recovery owns continuation.

## Finding and gate correctness

Every review binds target `start_sha` + source `head_sha`. Findings must satisfy schema, confidence floor, changed file, side and exact changed old/new line. Controller never relocates model line numbers. External status targets the correct source Project/ref and exact pipeline when resolvable. Genuine provider/local coverage gaps and unverifiable model output fail closed.

## Storage, backup and Admin boundary

SQLite stores review metadata, summaries/findings, usage counters, code-anchor hashes and durable delivery state. It does not intentionally persist raw diffs, full fetched context, prompts, raw Codex stdout/stderr, credentials or repository checkouts.

The Admin CLI is the supported operator mutation boundary. It may retry only terminal failed outbox rows, reconcile, drain, integrity-check and create/verify online backups. Direct SQL mutation is not an incident repair mechanism.

Backup acceptance requires `quick_check=ok`, zero foreign-key violations and exact Schema 5. Restore must occur with Controller stopped and a verified backup.

## Observability privacy

Logs/traces are metadata-only. Prometheus uses low-cardinality product/runtime labels and no Project/repository/branch/source-path/prompt/secret labels. `/version` exposes compatibility identity, not credentials.

## Deployment hardening

System deployments use non-login users, protected secret files, trusted TLS ingress and restricted health/metrics access. Hardened Runner egress should be limited to required OpenAI/Codex endpoints and prevented from routing to internal GitLab.

Docker release images run non-root, drop all capabilities, use `no-new-privileges`, read-only root filesystem and a Node base pinned by immutable digest.

## Supply chain

GitHub Actions are pinned to immutable full commit SHAs. PR/release gates include Node 24 floor/current-major testing, unit/fuzz/governance tests, Docker build/smoke, backup/recovery tests, real GitLab CE provider matrix, Dependency Review and CodeQL.

Release creates a bounded tgz, SPDX package SBOM, multi-arch GHCR image with BuildKit SBOM/provenance, vulnerability scan, canonical image digest, digest-pinned Compose manifest, SHA256 checksums and GitHub build-provenance attestations.

Production deployment should verify both file artifacts and OCI digest/attestation. Do not deploy mutable convenience tags as the final identity.

## Upgrade security contract

Schema 5 and Config Schema 1 are the first supported production contracts. After v5.0.0, future schema changes require explicit migration fixtures/tests and a documented rollback boundary. Never run an older binary against a newer irreversible schema merely to “roll back”.

## Reporting

Do not publish credentials, private source or exploitable details in public issues. Use GitHub private vulnerability reporting/security advisories when available.
