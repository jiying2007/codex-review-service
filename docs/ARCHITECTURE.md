# Architecture

```text
GitLab Webhook
   │ authenticated + idempotent + durable local transaction
   ▼
SQLite WAL/FULL review queue
   │
   ├── Review workers (different MRs parallel; same MR serialized)
   │      ├── immutable MR snapshot (start_sha + head_sha)
   │      ├── target-branch policy
   │      ├── provider diff completeness check
   │      ├── bounded immutable context
   │      ├── Codex Safe Contract
   │      └── deterministic finding validation / gate
   │
   └── transaction: review run + findings + publication outbox
                         │
                         ▼
                Publication workers
                   ├── summary upsert
                   ├── idempotent inline findings
                   ├── obsolete-thread resolution
                   └── pipeline-bound commit status
```

## Failure domains

Review execution and publication are deliberately separate. A GitLab write timeout cannot trigger a second Codex review after the review run has been persisted. Publisher retries use stable outbox keys and remote fingerprint discovery.

## Storage boundary

SQLite is the durable queue and metadata store. It uses WAL with `synchronous=FULL`, is local-filesystem only, and supports one active service process. A future HA implementation must provide a new transactional storage adapter with equivalent queue, outbox, idempotency, and per-MR serialization semantics.

## Provider boundary

GitLab-specific API behavior stays behind the provider client. Review snapshot construction, finding validation, policy, Codex execution, budgets, and publication planning remain provider-neutral enough to support a future provider without granting the model SCM credentials.
