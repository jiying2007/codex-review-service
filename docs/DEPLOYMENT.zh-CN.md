# 生产部署指南

## 支持基线

部署前先读取 `product-contract.json`。**Codex Review Service 7.4.3** 支持 Native/systemd Node.js **22 LTS >=22.22.2** 或 **24 LTS >=24.19.0**，GitLab Self-Managed **>=14.6.1**，Database Schema 8、**Config Schema 7**。官方 Docker 镜像使用 canonical Node 24.19.0。

Safe Core 精确固定到 `e962826ee6556fd8ffa74ab1994bf43d62826f10`。禁止替换 gitlink 或把另一份 Core Runtime 复制进 Release。

GitLab 14.6.1 只是兼容下限，不是生命周期推荐版本。真实 Provider CI 覆盖 GitLab CE 14.6.1、17.11.7、19.3.0。

## Config Schema 7 Provider Contract 硬切边界

Service 7.3.0 将 Config Schema 6 -> 7 硬切到 Core Provider Contract v2。Runtime 不翻译 Config Schema 6；升级前必须设置 `schemaVersion: 7`。`codex.credentialSource` 支持 `auto|env|auth-json`，`codex.allowInsecureHttp` 默认 `false`；非 loopback HTTP 只有显式授权可信中转站时才允许。Service 7.2.0 的 Config Schema 5 -> 6 责任人通知边界，以及已退役的 `review.incrementalReviewEnabled`，继续作为历史升级边界保留。

新的质量入口：

```json
{
  "schemaVersion": 7,
  "gitlab": {
    "baseUrl": "https://gitlab.example.internal",
    "projects": [101, 102],
    "groups": [{"id": 20, "includeSubgroups": true}]
  },
  "review": {
    "profile": "general",
    "analyzerReports": [
      {"format":"sarif","job":"security-*","path":"reports/security.sarif","required":false,"maxBytes":4194304},
      {"format":"junit","job":"test-*","path":"junit.xml","required":false,"maxBytes":4194304}
    ],
    "testImpactEnabled": true,
    "testPathPrefixes": ["test/", "tests/"],
    "maxTestCandidates": 200,
    "maxRecommendedTests": 40,
    "triggerAssignment": {"mode":"reviewer","userIds":[]}
  },
  "codex": {
    "providerMode": "auto"
  }
}
```

`analyzerReports` 只引用 CI 已生成的 Artifact；Service 不执行仓库定义的 Analyzer Command。Test Impact 只从精确 MR head SHA 推荐测试，不执行测试，也不会把“推荐”当成测试通过证据。

## GitLab capability profiles

Service 从认证后的 `/api/v4/version` 选择能力：

- **Classic diff**（`14.6.1` 到 `<15.7`）：`/merge_requests/:iid/changes`，必须明确 `overflow: false`。
- **Modern diff**（`>=15.7`）：分页 `/diffs` + `/versions.real_size` 完整性证明。
- **Classic webhook auth**（`<19.1`）：`X-Gitlab-Token` + raw-body 确定性身份；建议可信 HTTPS/内网入口与源网络限制。
- **Standard HMAC webhook auth**（`>=19.1`）：签名身份、timestamp replay window、raw-body HMAC-SHA256。

不能证明保证时直接 fail closed，不提供人工兼容 override。

## 选择部署模式

### Standard systemd / inline Runner

推荐默认模式：Controller、SQLite、GitLab Provider 和 Codex 执行使用同一 Unix Service User。

### Hardened systemd / isolated Runner

当 GitLab 凭据与 OpenAI/Codex 凭据必须分离时使用。Controller 拥有 GitLab/state，Runner 只拥有 Codex/OpenAI 凭据并通过 Unix Socket 暴露 Safe Contract。

### Docker / Compose

使用 Release 发布的 `compose.release.yaml` 和 canonical GHCR digest；生产主机不要重新 build 源码。

## 安装经过验证的 Release

先按 `VERIFY_RELEASE.md` 验证 checksum/provenance。systemd：

```bash
sudo useradd --system --create-home --home-dir /home/codex-review --shell /usr/sbin/nologin codex-review
sudo install -d -o root -g codex-review -m 0750 /etc/codex-review/secrets
sudo install -d -o codex-review -g codex-review -m 0700 /var/lib/codex-review
sudo install -m 0644 deploy/systemd/config.example.json /etc/codex-review/config.json
sudo install -m 0644 deploy/systemd/codex-review-service.service /etc/systemd/system/
```

Secret 使用受保护 `_FILE`：

