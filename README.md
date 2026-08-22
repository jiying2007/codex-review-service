# Codex Review Service

[English](README.md) | [简体中文](README.zh-CN.md)

Production-grade, self-hosted Codex review service for GitLab Self-Managed merge requests. The v1.1 architecture is a durable single-node controller with SQLite, asynchronous review workers, a transactional publication outbox, deterministic policy enforcement, optional isolated Codex Runner, and precise GitLab merge-gate publication.

## Long-term asset guarantees

- Webhook acknowledgement is backed by SQLite `WAL + synchronous=FULL`; a successful enqueue is power-loss durable under SQLite's durability model.
- Webhook requests only authenticate, deduplicate and enqueue locally. They do not call GitLab or Codex.
- Review jobs are serialized per MR and may run concurrently across MRs.
- Reviews are pinned to target `start_sha` + source `head_sha`; stale results cannot publish.
- Review runs/findings and their GitLab publication plan are committed in one transaction.
- A separate persistent Outbox Publisher retries GitLab writes without re-running Codex.
- External commit statuses are bound to the source project/ref and, when available, the exact GitLab `pipeline_id`.
- Superseded/closed reviews close their status lifecycle with `canceled`; delayed `running` publications cannot overwrite a terminal result.
- GitLab API traffic has global rate limiting, `Retry-After` support and a transient-failure circuit breaker.
- Codex findings must resolve to an exact changed old/new line. There is no silent ±N line relocation.
- Finding identity uses a source-code anchor hash rather than model-generated wording, stabilizing discussion reuse across re-reviews.
- Coverage distinguishes reviewed text, metadata-only changes, policy-excluded/generated files, known unreviewable binaries and genuine provider/local coverage gaps. Genuine gaps remain fail-closed.
- Bounded source/target context is fetched through GitLab Repository API at immutable snapshot SHAs. The service does not clone or execute untrusted MR code.
- Optional target-branch deterministic rules share the same Finding/Gate lifecycle as AI findings.
- Codex token usage is persisted; per-MR and per-project daily token budgets can fail closed before uncontrolled spend.
- Codex CLI capability and optional version policy are checked at startup/doctor time.
- Draft MRs may be skipped and automatic pushes are debounced/coalesced.
- Prometheus metrics, structured metadata-only logs and optional OTLP/HTTP traces cover queue, publisher and token behavior.
- GitHub Actions dependencies are pinned by full commit SHA and CI validates Node.js 22.13.0 and 24.

## Architecture

```text
GitLab Self-Managed
      │ authenticated MR / Note webhook
      ▼
Webhook Receiver
      │ verify HMAC/secret + instance + allowlist + delivery id
      ▼
SQLite WAL + synchronous=FULL
      │
      ├── Review Queue ── Review Workers (same MR serialized)
      │        │
      │        ├── MR + diff_refs + exact pipeline identity
      │        ├── target policy @ start_sha
      │        ├── paginated diff + hard-limit validation
      │        ├── bounded immutable source/target context
      │        ├── deterministic analyzers
      │        └── Codex review chunks
      │                 │
      │                 └── optional Unix-socket Isolated Runner
      │
      └── review_run + findings + publication_outbox  [one transaction]
                         │
                         ▼
                   Publisher Workers
                   ├── summary upsert
                   ├── inline discussions
                   ├── obsolete-thread resolve
                   └── pipeline-bound commit status
```

The supported production shape remains **single-node SQLite**. Do not share the SQLite database over a network filesystem or run multiple active controllers against the same database. If active/active HA becomes a real requirement, replace the queue/storage boundary with an external transactional store rather than layering distributed locking on SQLite.

## Requirements

- Node.js **22.13+**
- GitLab Self-Managed reachable from the controller
- Project/group access token with the minimum API scope required to read MR/diff/member/pipeline/repository data and write notes/discussions/statuses
- GitLab project webhooks; group webhooks may be used when the GitLab tier supports them
- GitLab 19+ Standard Webhooks Signing Token recommended; legacy secret token remains an explicit compatibility path
- OpenAI Codex CLI on the controller for inline mode, or on the isolated Runner for the recommended split mode

## Recommended production deployment: isolated Runner

The strongest boundary separates credentials by Unix user and process:

```text
codex-review controller
  - GitLab API/webhook credentials
  - SQLite state
  - no OpenAI/Codex credential required
        │
        │ /run/codex-review-runner/runner.sock
        ▼
codex-review-runner
  - Codex/OpenAI credential
  - no GitLab credential
  - Codex Safe Contract execution only
```

Install both units:

```bash
sudo useradd --system --create-home --home-dir /home/codex-review --shell /usr/sbin/nologin codex-review
sudo useradd --system --create-home --home-dir /home/codex-review-runner --shell /usr/sbin/nologin --gid codex-review codex-review-runner

git clone https://github.com/jiying2007/codex-review-service.git /opt/codex-review-service
cd /opt/codex-review-service
npm ci --ignore-scripts --no-audit --no-fund

sudo install -m 0600 .env.example /etc/codex-review-service.env
sudo install -m 0600 deploy/systemd/codex-review-runner.env.example /etc/codex-review-runner.env
sudo install -m 0644 deploy/systemd/codex-review-service.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/codex-review-runner.service /etc/systemd/system/
```

