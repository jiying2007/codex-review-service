# Token 效率与成本感知审核

Codex Review Service 将模型 Token 作为受预算约束的生产资源。在启动 Codex 进程之前，Controller 会尽量消除重复工作；当下一审核单元无法满足预算时按 fail-closed 处理。

## Review Planner

Planner 按以下顺序执行：

1. **Snapshot 去重与 supersede**：同一 MR 状态不重复审核，新快照淘汰旧任务。
2. **增量 Push 审核**：当 target start SHA 与 policy fingerprint 未变化时，复用最近一次完整审核；只把相对上次已审核 head 新变化的路径再次送入 Codex，未变化路径上的 finding 直接继承。
3. **风险评分**：安全、并发、资源生命周期、数据库/Schema、Native 代码获得更多上下文；低风险 chunk 使用更小上下文。自适应缩放只会减少上下文，不会突破有效 Policy 对字节数、文件数和行半径设置的上限。
4. **可选低成本模型路由**：配置 `codex.fastModel` 后，仅低风险 chunk 使用该模型；留空则保持单模型。
5. **MR 总 Diff 预算**：`review.maxTotalDiffBytes` 限制整个 MR 实际送模的 diff 总字节数；若因此遗漏证据，覆盖状态直接变为 incomplete。
6. **Token 事前预检**：调用前估算 prompt 与有界输出，先检查 `review.mrMaxTokenBudget`，避免“调用结束才发现超预算”。
7. **项目级 Token Reservation**：并发 Worker 调用前先预留估算 Token，避免多个任务同时看到同一份剩余日预算并共同穿透上限。
8. **确定性 Summary**：模型只输出 findings，不再为每个 chunk 生成 summary；最终摘要由 Controller 确定性渲染。
9. **Cache-friendly Prompt**：稳定的安全规则、Policy、MR 元数据放在 chunk 变量之前，尽可能扩大可复用前缀。

## 默认值

Config Schema 2 未显式配置时：

- `review.maxTotalDiffBytes`：默认等于 `review.maxDiffBytes`（默认 1 MiB）
- `review.incrementalReviewEnabled`：`true`
- `review.adaptiveContextEnabled`：`true`
- `review.mrMaxTokenBudget`：`250000`
- `review.projectDailyTokenBudget`：`5000000`
- `codex.fastModel`：空，默认不启用模型分级

Token Budget 显式配置为 `0` 时表示关闭对应预算。

## Fail-closed

预算不会以“少审一点但仍宣称完整”的方式降级。MR 总 Diff 预算或 MR Token 预检导致 chunk 无法执行时，会写入 coverage gap，最终门禁为 `incomplete`。项目日预算耗尽时返回非重试 `ETOKENBUDGET`，直到新的 UTC 日窗口重新具备容量。

## 指标

Prometheus 输出累计 input、cached-input、cache-write-input、output、reasoning-output Token，同时记录 chunk 估算 Token、风险分数、增量审核次数、继承 finding 数、Diff 预算遗漏 chunk 数和 Token preflight 阻断次数。

结合 `review_runs` 已持久化的 Token 列，可以直接对真实 MR 流量进行 Full Review / Incremental Review 成本对比。

## 在线 Token 校准

Core v4.9 从保守的 2 UTF-8 bytes/token 开始，只有积累足够真实样本后才启用有界 provider+model EWMA。校准状态只保存临时数值，不保存 prompt 或源码，也不能绕过既有 Token Budget。
## Flow Tracking

Flow Tracking 只进行确定性的 Webhook、状态投影和通知处理，绝不调用 Codex，因此模型 Token 成本严格为 0。
