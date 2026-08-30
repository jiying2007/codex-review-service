# Long-term asset invariants

Codex Review Service is maintained as a security- and reliability-sensitive platform component. Service **v6.2.2** is the current production-operations baseline; shared review/safety semantics remain exact-pinned Safe Core Family v4.

## Product identity

`product-contract.json` is the machine-checked product fact source: Service 6.2.2, Database Schema 6, Config Schema 3, Policy Schema 3, Review Receipt 4, Safe Contract 2, Profile Pack 1, Test Impact 1, Analyzer Adapter 1, exact Safe Core commit `e75d27d5f157cacc5e8f6b711355dd5cf4ddfe34`, Node 22.22.2+/24.19.0+ LTS support and GitLab >=14.6.1 compatibility.

## Non-negotiable invariants

1. A successful webhook acknowledgement is backed by a power-loss-durable local transaction (`WAL + synchronous=FULL`).
2. Codex never receives GitLab credentials and never owns GitLab mutations.
3. Review execution, GitLab publication and IM notification are separate durable failure domains; downstream retry never causes implicit Codex re-execution for a persisted Review Run.
4. Every review binds target `start_sha` + source `head_sha`; stale results never publish.
5. Findings map to exact changed lines; Controller never repairs model line numbers.
6. Merge gating is deterministic. Repository policy may narrow ceilings/add checks but cannot weaken Service-owned gate/security policy.
7. Genuine provider/local/token/model-evidence gaps fail closed; metadata/generated/known-binary cases remain explicitly classified.
8. External status targets the correct source Project/ref and concrete pipeline when resolvable.
9. Human-resolved discussions are never silently reopened.
10. Token usage, queue/review latency, publication/notification failures, Project-Scope health and provider health are observable without source/prompts/raw model output/secrets.
11. Production Codex CLI is capability-checked and may be version-pinned by canonical config.
12. SQLite is single-node/local-filesystem only. HA replaces the storage boundary; it never shares SQLite over a network filesystem.
13. Standard deployment is one Controller + inline Codex; Hardened adds isolated Runner without branching Review/Gate/Outbox semantics.
14. Projects/Groups scope changes only after complete discovery. Failed/incomplete refresh preserves the last complete Set and degrades dependency health.
15. Readiness answers whether local durable webhook intake is safe; remote GitLab/scope health is a separate dependency signal. A temporary remote outage must not unnecessarily discard durable intake capacity.
16. A Project removed from current Scope cannot receive new work or pending GitLab publication.
17. There is exactly one non-secret JSON configuration model. Direct user mode follows XDG config/state defaults; system-level systemd explicitly pins `/etc/codex-review/config.json` and production state under `/var/lib/codex-review`. Runtime does not infer root/sudo/systemd mode.
18. Config Schema identity is explicit. Current runtime accepts **Config Schema 3** only; unsupported or missing schema versions fail closed and hidden compatibility precedence is forbidden.
19. Config Schema 3 has one Analyzer Adapter surface, `review.analyzerReports`. The retired `review.sarifFiles` field and any compatibility translator must not return.
20. Analyzer Adapter Hub consumes bounded CI artifacts only. The Service never executes repository-defined analyzer commands or commands embedded in untrusted report/log text.
21. Analyzer evidence is bound to the exact MR head pipeline. Finding-like evidence passes canonical normalization and changed-line anchoring; coverage/SBOM/test metadata is not fabricated into source findings.
22. Profile Pack selection is versioned execution emphasis, not repository authority, and cannot weaken Safe Contract/evidence/gating invariants.
23. Test Impact is deterministic recommendation evidence only; it never executes tests and never claims a recommendation passed.
24. Secrets are outside JSON/SQLite. Production supports protected file-backed `_FILE` inputs; matching direct+file forms are mutually exclusive.
25. GitLab webhook authentication uses one configured token surface with capability-specific Classic/Standard verification. Classic GitLab does not pretend to have Standard HMAC replay guarantees.
26. One Service instance is one administrative/security trust domain. Materially different trust domains use separate instances instead of hidden multi-tenant behavior.
27. Unknown `unhandledRejection` / `uncaughtException` is a fatal integrity event: graceful shutdown, durable checkpoint/close, non-zero exit and service-manager restart.
28. Operator state mutations go through the Admin control plane; incident repair must not depend on deleting or hand-editing durable queue/outbox rows.
29. Backups use a consistent SQLite online backup and are accepted only after integrity, foreign-key and exact current **Schema 6** verification.
30. The historic **Schema 5 -> 6 migration** remains explicit and tested. After v5.0.0, database/config evolution requires explicit upgrade/migration fixtures/tests and a documented rollback boundary.
31. Service 6.2.2 makes Config Schema 2 -> 3 a documented configuration hard cut. Rollback to a Config Schema 2 release requires restoring its matching config; runtime translation is forbidden.
32. Docker production consumes a canonical OCI digest generated by Release, not a target-host source rebuild. The Node base image is digest-pinned.
33. Release identity covers tgz, package SBOM, OCI digest/metadata, digest-pinned Compose manifest, checksums and provenance attestations.
34. GitHub Actions are manually reviewed and pinned by immutable commit SHA. Action upgrades run the complete affected matrix before merge.
35. Provider compatibility is tested against real GitLab CE 14.6.1, 17.11.7 and 19.3.0; mocks alone are not sufficient for provider claims.
36. SLO/capacity decisions use queue age, time-to-verdict/publication convergence, token use, CPU/memory/filesystem and real MR workload measurements rather than arbitrary limit increases.
37. `main` uses audited squash-merge history for product changes; merged feature branches are disposable and must be cleaned.
38. Service-only GitLab/IM/Docker/Admin/deployment concerns must not be pushed into exact-pinned Safe Core shared protocol layers.
39. Compatibility inputs removed in earlier releases must not be reintroduced without an explicit architecture/version decision.
40. Current documentation must describe Service v6.2.2, Database Schema 6, Config Schema 3 and Safe Core Family v4 accurately; historical labels belong only in changelog/migration history.

## Evolution rule

Prefer clean Provider / Project-Scope / Storage / Runner / Analyzer-Adapter replacement boundaries over compatibility layers. PostgreSQL/HA, another SCM provider or additional distribution targets are adopted only when a demonstrated requirement justifies the added failure modes and after the replacement preserves transactionality, idempotency, per-MR serialization, immutable snapshot validation and recovery semantics.

Keep `main` deployable. README/README.zh-CN/OPERATIONS/SECURITY/ARCHITECTURE and `product-contract.json` must remain mutually consistent, and CI must fail when product facts drift.
