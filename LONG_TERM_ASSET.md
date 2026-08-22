# Long-term asset invariants

This service is maintained as a security- and reliability-sensitive internal platform component.

## Non-negotiable invariants

1. A successful webhook acknowledgement is backed by a power-loss-durable local transaction (`WAL + synchronous=FULL`).
2. Codex never receives GitLab credentials and never owns GitLab mutations.
3. Review execution and GitLab publication are separate failure domains; publication uses a persistent outbox and must not cause Codex re-execution.
4. Every review is bound to both target `start_sha` and source `head_sha`; stale results never publish.
5. Findings must map to exact changed lines. Controller code never silently repairs model line numbers.
6. Merge gating is deterministic. Repository policy can narrow resource ceilings or add checks, but cannot weaken global blocking policy.
7. Incomplete provider coverage, local budget truncation, token-budget truncation or unverifiable model output fail closed. Metadata-only/generated/known-binary changes are classified explicitly rather than conflated with provider truncation.
8. External commit statuses are written to the correct source project/ref and bound to a concrete pipeline when GitLab exposes a compatible pipeline ID; fallback behavior must remain explicit and observable.
9. Human-resolved discussions are never silently reopened. A recurring issue gets a new current-snapshot discussion.
10. Token usage, queue latency, review latency, publication failures and provider health are observable without logging source code, prompts, raw model output or secrets.
11. The production Codex CLI is capability-checked and may be version-pinned with `CODEX_VERSION_POLICY=strict` and `CODEX_ALLOWED_VERSION_PATTERN`.
12. SQLite remains single-node/local-filesystem only. Active/active HA requires replacing the storage/queue boundary, not sharing SQLite over a network filesystem.
13. Production should prefer the isolated Unix-socket Runner: Controller owns GitLab credentials/state; Runner owns Codex/OpenAI credentials. The Runner must not acquire SCM mutation privileges.
14. GitLab publication retry, Runner retry or service restart must never create an implicit second review run for an already persisted snapshot result.
15. CI dependencies are pinned by immutable commit SHA, and changes to durability, trust boundaries, schema, outbox or merge-gate semantics require contract tests before merge.

## Evolution rule

Prefer clean provider/storage/Runner interfaces and additive migrations over compatibility layers. Transitional code must have an explicit removal point. Keep `main` deployable, keep README/README.zh-CN/OPERATIONS/SECURITY/ARCHITECTURE mutually consistent, and do not declare a release mature while any documented invariant is only aspirational rather than executable/tested.