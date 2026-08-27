# 质量平台

Service 5.2 使用 Safe Core 4.4 的 Review Profile、Impact Evidence 与 SARIF 归一化能力。Profile 是运维侧执行偏好，不属于仓库 Policy。Impact 候选只通过 GitLab Repository API 从 MR 精确 head SHA 获取；SARIF 也必须已经存在于同一 SHA 的仓库中。Service 绝不执行仓库定义的 analyzer 命令。

人工 finding resolution 采用 append-only 历史：`fixed`、`false_positive`、`accepted_risk`、`duplicate`、`obsolete`、`not_applicable`、`policy_exception`。这些反馈只进入可观测指标，绝不会自动训练模型或动态修改 Prompt。
