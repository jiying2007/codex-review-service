# Codex Review Service

[English](README.md) | [简体中文](README.zh-CN.md)

面向 GitLab Self-Managed Merge Request 的生产化、自托管 Codex 代码审核服务。定位是内网单节点常驻服务：GitLab 只负责发送经过认证的 Webhook，SQLite 持久队列负责调度，Codex 只分析有边界的 MR diff snapshot，Controller 负责确定性校验、门禁与 GitLab 回写，GitLab 凭据不会暴露给 Codex。

## 成熟闭环能力

- MR `open` / `reopen` / **真实代码 `update`** 自动审核；标题、Reviewer、审批等普通更新不会浪费 Codex 配额。
- `/codex review` 同一 snapshot 强制重审，默认只允许 GitLab Developer(30)+ 有效成员触发。
- Webhook 快速确认：请求路径只做验签、重放/幂等记录和本地入队，不同步访问 GitLab API，也不执行 Codex。
- GitLab 19+ Standard Webhooks HMAC、时间窗口、`X-Gitlab-Instance` 实例绑定、Legacy Secret 回退和 Project Allowlist。
- SQLite WAL 持久队列、增量 schema migration、队列上限、服务重启恢复、指数退避、数据保留与 WAL checkpoint。
- 多 Worker：不同 MR 可并行，同一个 MR 严格串行。
- 完整 snapshot 使用目标分支 `start_sha` + 源分支 `head_sha`；显式项目白名单时定期 reconciliation，补偿 Webhook 丢失或目标分支变化。
- 使用 `GET /merge_requests/:iid/diffs` 并检查分页完整性；`too_large`、`collapsed`、binary/空 diff、单文件超限、chunk 数超限全部 fail-closed。
- 大 MR 按文件边界拆成有上限的 Codex chunks；不会静默丢弃大文件。
- finding 同时支持新增行 `side=new` 与删除行 `side=old`。
- Structured Output 本地严格校验；模型返回无法在本次 diff 验证的问题时，结果直接变为 `incomplete`，避免假 Pass。
- 确定性门禁：服务级 `BLOCKING_SEVERITY` 不能被仓库内容降低。
- 仓库 `.codex-review.json` 固定从 **目标分支 snapshot (`diff_refs.start_sha`)** 读取，MR 自己无法修改审核策略来绕过门禁。
- Summary Note 单条 upsert、稳定 fingerprint、Inline Discussion、未解决线程复用、已消失问题安全 resolve；人工已解决但问题再次出现时会创建新的当前 snapshot 线程。
- External Commit Status 带 source `ref`；阻断、覆盖不完整、终态服务失败都写 `failed`。
- Codex Safe Contract：ephemeral、忽略 user/repo rules、read-only sandbox、关闭 web/shell/apps/agents/hooks/memories、环境变量白名单、输出上限、CLI capability preflight、进程树取消。
- `/health/live`、缓存型 `/health/ready`、Prometheus `/metrics`、`npm run doctor`。
- Hardened systemd、中英文文档、运维手册、安全策略、Node 22.13/24 CI、Dependabot。

## 架构

```text
GitLab Self-Managed
      │  MR / Note Webhook
      ▼
Webhook Receiver ── 验签 / 实例 / Allowlist / Delivery-ID
      │              （Webhook 请求内不访问 GitLab API）
      ▼
SQLite WAL Queue
      │
      ├─ Worker 1 ─┐
      ├─ Worker 2 ─┼─ 同 MR 串行
      └─ ...       ┘
             │
             ▼
       Snapshot Hydration
       ├─ MR metadata + diff_refs
       ├─ target policy @ start_sha
       └─ paginated MR diffs
             │
             ▼
       Bounded Codex Chunks
             │
             ▼
      Local Validation / Gate
             │
             ▼
        GitLab Publisher
       ├─ Summary Note
       ├─ Inline Discussions
       └─ External Commit Status
```

当前架构明确是**生产化单节点**。不要让多个实例并发打开同一 SQLite 数据库，更不要把 SQLite 放到网络文件系统。如果未来要求 active/active HA，应替换 Queue/Storage 边界为外部事务存储，而不是给当前实现叠加兼容层。

