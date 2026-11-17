# 多 GitLab 扩展：2–16 个独立实例与多服务器安全入口（7.8 候选）

**架构边界**：每个 GitLab 独立的 Review Service OS 进程、SQLite Writer、API Token、
Webhook 签名密钥、Codex Home、资源配额和故障处理；不可让多个实例共享 SQLite 或以
NFS/WAL 伪装 HA。Edge 只做固定路由与只读指标聚合，绝不接收 GitLab/模型凭据。

## 非侵入兼容与实例目录
旧的双文件命令仍可用：
```bash
node src/sharded-catalog.js legacy.json sensor.json > catalog.json
```
新增受控多实例构建（至少包含 legacy，名称限 32 个小写安全字符，最多 16 个实例）：
```bash
node src/sharded-catalog.js legacy=/etc/codex-review/legacy.json \
  sensor=/etc/codex-review/sensor.json \
  qa=/etc/codex-review/qa.json > /etc/codex-review/catalog.json
```
以上均为**不启动模型、无 GitLab API**的配置目录生成，明确保留每个配置的
`configured_not_live_verified` 状态和 `instance:projectId` 标识，不会伪装远端已授权。

Edge 加载**无凭据、静态、白名单限定**的本地映射文件：
```json
{
  "legacy":{"host":"legacy","port":8787},
  "sensor":{"host":"sensor","port":8787},
  "qa":{"host":"qa","port":8787}
}
```
```bash
CODEX_REVIEW_SHARDED_CATALOG_FILE=/etc/codex-review/catalog.json \
CODEX_REVIEW_SHARDED_TARGETS_FILE=/etc/codex-review/targets.json \
node src/sharded-edge.js
```
Edge **仅允许 host 为准确实例 ID 或 127.0.0.1**，不允许输入任意 URL、域名或
公网上游；映射必须与 Catalog 完全一致，增删实例需要受控重启 Edge。Docker 桥接中
按实例名提供专用容器别名；跨物理主机请使用**单独维护的认证 HTTPS/mTLS 隧道或 VPN**
将远端 Service 以同名本地代理服务接入可信私有网络，Edge 不负责 TLS 协商或证书管理。
示例 Docker Sharded Compose 仍只有 Legacy/Sensor；新增实例需单独受控部署，不能声称
Compose 模板已动态自动发放远端 Worker。

## 只读统一管理视图

- `GET /repositories`：仅目录声明，与过去相同。
- `GET /repositories/status`：并行拉取每个实例 readiness + 本地 metrics，并返回
  `local_job_history_observed_not_remote_verified`、`configured_no_local_job_history`、
  `metrics_truncated`、`metrics_unavailable` 或 `metrics_incomplete`；
  这不是 GitLab 远端成员资格或 MR 审查成功证明。
- `GET /metrics`：按实例聚合，缺失上游指标不填 0。
- `GET /health/ready`：全部就绪；`/health/ingress`：至少一个可接收流量。

**安全**：`/repositories*`、`/metrics`、`/instances/*` 只面向可信管理网络，
公网反向代理只转发允许的原始 Webhook POST。独立 Service 仍以原始签名和项目白名单验证，
不能把 Edge 路由当成授权。切换须备份、drain、唯一 Writer、真实 webhook/mr
验证；生产验收不等于配置或 GitHub CI 成功。

## 告警
`deploy/monitoring/codex-review.rules.yaml` 提供标准 Prometheus 规则。
需要 Prometheus `job="codex-review-sharded-edge"` 的既有内部 scrape 目标，
并按实际 SLO 调整阈值，避免把实例失联和真正没有任务混为一谈。不建立 ChatGPT 定时巡检。
