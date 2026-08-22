# Security Policy

## Trust boundary

Codex Review Service separates privileged GitLab control from untrusted repository/model content. The recommended v1.1 production deployment also separates GitLab credentials from Codex/OpenAI credentials at the Unix-user/process boundary.

```text
Controller (codex-review)
  - GitLab API token
  - webhook signing/legacy secrets
  - SQLite state
  - policy/gate/publication logic
        │ Unix socket
        ▼
Runner (codex-review-runner)
  - Codex/OpenAI credential
  - no GitLab credentials
  - Codex Safe Contract only
```

Inline Codex execution remains supported for small/development deployments, but the isolated Runner is the preferred production boundary.

## Codex Safe Contract

Codex execution receives a small environment allowlist plus `CODEX_HOME` and optional `OPENAI_API_KEY`. It runs in a fresh temporary directory with:

- no approval prompts;
- ephemeral execution;
- ignored user/repository rules;
- read-only sandbox;
- disabled web search;
- disabled shell/unified execution and shell snapshots;
- disabled apps, multi-agent, remote plugins, hooks, goals and memories;
- disabled skill dependency installation;
- bounded stdout/stderr and process time;
- process-tree cancellation;
- startup capability validation and optional CLI version policy.

GitLab credentials are never intentionally passed to Codex or the Runner environment.

## Webhook authentication and scope

Preferred GitLab 19+ Standard Webhooks validation includes:

- `webhook-id` / idempotency identity;
- timestamp replay window;
- HMAC-SHA256 signature over the exact raw body;
- expected `X-Gitlab-Instance` binding;
- constant-time comparison.

Legacy `X-Gitlab-Token` is an explicit compatibility fallback. Delivery IDs are persisted for idempotency. `GITLAB_PROJECT_ALLOWLIST` constrains accepted projects independently of token permissions; explicit IDs are preferred.

Webhook requests do no GitLab API or Codex work. Body/header sizes and queue depth are bounded.

## Durable acknowledgement

The controller uses SQLite `WAL + synchronous=FULL`. A successful webhook enqueue is committed before the 202 response. This is intentionally stronger than WAL+NORMAL because GitLab may not redeliver a request already acknowledged by the service.

## Manual command authorization

`/codex review` accepts only newly-created MR comments, ignores the bot itself and validates effective GitLab project membership before spending Codex capacity. The default minimum access level is Developer (30).

## Untrusted repository data

MR title/description, filenames, diffs, source text, comments, generated content and model output are all untrusted. They cannot grant tools, network access, credentials or weaken deterministic controller policy.

`.codex-review.json` is read only from the immutable target snapshot `diff_refs.start_sha`, not the unreviewed source branch. Unknown/malformed fields fail closed. Repository policy may narrow resource ceilings and add deterministic checks; it cannot weaken the global blocking threshold, confidence floor, Safe Contract, credential boundary or worker/controller limits.

## Snapshot and stale-result protection

A review identity contains both target `start_sha` and source `head_sha`. The controller revalidates the MR before persisting/publishing results. A newer snapshot aborts active work and supersedes queued old work.

Publication outbox actions for summary/findings verify the current snapshot before writing. Delayed `running` status actions are canceled after a job reaches a terminal state. Superseded/closed review statuses close as `canceled`.

## Publication safety and Outbox

Review results/findings and GitLab publication actions are written in one SQLite transaction. Publisher Workers consume `publication_outbox` separately. This provides retry/recovery without re-running Codex.

Outbox actions use stable dedupe keys. Inline finding publication searches existing unresolved discussion fingerprints before creation to reduce ambiguous network-retry duplication. Human-resolved findings are not silently reopened; a reappearing current defect creates a new thread.

External statuses are written to the source project/ref and, when resolvable, the exact GitLab `pipeline_id` to avoid branch/MR pipeline ambiguity.

## Coverage safety

Coverage classification is explicit:

- reviewed text;
- metadata-only changes;
- policy-excluded/generated files;
- known binary/unreviewable files;
- genuine provider/local coverage gaps.

Provider pagination failure, hard diff limits, `too_large`, `collapsed`, unknown unavailable diffs, local file/chunk/token ceilings and structurally invalid model findings remain fail-closed. Known binaries/metadata-only/generated files are not automatically misclassified as provider truncation; project policy can make known unreviewable files blocking.

## Finding validation

Model findings must use allowed schema values, meet the confidence floor, reference a changed file and point to an **exact changed old/new line**. The controller does not silently relocate findings to nearby lines.

Finding fingerprints use code anchors derived from changed-line/hunk evidence, so model wording changes do not redefine finding identity.

## Immutable bounded context

The controller may retrieve bounded context through GitLab Repository API at exact source `head_sha` and target `start_sha`. Context size/file/line limits are hard-bounded. The service does not clone or execute the MR repository. Context is evidence for reasoning only and cannot create an inline position outside the supplied diff.

## Deterministic analyzers

Target-branch policy may enable mechanical checks such as forbidden path prefixes or requiring tests for configured code paths. These analyzers never execute repository code and emit the same normalized Finding model used by Codex. The deterministic gate remains controller-owned.

## Token and cost governance

Codex usage events are persisted per run. Optional MR/project budgets bound uncontrolled model consumption. If a budget prevents complete review, the service fails closed instead of claiming pass.

## GitLab backpressure

GitLab requests are globally rate-limited. `Retry-After` is honored where provided, and a circuit breaker opens after repeated transient/network/provider failures. This reduces request amplification during GitLab incidents.

## Storage and logging

SQLite stores service metadata, review summaries/findings, usage counters, code-anchor hashes, publication state and remote discussion/status IDs. It does **not** intentionally persist raw source diffs, full fetched context, prompts, raw Codex stdout/stderr, GitLab credentials, OpenAI credentials or repository checkouts.

Operational logs/traces must remain metadata-only: trace/job/run/project/MR identifiers, short SHAs, attempts, durations, normalized error/status codes and counts. Never add raw provider responses containing source/secrets to persistent logs.

## Metrics and traces

Prometheus metrics avoid project/repository/branch labels to prevent high-cardinality source metadata leakage. Optional OTLP/HTTP traces must follow the same metadata-only rule.

## Deployment hardening

Run Controller and Runner as dedicated non-login users. Keep environment files mode `0600`.

The provided systemd units use `NoNewPrivileges`, private temp/devices, read-only system/home protections, kernel/control-group protections, restricted address families and empty capability sets. The Runner receives only its Codex auth write path and runtime socket path.

For stronger production isolation, enforce egress controls so the Runner can reach only required OpenAI/Codex endpoints and cannot route to the internal GitLab API. Controller and Runner communicate only through the Unix socket.

Terminate TLS at a trusted internal reverse proxy, keep the Controller listener on loopback when possible, restrict webhook ingress to GitLab/trusted ingress and keep health/metrics endpoints on trusted monitoring networks.

## Supply-chain controls

GitHub Actions used by CI are pinned to full commit SHAs. CI runs `git diff --check`, syntax/tests on Node 22.13.0 and 24, plus package dry-run validation. Codex CLI production versions should be pinned/managed independently and changed only after capability/contract validation.

## Reporting

Do not publish credentials or exploitable details in a public issue. Use GitHub private vulnerability reporting/security advisories when available.