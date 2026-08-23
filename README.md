# Codex Review Service

[English](README.md) | [简体中文](README.zh-CN.md)

Production-grade, self-hosted Codex review enforcement for GitLab Self-Managed merge requests. **v3.0 is the server-side enforcement member of the Codex Safe family** and consumes the same commit-pinned `codex-safe-core` runtime, Policy Schema v3, Review Evidence semantics, deterministic review rules, and Review Receipt v4 contract as the local products.

## Product-family boundary

```text
                     codex-safe-core 3.0.1
              Safe Contract v2 / Policy v3
           Review Evidence / Rules / Receipt v3
                           │
       ┌───────────────────┼───────────────────┐
       │                   │                   │
Codex Review Safe   Codex Commit Safe    Codex PR Safe
       │
       └───────────────────────────────┐
                                       ▼
                              Codex Review Service
                              GitLab server enforcement
```

Core owns shared Codex/process/policy/review-evidence/receipt semantics. This repository owns GitLab provider behavior, immutable MR evidence acquisition, SQLite durability, review scheduling, publication Outbox, GitLab status/discussions, observability, and deployment.

## Requirements

- Node.js **22.13+**
- GitLab Self-Managed **19.1+** with Standard Webhooks Signing Token
- GitLab API token scoped only to required project/group/MR/repository/discussion/status operations
- OpenAI Codex CLI authenticated as the service user, or as the isolated Runner user in Hardened mode

## Canonical configuration

All non-secret service settings still live in exactly one JSON file. Direct user-mode execution defaults to:

```text
${XDG_CONFIG_HOME:-$HOME/.config}/codex-review/config.json
```

Persistent state defaults to:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/codex-review/
```

`CODEX_REVIEW_CONFIG_FILE` explicitly overrides the config path. Relative `XDG_CONFIG_HOME` / `XDG_STATE_HOME` values are ignored; the standard `$HOME` fallbacks are used instead. System-level systemd deployment explicitly pins `/etc/codex-review/config.json`, while the production example explicitly uses `/var/lib/codex-review` for state.

Copy [`config.example.json`](config.example.json). Environment input is intentionally limited to credentials and the optional config path:

```text
CODEX_REVIEW_CONFIG_FILE
GITLAB_API_TOKEN
GITLAB_WEBHOOK_SIGNING_TOKEN
OPENAI_API_KEY
```

There is no non-secret environment override layer.

## Direct user-mode run

No root-owned runtime path is required. Create the XDG config directory, copy the example, and adjust `server.dataDir` or remove it to use the XDG state default:

```bash
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/codex-review"
cp config.example.json "${XDG_CONFIG_HOME:-$HOME/.config}/codex-review/config.json"
# edit config.json for your GitLab scope; remove server.dataDir for the XDG state default

export GITLAB_API_TOKEN=...
export GITLAB_WEBHOOK_SIGNING_TOKEN=...
codex login
npm start
```

## Standard Deployment

The default production topology is one process:

```text
GitLab → codex-review-service
            ├─ SQLite WAL + synchronous=FULL
            ├─ Review Workers
            ├─ Transactional Publication Outbox
            └─ Codex Safe Core → Codex CLI (inline)
```

```bash
sudo useradd --system --create-home --home-dir /home/codex-review --shell /usr/sbin/nologin codex-review
sudo mkdir -p /etc/codex-review

git clone --recurse-submodules https://github.com/jiying2007/codex-review-service.git /opt/codex-review-service
cd /opt/codex-review-service
npm ci --ignore-scripts --no-audit --no-fund
npm run core:init

sudo install -m 0644 config.example.json /etc/codex-review/config.json
sudo install -o root -g codex-review -m 0640 .env.example /etc/codex-review-service.env
sudo install -m 0644 deploy/systemd/codex-review-service.service /etc/systemd/system/

