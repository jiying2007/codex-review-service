# Architecture

## Product and shared-family contract

<!-- BEGIN GENERATED PRODUCT CONTRACT -->

Codex Review Service **7.3.2** owns production operations and GitLab compatibility profiles while consuming the exact-pinned Safe Core quality/review platform. `product-contract.json` is the machine-checked product identity:

```text
Service 7.3.2
DB Schema 8
Config Schema 7
Policy Schema 4
Review Receipt 5
Safe Contract 2
Safe Core 4c746614a1a4a5b6ea166ab6ded32f1319cf44c3
Quality Platform 3
Review Profile 1
Profile Pack 1
Impact Evidence 2
Test Impact 1
Analyzer Finding 1
Analyzer Adapter 1
Native Node: 22 LTS >=22.22.2 OR 24 LTS >=24.19.0
Canonical Docker Node: 24.19.0
GitLab compatibility floor: 14.6.1
GitLab recommendation: vendor-supported release
```

<!-- END GENERATED PRODUCT CONTRACT -->

Service-owned responsibilities: GitLab provider semantics/capability selection, immutable snapshot acquisition, CI analyzer artifact acquisition/adapters, Test Impact candidate acquisition, SQLite durability, Review Queue, Publication Outbox, Notification Outbox, operational telemetry, Admin/DR and deployment/release artifacts.

Safe Core-owned responsibilities: process execution, Codex capability contract, Policy Schema 4, Review Evidence chunking, deterministic Review Rules, Review Profile Packs, Analyzer Finding normalization, Test Impact ranking/evidence and Review Receipt 4.

IM, Docker, Admin, GitLab version/profile logic, CI artifact retrieval and deployment concerns must not be added to Safe Core. The Service never executes repository-defined analyzer commands and Test Impact never executes tests.

## Configuration and deployment boundary

```text
Direct user mode                         System-level systemd
${XDG_CONFIG_HOME:-$HOME/.config}        /etc/codex-review/config.json
  /codex-review/config.json                         │
              │                                     │
              └──────── Config Schema 4 ────────────┘
                                   │
                                   ▼
                         Project Scope Resolver
                                   │
                                   ▼
                       Signed GitLab Webhook
                                   │
                                   ▼
                         SQLite WAL + FULL
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
        Review Workers       Publication Workers   Notification Workers
              │                    │                    │
        Codex Safe Contract      GitLab API          Feishu/WeCom
              │
       ┌──────┴──────┐
       ▼             ▼
 inline Runner   isolated Runner
```

Runtime does not infer root, sudo, or systemd. Docker consumes the same Config Schema and durable state model; its release manifest points to a canonical OCI digest. Native/systemd supports explicit Node 22/24 LTS ranges; canonical Docker deliberately stays on one Node 24.19 runtime.

## Quality evidence boundary

The Service may acquire already-produced CI artifacts from the exact MR head pipeline according to operator Config Schema 4 `analyzerReports`. Adapters accept bounded SARIF, GitLab Code Quality, JUnit, Cobertura, LCOV, compiler diagnostics, Cppcheck, CycloneDX, Trivy and Gitleaks evidence. Artifact text is untrusted data and repository policy cannot define executable analyzer commands.

Finding-like analyzer results are normalized through the Core Analyzer Finding contract and can become changed-line evidence only after exact path/line anchoring. Coverage, SBOM and test metadata remain evidence metadata rather than fabricated source findings.

Review Profile Pack v1 selects bounded engineering emphasis such as general, security, C++, embedded Linux/MCU, driver, kernel and realtime. Packs cannot weaken Safe Contract, coverage or finding anchoring.

Test Impact retrieves candidate test files at the exact MR head SHA, then delegates deterministic ranking/evidence projection to Safe Core. The result is a recommendation/evidence set only; the Service does not execute tests and never treats a recommendation as test-pass evidence.

## Security/trust domain

One Service instance represents one administrative/security trust domain. Its projects share a Controller, SQLite state, capacity pool and normally a GitLab credential domain. Isolated Runner can separate GitLab and OpenAI/Codex credentials, but it does not create multi-tenant isolation.

Projects with materially different confidentiality, administrator or AI-data policies should use separate Service instances.

## Project-scope boundary

Only explicit Project IDs and Group IDs are supported. Group scope is expanded through paginated Group Projects API with optional subgroup inclusion.

A refresh constructs a complete next Set before mutating the active Set. Provider/pagination failure preserves the last complete Set. Removed Projects become unauthorized for new work and pending GitLab writes are canceled before another mutation.

The real-GitLab CI matrix creates Groups/Projects/MRs and exercises this provider boundary against GitLab CE 14.6.1, 17.11.7 and 19.3.0.

## Webhook boundary

The receiver requires Standard Webhooks Signing Token semantics, raw-body HMAC verification, replay-window timestamp, expected GitLab instance, durable delivery-ID idempotency and resolved-scope authorization.

The HTTP request path performs no GitLab API or Codex work. It accepts only enough work to validate and persist the event.

## Readiness vs dependency health

These are deliberately separate architectural concepts:

```text
/health/ready
  Can this instance safely accept and durably persist webhook traffic?

/health/dependencies
  Are GitLab and dynamic project-scope dependencies healthy now?
```

