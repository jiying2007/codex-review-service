# Token efficiency and fresh-evidence review

Codex Review Service treats model tokens as a bounded production resource. Version 7 never persists or carries model judgments into a later review.

## Review planner

1. **Webhook delivery idempotency and supersession** deduplicate only the same delivered event and cancel stale in-flight snapshots. A later review event at the same Git SHA is still eligible for a fresh review.
2. **Fresh current-evidence review** rebuilds the current MR review from the complete bounded diff, current policy, current context and current analyzer evidence. Historical model findings are lifecycle/lineage evidence only and never enter the new prompt or verdict.
3. **Risk scoring** assigns more context to security, concurrency, resource-lifetime, database/schema and native-code changes. Adaptive sizing can shrink but never exceed configured caps.
4. **Model policy and role routing** uses Model Routing Contract v1 with `codex.selectionStrategy` set to `auto|preference|fixed`. Optional Scout hypotheses require Reviewer verification; same-provider role routing never reuses historical model judgments.
5. **MR total diff budget** limits model-reviewed diff bytes; omissions make coverage incomplete.
6. **Token preflight** checks the next bounded request before execution against the same review job's durable call ledger, including prior chunks, roles and retry attempts. Known usage contributes observed input plus output; unknown or started calls retain their stored estimate. The next estimate is added once before its intent is persisted. A new accepted review job has its own MR budget.
7. **Project reservation ledger** prevents concurrent workers from oversubscribing the daily token budget.
8. **Deterministic summaries** keep final summaries outside model judgment.
9. **Cache-friendly prompt layout** improves provider prefix reuse without persisting model judgment.

## Defaults

Config Schema 8 ships `config.example.json` defaults of `review.maxTotalDiffBytes=1048576`, `review.maxDiffBytes=1048576`, `review.adaptiveContextEnabled=true`, `review.mrMaxTokenBudget=250000`, and `review.projectDailyTokenBudget=5000000`. `codex.selectionStrategy` defaults to `auto`, with `codex.scoutEnabled=false` and `codex.adjudicatorEnabled=false`; `fixedModel` and `shadowCandidate` are empty and `candidates` is an empty array. Legacy `codex.model`, `codex.fastModel` and `review.incrementalReviewEnabled` are unsupported.

## Fail-closed behavior

Budget-induced omissions become explicit coverage gaps. Project daily budget exhaustion is a non-retryable ETOKENBUDGET until the UTC window has capacity.

## Metrics

Prometheus reports actual/cached/cache-write/output/reasoning token usage, risk scores, request estimates, diff-budget omissions and preflight blocks. The durable ledger reports unknown usage and its budget estimates separately from measured counters. Only complete valid raw usage can establish observed zero. Compare fresh-review cost over time; do not infer token savings from historical Judgment reuse because that path does not exist.

## Online token calibration

The exact-pinned Safe Core keeps bounded ephemeral provider+model bytes/token calibration. It stores numeric calibration only, never prompts, source text, findings or judgments.

## Flow Tracking

Flow Tracking is deterministic webhook/state/notification processing and invokes no model.
