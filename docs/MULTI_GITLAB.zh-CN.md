# 单进程多 GitLab：Legacy + Sensor 上线与回滚

本指南适用于 native multi-GitLab 候选分支。现有 Service 7.6.1 镜像不包含此功能，绝不能直接将旧实例切换为多实例模式；本文件也不表示已经在 192.168.1.22 部署或验证成功。

## 结构与身份隔离

一个 Node.js 主进程 + 一条 HTTP 入口 + 多个 Worker Threads；每台 GitLab 各自保留独立的 GitLab Client、项目/Group Scope、限流/断路器、审查/Publication/Notification Outbox、SQLite DB、API Token、Webhook Secret 与 Codex Home。

**强隔离边界**：Worker Threads 属于同一个 OS 进程、用户与文件系统，提供的是应用逻辑、配置和持久状态隔离，不能防止进程级入侵后访问其他实例的文件/内存。多实例配置必须显式设置 server.sharedProcessTrustAcknowledged=true，并且只能将同一管理方、相同数据使用与保密政策的 GitLab 合入此进程；不同保密级别/法律或模型数据政策必须使用独立容器/进程和 Unix 身份。

- legacy: GitLab 192.168.1.4；保留原 /webhooks/gitlab 路径；项目包括原 78 个显式/Group 项目。旧 GitLab 的 Project ID 113 为 vosen/toolchain/ssc305，旧 sensor 是 139。
- sensor: GitLab 192.168.2.50；新 /webhooks/gitlab/sensor 路径；只允许 Project ID 113，对应 airobot/modules/sensor。
- 持久身份逻辑上是 (instanceId, 独立 SQLite DB, project_id, mr_iid, commit_sha)。两台 GitLab 的 Project ID、User ID、状态、回写凭证、通知路由不得相互复用。避免侵入式改动全部 SQLite 表/迁移所有线上数据，使用物理数据库命名空间实现隔离。
- 单 GitLab 原入口、直接 CODEX_REVIEW_CONFIG_FILE 配置和旧 Schema 8 保持不变。只有显式设置 CODEX_REVIEW_MULTI_CONFIG_FILE 时才启动多实例入口。

## 免费离线代码验证（不调用 Codex/Work）

新增显式测试入口：

    npm run test:multi-offline

此命令只运行 8 组原生多实例单元/本地 HTTP/SQLite/Worker 模拟与实际 Worker Thread 测试，所有 GitLab API 调用使用 mock，禁止与生产中的旧 GitLab 共享数据库；不启动 Codex CLI、不请求 OpenAI API、不访问真实 GitLab。支持的正式测试运行时仍为 Node 22.22.2 或 Node 24.19.0。正式发布还必须完成 Service 全部 CI、CodeQL、GitLab CE Provider 与故障注入验收；离线通过不替代这些证据。

## 凭据与安全

多实例清单使用 deploy/docker/multi-instance.example.json。 必须人工确认共享进程信任边界后开启该选项，不能把它当成 OS 安全沙箱。每个实例都明确声明 configFile、homeDir、GitLab API Token 与 Webhook Secret 的 *_FILE 文件绝对路径，API 与 Webhook Secret 都不允许两实例共享文件或相同实际内容。配置检查读取受控凭据进行内存摘要比较，不打印凭据值。Worker Thread 仅接收所属实例的文件路径及有限环境变量，不继承宿主旧 API Token、OpenAI API Key 或另一实例的明文。

HTTP 路由只决定内部 Worker，不能代替安全认证。每个 Worker 独立进行原始请求 Webhook 签名、GitLab Instance、项目 allowlist、重放与配额校验。错误实例、错误签名、未知路径按实际校验拒绝。旧 GitLab Classic Token 模式仍兼容缺少 X-Gitlab-Instance 的老版本；如果传了实例头则必须匹配。Standard Webhooks HMAC 必须携带合法实例头和签名。

sensor.config.example.json 默认 review.triggerAssignment = always、projects = [113]、groups = []，notifications.enabled = false。always 仅取消用户指派过滤，不能越过项目白名单、签名、Bot 自触发等安全规则。原 Legacy assignee 用户 ID 8 不应复制给 sensor；若需要新服务器按人员触发，请重新查询新服务器的用户 ID。飞书/企业微信路由和用户身份映射也应单独审核。

## 准备（不操作运行中的旧容器）