A transient GitLab outage must not force a healthy local durable receiver out of traffic. Initial startup still fails closed because the first capability/scope initialization completes before listening.

## Storage boundary

SQLite is the durable webhook/review queue, review metadata store, GitLab Publication Outbox and Notification Outbox. It uses a local filesystem with `WAL + synchronous=FULL` and supports one active Controller.

Schema 5 is the first production database contract. After v5.0.0, schema evolution requires explicit tested migrations rather than hard-cut recreation.

HA must replace this boundary with equivalent semantics for transactionality, idempotency, per-MR serialization, recovery, ordering and snapshot checks. Never share SQLite over a network filesystem.

## Snapshot and diff-completeness boundary

A review is identified by immutable target `start_sha` and source `head_sha`. Policy, evidence, finding positions and publication plan derive from those identities. No stale result may publish.

Before Codex receives evidence, the GitLab Provider must prove complete diff coverage using exactly one capability profile selected from authenticated GitLab version:

```text
GitLab /api/v4/version
        │
        ├─ 14.6.1 .. <15.7  → Classic
        │                       /changes
        │                       overflow must be exactly false
        │
        └─ >=15.7            → Modern
                                paginated /diffs
                                + /versions
                                + exact real_size
```

There is no operator-configurable profile override. Missing/ambiguous completeness evidence blocks review. Version selection logic lives only in `src/gitlab-capabilities.js`; provider methods consume capabilities rather than scattering `if(version)` checks across the Service.

## Failure-domain boundary

Review execution, GitLab publication and IM delivery are separate durable domains:

```text
Review execution
   ↓ atomic persist
Review Run + Receipt + publication/notification plans
   ├─ GitLab publication retries independently
   └─ IM delivery retries independently
```

A GitLab or IM write timeout cannot trigger a second Codex review after the Review Run is durable.

Unexpected asynchronous runtime failures are not tolerated as “unknown but alive”. `unhandledRejection` / `uncaughtException` triggers graceful resource shutdown, SQLite checkpoint/close and non-zero exit. The service manager restarts; durable recovery requeues interrupted states.

## Secret boundary

JSON config contains no credentials. Secret resolution supports either direct environment values or file-backed `_FILE` references, never both. Production Docker maps Compose secrets to `/run/secrets/*`; system deployments use protected local files.

Secret file indirection belongs to Service deployment/runtime, not Safe Core.

## Provider boundary

GitLab-specific behavior stays behind provider modules: capability selection, scope discovery, webhook semantics, MR/diff APIs, pipelines, repository reads, CI job/artifact reads, notes/discussions and statuses.

Classic/Modern are **first-class provider capability profiles**, not temporary compatibility residue. A profile is allowed only when it has one centralized selector, deterministic fail-closed semantics and permanent real-version contract coverage.

Review construction, finding validation, deterministic gate, budgets, Test Impact ranking and receipt semantics remain provider-independent and model-unprivileged.

## Publication boundary

Review Workers produce a deterministic publication plan and persist it atomically with the Review Run. Publisher Workers execute the plan independently. Remote fingerprint discovery, stale snapshot checks, scope checks and idempotency protect delayed/repeated writes.

## Notification boundary

Notifications are deterministic renderers over explicit Service events. `notification_outbox` contains durable delivery intent but not credentials. Provider webhook URLs/signing secrets resolve only at delivery time from protected secret inputs.

Notification failure never changes Review Verdict or GitLab approval state.

## Operations boundary

`src/admin-cli.js` is the supported operator mutation plane. It can inspect state, retry only terminal failed outbox entries, reconcile, drain, run integrity checks and create/verify online backups. It does not delete durable evidence or rerun Codex as a publication repair mechanism.

## Observability boundary

Metrics/traces/logs are metadata-only. Prometheus includes low-cardinality product identity plus queue/outbox depth and oldest-item age. Repository names, branch names, prompts, source text and secret values are excluded from metric labels.

## Delivery boundary

Release produces two canonical deployment forms from the same source SHA:

```text
verified tgz + checksums + provenance
               │
               ├── systemd (Node 22/24 supported range)
               │
               └── audit/extraction

multi-arch GHCR OCI digest + OCI provenance/SBOM
               │
               └── digest-pinned compose.release.yaml
                    canonical Node 24.19
```

Production Docker does not rebuild source on target hosts.

## Evolution rule

Provider, Project Scope, storage and Runner remain explicit replacement boundaries. Future PostgreSQL/HA or another provider may replace one boundary only after preserving transaction/idempotency/snapshot/recovery contracts.

Do not reintroduce scattered version branches, one-off legacy fallbacks, hidden configuration precedence, deployment-mode guessing, Service concerns in Safe Core, repository-defined analyzer execution, implicit test execution, or ad-hoc database mutation paths. A compatibility profile is a product contract only when centrally selected, fail-closed, documented and permanently tested against a real representative release.

## GitLab Flow Tracking Domain

Authenticated GitLab webhooks are split into two orthogonal consumers: the Review Domain may enqueue Codex review work, while the Flow Tracking Domain only updates `flow_state` and creates deterministic notification actions. The Flow path cannot call Codex, mutate code, retry pipelines, or create MRs. Both paths share webhook authentication/dedupe, project scope and the durable notification outbox.
