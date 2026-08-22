# Security Policy

## Family v4 contract

- Shared Codex/process execution, Safe Contract v2, Policy Schema v3, Review Evidence chunking, deterministic review rules, and Review Receipt v4 are owned by the commit-pinned `codex-safe-core` 4.0.0.
- Service-owned responsibilities are GitLab provider semantics, immutable `start_sha`/`head_sha` evidence acquisition, SQLite schema 4, Queue/Outbox/Publisher, status/discussions, telemetry, and deployment.
- The only repository policy is target-branch `.codex-safe.json` schemaVersion 3; there is no Service-only policy parser or legacy policy fallback.
- Standard and isolated Runner modes execute the same Core runtime.


## Deployment trust levels

Codex Review Service v3.0 supports two deployment levels with identical Review/Gate/Outbox semantics:

- **Standard**: one Controller process owns GitLab credentials, SQLite, and inline Codex execution. The Codex child receives only a strict environment allowlist; GitLab credentials are excluded.
- **Hardened**: Controller and Codex Runner are separate Unix users/processes over a local Unix socket. Controller owns GitLab credentials/state; Runner owns Codex/OpenAI credentials and no GitLab credential.

## Configuration boundary

All non-secret product settings come from `/etc/codex-review/config.json`. The only supported environment inputs are optional `CODEX_REVIEW_CONFIG_FILE`, required `GITLAB_API_TOKEN`, required `GITLAB_WEBHOOK_SIGNING_TOKEN`, and optional `OPENAI_API_KEY`.

Unknown config sections/fields, invalid values, missing config, empty Project/Group scope, or invalid Signing Token fail startup. Do not reintroduce alternate env configuration paths.

## Webhook authentication

v2 requires GitLab Self-Managed 19.1+ Signing Tokens. The receiver validates:

- `webhook-id` delivery identity;
- `webhook-timestamp` replay window;
- `webhook-signature` HMAC-SHA256 over `{id}.{timestamp}.{rawBody}`;
- multiple Standard Webhooks signatures safely;
- `X-Gitlab-Instance` binding;
- constant-time signature comparison.

Plain-text `X-Gitlab-Token` is intentionally unsupported. Delivery IDs are persisted for idempotency. Webhook requests do no GitLab API or Codex work and return only after durable local enqueue.

## Project scope

Only explicit `gitlab.projects` and `gitlab.groups` are supported. Group discovery must exhaust pagination before a new scope is accepted. Failed/incomplete refresh keeps the last complete Set and marks readiness unhealthy. If a Project leaves scope, queued/new work is rejected and pending Outbox actions are canceled before any further GitLab mutation.

## Codex Safe Contract

Codex runs in a fresh temporary directory with no approval prompts, ephemeral execution, ignored user/repository rules, read-only sandbox, disabled web/shell/unified execution/apps/multi-agent/plugins/hooks/goals/memories/dependency installation, bounded output/time, process-tree cancellation, capability validation, and optional CLI version policy.

Untrusted MR title/description, filenames, diffs, source text, comments, generated content, target-policy extra instructions, and model output cannot grant tools/network/credentials or weaken Controller-owned deterministic policy.

## Target policy and immutable context

`.codex-safe.json` is read only from immutable target `diff_refs.start_sha`. Repository policy may narrow ceilings/add deterministic checks but cannot weaken global blocking threshold, confidence floor, Safe Contract, credentials, Project Scope, or service capacity.

Bounded context is fetched through GitLab Repository API at exact source `head_sha` and target `start_sha`. The service does not clone or execute reviewed repositories. Context cannot fabricate inline positions outside the diff.

## Durable acknowledgement and Outbox

SQLite uses local-filesystem `WAL + synchronous=FULL`. Webhook enqueue commits before HTTP 202.

Review runs/findings and publication plans commit in one transaction. Publisher Workers consume persistent Outbox actions independently, so GitLab write retries/restarts do not rerun an already persisted Codex review.

Stale Summary/Finding actions revalidate current MR snapshot; delayed `running` cannot overwrite terminal state; superseded/closed reviews terminate as `canceled`; out-of-scope actions are canceled locally.

## Merge-gate correctness

Every review binds target `start_sha` + source `head_sha`. External status is written to the correct source Project/ref and exact `pipeline_id` when resolvable. Genuine provider/local coverage gaps and unverifiable model output fail closed.

## Finding validation

Findings must satisfy the allowed schema, confidence floor, changed file, side, and **exact changed old/new line**. The Controller never relocates model line numbers. Finding identity uses code anchors rather than model-generated wording.

## Cost and provider backpressure

Codex usage is persisted per run. Optional MR/Project budgets fail closed when review cannot complete. GitLab API traffic is globally rate-limited, honors `Retry-After`, and uses a transient-failure circuit breaker.

## Storage and observability

SQLite stores metadata, summaries/findings, usage counters, code-anchor hashes, publication state, and remote IDs. It does not intentionally persist raw diffs, full fetched context, prompts, raw Codex stdout/stderr, credentials, or repository checkouts.

Logs/traces remain metadata-only. Prometheus exposes counts/health without Project/repository/branch labels.

## Deployment hardening

Run Controller/Runner as non-login users. Keep Secret env files tightly permissioned. Terminate TLS at a trusted internal proxy, keep Controller on loopback where possible, restrict webhook ingress to GitLab/trusted ingress, and expose health/metrics only to trusted monitoring networks.

In Hardened mode restrict Runner egress to required OpenAI/Codex endpoints and prevent routing to internal GitLab. Both services read the same non-secret `config.json`.

## Supply chain

GitHub Actions are manually reviewed and pinned to immutable full commit SHAs. CI runs whitespace checks, syntax/contract/unit/integration/fuzz tests on Node 22.13.0 and 24, plus package dry-run. Automated tag-based GitHub Actions dependency PRs are intentionally disabled to avoid bypassing full-SHA review policy.

Codex CLI versions are capability-checked and may be strictly pinned via `codex.versionPolicy` + `codex.allowedVersionPattern`.

## Reporting

Do not publish credentials or exploitable details in public issues. Use GitHub private vulnerability reporting/security advisories when available.