Authenticate Codex as the Runner user, or provision its API key through `/etc/codex-review-runner.env`:

```bash
sudo -u codex-review-runner -H codex login
```

Set in the controller environment:

```text
CODEX_RUNNER_SOCKET=/run/codex-review-runner/runner.sock
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now codex-review-runner codex-review-service
cd /opt/codex-review-service
sudo -u codex-review env $(sudo cat /etc/codex-review-service.env | xargs) npm run doctor
curl -fsS http://127.0.0.1:8787/health/ready
```

Inline Codex execution remains supported for development/small installations by leaving `CODEX_RUNNER_SOCKET` empty.

## GitLab webhook

Point the project/group webhook at:

```text
https://review.example.internal/webhooks/gitlab
```

Enable **Merge request events** and **Note events**. Prefer explicit numeric IDs in `GITLAB_PROJECT_ALLOWLIST`; wildcard mode is webhook-only because the controller cannot exhaustively reconcile an unknown project set.

For GitLab 19+, configure a Standard Webhooks Signing Token and set the same `whsec_...` value in `GITLAB_WEBHOOK_SIGNING_TOKEN`. `X-Gitlab-Instance` validation is enabled by default.

## Review and repository policy

Service environment values are hard ceilings. A repository may commit `.codex-review.json` on the **target branch**; the controller always reads it at `diff_refs.start_sha`, never from the unreviewed source branch.

Example:

```json
{
  "language": "zh-CN",
  "maxDiffBytes": 524288,
  "maxFindings": 30,
  "severityThreshold": "low",
  "timeoutSeconds": 120,
  "maxContextBytes": 131072,
  "maxContextFiles": 16,
  "contextLines": 40,
  "skipGeneratedFiles": true,
  "blockUnreviewableFiles": false,
  "forbiddenPathPrefixes": ["infra/prod-secrets/"],
  "requireTestsForCode": true,
  "codePathPrefixes": ["src/"],
  "testPathPrefixes": ["test/", "tests/"],
  "extraInstructions": "Focus on concurrency, resource lifetime and error handling."
}
```

Repository policy may narrow budgets or add deterministic rules; it cannot select credentials/tools, weaken `BLOCKING_SEVERITY`, lower the controller confidence floor, expand worker capacity or override the Codex Safe Contract.

## Merge gate semantics

The default external status name is `codex-review`:

- review started → `running`
- pass / advisory findings → `success`
- blocking findings / genuine coverage gap / terminal service failure / token-budget exhaustion → `failed`
- superseded or closed review → `canceled`

The controller resolves the source project/ref and tries to bind the status to the exact MR/source pipeline via `pipeline_id`. Enable GitLab **Pipelines must succeed** when the status should gate merge.

## Review quality and coverage

The service does not treat every empty/non-text diff as the same failure. Coverage states distinguish metadata-only changes, policy exclusions/generated files, known binary/unreviewable files and genuine provider/local truncation. Only genuine gaps are inherently fail-closed; `BLOCK_UNREVIEWABLE_FILES` can make known unreviewable files blocking when required by project risk policy.

Codex findings must point to an exact changed line. Controller-supplied context is advisory evidence only and cannot be used to fabricate an inline position outside the diff.

## Cost governance

Codex `turn.completed.usage` is persisted per review. Optional controls include:

```text
MR_MAX_TOKEN_BUDGET
PROJECT_DAILY_TOKEN_BUDGET
CODEX_VERSION_POLICY=off|warn|strict
CODEX_ALLOWED_VERSION_PATTERN=<regex>
```

A reached token budget marks the review incomplete/failed rather than silently skipping unreviewed chunks.

## Health, metrics and traces

```text
GET /health/live
GET /health/ready
GET /metrics
```

Readiness covers DB, Review Workers, Publisher Workers, GitLab reachability and Codex/Runner capability. Metrics include review queue depth, publication queue depth, retained job states, findings and token totals using low-cardinality labels. `OTEL_EXPORTER_OTLP_ENDPOINT` optionally exports JSON trace spans over OTLP/HTTP-compatible ingress.

`npm run doctor` validates configuration, SQLite schema/durability, Codex/Runner capability and GitLab connectivity without reviewing repository code.

## Manual review

A newly-created MR comment containing exactly `/codex review` requests a fresh review even when the snapshot SHA is unchanged. The author must satisfy `MANUAL_REVIEW_MIN_ACCESS_LEVEL` (Developer/30 by default). Bot-authored comments and edited old comments are ignored.

## Operations and governance

- [OPERATIONS.md](OPERATIONS.md) — deployment, upgrade, backup, rollback, monitoring and incidents
- [SECURITY.md](SECURITY.md) — trust boundary and threat model
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — architectural invariants
- [LONG_TERM_ASSET.md](LONG_TERM_ASSET.md) — rules for future changes
- [CHANGELOG.md](CHANGELOG.md) — release history

## Development

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run ci
npm pack --dry-run --ignore-scripts
```

CI runs `git diff --check`, syntax checks and the full contract/unit/integration/fuzz suite on Node.js 22.13.0 and Node.js 24.