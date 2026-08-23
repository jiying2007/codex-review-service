# Architecture

## Family v4 contract

- Shared Codex/process execution, Safe Contract v2, Policy Schema v3, Review Evidence chunking, deterministic Review Rules, and Review Receipt v4 are owned by the exact commit-pinned `codex-safe-core` 4 runtime.
- Service-owned responsibilities are GitLab provider semantics, immutable `start_sha`/`head_sha` evidence acquisition, SQLite schema 4, Queue/Outbox/Publisher, status/discussions, telemetry, and deployment.
- The only repository policy is target-branch `.codex-safe.json` schemaVersion 3.

## Configuration and deployment boundary

```text
Direct user mode                         System-level systemd
${XDG_CONFIG_HOME:-$HOME/.config}        /etc/codex-review/config.json
  /codex-review/config.json                         │
              │                                     │
              └────────── canonical config.json ────┘
                                   │
                                   ▼
                         Project Scope Resolver
                                   │
                                   ▼
                       Signed GitLab 19.1+ Webhook
                                   │
                                   ▼
                         SQLite WAL/FULL Queue
                                   │
                    ┌──────────────┴──────────────┐
                    ▼                             ▼
             Review Workers                Publication Workers
                    │
             Codex Safe Contract
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
   Standard inline      Hardened Runner
```

There is one configuration schema and one precedence model. Direct user mode defaults to XDG paths. System-level units explicitly pin `/etc/codex-review/config.json`; production config explicitly pins `/var/lib/codex-review` state. Runtime does not infer root, sudo, or systemd.

## Project-scope boundary

Only explicit Project IDs and Group IDs are supported. Group scope is expanded through paginated Group Projects API with optional subgroup inclusion. A refresh builds a complete next Set before mutating the active Set. Provider/pagination failure preserves the last complete Set and makes readiness unhealthy. Removed Projects immediately become unauthorized for new work and pending publication.

## Webhook boundary

The receiver requires Standard Webhooks Signing Token semantics, raw-body HMAC verification, replay-window timestamp, expected GitLab instance, durable delivery-ID idempotency, and resolved-scope authorization. It performs no GitLab API or Codex work inside the request.

## Failure domains

Review execution and GitLab publication are separate. A GitLab write timeout cannot trigger a second Codex review after a run is persisted. Publisher retry uses persistent Outbox state, stable dedupe keys, remote fingerprint discovery, snapshot checks, and current Project Scope checks.

Hardened Runner is a separate security/failure domain: Controller owns GitLab credentials/state; Runner owns Codex/OpenAI credentials and no SCM mutation capability.

## Storage boundary

SQLite is the durable webhook/review queue, review metadata store, and publication Outbox. It uses local-filesystem WAL + FULL and supports one active Controller. Direct user mode defaults to XDG state storage when `server.dataDir` is omitted. Production system config explicitly uses `/var/lib/codex-review`. HA must replace this boundary with equivalent transaction/idempotency/per-MR serialization/recovery semantics; never share SQLite over a network filesystem.

## Snapshot boundary

A review is identified by target `start_sha` + source `head_sha`. Policy, context, finding positions, and publication plan derive from those immutable identities. No stale result may publish.

## Provider boundary

GitLab-specific behavior stays behind provider-facing modules: scope discovery, webhook semantics, MR/diff APIs, pipelines, repository reads, discussions, and statuses. Review construction, finding validation, deterministic gate, budgets, and publication planning remain provider-independent and model-unprivileged.

## Publication boundary

Review Workers produce a deterministic publication plan and commit it with runs/findings. Publisher Workers execute the plan independently. Delayed running actions cannot overwrite terminal state; out-of-scope/stale actions are canceled locally.

## Evolution rule

Provider, Project Scope, storage, and Runner are explicit replacement boundaries. Future HA/provider/model transports replace one boundary cleanly. Do not reintroduce compatibility branches, hidden configuration precedence, or deployment-mode guessing throughout the review engine.