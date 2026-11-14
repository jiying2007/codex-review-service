# 单进程多 GitLab：Legacy + Sensor 上线与回滚

本指南适用于 **Service v7.7.1（Database Schema 12 / Core 4.18.4）** 的多 GitLab 运行时；仅当该版本完成不可变 Release、CI/签名和镜像 digest 验证后才可用于生产部署。此前 v7.6.3/v7.6.4 的发行验收不能代替 v7.7.1 的独立验收。新版本在正式 Release、CI、OCI 摘要和独立完整性核验完成前不得宣称发行成功；即使 GitHub 发行通过，亦**不表示**它已经部署在内网生产主机 `192.168.1.22`。旧服务器当前实际运行的版本、卷和数据库 Schema 必须由管理员在现场核查；旧 v7.6.1/v7.6.2 镜像均不具备这套多实例能力，禁止用旧镜像直接切换。

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

此命令只运行 8 组原生多实例单元/本地 HTTP/SQLite/Worker 模拟与实际 Worker Thread 测试，所有 GitLab API 调用使用 mock，禁止与生产中的旧 GitLab 共享数据库；不启动 Codex CLI、不请求 OpenAI API、不访问真实 GitLab。支持的正式测试运行时仍为 Node 22.22.2 或 Node 24.19.0。此前正式 v7.6.3/v7.6.4 的 Node 22/24、完整 CI、GitLab CE Provider、故障注入、OCI 构建、Trivy Critical 和独立 Release Integrity 已在 GitHub 取得实际成功证据；新 v7.7.1 必须独立完成相同资格；CodeQL 分析与实际 SARIF 高危门禁必须运行；Code Scanning 仪表盘上传不可用时只跳过上传，签名能力依实际发行证据记录，绝不伪造扫描或签名通过。离线测试不替代这些发行证据，也不替代真实内网验收。

## 凭据与安全

多实例清单使用 deploy/docker/multi-instance.example.json。 必须人工确认共享进程信任边界后开启该选项，不能把它当成 OS 安全沙箱。每个实例都明确声明 configFile、homeDir、GitLab API Token 与 Webhook Secret 的 *_FILE 文件绝对路径，API 与 Webhook Secret 都不允许两实例共享文件或相同实际内容。配置检查读取受控凭据进行内存摘要比较，不打印凭据值。Worker Thread 仅接收所属实例的文件路径及有限环境变量，不继承宿主旧 API Token、OpenAI API Key 或另一实例的明文。

**新增控制面文件准入约束**：多实例清单和每个租户的 JSON 配置须为独立、单硬链接（`nlink=1`）、非符号链接的普通文件，大小不超过 1 MiB；Linux/Unix 不允许组或其他用户写入。Secret 文件也必须独立、不可被组或其他用户改写且不允许硬链接。加载器采用检查过的文件描述符、有界读取与读取后元数据复核，减少文件替换竞态；它不能替代受保护的上级目录、容器挂载权限和管理员对实际 Secret 的保管。建议将清单/配置/密钥分别设置为 `0600`（或只读 `0400`，以真实运行 UID 能读取为前提），对配置目录实施最小权限并只读挂载；在 Windows 上须另行核验 ACL，POSIX 模式位不足以提供 Windows 文件保护。升级前执行只读预检，拒绝通过 `chmod 777`、硬链接复用或把文件放入租户可写状态卷来修复权限报错。

HTTP 路由只决定内部 Worker，不能代替安全认证。每个 Worker 独立进行原始请求 Webhook 签名、GitLab Instance、项目 allowlist、重放与配额校验。错误实例、错误签名、未知路径按实际校验拒绝。旧 GitLab Classic Token 模式仍兼容缺少 X-Gitlab-Instance 的老版本；如果传了实例头则必须匹配。Standard Webhooks HMAC 必须携带合法实例头和签名。

sensor.config.example.json 默认 review.triggerAssignment = always、projects = [113]、groups = []，notifications.enabled = false。always 仅取消用户指派过滤，不能越过项目白名单、签名、Bot 自触发等安全规则。原 Legacy assignee 用户 ID 8 不应复制给 sensor；若需要新服务器按人员触发，请重新查询新服务器的用户 ID。飞书/企业微信路由和用户身份映射也应单独审核。


