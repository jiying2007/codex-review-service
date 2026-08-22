# Architecture

```text
/etc/codex-review/config.json
   │ canonical non-secret configuration
   ▼
Project Scope Resolver ── GitLab Group Projects API
   │ complete atomic Projects/Groups Set
   ▼
Signed GitLab 19.1+ Webhook
   │ HMAC + instance + idempotency + scope
   ▼
SQLite WAL/FULL review queue
   │
   ├── Review Workers (different MRs parallel; same MR serialized)
   │      ├── immutable snapshot: start_sha + head_sha
   │      ├── source project/ref/pipeline identity
   │      ├── target policy @ start_sha
   │      ├── provider diff completeness
   │      ├── bounded immutable context
   │      ├── deterministic analyzers
   │      └── Codex Safe Contract
   │                │
   │                ├── Standard: inline Codex
   │                └── Hardened: Unix socket → isolated Runner
   │
   └── one transaction: review run + findings + publication outbox
                              │
                              ▼
                     Publication Workers
                       ├── summary upsert
                       ├── idempotent inline findings
                       ├── obsolete-thread resolution
                       └── source/pipeline-bound status
```

## Configuration boundary

`config.json` is the single non-secret configuration source for Controller and Runner. Environment is reserved for GitLab/OpenAI credentials and an optional config-path override. There are no alternate project-scope, runner-mode, lifecycle, budget, concurrency, GitLab URL, or observability env paths.

## Deployment boundary

Standard and Hardened modes share all queue/review/gate/outbox behavior. Hardened adds a process/user credential boundary only; it does not fork business logic.

## Project-scope boundary

Only explicit Project IDs and Group IDs are supported. Group scope is expanded through paginated Group Projects API with optional subgroup inclusion. A refresh builds a complete next Set before mutating the active Set. Provider/pagination failure preserves the last complete Set and makes readiness unhealthy. Removed Projects immediately become unauthorized for new work and pending publication.

## Webhook boundary

The receiver requires Standard Webhooks Signing Token semantics, raw-body HMAC verification, replay-window timestamp, expected GitLab instance, and durable delivery-ID idempotency. It performs no GitLab API or Codex work inside the request.

## Failure domains

Review execution and GitLab publication are separate. A GitLab write timeout cannot trigger a second Codex review after a run is persisted. Publisher retry uses persistent Outbox state, stable dedupe keys, remote fingerprint discovery, snapshot checks, and current Project Scope checks.

Hardened Runner is a third security/failure domain: Controller owns GitLab credentials/state; Runner owns Codex/OpenAI credentials and no SCM mutation capability.

## Storage boundary

SQLite is the durable webhook/review queue, review metadata store, and publication Outbox. It uses local-filesystem WAL + FULL and supports one active Controller. HA must replace this boundary with equivalent transaction/idempotency/per-MR serialization/recovery semantics; do not share SQLite over a network filesystem.

## Snapshot boundary

A review is identified by target `start_sha` + source `head_sha`. Policy, context, finding positions, and publication plan derive from those immutable identities. No stale result may publish.

## Provider boundary

GitLab-specific behavior stays behind provider-facing modules: scope discovery, webhook semantics, MR/diff APIs, pipelines, repository reads, discussions, and statuses. Review construction, finding validation, deterministic gate, budgets, and publication planning remain provider-independent and model-unprivileged.

## Publication boundary

Review Workers produce a deterministic publication plan and commit it with runs/findings. Publisher Workers execute the plan independently. Delayed running actions cannot overwrite terminal state; out-of-scope/stale actions are canceled locally.

## Evolution rule

Provider, Project Scope, storage, and Runner are explicit replacement boundaries. Future HA/provider/model transports replace one boundary cleanly. Do not reintroduce compatibility branches throughout the review engine.