1. 首先取得受保护 PR 的独立审核、完整 Node 22/24 与 GitLab/CodeQL CI、可信 release 与 OCI 镜像 digest。验证镜像包含 src/multi-gitlab* 和新入口。现有 7.6.1 image 不包含，绝对不能用于本模式。私有 Service 当前 Actions Runner 如果没有运行 job steps，不能把失败/跳过算成通过。
2. 在 192.168.1.22 用 docker inspect 检查旧容器实际状态卷、Codex Home 卷和配置。使用现有 admin backup/backup-verify 完成一致性备份，保留原版本及 Compose 文件。禁止在旧实例运行时粗暴复制 WAL/SQLite 文件。
3. 将真正的 /opt/codex-review-service/config.json 另存为候选 legacy.json，保留所有旧 Project、Group 48、触发规则、企业微信/飞书、Codex 模型策略等有效设置；只按新容器内部的真实路径设置 server.dataDir 为 /var/lib/codex-review/legacy、codex.home 为 /home/codex-review/legacy。不要用模板覆盖原配置。
4. 根据 deploy/docker/sensor.config.example.json 创建 sensor.json（Config Schema 8），指向 http://192.168.2.50、projects [113]、独立数据目录 /var/lib/codex-review/sensor 与 Home。Webhook expectedInstance 与该 GitLab 的真实 origin 相同。通知先禁用。
5. 将 multi-instance.example.json 复制为 multi-instance.json。配置四个分离的受控 GitLab API/Webhook 文件。Compose 只接收秘密文件的路径环境变量，禁止任何 Secret 明文进入 git、配置仓库、Shell 历史、命令参数或聊天。按最小权限配置 API Token，必须能读新项目并在真实 MR 写入 Note/Discussion/Commit Status。
6. 按 deploy/docker/compose.multi.yaml 准备 Docker 环境。CODEX_REVIEW_IMAGE_DIGEST 必须是已发行且验证可追溯的完整 64 位十六进制 digest 值（不含 sha256: 前缀）；Compose 镜像硬绑定 ghcr.io/jiying2007/codex-review-service@sha256:<该摘要>，不接受可变 tag；CODEX_REVIEW_LEGACY_STATE_VOLUME 与 CODEX_REVIEW_LEGACY_HOME_VOLUME 必须指向已经存在的旧命名卷，Compose 标为 external，不允许自动创建一个空卷替代。其他两个 sensor 卷新建。先运行以下只读校验，不启动重复旧 Writer：

       docker compose -f compose.multi.yaml config --quiet
       ss -ltnp | grep -E ':(8787|8788)' || true

**只读预检（允许在 10 月执行，不启动服务/模型、不调用 Codex）：**

       CODEX_REVIEW_MULTI_CONFIG_FILE=/etc/codex-review/multi-instance.json node src/multi-gitlab-preflight.js

预检通过实际认证的 GitLab /api/v4/version、显式 /api/v4/projects/:id 与 /api/v4/groups/:id 只读 GET；输出只包含实例 ID、版本和已验证项目/组数量，不输出 Token。返回 ok=true 仍**不能证明** GitLab 写入权限、Webhook 反向访问、真实 MR 审查成功，也不能代替正式 CI 与发布资格。运行命令的系统必须具备与部署相同的配置/Secret 文件挂载。

**隔离管理（选择唯一实例，不能跨实例查询 DB）：**

       CODEX_REVIEW_MULTI_CONFIG_FILE=/etc/codex-review/multi-instance.json node src/multi-gitlab-admin.js legacy status
       CODEX_REVIEW_MULTI_CONFIG_FILE=/etc/codex-review/multi-instance.json node src/multi-gitlab-admin.js sensor db-check

备份、drain、notifications、reconcile 等仍使用已有 admin 命令，但必须显式指定实例；正式上线时用现有配置的受控路径操作。禁止用同一个数据目录执行双实例 admin 写操作，且 10 月不触发任何可能运行 Codex 的 reconcile/Review。

**镜像能力预检：** IMAGE 必须是通过验签的真实 digest，并在不启动应用的前提下，确认镜像包含本功能：

       docker run --rm --entrypoint node "ghcr.io/jiying2007/codex-review-service@sha256:${CODEX_REVIEW_IMAGE_DIGEST}" -e "require('./src/multi-gitlab-config');require('./src/multi-gitlab-gateway');require('./src/multi-gitlab')"

旧 v7.6.1 镜像会因缺少模块而非零退出；即使能力检查通过，也不能替代受保护 CI、SBOM、GitLab 真机与独立审核。

容器内部单个 HTTP 端口继续为 8787；主机若使用 8788 进行其他隔离验证，只修改 CODEX_REVIEW_PORT 映射，不必修改每个实例 Config Schema 的 server.port。默认 Compose 只绑定本机 127.0.0.1；反向代理需要接收 GitLab 外部回调，推荐可信 HTTPS 入口及源地址限制。网页登录 200 不证明 API Token 有权限，也不证明新 GitLab 能反向访问 Webhook。

## 数据库切换只读门禁（候选新增）

新 CLI `node src/multi-gitlab-cutover-check.js` 只读打开每台 GitLab 的 `review-service.sqlite`，不调用 `Store()`、不触发迁移、恢复、Webhook、Codex 或外部请求；检查当前 Service 的 DB Schema、SQLite quick_check/foreign_key_check、Review Job 非终态、Publication/Notification Outbox 未投递任务以及状态写入的 `started/uncertain`。任一实例有待处理任务或任何状态结果不确定，则整体返回非零并报告实例级阻断。

    CODEX_REVIEW_MULTI_CONFIG_FILE=/etc/codex-review/multi-instance.json node src/multi-gitlab-cutover-check.js

