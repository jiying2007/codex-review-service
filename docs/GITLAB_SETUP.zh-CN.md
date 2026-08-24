# GitLab 接入

1. 创建只包含 Codex Review Service 所需 API 权限的 Group/Project Access Token。
2. 在 `config.json` 配置 Project ID 和/或 Group ID。
3. 配置 GitLab 19.1+ Standard Webhooks Signing Token，并使用同一个 `GITLAB_WEBHOOK_SIGNING_TOKEN`。
4. 添加 Webhook `https://<host>/webhooks/gitlab`，开启 **Merge request events** 与 **Note events**。
5. 运行 `npm run doctor`，再确认 `GET /health/ready`。
6. 创建或更新测试 MR，验证 GitLab Status、Summary、Discussion。
7. 如已启用 IM 通知，确认目标飞书/企业微信 Route 收到确定性卡片。
