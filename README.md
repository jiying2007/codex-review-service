# Codex Review Service

[English](README.md) | [简体中文](README.zh-CN.md)

Production-oriented, self-hosted Codex code review service for GitLab Self-Managed merge requests. It is designed for an internal single-node deployment: GitLab delivers authenticated webhooks, a durable SQLite queue schedules reviews, Codex analyzes bounded MR diff snapshots, and the controller publishes deterministic GitLab review results without exposing GitLab credentials to Codex.

## Capabilities

- Merge Request `open`, `reopen`, and source-code `update` auto review; non-code MR updates do not spend Codex capacity.
- `/codex review` manual re-review, authorized through effective GitLab project membership (Developer+ by default).
- Fast webhook acknowledgement: authentication, replay/idempotency recording, and local queue insertion only; GitLab API/Codex work happens asynchronously.
- GitLab 19+ Standard Webhooks HMAC signing, timestamp replay window, `X-Gitlab-Instance` binding, legacy secret fallback, and explicit project allowlist.
- SQLite WAL durable queue with additive schema migration, bounded queue depth, restart recovery, exponential retry/backoff, retention, and WAL checkpoint maintenance.
- Configurable worker concurrency: different MRs can run concurrently while each MR is serialized.
- Full MR snapshot identity uses target `start_sha` + source `head_sha`; periodic reconciliation catches snapshot changes when an explicit project allowlist is configured.
- `GET /merge_requests/:iid/diffs` pagination with fail-closed handling for incomplete pagination, `too_large`, `collapsed`, binary/unavailable, oversized, or chunk-limit gaps.
- Large textual MRs are split into bounded Codex chunks; one oversized file never silently disappears.
- Findings support both added (`side=new`) and removed (`side=old`) changed lines.
- Structured model output is locally validated; unverifiable model findings make the review `incomplete` instead of allowing a false pass.
- Deterministic gate policy: service-level `BLOCKING_SEVERITY` cannot be weakened by repository content.
- Target-branch `.codex-review.json` policy is pinned to `diff_refs.start_sha`, so an unreviewed MR cannot lower its own review policy.
- One upserted summary note, stable finding fingerprints, inline discussions, unresolved-thread reuse, and safe obsolete-thread resolution.
- GitLab external commit status with source `ref`; blocking/incomplete/service failure is `failed`.
- Codex Safe Contract: ephemeral execution, ignored user/repository rules, read-only sandbox, disabled web/shell/apps/agents/hooks/memories, filtered child environment, output limits, capability preflight, and process-tree cancellation.
- `/health/live`, cached `/health/ready`, Prometheus `/metrics`, and `npm run doctor`.
- Hardened systemd unit, bilingual docs, operations runbook, security policy, Node 22.13/24 CI, and Dependabot.

## Architecture

```text
GitLab Self-Managed
      │  MR / Note webhook
      ▼
Webhook Receiver ── verify signature / instance / allowlist / delivery-id
      │              (no GitLab API call on webhook request)
      ▼
SQLite WAL Queue
      │
      ├─ Worker 1 ─┐
      ├─ Worker 2 ─┼─ per-MR serialization
      └─ ...       ┘
             │
             ▼
       Snapshot Hydration
       ├─ MR metadata + diff_refs
       ├─ target policy @ start_sha
       └─ paginated MR diffs
             │
             ▼
       Bounded Codex Chunks
             │
             ▼
      Local Validation / Gate
             │
             ▼
        GitLab Publisher
       ├─ summary note upsert
       ├─ inline discussions
       └─ external commit status
```

The service is intentionally single-node with local SQLite. Do not run multiple service instances against the same database. If active/active HA becomes a requirement, replace the queue/storage boundary with an external transactional store rather than sharing SQLite over a network filesystem.

## Requirements

