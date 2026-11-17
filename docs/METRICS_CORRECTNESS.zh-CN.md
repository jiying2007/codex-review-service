# 多 GitLab 指标正确性与采集优化（7.8 候选）

此变更不启动 Worker、不调用 GitLab API 或审查模型。持久化 `model_calls` 的历史记录受保留策略清理，因此它们不是单调计数器。保留窗口内用量改为 `codex_review_retained_{input,cached_input,output,reasoning_output}_tokens` Gauge。原始 `codex_review_{input,cached_input,output}_tokens_total` Counter 仅由同进程内真实调用成功时递增，进程重启会重置，不再由可裁剪历史记录冒充；原 Dashboard 如需历史窗口数据应明确迁移到 retained Gauge。

采集接口对同步 SQLite 统计使用 3 秒快照缓存，避免大量并行采集反复阻塞 Event Loop；项目 Token 日统计重用已选项目 ID，消除第二次全历史项目分组。缓存不保证首次查询便宜，上线前需在 1 万 / 10 万 / 100 万记录上测 SQL Query Plan、Webhook P95/P99 和 HTTP 超时，若仍阻塞应拆独立只读采集进程。既有 Config/DB Schema 不变。

**监控迁移**：对 retained Gauge 不得使用 `rate()`、`increase()`。账单审计必须依据持久模型调用账本并保留 unknown 用量标志，不得把 unknown 当零。新增存活/缺失与仓库状态检测见后续控制面。