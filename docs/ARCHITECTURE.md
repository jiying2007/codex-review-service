# Architecture

```text
GitLab Webhook
   │ authenticated + idempotent + durable local transaction
   ▼
SQLite WAL/FULL review queue
   │
   ├── Review Workers (different MRs parallel; same MR serialized)
   │      ├── immutable MR snapshot (start_sha + head_sha)
   │      ├── exact source project/ref/pipeline identity
   │      ├── target-branch policy @ start_sha
   │      ├── provider diff completeness check
   │      ├── bounded immutable context @ start_sha/head_sha
   │      ├── deterministic analyzers
   │      └── Codex Safe Contract
   │                │
   │                ├── inline mode (development/small deployments)
   │                └── Unix socket → isolated Codex Runner (recommended production)
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

## Failure domains

Review execution and GitLab publication are deliberately separate. A GitLab write timeout cannot trigger a second Codex review after the review run has been persisted. Publisher retries use stable outbox keys and remote fingerprint discovery.

The optional isolated Runner creates a third failure/security domain: the Controller owns GitLab credentials and durable state; the Runner owns Codex/OpenAI credentials and does not own SCM mutation capability. Controller/Runner communication is a bounded HTTP protocol over a local Unix socket.

## Storage boundary

SQLite is the durable queue, review metadata store and publication outbox. It uses local-filesystem WAL with `synchronous=FULL` and supports one active Controller. A future HA implementation must provide a new transactional storage adapter with equivalent review queue, outbox, webhook idempotency, per-MR serialization and recovery semantics.

## Review snapshot boundary

A review is identified by target `start_sha` and source `head_sha`. Context, target policy and inline positions are derived from those immutable identities. No result may be published after either SHA changes.

## Provider boundary

GitLab-specific API behavior stays behind the provider client: webhook semantics, MR/diff APIs, pipeline lookup, discussions and statuses. Review snapshot construction, finding validation, deterministic analyzers, policy, budgets and publication planning do not grant the model SCM credentials.

## Publication boundary

The Review Worker creates a deterministic publication plan; it does not perform GitLab writes. The plan is committed with the run/findings, then Publisher Workers execute it independently. Delayed `running` actions are canceled after a terminal job state, while final/canceled statuses are durable actions.

## Codex boundary

Codex receives only bounded untrusted review data plus controller-selected immutable context. It cannot run repository commands, fetch SCM data or mutate GitLab. The Safe Contract is capability-checked. In isolated Runner mode, GitLab credentials are absent at the process/user boundary as well as the child environment boundary.

## Evolution rule

Provider, storage and Runner interfaces are intentional replacement boundaries. New HA/providers/model transports should replace one boundary cleanly rather than add compatibility branches throughout the review engine.