## 额度保护期：Sensor 只读预检≠启用模型审查

**默认不把 Sensor 的实际 Webhook 接入正在运行的服务。** `deploy/docker/sensor.config.example.json` 是未来经授权启用 Review 的示例，**不是无模型运行配置**：当前 `review.triggerAssignment.mode=always`，`triggerOnOpen/triggerOnPush/triggerOnReopen=true`，收到合法 MR 事件可能创建真正的 Codex 审查任务，消耗模型额度。`notifications.enabled=false` **只关闭通知，不代表模型不会调用**。

**不能仅将三个 `triggerOnOpen`、`triggerOnPush`、`triggerOnReopen` 改成 `false`，就宣称模型调用被完全禁用。** `src/webhook.js` 的实际规则还会因 Reviewer/Assignee 变更、`source_branch` / `target_branch` 更新创建审查任务；有权限的用户发送 `/codex review` Note 也能走手动审查路径。启动后的恢复队列和定期 reconcile 也必须单独评估，不能用关闭通知或关闭新事件代替已有任务的处理控制。

在共享 Codex/Work 额度限制未明确解除前，管理员**只执行不启动 Worker、不投递真实 MR Webhook、不调用模型**的预备动作：

1. 核对 Service v7.7.1 精确发行和 GHCR digest，`docker inspect` 读取旧容器信息（不输出 Env 或 Secret），验证旧实例备份及唯一 Writer。
2. 在独立暂存环境按经许可的配置/Secret 文件运行 `src/multi-gitlab-preflight.js`：这会对真实 GitLab 执行只读 API 请求，但不运行 Codex。对已存在的、经过授权的 SQLite 副本，使用 `src/multi-gitlab-cutover-check.js` 进行只读 Schema/队列检查。
3. **不要执行 `docker compose up`、开放 Sensor Webhook、启动 Review Worker、调用 reconcile 或创建可触发审查的真实 MR/Note**；先由现场管理员记录脱敏回执。Legacy 在线服务继续沿用原配置，不得为了测试 Sensor 停止或切换它。
4. 需要执行真实 Review 时，单独确认授权的模型/额度、项目 Bot 非 Required/无 Merge 权限、备份/回滚和现场维护窗口，再遵循下文 Advisory 验收；这不包含在当前无模型预检范围。

这是一项**操作边界**，而不是产品内新增的强制无模型开关。即使将示例字段设为 false，也不能把正在运行的 Review 服务视作被技术隔离的无模型沙箱。

## 单人维护分级验收：建议先 Advisory，再启用权威合并门禁

**阶段 A：只做非强制的审查建议。** 允许在已有准确的产品 Release/运行时测试、每实例密钥与物理隔离、旧 SQLite 在线备份和迁移回滚、唯一 Writer、Webhook 路由/签名/重放与真实 GitLab 双端只读+写入沙箱 MR 验收之后，以非强制 Advisory 方式逐步接入新 Sensor。此模式必须由项目管理员在每台 GitLab 实际核验并保存设置证据：机器人状态不在 Required/Must-pass 合并检查内，服务没有任何自动 Merge/Approve 权限，所有 `mergeAuthorized:false` 和 `refTransactionBound:false` 保持诚实，任何延迟/未知写入只作为待核对观察结果而不是允许合并的授权。若无法证明非强制性，则**禁止以 Advisory 名义上线并提供合并门禁**。