## 环境要求

- Node.js **22.13+**
- 服务账号可执行 OpenAI Codex CLI
- 服务主机可以访问局域网 GitLab
- Project/Group Access Token，具备读取 MR/diff/member/target policy，以及写 Note/Discussion/Commit Status 所需 API 权限
- GitLab Project Webhook；GitLab 套餐支持时也可以使用 Group Webhook
- GitLab 19+ 推荐 Standard Webhooks Signing Token；老版本/迁移期保留 Legacy Secret

## 安装

```bash
sudo useradd --system --create-home --home-dir /home/codex-review --shell /usr/sbin/nologin codex-review
sudo mkdir -p /opt/codex-review-service /home/codex-review/.codex
sudo chown -R codex-review:codex-review /home/codex-review/.codex

git clone https://github.com/jiying2007/codex-review-service.git /opt/codex-review-service
cd /opt/codex-review-service
npm ci --ignore-scripts --no-audit --no-fund
```

使用 ChatGPT/Codex managed auth：`sudo -u codex-review -H codex login`。也可以在受保护环境文件里使用 `OPENAI_API_KEY`。

复制 `.env.example` 到 `/etc/codex-review-service.env`，安装 systemd unit，然后正式接 Webhook 前用 `npm run doctor` 验证 Config、SQLite、Codex CLI 与 GitLab API。

## GitLab 配置

Webhook 地址为 `https://review.example.internal/webhooks/gitlab`，开启 Merge request events 与 Note events。

建议 `GITLAB_PROJECT_ALLOWLIST` 填明确的数字 Project ID。使用 `*` 虽然可以接收 Token 有权限的项目，但服务无法知道“应当巡检的全部项目”，所以会关闭周期 reconciliation，只依赖 Webhook。

GitLab 19+ 配置 Signing Token，并将 `whsec_...` 写入 `GITLAB_WEBHOOK_SIGNING_TOKEN`。默认同时验证 `X-Gitlab-Instance`。

## 仓库审核策略

服务端配置是不可突破的安全上限。仓库可以在目标分支提交 `.codex-review.json`：

```json
{
  "language": "zh-CN",
  "maxDiffBytes": 524288,
  "maxFindings": 30,
  "severityThreshold": "low",
  "timeoutSeconds": 120,
  "extraInstructions": "重点检查并发、资源生命周期和错误处理。"
}
```

服务固定从 MR `diff_refs.start_sha` 读取该文件，而不是从 source HEAD 读取。仓库只能收紧资源参数或调整审核重点；不能选择 Codex executable/model、修改凭据/worker/confidence、降低 blocking policy，也不能把本来应阻断的 severity 隐藏掉。

## Merge Gate

默认 External Commit Status 名称为 `codex-review`。审核中 → `running`；`pass` / `needs_attention` → `success`；`block` / `incomplete` / 终态服务失败 → `failed`。默认 `critical` / `high` 阻断。GitLab 开启 “Pipelines must succeed” 后即可纳入 Merge Gate。任何 coverage gap 都不会被当成 Pass。

## 手工重审

在 MR 新建评论 `/codex review`，即使 HEAD 不变也会新建一次审核。默认要求 `MANUAL_REVIEW_MIN_ACCESS_LEVEL=30`（Developer）。Bot 自己的评论以及编辑旧评论不会触发。

## Health / Metrics / Doctor

提供 `GET /health/live`、`GET /health/ready`、`GET /metrics`。`/health/ready` 检查 DB、Worker 和 GitLab 可达性并短时缓存；metrics 只使用低基数标签，不暴露项目、仓库、分支或源码信息。`npm run doctor` 不审核代码，只检查环境和依赖。

## 运维与安全

部署、升级、回滚、备份恢复、监控和故障处理见 [OPERATIONS.md](OPERATIONS.md)。信任边界与威胁模型见 [SECURITY.md](SECURITY.md)。版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 开发验证

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run ci
```

CI 同时验证最低支持的 Node.js 22.13 和 Node.js 24。
