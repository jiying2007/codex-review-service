# Security Policy

## Family v4 contract

- Shared Codex/process execution, Safe Contract v2, Policy Schema v3, Review Evidence chunking, deterministic Review Rules, and Review Receipt v4 are owned by the exact commit-pinned `codex-safe-core` 4 runtime.
- Service-owned responsibilities are GitLab provider semantics, immutable `start_sha`/`head_sha` evidence acquisition, SQLite schema 4, Queue/Outbox/Publisher, status/discussions, telemetry, and deployment.
- Standard and isolated Runner modes execute the same Core runtime and Safe Contract.

## Deployment trust levels

Codex Review Service 4.x supports three execution contexts with one security/configuration model:

- **Direct user mode**: the invoking user owns the XDG config/state paths and Codex credentials.
- **Standard system deployment**: one non-login Controller user owns GitLab credentials/state and runs inline Codex with a strict child environment allowlist.
- **Hardened system deployment**: Controller and Codex Runner are separate Unix users/processes over a local Unix socket; Runner owns Codex/OpenAI credentials and no GitLab credential.

## Configuration boundary

There is exactly one non-secret JSON configuration source. Its default location is context-specific, not globally hard-coded:

```text
Direct user mode:
${XDG_CONFIG_HOME:-$HOME/.config}/codex-review/config.json

System-level systemd:
/etc/codex-review/config.json
```

Direct user state defaults to `${XDG_STATE_HOME:-$HOME/.local/state}/codex-review` when `server.dataDir` is omitted. Production system config explicitly uses `/var/lib/codex-review`.

`CODEX_REVIEW_CONFIG_FILE` explicitly selects the config file. The only other supported process inputs are required `GITLAB_API_TOKEN`, required `GITLAB_WEBHOOK_SIGNING_TOKEN`, and optional `OPENAI_API_KEY`. Unknown config sections/fields, invalid values, missing config, empty Project/Group scope, or invalid Signing Token fail startup. Do not reintroduce non-secret environment overrides, UID/root detection, or implicit alternate configuration sources.

## Webhook authentication

GitLab Self-Managed 19.1+ Standard Webhooks Signing Token semantics are required. The receiver validates delivery identity, timestamp replay window, HMAC-SHA256 over the exact raw body, multiple standard signatures safely, expected GitLab instance, and constant-time comparison. Plain-text `X-Gitlab-Token` is intentionally unsupported.

## Project scope

Only explicit `gitlab.projects` and `gitlab.groups` are supported. Group discovery must exhaust pagination before a new scope is accepted. Failed/incomplete refresh keeps the last complete Set and marks readiness unhealthy. If a Project leaves scope, queued/new work is rejected and pending Outbox actions are canceled before another GitLab mutation.

## Codex Safe Contract

Codex runs in a fresh temporary directory with no approval prompts, ephemeral execution, ignored user/repository rules, read-only sandbox, disabled web/shell/unified execution/apps/multi-agent/plugins/hooks/goals/memories/dependency installation, bounded output/time, process-tree cancellation, capability validation, and optional CLI version policy.

Untrusted MR title/description, filenames, diffs, source text, comments, generated content, target-policy extra instructions, and model output cannot grant tools/network/credentials or weaken Controller-owned deterministic policy.

## Immutable policy and context

`.codex-safe.json` is read only from immutable target `diff_refs.start_sha`. Repository policy may narrow ceilings/add deterministic checks but cannot weaken global blocking threshold, confidence floor, Safe Contract, credentials, Project Scope, or service capacity.

Bounded context is fetched through GitLab Repository API at exact source `head_sha` and target `start_sha`. The service does not clone or execute reviewed repositories. Context cannot fabricate inline positions outside the diff.

## Durable acknowledgement and Outbox

SQLite uses local-filesystem `WAL + synchronous=FULL`. Webhook enqueue commits before HTTP 202. Review runs/findings and publication plans commit in one transaction. Publisher Workers consume persistent Outbox actions independently, so GitLab write retries/restarts do not rerun an already persisted Codex review.

Stale Summary/Finding actions revalidate current MR snapshot; delayed `running` cannot overwrite terminal state; superseded/closed reviews terminate as `canceled`; out-of-scope actions are canceled locally.

## Finding and gate correctness

Every review binds target `start_sha` + source `head_sha`. Findings must satisfy the allowed schema, confidence floor, changed file, side, and exact changed old/new line. Controller never relocates model line numbers. External status is bound to the correct source Project/ref and exact `pipeline_id` when resolvable. Genuine provider/local coverage gaps and unverifiable model output fail closed.

## Storage and observability

SQLite stores metadata, summaries/findings, usage counters, code-anchor hashes, publication state, and remote IDs. It does not intentionally persist raw diffs, full fetched context, prompts, raw Codex stdout/stderr, credentials, or repository checkouts.

Logs/traces remain metadata-only. Prometheus exposes counts/health without Project/repository/branch labels.

## Deployment hardening

For system deployments, run Controller/Runner as non-login users, keep secret env files tightly permissioned, terminate TLS at trusted internal ingress, restrict webhook ingress to GitLab/trusted networks, and expose health/metrics only to trusted monitoring networks. In Hardened mode restrict Runner egress to required OpenAI/Codex endpoints and prevent routing to internal GitLab.

## Supply chain

GitHub Actions are manually reviewed and pinned to immutable full commit SHAs. CI runs whitespace, syntax, contract, unit/integration/fuzz, Family v4 boundary checks, Node 22.13.0/24 validation, and package dry-run. Codex CLI versions are capability-checked and may be strictly pinned via canonical config.

## Reporting

Do not publish credentials or exploitable details in public issues. Use GitHub private vulnerability reporting/security advisories when available.