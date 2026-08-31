# Token efficiency and cost-aware review

Codex Review Service treats model tokens as a bounded production resource. The controller reduces repeated work before a Codex process is started and fails closed when a configured budget cannot cover the next review unit.

## Review planner

The planner applies these controls in order:

1. **Snapshot deduplication and supersession** avoid duplicate reviews of the same MR state.
2. **Incremental push review** reuses the latest complete review when the target start SHA and policy fingerprint are unchanged. Only paths changed since the previous reviewed head are sent back to Codex; findings on untouched paths are carried forward.
3. **Risk scoring** assigns more context to security, concurrency, resource-lifetime, database/schema and native-code changes. Low-risk chunks receive a smaller context window. Adaptive sizing may shrink a configured context allowance but never exceed the effective policy caps for bytes, files, or line radius.
4. **Optional fast-model routing** uses `codex.fastModel` only for low-risk chunks. Empty `fastModel` keeps one-model behavior.
5. **MR total diff budget** (`review.maxTotalDiffBytes`) limits total model-reviewed diff bytes across all chunks. If the limit omits evidence, coverage is marked incomplete.
6. **Token preflight** estimates the next prompt plus bounded output before execution. Input is conservatively estimated at roughly two UTF-8 bytes per token before the model call. `review.mrMaxTokenBudget` is checked before execution, avoiding post-call budget discovery.
7. **Project reservation ledger** reserves estimated tokens across concurrent workers before execution so simultaneous jobs cannot independently consume the same remaining daily budget.
8. **Deterministic summaries** remove per-chunk model summaries. Codex returns findings only; the controller renders the final summary.
9. **Cache-friendly prompt layout** keeps stable safety rules, policy and MR metadata before chunk-specific content to maximize reusable prompt prefixes.

## Defaults

When omitted from Config Schema 2, the production defaults are:

- `review.maxTotalDiffBytes`: same as `review.maxDiffBytes` (1 MiB by default)
- `review.incrementalReviewEnabled`: `true`
- `review.adaptiveContextEnabled`: `true`
- `review.mrMaxTokenBudget`: `250000`
- `review.projectDailyTokenBudget`: `5000000`
- `codex.fastModel`: empty (disabled)

A configured value of `0` for either token budget explicitly disables that budget.

## Fail-closed behavior

Budget controls never silently claim full coverage. If the MR total diff budget or MR token preflight prevents a chunk from running, the review receives a coverage gap and the final gate is `incomplete`. Project daily budget exhaustion is a non-retryable `ETOKENBUDGET` failure until the UTC daily window has capacity again.

## Metrics

Prometheus output includes cumulative input, cached-input, cache-write-input, output and reasoning-output token counters, plus estimated chunk-token and chunk-risk histograms. Incremental runs, carried findings, diff-budget omissions and preflight blocks are also counted.

Use these metrics together with the persisted `review_runs` token columns to compare full-review and incremental-review behavior on real MR traffic.

## Online token calibration

Core v4.9 starts from the conservative 2 UTF-8 bytes/token estimate and activates a bounded provider+model EWMA only after enough real samples. The calibration state is ephemeral numeric data only; it never stores prompts or source text and never bypasses configured token budgets.
## Flow Tracking

Flow Tracking is deterministic webhook/state/notification processing and never invokes Codex. Its model-token cost is exactly zero.