sudo -u codex-review -H codex login
sudo -u codex-review /usr/bin/node --env-file=/etc/codex-review-service.env src/doctor.js
sudo systemctl daemon-reload
sudo systemctl enable --now codex-review-service
curl -fsS http://127.0.0.1:8787/health/ready
```

## Multi-repository scope

One instance manages explicit Projects and/or Groups:

```json
{
  "gitlab": {
    "baseUrl": "https://gitlab.example.internal",
    "projects": [101, 102],
    "groups": [
      { "id": 20, "includeSubgroups": true }
    ]
  },
  "review": { "concurrency": 4 },
  "runner": { "mode": "inline" }
}
```

Group discovery is paginated and fail-closed. A newly discovered set replaces the active scope only after complete discovery; failed refresh keeps the last complete scope and makes readiness unhealthy. Different MRs may run concurrently while one MR remains serialized.

## Hardened Deployment

For credential/process isolation:

```json
{
  "runner": {
    "mode": "isolated",
    "socket": "/run/codex-review-runner/runner.sock"
  }
}
```

Controller and Runner read the same canonical `config.json`. The Controller owns GitLab credentials and SQLite. The Runner owns Codex/OpenAI credentials, receives only bounded review input through the Unix socket, and has no GitLab credentials. Both execution modes use the same Safe Core runtime and Safe Contract.

## Webhook contract

Configure GitLab 19.1+ **Merge request events** and **Note events** at:

```text
https://review.example.internal/webhooks/gitlab
```

The receiver requires `webhook-id`, `webhook-timestamp`, `webhook-signature`, validates HMAC over the exact raw body, enforces timestamp skew, validates `X-Gitlab-Instance`, deduplicates delivery IDs, durably enqueues locally, and returns quickly.

## Repository Policy v3

The only repository policy is target-branch **`.codex-safe.json`**. The service reads it from the exact `diff_refs.start_sha` and validates it with the pinned Core closed schema. See [`.codex-safe.example.json`](.codex-safe.example.json).

Shared `review` policy is consumed by both local Review Safe and Review Service. Service-only provider/context controls live under `reviewService`.

```json
{
  "schemaVersion": 3,
  "review": {
    "language": "zh-CN",
    "maxDiffBytes": 524288,
    "maxFindings": 30,
    "severityThreshold": "low",
    "confidenceThreshold": 0.7,
    "rules": {
      "requireTestsForCodeChanges": true,
      "codePathPrefixes": ["src/"],
      "testPathPrefixes": ["test/", "tests/"],
      "forbiddenPathPrefixes": []
    }
  },
  "reviewService": {
    "maxContextBytes": 131072,
    "maxContextFiles": 8,
    "contextLines": 16,
    "skipGeneratedFiles": true,
    "blockUnreviewableFiles": false
  }
}
```

Repository policy may narrow resource ceilings and strengthen deterministic gates; it cannot weaken service-wide blocking/confidence/security/capacity boundaries.

## Review Evidence and exact-line semantics

GitLab hunk-only patches are normalized by the provider adapter into canonical unified-diff blocks, then passed to Core `buildReviewEvidenceChunks()`. `maxDiffBytes` is a per-review-evidence chunk budget. Changed hunks are never silently head/tail truncated: a hunk is reviewed or produces an explicit coverage gap.

Service retains the complete provider diff metadata for exact `old/new` changed-line validation and stable anchors. Model findings are never relocated to nearby lines.

## Immutable context

Additional source windows are acquired by the Service through GitLab Repository API only at the captured source `head_sha` and target `start_sha`. Reviewed repository code is never checked out or executed by the service. Core receives the resulting bounded evidence but does not own GitLab provider access.

## Review Receipt v4 and durability

SQLite schema **4** stores a canonical GitLab-MR Review Receipt v4 projection and fingerprint in `review_runs`. Receipt, run, findings, and publication plan are committed in the same `BEGIN IMMEDIATE` transaction.

The receipt binds:

```text
projectId + MR iid + startSha + headSha
+ diff fingerprint + policy fingerprint
+ quality/readiness/mechanical/coverage verdicts
+ model + Codex version + timestamp
```

SQLite remains the Service source of truth; Receipt v3 is the cross-product audit/provenance projection, not a second storage system.

## Reliability and security invariants

- SQLite `WAL + synchronous=FULL` backs acknowledged local state;
- review execution and GitLab publication are independent durable failure domains;
- target `start_sha` + source `head_sha` identify the reviewed MR snapshot;
- stale snapshots and projects removed from dynamic scope cannot publish;
- status binds source project/ref and exact `pipeline_id` when resolvable;
- exact changed-line validation with no relocation;
- stable code-anchor finding identity;
- provider/context/evidence coverage gaps fail closed;
- deterministic `review.rules` semantics come from Safe Core;
- token usage and MR/project budgets are persisted and enforced;
- GitLab traffic is rate-limited and circuit-breaker protected;
- GitHub Actions are pinned to immutable full commit SHAs.

## Health and operations

```text
GET /health/live
GET /health/ready
GET /metrics
```

`npm run doctor` validates canonical config, SQLite durability/schema, Core-backed Codex/Runner capability, GitLab reachability, and complete Project/Group scope without executing reviewed code.

See [OPERATIONS.md](OPERATIONS.md), [SECURITY.md](SECURITY.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [LONG_TERM_ASSET.md](LONG_TERM_ASSET.md), and [CHANGELOG.md](CHANGELOG.md).

## Development and release

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run core:init
npm run ci
npm pack --dry-run --ignore-scripts
npm run release:check
```

CI validates Node.js 22.13.0 and Node.js 24. A version change on `main` triggers the Release workflow, which repeats the dual-Node validation, creates exactly one `codex-review-service-<version>.tgz`, generates `SHA256SUMS`, creates GitHub build-provenance attestations, creates/validates the immutable `v<version>` tag, and publishes the GitHub Release.
