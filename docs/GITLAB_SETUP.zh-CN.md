# GitLab 接入

1. 确认实例为 GitLab Self-Managed **14.6.1 或更高版本**。14.6.1 是兼容下限，不代表建议长期运行已经停止官方维护的旧 GitLab；条件允许时应运行 GitLab 官方仍支持的版本。
2. 创建只包含 Codex Review Service 所需 API 权限的 Group/Project Access Token。生产环境使用受保护文件，并配置 `GITLAB_API_TOKEN_FILE`。
3. 创建 Config Schema 1（`"schemaVersion": 1`），在 `config.json` 配置显式 Project ID 和/或 Group ID。
4. 生成一个 `whsec_...` Webhook Secret，通过 `GITLAB_WEBHOOK_SIGNING_TOKEN` 或生产优先的 `GITLAB_WEBHOOK_SIGNING_TOKEN_FILE` 提供；两者不能同时设置。GitLab **<19.1** 时，把这个值原样填入 Webhook 的 **Secret Token**；GitLab **>=19.1** 时，将其配置为 Standard Webhooks Signing Token。
5. 添加 Webhook `https://<host>/webhooks/gitlab`，开启 **Merge request events** 与 **Note events**。
6. 运行 `npm run doctor`，记录检测出的 GitLab version、diff profile 与 `webhookAuth`，再检查 `GET /health/ready`、`GET /health/dependencies`、`GET /version`。
7. 创建或更新可丢弃测试 MR，确认 GitLab `running` → terminal status、单一 Summary、确定性 Discussion；duplicate webhook 不应产生重复 Review Run。
8. Push 新 source commit，确认上一 immutable snapshot 被 supersede，stale publication 不会覆盖新结果。
9. 如开启 IM，确认飞书/企业微信 Route 通过 `notification_outbox` 收到确定性卡片；通知失败不改变 GitLab Verdict。
10. Group scope 场景确认完整 refresh 能发现预期 Project；失败/不完整 refresh 保留上一次完整 scope，同时 `/health/dependencies` 进入 degraded。

## Provider Profile

Doctor 根据已认证的 `/api/v4/version` 自动选择能力。

### Diff Profile

- **Classic（`14.6.1` 到 `<15.7`）**：使用 `GET /projects/:id/merge_requests/:iid/changes`。响应必须明确包含 `overflow: false`；`overflow: true` 或缺少/未知 overflow 信号都会在调用 Codex 前阻断 Review。
- **Modern（`>=15.7`）**：使用分页 `GET /projects/:id/merge_requests/:iid/diffs`，并要求 `/versions` 元数据与 `real_size` 精确匹配。

### Webhook 认证 Profile

- **Classic Token（`<19.1`）**：对 GitLab 的 `X-Gitlab-Token` 做常量时间比较，并用事件类型 + 原始 body 的 SHA-256 生成确定性 delivery identity。旧 GitLab 没有 Standard Webhooks 的 timestamp/HMAC replay-window 能力，因此生产环境应额外使用可信 HTTPS/私有 ingress，并在网络条件允许时限制来源地址。
- **Standard HMAC（`>=19.1`）**：要求 provider delivery identity、timestamp replay window、原始 body HMAC-SHA256 和预期 GitLab instance。

不提供人工 profile override。能力由 GitLab 版本确定性选择，避免运维人员通过配置误削弱 diff 完整性或 webhook 安全保证。

## 永久兼容证据

仓库 system matrix 会在真实 GitLab CE **14.6.1、17.11.7、19.3.0** 上运行完整 Provider Contract：创建真实 Group/Project/MR，通过对应 profile 获取完整 diff，发布 notes/discussions/status，resolve discussion，验证 repository/scope 行为，并校验该 GitLab 版本应选择的 webhook auth capability。

生产环境仍应在实际 Self-Managed 实例重复验收，因为权限、Hook、diff limits 与网络策略属于具体部署环境。Classic 环境建议额外准备一个故意触发 overflow 的 MR，确认其结果是 blocked，而不是对不完整 diff 做部分 Review。

GitLab 本体升级与 Review Service 部署是独立生命周期。不要仅为了 Codex Review Service 从旧版本直接跨多个 major 升级 GitLab；GitLab 升级应遵循官方 required upgrade stops 与 background migration 要求。
