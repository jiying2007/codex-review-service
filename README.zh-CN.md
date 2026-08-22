# Codex Review Service

[English](README.md) | [简体中文](README.zh-CN.md)

面向 GitLab Self-Managed Merge Request 的生产级、自托管 Codex 代码审核服务。v1.1 的定位已经不是“Webhook + Codex 脚本”，而是一个单节点长期资产：SQLite 持久队列、异步 Review Worker、事务性 Publication Outbox、确定性门禁、精确 GitLab Pipeline Status，以及可选的独立 Codex Runner。

## 长期资产保证

- SQLite 使用 `WAL + synchronous=FULL`，Webhook 成功入队后具备掉电耐久语义。
- Webhook 请求内只做验签、实例/项目范围校验、幂等记录和本地入队，不同步调用 GitLab API 或 Codex。
- 不同 MR 可以并行，同一个 MR 严格串行。
- 审核固定绑定目标 `start_sha` + 源 `head_sha`，旧 snapshot 结果不能发布到新 MR 状态。
- `review_run + findings + GitLab 发布计划` 在同一个 SQLite 事务内提交。
- 独立 Publisher Worker 消费持久 Outbox；GitLab 发布失败只重试发布，不重新运行 Codex。
- External Commit Status 绑定源项目、源分支，并在可用时精确绑定 `pipeline_id`。
- superseded / closed Review 会闭环写 `canceled`；延迟的 `running` 状态不能覆盖终态。
- GitLab API 具备全局限速、`Retry-After` 和瞬态故障 Circuit Breaker。
- Codex finding 必须精确命中 old/new changed line，不再做 ±N 行静默吸附。
- finding identity 基于代码 anchor hash，而不是模型生成标题，跨重审 Discussion 更稳定。
- Coverage 区分 text reviewed、metadata-only、policy-excluded/generated、已知 binary/unreviewable、真正 provider/local coverage gap；真实 gap 始终 fail-closed。
- Controller 通过 GitLab Repository API 在精确 `start_sha/head_sha` 上读取有界上下文，不 clone、不执行 MR 代码。
- 目标分支可配置确定性 Analyzer，机械规则和 AI finding 走同一个 Finding/Gate 生命周期。
- Codex token usage 持久化，可配置单 MR 和项目每日 Token Budget。
- 启动与 Doctor 会校验 Codex CLI capability，并支持版本 off/warn/strict 策略。
- Draft MR 默认可跳过，自动 push 支持 debounce/coalesce。
- Prometheus metrics、元数据型结构化日志和可选 OTLP/HTTP trace 覆盖 Review/Publisher/Token 状态。
- GitHub Actions 依赖固定 full commit SHA；CI 同时验证 Node.js 22.13.0 与 24。

## 架构

```text
GitLab Self-Managed
      │ MR / Note Webhook
      ▼
Webhook Receiver
      │ HMAC/Secret + Instance + Allowlist + Delivery-ID
      ▼
SQLite WAL + synchronous=FULL
      │
      ├── Review Queue ── Review Workers（同 MR 严格串行）
      │        │
      │        ├── MR + diff_refs + pipeline identity
      │        ├── target policy @ start_sha
      │        ├── paginated diff + hard-limit 校验
      │        ├── immutable bounded source/target context
      │        ├── deterministic analyzers
      │        └── Codex chunks
      │                 │
      │                 └── 可选 Unix Socket Isolated Runner
      │
      └── review_run + findings + publication_outbox（同事务）
                         │
                         ▼
                   Publisher Workers
                   ├── Summary upsert
                   ├── Inline Discussions
                   ├── obsolete thread resolve
                   └── pipeline-bound commit status
```

当前正式支持的是**单节点 SQLite**。不要把数据库放在网络文件系统，也不要让多个 Controller 同时打开同一个数据库。如果未来明确需要 active/active HA，应替换 Queue/Storage 边界为外部事务存储，而不是给 SQLite 叠分布式锁兼容层。

## 环境要求

- Node.js **22.13+**
- Controller 可访问 GitLab Self-Managed
- Project/Group Access Token，权限仅覆盖所需的 MR/diff/member/pipeline/repository 读取和 Note/Discussion/Status 写入
- GitLab Project Webhook；套餐支持时可使用 Group Webhook
- GitLab 19+ 推荐 Standard Webhooks Signing Token；旧版本/迁移期显式支持 Legacy Secret
- Inline 模式下 Controller 用户可执行 Codex CLI；推荐生产模式下由独立 Runner 用户执行 Codex CLI

## 推荐生产部署：独立 Runner

最强边界是把凭据按 Unix 用户和进程分离：

```text
codex-review Controller
  - GitLab API / Webhook 凭据
  - SQLite
  - 不需要 OpenAI/Codex 凭据
        │
        │ /run/codex-review-runner/runner.sock
        ▼
codex-review-runner
  - Codex/OpenAI 凭据
  - 不包含 GitLab 凭据
  - 只执行 Codex Safe Contract
```

安装：

```bash
sudo useradd --system --create-home --home-dir /home/codex-review --shell /usr/sbin/nologin codex-review
sudo useradd --system --create-home --home-dir /home/codex-review-runner --shell /usr/sbin/nologin --gid codex-review codex-review-runner

git clone https://github.com/jiying2007/codex-review-service.git /opt/codex-review-service
cd /opt/codex-review-service
npm ci --ignore-scripts --no-audit --no-fund

sudo install -m 0600 .env.example /etc/codex-review-service.env
sudo install -m 0600 deploy/systemd/codex-review-runner.env.example /etc/codex-review-runner.env
sudo install -m 0644 deploy/systemd/codex-review-service.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/codex-review-runner.service /etc/systemd/system/
```

