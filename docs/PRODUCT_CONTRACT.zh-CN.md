# 产品契约

`product-contract.json` 是 Codex Review Service 兼容性与 Release Identity 的机器可读唯一事实源。Runtime 常量、配置示例、Release 元数据、Docker Label、Doctor 输出与 Governance Test 都必须和它一致。

Service v5.0.0 把 Database Schema 5 与 Config Schema 1 冻结为第一套正式生产契约。后续 Schema 变化必须提供显式 Migration Fixture、Forward Upgrade Test 与清晰的 Rollback Boundary；首发前 Hard-cut 重新初始化不能继续作为正常升级策略。

Safe Core 继续 exact commit pin，负责共享 Review Protocol；Service 自己的 Deployment、Notification、Admin/DR、OCI 能力不能污染共享协议边界。