- Node.js **22.13+**
- OpenAI Codex CLI available to the service account
- GitLab Self-Managed reachable from the service host
- Project or group access token with API permissions required to read MRs/diffs/membership/repository policy and write notes/discussions/commit statuses
- GitLab project webhooks; group webhooks may be used when supported by the GitLab tier
- GitLab 19+ Standard Webhooks signing token recommended; legacy secret token remains supported for older installations/migrations

## Install

```bash
sudo useradd --system --create-home --home-dir /home/codex-review --shell /usr/sbin/nologin codex-review
sudo mkdir -p /opt/codex-review-service /home/codex-review/.codex
sudo chown -R codex-review:codex-review /home/codex-review/.codex

git clone https://github.com/jiying2007/codex-review-service.git /opt/codex-review-service
cd /opt/codex-review-service
npm ci --ignore-scripts --no-audit --no-fund
```

Authenticate Codex as the service user, or use an API key in the protected environment file:

```bash
sudo -u codex-review -H codex login
```

Install configuration and service unit:

```bash
sudo install -m 0600 .env.example /etc/codex-review-service.env
sudo install -m 0644 deploy/systemd/codex-review-service.service /etc/systemd/system/codex-review-service.service
sudo systemctl daemon-reload
sudo systemctl enable --now codex-review-service
```

Before enabling production webhooks, run `npm run doctor` under the same user/environment as systemd.

## GitLab setup

Point a project webhook to:

```text
https://review.example.internal/webhooks/gitlab
```

Enable Merge request events and Note events. Configure `GITLAB_PROJECT_ALLOWLIST` with explicit numeric project IDs for the strongest closed loop. `*` accepts any project reachable by the token, but periodic reconciliation is disabled because the service cannot exhaustively enumerate the intended scope.

For GitLab 19+, configure the webhook Signing token and copy its `whsec_...` value to `GITLAB_WEBHOOK_SIGNING_TOKEN`. The service also validates `X-Gitlab-Instance` by default.

## Review policy

Service configuration is the hard security ceiling. A repository may commit `.codex-review.json` on the target branch. The service reads it from the immutable MR target snapshot (`diff_refs.start_sha`), not the source branch.

```json
{
  "language": "zh-CN",
  "maxDiffBytes": 524288,
  "maxFindings": 30,
  "severityThreshold": "low",
  "timeoutSeconds": 120,
  "extraInstructions": "Focus on concurrency, resource lifetime, and error handling."
}
```

Repository values can reduce resource ceilings. `severityThreshold` controls which validated findings are surfaced, but it may not hide any severity that the service-level `BLOCKING_SEVERITY` would block. Repository content cannot change Codex executable/model, credentials, worker controls, confidence floor, or blocking policy.

## Merge gate

The service publishes the configured external commit status (default `codex-review`): review running → `running`; `pass` / `needs_attention` → `success`; `block` / `incomplete` / terminal service failure → `failed`. Enable GitLab's “pipelines must succeed” merge check if this status should gate merge. `critical` and `high` are blocking by default. Coverage gaps are always fail-closed.

## Manual command

A newly-created MR comment containing exactly `/codex review` requests a fresh review even when the snapshot SHA is unchanged. The commenter must meet `MANUAL_REVIEW_MIN_ACCESS_LEVEL` (default 30 / Developer), based on effective project membership. Bot-authored comments and edited old comments are ignored.

## Health / metrics / doctor

`GET /health/live`, `GET /health/ready`, and `GET /metrics` are available. `/health/ready` checks DB state, worker state, and GitLab reachability with a short cache. Metrics intentionally use only low-cardinality labels and contain no project/repository/source identifiers.

`npm run doctor` checks configuration, SQLite schema, Codex capabilities, and GitLab API reachability without reviewing source code.

## Operations and security

See [OPERATIONS.md](OPERATIONS.md) for deployment, upgrade, backup/restore, rollback, monitoring, and incident procedures. See [SECURITY.md](SECURITY.md) for the trust boundary and threat model. See [CHANGELOG.md](CHANGELOG.md) for release changes.

## Development

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run ci
```

CI validates the minimum supported Node.js 22.13 runtime and Node.js 24.
