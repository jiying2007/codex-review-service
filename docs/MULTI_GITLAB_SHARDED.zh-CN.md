# 多 GitLab / 多仓库：独立容器 + 统一无凭据 Edge（V8）

新版本只支持显式路由，不保留旧的 Legacy 默认入口。每个 GitLab 实例的 Service/SQLite/Codex Home/API Token/Webhook Secret 必须相互隔离，实例内部可纳管多个 Project/Group。不支持同一 SQLite Writer 跨机器共享，也不提供 NFS/WAL 伪双活。

## 两个独立发行模板

- deploy/docker/compose.instance.yaml：每台 GitLab 所在执行主机单独使用，profile cutover-standalone，专属外部数据卷和密钥文件；裸 docker compose up 不启动审查进程。
- deploy/docker/compose.sharded.yaml：只提供 profile cutover-edge 的无凭据统一入口，不包含任何 Review Worker、Secret 或 SQLite。要求在宿主机的 127.0.0.1 绑定，再由可信 HTTPS 代理对外仅开放指定 Webhook。
- Docker 以 RELEASE-PUBLISHED OCI digest 精确固定镜像；GitHub 主线成功但没有 Release Integrity 不足以放行生产。

## 显式 Catalog Schema 2 和目标映射

~~~bash
node src/sharded-catalog.js primary=/etc/codex-review/primary.json sensor=/etc/codex-review/sensor.json > /etc/codex-review/catalog.json
node src/sharded-deploy-check.js /etc/codex-review/catalog.json /etc/codex-review/targets.json primary=/etc/codex-review/primary.json sensor=/etc/codex-review/sensor.json
docker compose -f deploy/docker/compose.sharded.yaml config --quiet
~~~

其中 primary/sensor 仅为示例实例 ID，1–16 个 ID 均由使用方显式提供，不存在默认 ID。完整合法 Catalog 包含 schemaVersion=2 和来源摘要，项目显式标记 configured_not_live_verified，Group 成员并不代表已完成在线枚举。

targets.json 必须是无凭据 JSON，每个实例有同名私有 DNS 别名或 127.0.0.1 指向一个受信端口，例如：

~~~json
{"primary":{"host":"primary","port":8787},"sensor":{"host":"sensor","port":8787}}
~~~

Edge 使用 CODEX_REVIEW_SHARDED_TARGETS_FILE 指向 targets.json，目标数量与 Catalog 必须完全一致。任意网络 URL、公开 IP、跨 GitLab 目标复用、未声明目标均拒绝。跨物理主机必须另行提供经过审核的双向 TLS/VPN 隧道，并在 Edge 私有网络上公布与实例 ID 一致的别名；项目不内置 TLS 终止服务，也不自动授权网络。

## 接口和访问限制

- POST /webhooks/gitlab/<instance-id>：唯一外部 Webhook 入口，仅固定路由至该 Service 内部 /webhooks/gitlab，并由各实例再次验证原始签名、项目和 Head SHA。
- POST /webhooks/gitlab：404，**不会回退到任意默认实例**。
- GET /health/live：Edge 进程存活；GET /health/ready：全部实例 READY；GET /health/ingress：至少一个实例可路由，不能解释为全部健康。
- GET /instances/<instance-id>/health/ready、/metrics：私网定位单实例。
- GET /repositories：只读配置目录；GET /repositories/status：只读本地任务观测，不宣称远端 GitLab 权限；GET /metrics：Prometheus 聚合，未知用量与缺失指标不填零。

GET /repositories*、/instances/*、/metrics 必须仅允许可信管理内网或认证监控平台访问，外部 HTTPS 仅转发明确授权的 Webhook 路径。Prometheus 告警 deploy/monitoring/codex-review.rules.yaml 和 Grafana deploy/monitoring/grafana-fleet.json 需要独立监控采集；不创建 ChatGPT 定时巡检。

## 切换安全边界

正式切换前先只读验证当前唯一 Writer 和数据库 Schema 12；等待队列清空，核验 Model Call started/unknown 与所有 Publication/Notification Outbox 和 status uncertainty，再做一致性备份、停止原 Writer、验证新旧版本回滚备份。任何阶段不能让两个 Writer 同时访问同一个 SQLite 卷。

模型执行需要独立资源授权，notifications.enabled=false 不代表模型不会调用。这里的检查**不启动模型、不发送真实 Webhook**，也不是生产可用性证明。正式验收必须包含一个实例断线时另一个继续处理、跨仓库公平调度、真实 GitLab Webhook 签名拒绝和状态恢复。
