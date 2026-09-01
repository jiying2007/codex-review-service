## 7.3.0 - 2026-09-01

- Pin Codex Safe Core 4.12.0 and consume Codex Runtime / Provider Contract v2.
- Hard-cut Config Schema 6 to Config Schema 7 while preserving Database Schema 8 and the full 7.2.1 notification/product line.
- Add `codex.credentialSource` with `auto`, `env`, and `auth-json`; `auto` prefers the configured environment variable and otherwise resolves the API key from the configured Codex home, `CODEX_HOME`, or the OS user Codex home.
- Accept `auth.json` only for `auth_mode=apikey` with a non-empty `OPENAI_API_KEY`; resolved secrets remain child-process-only and are excluded from argv, receipts, settings, and diagnostics.
- Add explicit `codex.allowInsecureHttp` for trusted private-network OpenAI-compatible relays; HTTPS remains the default and repository policy cannot enable insecure transport.

## 7.2.1 - 2026-09-01

- Show the GitLab repository path on Review and Flow notification cards so multi-repository notifications are distinguishable.
- Record direct-message delivery as provider acceptance rather than an unsupported user-read claim.

## 7.2.0 - 2026-09-01

- Add Config Schema 6 responsible-owner notification delivery: strict GitLab-to-Feishu identity mappings, bounded Reviewer → Assignee → Author resolution, safe group-card mentions, and optional per-owner direct messages.
- Keep durable Feishu group status cards unchanged: only terminal group cards mention owners; direct messages are independently deduplicated terminal cards and cannot affect a Review Verdict or group-card delivery.

## 7.1.0 - 2026-09-01

- Add durable Feishu application-bot Review status cards with Schema 8 message mapping, PATCH completion, restart reconciliation and one-shot fallback.
- Add 30-second Push aggregation and bounded MR-related Push/Pipeline/Review change activity.
- Add branch, severity, author and Reviewer route subscriptions, per-route Chinese/English cards and read-only diagnostics/navigation actions.
- Improve Review/Flow card hierarchy, Top Finding impact display, three-Commit expansion, deterministic truncation and notification delivery metrics.
- Add indexed aggregation metadata, SHA/freshness-bound MR correlation, Feishu token single-flight, 20 RPS throttling, Retry-After handling and a 28,000-byte card safety gate.
- Add dry-run-by-default `smoke-feishu-card`, explicit `--send` create/PATCH acceptance and notification Route diagnostics in Doctor.

## 7.0.0

- Hard-cut persistent model-Finding carry-forward and incremental Judgment reuse; every accepted review event now produces a fresh judgment from current evidence.
- Separate webhook-delivery idempotency from ReviewSubject identity so same-SHA analyzer/pipeline evidence can trigger a new review.
- Adopt Safe Core 4.11.0 Judgment Lifecycle v1 and Review Receipt v5 with Evidence Manifest identity.
- Remove the incrementalReviewEnabled configuration surface; historical findings remain post-fresh lifecycle evidence only.

## 6.5.2

- Repin to immutable Safe Core v4.10.2 (`cd9788f1280a217fbe6d0beb59682a85a8b82c4d`) so Review Service remains on the same Family trust root as the VS Code SCM UI Contract release.
- Preserve Database Schema 7, Config Schema 4, Review Receipt v4, Safe Contract v2, GitLab compatibility boundaries, and service runtime behavior.

## 6.5.1

- Repin to immutable Safe Core v4.10.1 and keep all product semantics unchanged.

## 6.5.0

- Add durable AI Judgment Lifecycle v1: fresh ReviewSubject identity, evidence-bound Review Receipt v5, no persisted-model-Judgment reuse, and reconciliation-only historical lineage.
- Hard-cut configuration and storage to the new Judgment Lifecycle with no incremental-review compatibility surface.
- Keep GitLab provider, publication, notification, observability, deployment, and product boundaries intact.

## 6.4.0

- Add Product Contract v1 and exact Core pin governance for family compatibility.
- Keep all provider/database/notification behavior product-owned.

## 6.3.0

- Add Review Service Quality Platform v3 integration, Profile Packs, Test Impact, analyzer adapters, and deterministic quality gates.

## 6.2.0

- Add flow tracking, durable notification outbox, Feishu/WeCom routes, and operational telemetry.

## 6.1.0

- Add hardened GitLab Self-Managed deployment, runner separation, and production operations controls.

## 6.0.0

- Establish the v6 hard-cut service line with current provider/database boundaries and immutable release flow.
