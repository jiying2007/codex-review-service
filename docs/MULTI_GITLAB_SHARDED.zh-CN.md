# 多 GitLab / 多仓库：独立容器部署

适用：多个 GitLab Self-Managed 实例及各自多个 Project，Legacy 和 Sensor 互不共享状态或运行身份。此模板仅提供**单管理主机、双独立容器 + 固定路由 Nginx**，不代表双活 HA、不代表已部署内网。跨管理主机部署时，每个实例仍只能有一个活动 Controller/SQLite Writer；应由可信的专用 HTTPS/VPN 反向代理提供固定路径与网络 ACL，不能直接共享数据库卷。

## 选择拓扑

- **同信任域，资源有限**：继续使用 `compose.multi.yaml`（一个进程、多 Worker Thread；非硬安全边界）。
- **不同 GitLab、独立故障域**：优先 `compose.sharded.yaml`，Legacy / Sensor 分容器、分网络、分密钥、分本地数据库、分 Codex Home；每台 GitLab 内多仓库通过 Project/Group Allowlist 接入，不为每个仓库再创建 Service。
- **真正同实例多 Controller**：本版本不支持。不要让两个容器或两台机器指向同一个 SQLite 卷，也不能用 NFS/WAL 伪装多机 HA。需要数据库/队列重构及部署资格后另行演进。

## 安全边界与上线前提

`compose.sharded.yaml` 中全部服务都带独立 Compose `profiles`：**直接 `docker compose up` 不应启动任何模型 Worker**。模板是交付示例，不能在旧 Legacy 在线时启用新 Legacy Writer。

必须先具有**已正式发布、签名/摘要验证且可拉取每一层**的新 Service OCI Index Digest（不是源码版本号、普通 Tag 或 CI 成功）；再单独选择已验证 Digest 固定的 Nginx 镜像作为 `CODEX_REVIEW_EDGE_IMAGE`。当前安装版本还须确认 `src/index.js` / Config Schema 8 / DB Schema 12 对应。

在部署目录中准备 `legacy.json`、`sensor.json`，两份皆为**独立单实例 Config Schema 8**，不是多实例清单。Legacy 必须从实际原配置迁移有效规则，不能用示例覆盖；其 `server.dataDir` 应为 `/var/lib/codex-review/legacy`，`codex.home` 为 `/home/codex-review/legacy`；Sensor 对应 `.../sensor`。各实例 `gitlab.projects` / `gitlab.groups` 含明确授权范围，`webhook.expectedInstance` 与各自真实 `gitlab.baseUrl` 对应。

两个实例须独立 API Token、Webhook Token、数据卷和 Home。绝不在 Git、Shell 历史、日志或 PR 写入 Secret。四个 `*_FILE` 宿主路径应指向权限受限的常规文件。Legacy 已有真实命名卷必须用 `external: true` 指向，不会自动创建同名空卷冒充旧数据。

## 只读验证（禁止启动应用）

确认环境中的 `CODEX_REVIEW_IMAGE_DIGEST` 为 64 个 hex 字符、`CODEX_REVIEW_EDGE_IMAGE` 包含 `@sha256:<digest>`，以及四个凭据文件路径与 Legacy 两个现有卷名；不要在命令行直接放凭据值。

~~~bash
node src/sharded-deploy-check.js deploy/docker
docker volume inspect "$CODEX_REVIEW_LEGACY_STATE_VOLUME" >/dev/null
docker volume inspect "$CODEX_REVIEW_LEGACY_HOME_VOLUME" >/dev/null
docker compose -f deploy/docker/compose.sharded.yaml config --quiet
~~~

这些步骤**不启动 Worker、不运行 Codex、不调用 GitLab API**。其中本地计划检查只确认配置/路径/摘要格式，并非镜像发行签名证明；必须另外执行官方发行校验、镜像逐平台 Layer Pull、真实服务端 API 身份和网络连通性只读检查，并保留脱敏回执。

也可在现有真正多实例运行环境中执行：

~~~bash
CODEX_REVIEW_MULTI_CONFIG_FILE=/etc/codex-review/multi-instance.json \
  node src/multi-instance-inventory.js
~~~

该命令报告 `instance:projectId` 及 Group 选择器，**不递归枚举 Group 成员**、不读取 MR、不运行模型；它必须在具备相同只读配置/Secret 文件挂载的环境执行。清单中 `configured_not_live_verified` 不得等同实际仓库接入成功。

## 受控切换 / 回滚

1. Legacy 继续使用现有已验收实例，不将旧正在运行的卷交给新容器并行写入。对旧实例先 drain 并观察未决模型调用、Publication/Notification Outbox、状态回写、回放账本，再执行一致性 SQLite 备份与校验。
2. 现场停止旧唯一 Writer，在隔离副本上验证 Schema 迁移至目标版本、回滚备份可读。Sensor 的首次数据库初始化也只能在独立受控暂存中完成。缺失数据库不能算作 READY。
3. 单独启用 `--profile cutover-legacy` 或 `--profile cutover-sensor` 所选择的实例，完成真实 API/Webhook 签名拒绝、项目范围、错误重放和状态恢复测试；仅在两个实例均获许可后才启用 `--profile cutover-edge`。新边缘入口默认仅绑定宿主机 `127.0.0.1:8799`，由已有可信 HTTPS 入口转发，不直接暴露公网。
4. 旧路径 `/webhooks/gitlab` 固定转 Legacy；`/webhooks/gitlab/sensor` 固定转 Sensor 并转写后端路径为 `/webhooks/gitlab`。WebHook 原始签名/Token 必须由各自 Service 再次验证，不以 Nginx 路由视为授权。
5. 任一实例故障，不切断另一实例的独立执行与后端队列；边缘单点故障和主机故障不在本模板的 HA 能力之内。故障回滚应停止对应新 Writer，若 DB 迁移则恢复与旧镜像匹配的完整原始备份，不得直接让旧二进制打开新 DB。

**重要：** `notifications.enabled=false`、`triggerOnOpen=false` 等不是严格的“无模型”开关。初始化运行时可能恢复已有队列、响应 Note 或 reconcile。共享 Codex/Work 额度未另行授权时不执行任何 `docker compose up`、不向新的 Sensor 发送真实 MR/Note Webhook，也不启动新 Review Worker；只读离线检查不等同于生产验证。

## 指标与扩容

Gateway 原有 `/health/ready` 继续表示**所有实例**就绪（任一异常时 503）；新增 `/health/ingress` 仅在至少一个实例可接受流量时返回 200，仍列出全部实例状态，不能替代任何单实例健康探针。查看 `/instances/<id>/health/ready` 和 `/instances/<id>/metrics` 定位局部问题。

跨仓库调度仍以实例内 Project ID 为单位，保留同 MR 串行、防重复、最新 SHA 和每 Project/每 MR Token 账本。Node 端仅接收每个 Project 的候选任务，不搬运所有排队记录；仍需按实际队列等待、资源峰值和 Token 样本扩容。只有容量/可用性证据要求同 GitLab 实例多副本时，才考虑支持 Postgres / 分布式队列的独立方案。
