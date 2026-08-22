# Security Policy

## Deployment trust levels

Codex Review Service v1.2 has two supported deployment levels:

- **Standard Deployment**: one `codex-review-service` process owns GitLab credentials, SQLite and inline Codex execution. Codex still receives only the Safe Contract environment allowlist; GitLab secrets are not passed to the Codex child process.
- **Hardened Deployment**: Controller and Codex Runner are separate Unix users/processes connected by a local Unix socket. Controller owns GitLab credentials/state; Runner owns Codex/OpenAI credentials and no SCM mutation capability.

Hardened mode is defense in depth for higher-risk environments, not a prerequisite for ordinary internal production use.

## Codex Safe Contract

Codex runs in a fresh temporary directory with no approval prompts, ephemeral execution, ignored user/repository rules, read-only sandbox, disabled web/shell/unified execution/apps/multi-agent/plugins/hooks/goals/memories/dependency installation, bounded output/time, process-tree cancellation, capability validation and optional CLI version policy.

GitLab API tokens, webhook secrets and controller-only configuration are never intentionally passed into the Codex child environment or isolated Runner environment.

## Configuration and project scope

Recommended non-secret settings live in `/etc/codex-review/config.json`; secrets remain in the protected environment file.

Structured scope is strict and fail-closed:

- `gitlab.projects` contains explicit numeric project IDs;
- `gitlab.groups` contains numeric Group IDs plus `includeSubgroups`;
- unknown config fields or invalid IDs fail startup;
- Group project discovery must complete all GitLab pagination pages before a new scope is accepted;
- a failed/incomplete refresh never replaces the last complete scope;
- while Group discovery is unhealthy, readiness is unhealthy;
- explicit and discovered project IDs are merged and deduplicated before webhook acceptance/reconciliation.

Legacy `GITLAB_PROJECT_ALLOWLIST` remains an intentional compatibility input. If present, it overrides structured project/group scope. Wildcard `*` is webhook-only and does not claim exhaustive reconciliation.

## Webhook authentication

Preferred GitLab 19+ Standard Webhooks validation includes delivery identity, replay-window timestamp, HMAC-SHA256 over the exact raw body, expected GitLab instance binding and constant-time comparison. Legacy `X-Gitlab-Token` is an explicit fallback. Delivery IDs are persisted for idempotency.

Webhook requests do no GitLab API or Codex work. Body/header sizes and queue depth are bounded.

## Durable acknowledgement

The Controller uses SQLite `WAL + synchronous=FULL`. A successful webhook enqueue is committed before HTTP 202, so an acknowledged delivery is backed by the service's power-loss durability contract.

## Manual command authorization

`/codex review` accepts only newly-created MR comments, ignores the bot itself and verifies effective GitLab membership before spending Codex capacity. Default minimum access is Developer (30).

## Untrusted repository data

MR title/description, filenames, diffs, source text, comments, generated content and model output are untrusted. They cannot grant tools/network/credentials or weaken deterministic Controller policy.

`.codex-review.json` is read only from immutable target `diff_refs.start_sha`, never the unreviewed source branch. Repository policy may narrow resource ceilings or add deterministic checks, but cannot weaken global blocking threshold, confidence floor, Safe Contract, credentials, project-scope rules or service concurrency.

## Snapshot, scope and publication safety

Every review binds target `start_sha` and source `head_sha`. New snapshots supersede old work; stale Summary/Finding actions revalidate the current MR before writing. Delayed `running` status cannot overwrite terminal state, and superseded/closed reviews close as `canceled`.

Publication also rechecks the current runtime Project Scope. If a repository leaves the configured Projects/Groups scope while an old review or Outbox action is still pending, that publication is canceled locally and no further GitLab mutation is performed for the removed project.

Review results/findings and publication actions are committed together. Publisher Workers consume the persistent Outbox separately, so GitLab write retries/restarts do not implicitly rerun Codex.

External status is written to the correct source project/ref and exact `pipeline_id` when resolvable.

## Finding and coverage safety

Findings must reference exact changed old/new lines; the Controller never silently relocates a model line number. Finding identity uses stable code anchors rather than model wording.

Coverage distinguishes reviewed text, metadata-only changes, generated/policy exclusions, known binary/unreviewable files and genuine provider/local gaps. Provider pagination/hard limits, unknown unavailable diffs, local chunk/token ceilings and structurally invalid findings remain fail-closed.

## Immutable bounded context

Controller context is fetched through GitLab Repository API at exact `head_sha/start_sha` with hard file/byte/line bounds. The service does not clone or execute reviewed repositories. Context helps reasoning but cannot fabricate an inline position outside the diff.

## Token and provider backpressure

Codex usage is persisted per run; optional MR/project budgets prevent uncontrolled consumption and fail closed when review becomes incomplete. GitLab API calls are globally rate-limited, honor `Retry-After`, and use a transient-failure circuit breaker.

## Storage, logs and observability

SQLite stores service metadata, summaries/findings, usage counters, anchor hashes, publication state and remote IDs. It does not intentionally persist raw diffs, full fetched context, prompts, raw Codex stdout/stderr, SCM credentials, OpenAI credentials or repository checkouts.

Logs/traces remain metadata-only. Prometheus avoids project/repository/branch labels to reduce high-cardinality metadata leakage. Project-scope metrics expose only counts/health, not repository names.

## Deployment hardening

Run services as non-login users, terminate TLS at a trusted internal proxy, keep the Controller listener on loopback where possible, restrict webhook ingress to GitLab/trusted ingress, and keep health/metrics on trusted monitoring networks.

For Standard Deployment, `/etc/codex-review-service.env` may be `0640 root:codex-review`: the Controller account already needs these credentials, and this permits `node --env-file=... src/doctor.js` to validate the exact service environment without copying secrets to command arguments. Do not grant that group membership to unrelated users.

For Hardened Deployment, keep the Runner credential file readable only by the system manager/root as appropriate; do not make the Controller account able to read Runner Codex/OpenAI credentials. Hardened Runner mode should additionally restrict Runner egress to required OpenAI/Codex endpoints and prevent routing to the internal GitLab API.

## Supply-chain controls

GitHub Actions are pinned to full commit SHAs. CI runs `git diff --check`, syntax/contract/unit/integration/fuzz tests on Node 22.13.0 and 24, plus package dry-run validation. Codex CLI versions should be managed separately and changed only after capability/contract validation.

## Reporting

Do not publish credentials or exploitable details in public issues. Use GitHub private vulnerability reporting/security advisories when available.
