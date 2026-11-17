# 多 GitLab 扩容与统一运维（V8，显式实例制）

支持 1–16 个明确命名的 GitLab 实例，每个实例可独立部署在不同服务器，服务自己的 Project/Group 白名单。统一 Edge 只做固定目标路由与管理读接口，所有实例身份来源于只读 Catalog Schema 2 / targets.json。**没有 Legacy 回退路由**、自动迁移或默认实例。

## 部署模式

单 GitLab 容器使用 deploy/docker/compose.instance.yaml；统一入口使用 deploy/docker/compose.sharded.yaml。每台主机保留独立 SQLite Writer、外部已核验数据卷、密钥和模型资源配额。Edge 专用私有网络只解析指定 ID 对应的受信 mTLS/VPN 隧道或本地 Docker 服务别名，不接收任意远端地址。

~~~bash
node src/sharded-catalog.js primary=/etc/codex-review/primary.json sensor=/etc/codex-review/sensor.json > /etc/codex-review/catalog.json
node src/sharded-deploy-check.js /etc/codex-review/catalog.json /etc/codex-review/targets.json
~~~

~~~json
{"primary":{"host":"primary","port":8787},"sensor":{"host":"sensor","port":8787}}
~~~

多实例共享进程模式如需使用，必须显式准备 Manifest Schema 2，且不具备跨进程硬隔离。推荐独立进程方案，不为每个仓库启动新 Service。

## 运维检查清单

1. 每个 instanceId 都有独立受控 Config Schema 8、Token 和真实 GitLab Origin。仓库键 instanceId:projectId 不会跨实例冲突。
2. Webhook 一律指向 POST /webhooks/gitlab/<instance-id>。裸 POST /webhooks/gitlab 必须返回 404。后端仍需要验证原始签名。
3. GET /repositories/status 只说明配置/本地指标可见，不等于远端 Project 已授权。历史任务为零和指标缺失必须区分。
4. 监控 Prometheus 实例 up、queue age、status uncertain、metrics completeness、retained Token Gauge，不把 missing metric 当 0。
5. 模型消费以已知和未知用量共同衡量；质量—Token benchmark 不能替代真实 MR Head 绑定验收。

切换前必须检查发行 OCI digest、唯一 Writer、未完成事务及回滚备份。没有现场网络/数据库访问时只能标记代码就绪，**不能宣称生产上线**。
