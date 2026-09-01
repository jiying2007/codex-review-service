# Token efficiency and fresh-evidence review

Codex Review Service treats model tokens as a bounded production resource. Version 7 never persists or carries model judgments into a later review.

## Review planner

1. **Webhook delivery idempotency and supersession** deduplicate only the same delivered event and cancel stale in-flight snapshots. A later review event at the same Git SHA is still eligible for a fresh review.
2. **Fresh current-evidence review** rebuilds the current MR review from the complete bounded diff, current policy, current context and current analyzer evidence. Historical model findings are lifecycle/lineage evidence only and never enter the new prompt or verdict.
3. **Risk scoring** assigns more context to security, concurrency, resource-lifetime, database/schema and native-code changes. Adaptive sizing can shrink but never exceed configured caps.
4. **Optional fast-model routing** uses codex.fastModel only for low-risk chunks.
5. **MR total diff budget** limits model-reviewed diff bytes; omissions make coverage incomplete.
6. **Token preflight** checks the next bounded request before execution.
7. **Project reservation ledger** prevents concurrent workers from oversubscribing the daily token budget.
8. **Deterministic summaries** keep final summaries outside model judgment.
9. **Cache-friendly prompt layout** improves provider prefix reuse without persisting model judgment.

## Defaults

Config Schema 5 defaults include review.maxTotalDiffBytes equal to review.maxDiffBytes, review.adaptiveContextEnabled=true, review.mrMaxTokenBudget=250000, review.projectDailyTokenBudget=5000000, and an empty codex.fastModel. The retired review.incrementalReviewEnabled field is unsupported.

## Fail-closed behavior

Budget-induced omissions become explicit coverage gaps. Project daily budget exhaustion is a non-retryable ETOKENBUDGET until the UTC window has capacity.

## Metrics

Prometheus reports actual/cached/cache-write/output/reasoning token usage, risk scores, request estimates, diff-budget omissions and preflight blocks. Compare fresh-review cost over time; do not infer token savings from historical Judgment reuse because that path does not exist.

## Online token calibration

Core 4.11.0 keeps bounded ephemeral provider+model bytes/token calibration. It stores numeric calibration only, never prompts, source text, findings or judgments.

## Flow Tracking

Flow Tracking is deterministic webhook/state/notification processing and invokes no model.
