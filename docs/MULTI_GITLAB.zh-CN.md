# 单进程多 GitLab：Legacy + Sensor 上线与回滚

本指南适用于 native multi-GitLab 候选分支。现有 Service 7.6.1 镜像不包含此功能，绝不能直接将旧实例切换为多实例模式；本文件也不表示已经在 192.168.1.22 部署或验证成功。

## 结构与身份隔离

一个 Node.js 主进程 + 一条 HTTP 入口 + 多个 Worker Threads；每台 GitLab 各自保留独立的 GitLab Client、项目/Group Scope、限流/断路器、审查/Publication/Notification Outbox、SQLite DB、API Token、Webhook Secret 与 Codex Home。

- legacy: GitLab 192.168.1.4；保留原 /webhooks/gitlab 路径；项目包括原 78 个显式/Group 项目。旧 GitLab 的 Project ID 113 为 vosen/toolchain/ssc305，旧 sensor 是 139。
- sensor: GitLab 192.168.2.50；新 /webhooks/gitlab/sensor 路径；只允许 Project ID 113，对应 airobot/modules/sensor。
- 持久身份逻辑上是 (instanceId, 独立 SQLite DB, project_id, mr_iid, commit_sha)。两台 GitLab 的 Project ID、User ID、状态、回写凭证、通知路由不得相互复用。避免侵入式改动全部 SQLite 表/迁移所有线上数据，使用物理数据库命名空间实现隔离。
- 单 GitLab 原入口、直接 CODEX_REVIEW_CONFIG_FILE 配置和旧 Schema 8 保持不变。只有显式设置 CODEX_REVIEW_MULTI_CONFIG_FILE 时才启动多实例入口。

## 凭据与安全

多实例清单使用 deploy/docker/multi-instance.example.json。每个实例都明确声明 configFile、homeDir、GitLab API Token 与 Webhook Secret 的 *_FILE 文件绝对路径，API 与 Webhook Secret 都不允许两实例共享文件或相同实际内容。配置检查读取受控凭据进行内存摘要比较，不打印凭据值。Worker Thread 仅接收所属实例的文件路径及有限环境变量，不继承宿主旧 API Token、OpenAI API Key 或另一实例的明文。

HTTP 路由只决定内部 Worker，不能代替安全认证。每个 Worker 独立进行原始请求 Webhook 签名、GitLab Instance、项目 allowlist、重放与配额校验。错误实例、错误签名、未知路径按实际校验拒绝。旧 GitLab Classic Token 模式仍兼容缺少 X-Gitlab-Instance 的老版本；如果传了实例头则必须匹配。Standard Webhooks HMAC 必须携带合法实例头和签名。

sensor.config.example.json 默认 review.triggerAssignment = always、projects = [113]、groups = []，notifications.enabled = false。always 仅取消用户指派过滤，不能越过项目白名单、签名、Bot 自触发等安全规则。原 Legacy assignee 用户 ID 8 不应复制给 sensor；若需要新服务器按人员触发，请重新查询新服务器的用户 ID。飞书/企业微信路由和用户身份映射也应单独审核。

## 准备（不操作运行中的旧容器）

1. 首先取得受保护 PR 的独立审核、完整 Node 22/24 与 GitLab/CodeQL CI、可信 release 与 OCI 镜像 digest。验证镜像包含 src/multi-gitlab* 和新入口。现有 7.6.1 image 不包含，绝对不能用于本模式。私有 Service 当前 Actions Runner 如果没有运行 job steps，不能把失败/跳过算成通过。
2. 在 192.168.1.22 用 docker inspect 检查旧容器实际状态卷、Codex Home 卷和配置。使用现有 admin backup/backup-verify 完成一致性备份，保留原版本及 Compose 文件。禁止在旧实例运行时粗暴复制 WAL/SQLite 文件。
3. 将真正的 /opt/codex-review-service/config.json 另存为候选 legacy.json，保留所有旧 Project、Group 48、触发规则、企业微信/飞书、Codex 模型策略等有效设置；只按新容器内部的真实路径设置 server.dataDir 为 /var/lib/codex-review/legacy、codex.home 为 /home/codex-review/legacy。不要用模板覆盖原配置。
4. 根据 deploy/docker/sensor.config.example.json 创建 sensor.json（Config Schema 8），指向 http://192.168.2.50、projects [113]、独立数据目录 /var/lib/codex-review/sensor 与 Home。Webhook expectedInstance 与该 GitLab 的真实 origin 相同。通知先禁用。
5. 将 multi-instance.example.json 复制为 multi-instance.json。配置四个分离的受控 GitLab API/Webhook 文件。Compose 只接收秘密文件的路径环境变量，禁止任何 Secret 明文进入 git、配置仓库、Shell 历史、命令参数或聊天。按最小权限配置 API Token，必须能读新项目并在真实 MR 写入 Note/Discussion/Commit Status。
6. 按 deploy/docker/compose.multi.yaml 准备 Docker 环境。CODEX_REVIEW_IMAGE 必须是已发行且证明可核验的完整 @sha256 digest；CODEX_REVIEW_LEGACY_STATE_VOLUME 与 CODEX_REVIEW_LEGACY_HOME_VOLUME 必须指向已经存在的旧命名卷，Compose 标为 external，不允许自动创建一个空卷替代。其他两个 sensor 卷新建。先运行以下只读校验，不启动重复旧 Writer：

       docker compose -f compose.multi.yaml config --quiet
       ss -ltnp | grep -E ':(8787|8788)' || true

容器内部单个 HTTP 端口继续为 8787；主机若使用 8788 进行其他隔离验证，只修改 CODEX_REVIEW_PORT 映射，不必修改每个实例 Config Schema 的 server.port。默认 Compose 只绑定本机 127.0.0.1；反向代理需要接收 GitLab 外部回调，推荐可信 HTTPS 入口及源地址限制。网页登录 200 不证明 API Token 有权限，也不证明新 GitLab 能反向访问 Webhook。

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
