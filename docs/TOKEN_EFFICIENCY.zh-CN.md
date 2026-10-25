# Token 效率与 Fresh Evidence 审核

Codex Review Service 将模型 Token 视为受预算约束的生产资源。7.0 起禁止把历史模型 Judgment 持久化继承到后续审核。

## Review Planner

1. **Webhook delivery 幂等与 supersede**：只对同一次投递去重，并取消已过期的在途快照；同一 Git SHA 后续出现新的审核事件时仍可 fresh 审核。
2. **Fresh 当前证据审核**：每轮都从当前完整有界 diff、当前 Policy、当前 Context 和当前 Analyzer Evidence 重建结论。历史模型 Finding 只用于审核完成后的 lifecycle/lineage 对账，绝不进入新 prompt 或 verdict。
3. **风险评分**：安全、并发、资源生命周期、数据库/Schema、Native 代码获得更多上下文；自适应预算只能缩小，不能突破上限。
4. **模型策略与角色路由**：Model Routing Contract v1 使用 `codex.selectionStrategy` 的 `auto|preference|fixed` 策略。可选 Scout 的假设必须经过 Reviewer 验证；同 Provider 的角色路由不会复用历史模型 Judgment。
5. **MR 总 Diff 预算**：预算导致遗漏时 coverage 必须 incomplete。
6. **Token 事前预检**：模型执行前检查下一有界请求。
7. **项目 Token Reservation**：避免并发 Worker 共同穿透日预算。
8. **确定性 Summary**：最终摘要不作为模型 Judgment 保存。
9. **Cache-friendly Prompt**：只改善 Provider 前缀复用，不保存模型 Judgment。

## 默认值

Config Schema 8 的 `config.example.json` 默认 `review.maxTotalDiffBytes=1048576`、`review.maxDiffBytes=1048576`、`review.adaptiveContextEnabled=true`、`review.mrMaxTokenBudget=250000`、`review.projectDailyTokenBudget=5000000`。`codex.selectionStrategy` 默认为 `auto`，`codex.scoutEnabled=false`、`codex.adjudicatorEnabled=false`；`fixedModel` 与 `shadowCandidate` 为空，`candidates` 为空数组。旧 `codex.model`、`codex.fastModel` 与 `review.incrementalReviewEnabled` 均不支持。

## Fail-closed

预算造成的证据遗漏必须形成显式 coverage gap；项目日预算耗尽返回非重试 ETOKENBUDGET。

## 指标

Prometheus 记录实际/缓存读取/缓存写入/输出/推理 Token、风险分数、请求估算、Diff 预算遗漏与 preflight 阻断。成本比较以 fresh review 为基准，不再存在“复用历史 Judgment 节省 Token”的产品语义。

## 在线 Token 校准

精确固定的 Safe Core 仅维护有界、临时的 provider+model 数值校准，不保存 prompt、源码、Finding 或 Judgment。

## Flow Tracking

Flow Tracking 只处理确定性的 Webhook、状态与通知，模型调用为 0。
