# Codex Review Service

[English](README.md) | [简体中文](README.zh-CN.md)

Production-grade, self-hosted Codex review enforcement for GitLab Self-Managed merge requests. This repository is the server-side enforcement member of the **Codex Safe Family v4** and consumes one exact commit-pinned `codex-safe-core` 4 runtime with Safe Contract v2, Policy Schema v3, Review Evidence, deterministic Review Rules, and Review Receipt v4.

## Product-family boundary

```text
                     codex-safe-core 4
              Safe Contract v2 / Policy v3
           Review Evidence / Rules / Receipt v4
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
- OpenAI Codex CLI authenticated as the execution user, or `OPENAI_API_KEY`

## Canonical configuration

There is exactly one non-secret JSON configuration source. The location depends on how the process is launched; the schema and precedence do not.

Direct user-mode execution defaults to:

```text
${XDG_CONFIG_HOME:-$HOME/.config}/codex-review/config.json
```

If `server.dataDir` is omitted, persistent state defaults to:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/codex-review/
```

`CODEX_REVIEW_CONFIG_FILE` explicitly selects another config file. Relative `XDG_CONFIG_HOME` / `XDG_STATE_HOME` values are ignored and fall back to the standard `$HOME` locations.

System-level systemd deployment deliberately pins:

```text
/etc/codex-review/config.json
/var/lib/codex-review
```

The production [`config.example.json`](config.example.json) explicitly uses `/var/lib/codex-review`, while both systemd units explicitly set `CODEX_REVIEW_CONFIG_FILE=/etc/codex-review/config.json`. Runtime code does not detect root, sudo, or systemd.

Supported environment input is intentionally narrow:

```text
CODEX_REVIEW_CONFIG_FILE
GITLAB_API_TOKEN
GITLAB_WEBHOOK_SIGNING_TOKEN
OPENAI_API_KEY
```

There is no non-secret environment override layer.

## Direct user-mode run

No root-owned runtime path is required:

```bash
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/codex-review"
cp config.example.json "${XDG_CONFIG_HOME:-$HOME/.config}/codex-review/config.json"
# Edit GitLab scope. Remove server.dataDir to use the XDG state default.

export GITLAB_API_TOKEN=...
export GITLAB_WEBHOOK_SIGNING_TOKEN=...
codex login
npm start
```

## System-level deployment

The default production topology is one Controller with inline Codex:

```text
GitLab → codex-review-service
            ├─ SQLite WAL + synchronous=FULL
            ├─ Review Workers
            ├─ Transactional Publication Outbox
            └─ Codex Safe Core → Codex CLI
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

One instance can manage explicit Projects and/or Groups:

```json
{
  "gitlab": {
    "baseUrl": "https://gitlab.example.internal",
    "projects": [101, 102],
    "groups": [{ "id": 20, "includeSubgroups": true }]
  },
  "review": { "concurrency": 4 },
  "runner": { "mode": "inline" }
}
```

Group discovery is paginated and fail-closed. The active scope changes only after complete discovery succeeds; a failed refresh retains the previous complete set and makes readiness unhealthy. Different MRs may run concurrently while each MR remains serialized.

## Hardened deployment

Set `runner.mode="isolated"` to separate GitLab credentials from Codex/OpenAI credentials:

```json
{
  "runner": {
    "mode": "isolated",
    "socket": "/run/codex-review-runner/runner.sock"
  }
}
```

Controller and Runner consume the same canonical `config.json`. In system-level deployment both units explicitly point to `/etc/codex-review/config.json`; the Runner has no GitLab credential.

## Webhook contract

Configure GitLab 19.1+ **Merge request events** and **Note events** at:

```text
https://review.example.internal/webhooks/gitlab
```

The receiver validates Standard Webhooks signing metadata, exact raw-body HMAC, replay window, expected GitLab instance, delivery identity, and resolved scope before durably enqueuing work.

## Repository Policy v3

The only repository policy is target-branch **`.codex-safe.json`**. It is read from the immutable target `diff_refs.start_sha` and validated by the pinned Core closed schema. Shared `review` policy is consumed by both local Review Safe and Review Service; service-only provider/context controls live under `reviewService`.

Repository policy may narrow ceilings and strengthen deterministic gates. It cannot weaken service-wide blocking/confidence/security/capacity boundaries.

## Review evidence and receipts

Provider patches are normalized into Core Review Evidence chunks without silent hunk truncation. Findings must resolve to exact changed lines; model line numbers are never repaired or relocated.

SQLite schema **4** stores the canonical GitLab-MR Review Receipt v4 projection and fingerprint with the run, findings, and publication plan in one durable transaction. SQLite remains the Service source of truth; Receipt v4 is the cross-product audit/provenance projection.

## Reliability invariants

- SQLite local-filesystem `WAL + synchronous=FULL`;
- review and GitLab publication are separate durable failure domains;
- every review binds target `start_sha` + source `head_sha`;
- stale or out-of-scope results cannot publish;
- publication retry never reruns an already persisted review;
- Project/Group discovery is atomic and fail-closed;
- GitHub Actions are full-SHA pinned.

## Health and operations

```text
GET /health/live
GET /health/ready
GET /metrics
```

`npm run doctor` validates canonical config, state/database readiness, Core-backed Codex/Runner capability, GitLab reachability, and complete Project/Group scope without executing reviewed repository code.

See [OPERATIONS.md](OPERATIONS.md), [SECURITY.md](SECURITY.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [LONG_TERM_ASSET.md](LONG_TERM_ASSET.md), and [CHANGELOG.md](CHANGELOG.md).

## Development and release

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run core:init
npm run ci
npm pack --dry-run --ignore-scripts
npm run release:check
```

CI validates Node.js 22.13.0 and Node.js 24. Versioned releases generate an immutable TGZ, SPDX SBOM, SHA256 checksums, provenance attestation, and immutable `v<version>` tag/Release.