```text
GITLAB_API_TOKEN_FILE=/etc/codex-review/secrets/gitlab-api-token
GITLAB_WEBHOOK_SIGNING_TOKEN_FILE=/etc/codex-review/secrets/gitlab-webhook-signing-token
OPENAI_API_KEY_FILE=/etc/codex-review/secrets/openai-api-key
```

直接值和 `_FILE` 互斥，Secret 不进入 Config Schema 7 JSON。使用 `credentialSource: "auth-json"` 时，Provider Key 也可以只保留在配置的 Codex Home `auth.json` 中，Key 值仍不得进入 Service JSON。

## Doctor Preflight

```bash
cd /opt/codex-review-service
sudo -u codex-review /usr/bin/node --env-file=/etc/codex-review-service.env src/doctor.js
```

Doctor 校验产品/配置身份、SQLite Schema 8/integrity、Codex Runtime、GitLab 版本/profile 与完整 Project/Group Scope。

## 启动与健康检查

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now codex-review-service
curl -fsS http://127.0.0.1:8787/health/live
curl -fsS http://127.0.0.1:8787/health/ready
curl -fsS http://127.0.0.1:8787/health/dependencies
curl -fsS http://127.0.0.1:8787/version
```

isolated 模式先启动 `codex-review-runner`，再启动 Controller。

## 配置 GitLab Webhook

通过可信 HTTPS 暴露：

```text
https://<review-host>/webhooks/gitlab
```

Review 必须启用 **Merge request events** 和 **Note events**。当 `flowTracking.enabled=true` 时，只额外开启配置实际需要的事件族：**Pipeline events**、**Tag Push events**，以及用于 Branch 创建/删除跟踪的 **Push events**。按 Doctor 检测到的能力配置 Secret Token / Standard Webhooks Signing Token；Doctor 与 `/health/ready` 未通过前不要启用流量。

## 端到端验收

使用一次性 MR：

1. 运行 Doctor，记录 GitLab version/profile。
2. 打开或更新 MR。
3. 确认只入队一个 durable Review Job。
4. 确认 GitLab terminal status、summary、discussions。
5. 配置 Analyzer Adapter 时，确认只读取 exact-head pipeline Artifact。
6. 确认 Test Impact 只输出推荐，不宣称已执行测试。
7. Push 新 Commit，验证 stale publication 被阻断。
8. 重放 webhook，验证幂等。
9. 检查 `/version`、`/health/dependencies`。
10. 如果启用通知，验证飞书/企业微信只做 Attention Routing，不改变 Review Verdict。
11. 如果启用 Flow Tracking，确认订阅的 Pipeline/MR/Tag/Branch 状态转换写入 `flow_state` 与 `notification_outbox`，且不会启动 Codex。

## Docker / Compose

使用：

```text
IMAGE_DIGEST.txt
compose.release.yaml
```

创建 `./secrets` 后：

```bash
docker compose -f compose.release.yaml up -d
curl -fsS http://127.0.0.1:8787/health/ready
```

Compose 通过 `/run/secrets/*` 映射必须凭据。

## 升级前备份

```bash
npm run admin -- backup /secure-backup/pre-upgrade.sqlite
npm run admin -- backup-verify /secure-backup/pre-upgrade.sqlite
npm run admin -- drain 120
```

## Upgrade / Rollback

从 v5.0.0 起，已发布 DB/Config Compatibility 是正式产品契约。Service 7.3.0 引入当前 **Config Schema 6 -> 7** 硬切，用于 Provider Contract v2 凭据/传输控制；Service 7.2.0 的 **Config Schema 5 -> 6** 责任人身份映射，以及 Service 7.0.0 的 **Config Schema 4 -> 5** 与 `review.incrementalReviewEnabled` 退役继续作为历史边界。Runtime 不翻译这些配置版本。

历史 Database Schema 5 -> 6 Startup Migration 继续保持显式和受测试。Schema 7 -> 8 会在增加状态卡持久化前创建并验证 Schema 7 备份。回滚必须恢复与目标版本匹配的备份；禁止直接对 Schema 8 做原地降级。

升级顺序：

1. 阅读 Release Notes 和 rollback boundary。
2. 创建并验证 backup。
3. drain durable work。
4. 重写 Config Schema 7，并显式复核 `codex.credentialSource` / `codex.allowInsecureHttp`。
5. 验证新 tgz/OCI digest/provenance。
6. 安装精确 Release Artifact。
7. 流量前运行 Doctor。
8. 要求 `/health/ready`、`/version` 和 queue/outbox 状态符合预期。

Rollback 只能使用与目标 Release 匹配的 Artifact、Configuration Schema 和该版本要求的 verified database backup。
