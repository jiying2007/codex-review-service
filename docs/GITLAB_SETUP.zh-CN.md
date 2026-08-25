# GitLab 接入

1. 创建只包含 Codex Review Service 所需 API 权限的 Group/Project Access Token。生产环境使用受保护文件，并配置 `GITLAB_API_TOKEN_FILE`。
2. 创建 Config Schema 1（`"schemaVersion": 1`），在 `config.json` 配置显式 Project ID 和/或 Group ID。
3. 配置 GitLab Self-Managed 19.1+ Standard Webhooks Signing Token，通过 `GITLAB_WEBHOOK_SIGNING_TOKEN` 或生产优先的 `GITLAB_WEBHOOK_SIGNING_TOKEN_FILE` 提供；两者不能同时设置。
4. 添加 Webhook `https://<host>/webhooks/gitlab`，开启 **Merge request events** 与 **Note events**。
5. 运行 `npm run doctor`，再检查 `GET /health/ready`、`GET /health/dependencies`、`GET /version`。
6. 创建或更新可丢弃测试 MR，确认 GitLab `running` → terminal status、单一 Summary、确定性 Discussion；duplicate webhook 不应产生重复 Review Run。
7. Push 新 source commit，确认上一 immutable snapshot 被 supersede，stale publication 不会覆盖新结果。
8. 如开启 IM，确认飞书/企业微信 Route 通过 `notification_outbox` 收到确定性卡片；通知失败不改变 GitLab Verdict。
9. Group scope 场景确认完整 refresh 能发现预期 Project；失败/不完整 refresh 保留上一次完整 scope，同时 `/health/dependencies` 进入 degraded。

仓库永久 system matrix 会在真实 GitLab CE 最低支持的 19.1 版本线及当前认证版本线上运行 Provider Contract。生产部署仍应在实际 Self-Managed 实例重复验收，因为权限、Hook 和网络策略属于部署环境。
