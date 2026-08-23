# Long-term asset invariants

## Family v4 contract

- Shared Codex/process execution, Safe Contract v2, Policy Schema v3, Review Evidence chunking, deterministic Review Rules, and Review Receipt v4 are owned by the exact commit-pinned `codex-safe-core` 4 runtime.
- Service-owned responsibilities are GitLab provider semantics, immutable `start_sha`/`head_sha` evidence acquisition, SQLite schema 4, Queue/Outbox/Publisher, status/discussions, telemetry, and deployment.
- The only repository policy is target-branch `.codex-safe.json` schemaVersion 3; there is no Service-only policy parser or legacy policy fallback.
- Standard and isolated Runner modes execute the same Core runtime.

This service is maintained as a security- and reliability-sensitive internal platform component.

## Non-negotiable invariants

1. A successful webhook acknowledgement is backed by a power-loss-durable local transaction (`WAL + synchronous=FULL`).
2. Codex never receives GitLab credentials and never owns GitLab mutations.
3. Review execution and GitLab publication are separate failure domains; persistent Outbox retry must not cause Codex re-execution.
4. Every review binds target `start_sha` + source `head_sha`; stale results never publish.
5. Findings map to exact changed lines; Controller never repairs model line numbers.
6. Merge gating is deterministic. Repository policy can narrow ceilings/add checks but cannot weaken global gate/security policy.
7. Genuine provider/local/token/model-evidence gaps fail closed; metadata/generated/known-binary cases are explicitly classified.
8. External status targets the correct source Project/ref and concrete pipeline when resolvable.
9. Human-resolved discussions are never silently reopened.
10. Token usage, queue/review latency, publication failures, Project-Scope health and provider health are observable without source/prompts/raw model output/secrets.
11. Production Codex CLI is capability-checked and may be version-pinned by canonical config.
12. SQLite is single-node/local-filesystem only. HA replaces the storage boundary; it never shares SQLite over a network filesystem.
13. Standard is one Controller + inline Codex; Hardened adds isolated Runner without branching Review/Gate/Outbox logic.
14. Publication/Runner retry or restart never creates an implicit second review run for an already persisted result.
15. Projects/Groups scope changes only after complete discovery. Failed/incomplete refresh preserves the last complete Set and makes readiness unhealthy.
16. A Project removed from current Scope cannot receive new work or pending GitLab publication.
17. There is exactly one non-secret JSON configuration model. Direct user mode follows XDG config/state defaults; system-level systemd explicitly pins `/etc/codex-review/config.json` and production state under `/var/lib/codex-review`. Runtime does not infer root/sudo/systemd mode.
18. Supported environment is limited to optional `CODEX_REVIEW_CONFIG_FILE`, required GitLab credentials, and optional `OPENAI_API_KEY`; non-secret environment override layers are forbidden.
19. GitLab webhook authentication requires Standard Webhooks Signing Token semantics; no plain-text secret-token fallback exists.
20. Compatibility inputs removed in earlier majors must not be reintroduced without a new explicit major-version architecture decision.
21. GitHub Actions are manually reviewed and pinned by immutable commit SHA. Action upgrades must run the full matrix before merge.
22. `main` uses audited squash-merge history for product changes; merged feature branches are disposable and must be cleaned.
23. Changes to durability, trust boundaries, config schema, Outbox, Project Scope, Runner, or merge-gate semantics require contract tests before merge.
24. Current documentation must describe Family v4 semantics and current deployment boundaries; historical version labels belong only in changelog/history, not current-state architecture or operations text.

## Evolution rule

Prefer clean Provider/Project-Scope/Storage/Runner interfaces and additive data migrations over compatibility layers. Configuration has one canonical schema and no hidden precedence. Keep `main` deployable; keep README/README.zh-CN/OPERATIONS/SECURITY/ARCHITECTURE mutually consistent; do not declare a release mature while a documented invariant is aspirational rather than executable/tested.