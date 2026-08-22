# Architecture

```text
/etc/codex-review/config.json
   │ projects + groups + deployment mode
   ▼
Project Scope Resolver ── GitLab Group Projects API
   │ complete atomic project set
   ▼
GitLab Webhook
   │ authenticated + idempotent + scope-checked
   ▼
SQLite WAL/FULL review queue
   │
   ├── Review Workers (different MRs parallel; same MR serialized)
   │      ├── immutable MR snapshot (start_sha + head_sha)
   │      ├── exact source project/ref/pipeline identity
   │      ├── target policy @ start_sha
   │      ├── provider diff completeness check
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
                       └── source/pipeline-bound commit status
```

## Deployment boundary

**Standard Deployment** is the default product path: one Controller process with inline Codex. **Hardened Deployment** preserves the optional separate Runner/user boundary. Both modes use exactly the same Review, Gate, Queue and Outbox semantics.

## Project-scope boundary

Structured configuration can name explicit Project IDs and Group IDs. Group scope is expanded with GitLab's paginated Group Projects API and optional subgroup inclusion. The resulting IDs are merged and deduplicated into one mutable runtime Set shared by webhook scope checks and reconciliation.

Scope replacement is atomic: a refresh builds a complete next set first. If any provider request fails or pagination is incomplete, the last complete Set remains active and scope health becomes unhealthy. Readiness therefore prevents operators from confusing partial discovery with a complete configuration.

Wildcard legacy scope is intentionally different: it accepts webhook projects reachable by the token but cannot provide exhaustive reconciliation.

## Failure domains

Review execution and GitLab publication are separate. A GitLab write timeout cannot trigger a second Codex review after the run has persisted. Publisher retries use stable Outbox keys and remote fingerprint discovery.

Hardened Runner mode adds a third security/failure domain: Controller owns GitLab credentials/state; Runner owns Codex/OpenAI credentials and no SCM mutation capability.

## Storage boundary

SQLite is the durable webhook/review queue, review metadata store and publication Outbox. It uses local-filesystem WAL with `synchronous=FULL` and supports one active Controller. HA requires replacing the storage boundary with equivalent transactional/idempotency/per-MR-serialization semantics rather than sharing SQLite over a network filesystem.

## Review snapshot boundary

A review is identified by target `start_sha` and source `head_sha`. Context, policy and inline positions derive from those immutable identities. No stale result may publish.

## Provider boundary

GitLab-specific behavior stays behind provider-facing modules: scope discovery, webhook semantics, MR/diff APIs, pipelines, discussions and statuses. Review construction, finding validation, policy, budgets and publication planning do not grant the model SCM credentials.

## Publication boundary

Review Workers create deterministic publication plans and commit them with runs/findings. Publisher Workers execute them independently. Delayed `running` actions cannot overwrite terminal state.

## Evolution rule

Provider, project-scope, storage and Runner interfaces are intentional replacement boundaries. New HA/providers/model transports should replace a boundary cleanly rather than spread compatibility branches through the review engine.