以 Runner 用户登录 Codex，或者在 Runner 环境文件里配置 API Key：

```bash
sudo -u codex-review-runner -H codex login
```

Controller 环境配置：

```text
CODEX_RUNNER_SOCKET=/run/codex-review-runner/runner.sock
```

然后启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now codex-review-runner codex-review-service
curl -fsS http://127.0.0.1:8787/health/ready
```

开发/小规模部署可不配置 `CODEX_RUNNER_SOCKET`，继续使用 Inline Codex 模式。

## GitLab Webhook

地址：

```text
https://review.example.internal/webhooks/gitlab
```

开启 **Merge request events** 和 **Note events**。建议 `GITLAB_PROJECT_ALLOWLIST` 使用明确数字 Project ID；`*` 只能做 webhook-only，因为 Controller 无法完整知道需要周期巡检的所有项目。

GitLab 19+ 配置 Standard Webhooks Signing Token，并把 `whsec_...` 写入 `GITLAB_WEBHOOK_SIGNING_TOKEN`。默认同时校验 `X-Gitlab-Instance`。

## 仓库审核策略

服务端环境配置是不可突破的硬上限。仓库可以在**目标分支**提交 `.codex-review.json`；Controller 固定从 `diff_refs.start_sha` 读取，绝不从尚未审核的 source branch 读取。

```json
{
  "language": "zh-CN",
  "maxDiffBytes": 524288,
  "maxFindings": 30,
  "severityThreshold": "low",
  "timeoutSeconds": 120,
  "maxContextBytes": 131072,
  "maxContextFiles": 16,
  "contextLines": 40,
  "skipGeneratedFiles": true,
  "blockUnreviewableFiles": false,
  "forbiddenPathPrefixes": ["infra/prod-secrets/"],
  "requireTestsForCodeChanges": true,
  "codePathPrefixes": ["src/"],
  "testPathPrefixes": ["test/", "tests/"],
  "extraInstructions": "重点检查并发、资源生命周期和错误处理。"
}
```

仓库策略只能收紧资源预算或增加确定性规则，不能修改凭据/工具、降低 `BLOCKING_SEVERITY`、降低 Controller confidence floor、扩大 Worker 并发或改变 Codex Safe Contract。

## Merge Gate

默认 External Commit Status 名称为 `codex-review`：

- 审核开始 → `running`
- Pass / 仅提醒项 → `success`
- 阻断 finding / 真实 coverage gap / 终态服务失败 / Token Budget 耗尽 → `failed`
- superseded / MR close → `canceled`

Controller 会解析 source project/ref，并尽量使用精确 `pipeline_id` 绑定当前 MR/源分支 pipeline。GitLab 开启 **Pipelines must succeed** 后即可纳入合并门禁。

## 审核质量与 Coverage

服务不再把所有空 diff / 非文本文件都粗暴视为同一种失败。Coverage 会区分 metadata-only、policy-excluded/generated、已知 binary/unreviewable 和真正 provider/local truncation。只有真正的 coverage gap 天生 fail-closed；对于已知不可审核文件，可用 `BLOCK_UNREVIEWABLE_FILES` 按项目风险策略升级为阻断。

Codex finding 必须落在真实 changed line。Controller 提供的上下文只能帮助判断，不能用来伪造 diff 外的 inline position。

## Token / 成本治理

每次 Codex `turn.completed.usage` 都会持久化。可选控制：

```text
MR_MAX_TOKEN_BUDGET
PROJECT_DAILY_TOKEN_BUDGET
CODEX_VERSION_POLICY=off|warn|strict
CODEX_ALLOWED_VERSION_PATTERN=<regex>
```

达到 Token Budget 后会把审核判定为 incomplete/failed，而不是静默跳过剩余 chunk。

## Health / Metrics / Trace

```text
GET /health/live
GET /health/ready
GET /metrics
```

Readiness 覆盖 DB、Review Worker、Publisher Worker、GitLab、Codex/Runner capability。Metrics 包含 review queue、publication queue、job 状态、finding 和 token 总量，避免高基数项目/分支标签。设置 `OTEL_EXPORTER_OTLP_ENDPOINT` 后可通过 OTLP/HTTP-compatible ingress 输出 JSON spans。

`npm run doctor` 不执行审核，只检查配置、SQLite schema/durability、Codex/Runner capability 和 GitLab 可达性。

## 手工重审

MR 新建评论严格等于 `/codex review` 时触发同一 snapshot 强制重审。默认要求 `MANUAL_REVIEW_MIN_ACCESS_LEVEL=30`（Developer）；Bot 自己的评论和编辑旧评论不会触发。

## 运维与长期治理

- [OPERATIONS.md](OPERATIONS.md)：部署、升级、备份、回滚、监控和事故处理
- [SECURITY.md](SECURITY.md)：信任边界和威胁模型
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)：架构不变量
- [LONG_TERM_ASSET.md](LONG_TERM_ASSET.md)：后续变更规则
- [CHANGELOG.md](CHANGELOG.md)：版本变化

## 开发验证

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run ci
npm pack --dry-run --ignore-scripts
```

CI 会执行 `git diff --check`、语法检查，以及完整 contract/unit/integration/fuzz 测试，并同时验证 Node.js 22.13.0 和 Node.js 24。
