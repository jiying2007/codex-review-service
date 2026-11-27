# 多 GitLab 独立执行：生产切换规范 V8

本指南适用于 **Service v8.0.2（Database Schema 12 / Core 4.18.13）**。

## 强制边界

- 不提供旧版默认实例、匿名 Webhook 路径或自动迁移配置。统一入口只接受 **POST /webhooks/gitlab/<instance-id>**，裸路径 POST /webhooks/gitlab 必须返回 404。
- 实例 ID 明确命名、彼此独立，每个 GitLab 可以服务多个 Project/Group；以 instanceId:projectId 作为跨 GitLab 唯一仓库键。
- 优先每 GitLab 独立进程、独立 SQLite Writer、独立 Codex Home、独立 Webhook 签名密钥和 API 凭据。共享进程 Worker Thread 仅用于明确承认非硬安全隔离的场合。
- 统一 Edge 无 Secret、无 SQLite 和模型 Worker。任何一台 GitLab 不可达不得被表示为队列为 0。
- Config Schema 8 保持不变；显式多实例 Manifest 使用 Schema 2；Sharded Catalog 使用 Schema 2。Schema 1 不会自动兼容转换。
- 新代码、PR CI 或 OCI 发布均不等于 AiotServer01 等现场主机已升级。没有真实生产读写证据时不可宣称生产验收通过。

## 安装与只读检查

先根据各主机真实配置准备唯一的实例 ID 和允许的仓库范围，随后：

~~~bash
node src/sharded-catalog.js primary=/etc/codex-review/primary.json sensor=/etc/codex-review/sensor.json > /etc/codex-review/catalog.json
node src/sharded-deploy-check.js /etc/codex-review/catalog.json /etc/codex-review/targets.json primary=/etc/codex-review/primary.json sensor=/etc/codex-review/sensor.json
docker compose -f deploy/docker/compose.sharded.yaml config --quiet
~~~

上述命令不启动模型、不调用 GitLab、不会创建数据库 Writer。调用前须将目录与环境变量配置为实际的受保护私有文件，不应将演示地址当作生产配置。校验仍不证明签名、远端权限或镜像存在；单独核验正式 Release 和 OCI index digest、两个平台的实际拉取与来源证据。

部署阶段使用 deploy/docker/compose.instance.yaml 为每个 GitLab 建立独立容器、私有 Docker 网络、两份外部且已核验的状态卷。每个容器本地的 server.dataDir=/var/lib/codex-review/tenant，codex.home=/home/codex-review/tenant，server.host=0.0.0.0，server.port=8787。Edge 使用 deploy/docker/compose.sharded.yaml，只接入以实例名作为 host 的可信内部隧道/网络别名，不得连接任意 IP 或暴露后端公网端口。

## 受控切换、停止和回滚

1. 先确认旧服务唯一 Writer、数据库 Schema 和真实镜像版本。暂停入口、drain 队列并检查 model_calls started/unknown、Publication/Notification Outbox 与 GitLab 状态不确定写入。
2. 记录不暴露 Secret 的 SQLite 完整性与备份回执。**停止原 Writer** 后才允许新服务使用迁移数据；回滚必须使用与旧版本匹配的原始备份，不能在活库上并行写入或直接原地降级。
3. 预先部署但不启动新模型 Worker；核验 GitLab API 权限、Webhook HMAC/Classic Token 模式、最小权限和 Project/Group 白名单。没有真实授权时不向新系统发送 MR/Note Webhook。
4. 完成新入口配置后，将真实 GitLab Webhook URL 显式改为 /webhooks/gitlab/<instance-id>；不得依赖旧裸路径重定向。在受控窗口中逐实例验收签名拒绝、同数字项目 ID 隔离、重复投递去重和写入恢复。
5. 测试一个实例断网时其他实例依旧可审查，并检查 /health/ready、/health/ingress、/repositories/status 与 /metrics 的区别。不能将监控缺失当作任务清空。

**重要**：notifications.enabled=false、triggerOnOpen/triggerOnPush/triggerOnReopen=false 不代表模型不会调用。启动时可能恢复队列、响应 Note、reconcile。共享 Codex/Work 额度禁令明确解除之前，不启动新的真实审查 Worker。任何自动 Merge/Approve 必须仍由独立权限和保护规则授权；读写检查不能伪装 Merge 授权。

## 审查和观测约束

所有审查结论必须绑定源 MR 精确 Head SHA、代码 diff 完整性、最新来源和可追溯的发现生命周期。离线质量—Token 评测是研究门禁，不是生产自动晋级。统一指标区分 retained Gauge、过程 Counter、未知模型用量与缺失的仓库数据；若指标采集影响 Webhook P95/P99 则需独立读进程。

每次发行应有 Node 22/24 CI、真实 GitLab 版本 E2E、两架构镜像安全扫描、不可变 SHA、SBOM/Provenance 和 Release Integrity；CodeQL 分析与实际 SARIF 高危门禁必须运行。仪表盘上传失败只影响可视化，不得伪装 CI 或镜像验收成功。签名能力依实际发行证据记录。