**阶段 B：允许权威合并或强制 Required status。** 只有在 [#114](https://github.com/jiying2007/codex-review-service/issues/114) 的 GitLab 服务端精确 ref/代次事务 fence 实际实现并通过竞态/断连/延迟 ACK/恢复测试、且生产 GitLab 项目已验收后，才能将机器人判断用于 merge authorization 或 Required status。单次 GET、普通 CI 绿色和本地 mock 不足以达到阶段 B。

两个阶段都要遵守 Secret 不入仓、同旧 DB 仅一名 Writer、真实迁移前备份、可验证回滚、不可变发行 SHA/OCI digest；**阶段 A 不需要为不存在的第二名 Reviewer 设永久阻断**，但也不能把未绑定的审查意见升级为强制合并权。生产机器/网络/凭据和新 GitLab 实际 MR 设置均不可由 GitHub 仓库代码读取冒充验收；没有管理员现场证明时维持 Draft/未部署。

## 准备（不操作运行中的旧容器）

1. 首先取得精确最终 HEAD 的真实 PR `CI Gate`、完整受支持 Node 22/24 与 GitLab Provider/安全资格、正式不可变 Release 和 OCI 镜像 digest。**单人维护不强制第二名人工 Reviewer**；维护者可以在自动化证据真实通过后合并，但不得以自审伪造独立 reviewer 或跳过生产 Publisher 验证。CodeQL 分析与 SARIF 门禁须实际成功；仪表盘上传能力单独记录，绝不伪造 CodeQL PASS。验证镜像包含 src/multi-gitlab* 和新入口。旧 v7.6.1 image 不包含，绝不能用于本模式。
2. 在 192.168.1.22 用 docker inspect 检查旧容器实际状态卷、Codex Home 卷和配置。使用现有 admin backup/backup-verify 完成一致性备份，保留原版本及 Compose 文件。禁止在旧实例运行时粗暴复制 WAL/SQLite 文件。
3. 将真正的 /opt/codex-review-service/config.json 另存为候选 legacy.json，保留所有旧 Project、Group 48、触发规则、企业微信/飞书、Codex 模型策略等有效设置；只按新容器内部的真实路径设置 server.dataDir 为 /var/lib/codex-review/legacy、codex.home 为 /home/codex-review/legacy。不要用模板覆盖原配置。
4. 根据 deploy/docker/sensor.config.example.json 创建 sensor.json（Config Schema 8），指向 http://192.168.2.50、projects [113]、独立数据目录 /var/lib/codex-review/sensor 与 Home。Webhook expectedInstance 与该 GitLab 的真实 origin 相同。通知先禁用。
5. 将 multi-instance.example.json 复制为 multi-instance.json。配置四个分离的受控 GitLab API/Webhook 文件。Compose 只接收秘密文件的路径环境变量，禁止任何 Secret 明文进入 git、配置仓库、Shell 历史、命令参数或聊天。按最小权限配置 API Token，必须能读新项目并在真实 MR 写入 Note/Discussion/Commit Status。
6. 按 deploy/docker/compose.multi.yaml 准备 Docker 环境。CODEX_REVIEW_IMAGE_DIGEST 必须是已发行且验证可追溯的完整 64 位十六进制 digest 值（不含 sha256: 前缀）；Compose 镜像硬绑定 ghcr.io/jiying2007/codex-review-service@sha256:<该摘要>，不接受可变 tag；CODEX_REVIEW_LEGACY_STATE_VOLUME 与 CODEX_REVIEW_LEGACY_HOME_VOLUME 必须指向已经存在的旧命名卷，Compose 标为 external，不允许自动创建一个空卷替代。其他两个 sensor 卷新建。先运行以下只读校验，不启动重复旧 Writer：

       docker compose -f compose.multi.yaml config --quiet
       ss -ltnp | grep -E ':(8787|8788)' || true

**只读预检（不会启动服务/模型，也不调用 Codex）：**

       CODEX_REVIEW_MULTI_CONFIG_FILE=/etc/codex-review/multi-instance.json node src/multi-gitlab-preflight.js

预检首先以每个实例的独立 Token 只读访问 GitLab /api/v4/user 并验证有效数值 User ID（**因为公开 /projects/:id 返回 200 并不能证明 Token 有效**），随后读取 /api/v4/version、显式 /api/v4/projects/:id 与 /api/v4/groups/:id；输出只包含实例 ID、版本、认证布尔值和已验证项目/组数量，不输出 Token、用户身份详情。返回 ok=true 仍**不能证明** GitLab 写入权限、Webhook 反向访问、真实 MR 审查成功，也不能代替正式 CI 与发布资格。运行命令的系统必须具备与部署相同的配置/Secret 文件挂载。

**隔离管理（选择唯一实例，不能跨实例查询 DB）：**

       CODEX_REVIEW_MULTI_CONFIG_FILE=/etc/codex-review/multi-instance.json node src/multi-gitlab-admin.js legacy status
       CODEX_REVIEW_MULTI_CONFIG_FILE=/etc/codex-review/multi-instance.json node src/multi-gitlab-admin.js sensor db-check

备份、drain、notifications、reconcile 等仍使用已有 admin 命令，但必须显式指定实例；正式上线时用现有配置的受控路径操作。禁止用同一个数据目录执行双实例 admin 写操作，且在共享 Codex/Work 额度限制未明确解除前，不触发任何可能调用模型的 reconcile、Review 或可执行 Codex 的后台 Worker。

**镜像能力预检：** IMAGE 必须是通过验签的真实 digest，并在不启动应用的前提下，确认镜像包含本功能：

       docker run --rm --entrypoint node "ghcr.io/jiying2007/codex-review-service@sha256:${CODEX_REVIEW_IMAGE_DIGEST}" -e "require('./src/multi-gitlab-config');require('./src/multi-gitlab-gateway');require('./src/multi-gitlab')"

旧 v7.6.1/v7.6.2 镜像会因缺少模块而非零退出；即使能力检查通过，也不能替代目标新发行版本的真实 SHA/digest、SBOM、GitLab 真机和独立完整性验收。单人维护不要求虚构第二人批准。

容器内部单个 HTTP 端口继续为 8787；主机若使用 8788 进行其他隔离验证，只修改 CODEX_REVIEW_PORT 映射，不必修改每个实例 Config Schema 的 server.port。默认 Compose 只绑定本机 127.0.0.1；反向代理需要接收 GitLab 外部回调，推荐可信 HTTPS 入口及源地址限制。网页登录 200 不证明 API Token 有权限，也不证明新 GitLab 能反向访问 Webhook。

## 数据库切换只读门禁（候选新增）

新 CLI `node src/multi-gitlab-cutover-check.js` 只读打开每台 GitLab 的 `review-service.sqlite`，不调用 `Store()`、不触发迁移、恢复、Webhook、Codex 或外部请求；检查当前 Service 的 DB Schema、SQLite quick_check/foreign_key_check、Review Job 非终态、Publication/Notification Outbox 未投递任务以及状态写入的 `started/uncertain`。任一实例有待处理任务或任何状态结果不确定，则整体返回非零并报告实例级阻断。

    CODEX_REVIEW_MULTI_CONFIG_FILE=/etc/codex-review/multi-instance.json node src/multi-gitlab-cutover-check.js

**启动期强制检查**：多实例进程在打开公共 HTTP 入口以及启动任何 GitLab Worker 之前，会调用同一只读检查器，要求**每个实例**已经具备完整且与当前产品一致的数据库 Schema；如果缺失、损坏或仍为旧 Schema 9，直接报 `EMULTIDBPREP`，不让新服务自动迁移旧数据库。正常崩溃恢复若数据库 Schema 已准备完成而队列非空，仍允许原有 durable recovery 接管，避免遗失待处理任务。首次切换依然要求人工在停止旧 Writer 后确认队列已排空，自动启动门禁不代表能自动识别其它进程是否还在写同一卷。

**这不是数据库锁或备份**：即使返回 READY，旧进程也可能继续收到 Webhook、reconcile 或 Outbox 写入。因此操作前必须实际排空、暂停入口、停止原 Writer 并完成 SQLite 在线一致性备份。对于现场确认仍为 Schema 9 的旧数据库，升级到 **v7.7.1 / Schema 12** 时，只读检查会明确返回 `EDBSCHEMA`；必须在经过验证的受控副本中进行 **9 → 10 → 11 → 12** 三段迁移，不能修改 JSON、关闭检查或让两个 Writer 并行操作活库。应在停旧实例并保存不可变备份后，用有版本资格的升级程序在**受控复制数据库**上完成正式迁移、`backup-verify` 与读写边界核验，再将经验证的数据放入新实例的独立卷，并重新执行只读门禁。新 Sensor 的空库必须在**隔离暂存环境**中使用经过验证且已正式发行的 v7.7.1 镜像和 Sensor 专属配置、密钥，由正式单实例 Storage 初始化/迁移，再独立执行只读 `multi-gitlab-cutover-check.js` 验证。特别注意：**v7.6.4 起 `src/admin-cli.js db-check` 在 `openStore()` 之前只读校验数据库，拒绝缺失/旧 Schema，不执行自动迁移**；绝不能在仍由旧 Writer 使用的卷上运行它，也不能拿它对活库做只读预检。在旧 v7.6.3 和更早版本，`admin-cli db-check` 仍可能打开 Store 并迁移数据库，因此**现场不得对旧版本活库执行该命令**；新版本通过正式测试后可以使用其只读 `db-check`，而跨实例验收仍优先用完全不构造 Store 的 `multi-gitlab-cutover-check.js`。 真正无副作用的检查使用 `src/multi-gitlab-cutover-check.js`，并要求预建 Schema 12 DB 后通过检查。不能继承 Legacy Token、Webhook 密钥或 Codex Home；任何缺失 DB 不代表已验收。

**不要使用 `src/multi-gitlab-admin.js` 来创建或迁移数据库。** 该命令现会先只读检查目标 SQLite 的当前 Schema 与完整性，拒绝 Schema 9、缺失 DB 或腐坏状态；只有在明确隔离的**受控暂存副本**中才允许使用正式单实例 Admin 的建库/迁移能力。旧 Legacy 迁移亦必须在停止旧 Writer、持有验证过的在线备份后，使用暂存副本升级至 Schema 12，并核对反向回滚备份是否可读后，再接入多实例入口。

如果修复 #114 的最终引用/发布事务栅栏尚未得到认可，`status_write_attempts` / `status_publication_targets` 的不确定远端效果仍必须由正式 Recovery 验收独立解决；本门禁只能拒绝**数据库显式记录**的不确定项，不能代替 GitLab 服务端原生原子 CAS 资格。

## 正式切换步骤（需要主机管理员与维护窗口）

不可在旧单实例容器写旧 SQLite 的同时启动读取相同卷的新 Legacy Worker。即使旧 Webhook 暂停，旧进程的周期 reconcile / outbox 也可能写 DB，因此必须先 drain、备份并停止原容器。若 sensor 之前已经由独立 8788 服务运行，也需要先停、排空并备份其数据库卷。

1. 先验证真实的新 GitLab API 鉴权、版本兼容与反向网络，再确认所有配置、卷、Secret、镜像/签名及资源容量；共享 Codex/Work 额度禁令未明确解除前，禁止任何会消耗该额度的模型审查或真实 Codex CLI/Cloud/Work 任务，只允许独立的只读/合成数据预检。
2. 排空旧实例审查与 Publication/Notification Outbox，验证在线备份；暂停写入并停止旧容器，在受控维护窗口启动新多实例容器。旧原始配置、原镜像和备份保持不变。
3. 检查 /health/live、/health/ready、/health/dependencies、/instances/legacy/health/ready、/instances/sensor/health/dependencies、/version、/metrics。任一实例异常时先修复，不把其他实例被动判为成功。每实例完整指标位于 /instances/<id>/metrics。
4. 旧 GitLab 仍发到原入口 192.168.1.22:8787/webhooks/gitlab；新 sensor Webhook 发到统一入口 192.168.1.22:8787/webhooks/gitlab/sensor。启用 Merge request events 和 Note events，用新服务器独立密钥与实际 GitLab webhook auth profile；先验证签名、错误签名拒绝、重放和路由。
5. 只有模型调用额度禁令明确解除且获准后，才分别对旧、新 GitLab 的可丢弃 MR 做真实模型审查验收：状态更新、Summary、Discussion、推送新 SHA 后重审、重复 Webhook 去重、Project ID 113 不交叉、独立通知、GitLab Server 中断和恢复、CPU/内存与队列预算。不能把 webhook 202 等同于审查成功。
6. 任一门禁失败，停止多实例与新 Webhook，保留数据一致性证据；如未发生任何 DB schema 迁移可在确认旧镜像仍能读取旧 DB 后恢复原单实例。若 Schema 12 已造成数据库升级，则必须恢复经验证的迁移前备份，不可强行使用旧镜像打开新版数据库。

## 发布与资源边界

- 新功能独立于现有 Service PR #113 及 Issue #114 的权威 Git ref 事务保护；不得对未通过的 CI、暂缺私有 Ruleset entitlement、未验证的部署回执造假。
- Worker 独立保留旧任务队列、重试、API 限流、Token 预算、通知/告警；单容器总 CPU/RSS 是各 Worker 累计值，须独立容量审查与监控。健康检查为保守的聚合 fail-closed，但单个 GitLab 宕机不能使另一台 GitLab 的合法 Webhook 停止服务。
- 无需整体 SQL Schema 改写即可在同一个 OS 服务进程内支持多个 GitLab；物理 DB 独立也意味着按不同版本执行 DB Schema 迁移和备份，不能让两个服务指向同一个 dbPath。
- 该运行手册定义 v7.7.1 发行并验收后可采用的人工切换与回滚步骤，**不宣称**生产主机已部署。自动模型审查须在共享 Codex/Work 额度禁令明确解除、真实账户权限与资金来源确认后才能启用和验收。

## v7.6.3/v7.6.4 历史代码资格与 v7.7.1 新版发行要求

在独立维护仓库中，普通 PR 保持轻量 Node24 + Docker + 恢复 + 依赖审查；但以 `port/` 开头的高风险候选 PR 将额外触发 Node22、Linux/Windows/macOS 数据库迁移兼容矩阵、故障注入，以及 GitLab CE 14.6.1/17.11.7/19.3.0 的**真实临时本地 Provider 环境**。此时使用的是 GitHub Actions 的一次性 GitLab 容器和测试令牌，不调用在线 Codex/ChatGPT 模型，不访问 `192.168.1.4` 或 `192.168.2.50` 内网实例，也不触碰旧生产 SQLite 卷。CI Gate 必须对所有实际运行的工作作业 fail closed，不能把某一个作业绿灯当作矩阵完成。

安全与 Family 跨仓 Secret 只在主线检查/实际 Release 中使用，不对候选 PR 暴露。原 Schema 12 + 多 GitLab 代码已通过 [PR #133](https://github.com/jiying2007/codex-review-service/pull/133) 高风险矩阵并合并为 `ba734330be8eb2909ef668aa38b7edfc63abad42`；[v7.6.3 正式发行](https://github.com/jiying2007/codex-review-service/releases/tag/v7.6.3) 的主线 CI、OCI、SBOM、不可变资产与独立 Release Integrity 均成功。**这些证据只能证明代码与发行资格，不能证明内网 GitLab 的实际权限、网络、Webhook、状态回写、备份及回滚通过。** 运行时仍只在显式提供合法多实例清单时启用；不允许把 GitHub 发行自动等同内网生产切换。


### 7.7.0 接纳、容量与调用用量

Webhook 去重、Review 入队、Flow 与通知意图在同一个 SQLite 事务中提交；HTTP 202 只在提交后返回。新版本启动前先取得状态库侧车的 OS 排他锁，第二个 Controller 不会先恢复或迁移数据库；不要删除正在使用的 `.controller-lock.sqlite` 文件。Runner 固定执行容量为 1，超出容量明确返回 503，Controller 会按能力收敛 worker 数。

Schema 12 的 `model_calls` 在每次模型调用前持久化意图，并保留失败、取消及过期任务已经观测到的用量。未知用量单列，不能当作零；进程中断时未完成的调用保留 unknown，任务记为 `EMODELCALLUNCERTAIN`，不会自动重跑。通过 `node src/admin-cli.js model-calls` 查看调用账本，人工确认 provider 状态后才提交新的显式 review 命令，旧记录保留。升级先停止原 Writer、备份并验证；回退保留当前调用及发布账本，并使用匹配旧版本的 Schema 11 备份。以上确定性回归不代表两台内网 GitLab 已完成生产验收。