**启动期强制检查**：多实例进程在打开公共 HTTP 入口以及启动任何 GitLab Worker 之前，会调用同一只读检查器，要求**每个实例**已经具备完整且与当前产品一致的数据库 Schema；如果缺失、损坏或仍为旧 Schema 9，直接报 `EMULTIDBPREP`，不让新服务自动迁移旧数据库。正常崩溃恢复若数据库 Schema 已准备完成而队列非空，仍允许原有 durable recovery 接管，避免遗失待处理任务。首次切换依然要求人工在停止旧 Writer 后确认队列已排空，自动启动门禁不代表能自动识别其它进程是否还在写同一卷。

**这不是数据库锁或备份**：即使返回 READY，旧进程也可能继续收到 Webhook、reconcile 或 Outbox 写入。因此操作前必须实际排空、暂停入口、停止原 Writer 并完成 SQLite 在线一致性备份。对于 7.6.1 → 7.6.2（Schema 9 → 11），该检查会**明确返回 EDBSCHEMA**，不能用修改 JSON 或关闭检查强行放行。应在停旧实例并保存不可变备份后，用有版本资格的升级程序在**受控复制数据库**上完成正式迁移、`backup-verify` 与读写边界核验，再将经验证的数据放入新实例的独立卷，并重新执行只读门禁。新 sensor 的空库也必须由官方 7.6.2 `admin db-check` 在隔离维护步骤初始化与验证；任何缺失 DB 不代表已验收。

如果修复 #114 的最终引用/发布事务栅栏尚未得到认可，`status_write_attempts` / `status_publication_targets` 的不确定远端效果仍必须由正式 Recovery 验收独立解决；本门禁只能拒绝**数据库显式记录**的不确定项，不能代替 GitLab 服务端原生原子 CAS 资格。

## 正式切换步骤（需要主机管理员与维护窗口）

不可在旧单实例容器写旧 SQLite 的同时启动读取相同卷的新 Legacy Worker。即使旧 Webhook 暂停，旧进程的周期 reconcile / outbox 也可能写 DB，因此必须先 drain、备份并停止原容器。若 sensor 之前已经由独立 8788 服务运行，也需要先停、排空并备份其数据库卷。

1. 先验证真实的新 GitLab API 鉴权、版本兼容与反向网络，再确认所有配置、卷、Secret、镜像/签名及资源容量；10 月仍禁止任何 Codex CLI/Cloud/Work 与共享额度调用，不执行真实模型 Review。
2. 排空旧实例审查与 Publication/Notification Outbox，验证在线备份；暂停写入并停止旧容器，在受控维护窗口启动新多实例容器。旧原始配置、原镜像和备份保持不变。
3. 检查 /health/live、/health/ready、/health/dependencies、/instances/legacy/health/ready、/instances/sensor/health/dependencies、/version、/metrics。任一实例异常时先修复，不把其他实例被动判为成功。每实例完整指标位于 /instances/<id>/metrics。
4. 旧 GitLab 仍发到原入口 192.168.1.22:8787/webhooks/gitlab；新 sensor Webhook 发到统一入口 192.168.1.22:8787/webhooks/gitlab/sensor。启用 Merge request events 和 Note events，用新服务器独立密钥与实际 GitLab webhook auth profile；先验证签名、错误签名拒绝、重放和路由。
5. 在允许真实模型调用的时间窗口，分别对旧、新 GitLab 的可丢弃 MR 做完整验收：状态更新、Summary、Discussion、推送新 SHA 后重审、重复 Webhook 去重、Project ID 113 不交叉、独立通知、GitLab Server 中断和恢复、CPU/内存与队列预算。不能把 webhook 202 等同于审查成功。
6. 任一门禁失败，停止多实例与新 Webhook，保留数据一致性证据；如未发生任何 DB schema 迁移可在确认旧镜像仍能读取旧 DB 后恢复原单实例。若 Service #113 / Schema 11 等已造成数据库升级，则必须恢复已验证的迁移前备份，不可强行用 7.6.1 打开新 DB。

## 发布与资源边界

- 新功能独立于现有 Service PR #113 及 Issue #114 的权威 Git ref 事务保护；不得对未通过的 CI、暂缺私有 Ruleset entitlement、未验证的部署回执造假。
- Worker 独立保留旧任务队列、重试、API 限流、Token 预算、通知/告警；单容器总 CPU/RSS 是各 Worker 累计值，须独立容量审查与监控。健康检查为保守的聚合 fail-closed，但单个 GitLab 宕机不能使另一台 GitLab 的合法 Webhook 停止服务。
- 无需整体 SQL Schema 改写即可在同一个 OS 服务进程内支持多个 GitLab；物理 DB 独立也意味着按不同版本执行 DB Schema 迁移和备份，不能让两个服务指向同一个 dbPath。
- 该 README 仅定义候选交付与人工切换步骤，不宣称用户主机已改动。自动模型审查须在用户正式解除 2026-10 Codex/Work 额度禁令后才可启用与验收。
