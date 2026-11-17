# V8 运行时审查修复与验收边界

## 更正既有审查结论

V8.0.0 的不可变发行和独立 Release Integrity 已实际完成，精确源码为 ca9fa890aab1478cbe30976de0f26a34bcfaacf2。PR 作业按设计跳过的主线资格项，不等于后续主线资格没有执行。生产入口 src/index.js 已安装 installFairScheduling；不能仅看 Store 默认 FIFO 实现就声称生产没有公平调度。

## 本轮实现

- 队列年龄查询失败、缺失结果或非法时间戳使指标请求失败，不再输出健康的零；空队列的真实 SQL NULL 仍输出零。
- 仓库历史总数走现有项目索引，排队/运行统计只读取活动任务；保留范围上限、UTC 日期边界、未知 Token 和指标完整性语义，不进行数据库迁移。
- Edge 拒绝不同实例共享同一明确 host:port，拒绝目标映射额外字段和继承属性；DNS 别名仍须由真实 mTLS/VPN 信任验证，字符串校验不证明远端身份。
- 上游观测具备总时间上限、字节上限、完整响应及 UTF-8 验证；并发管理请求合并正在进行的读取，不跨后续请求保留成功状态。
- 已有公平调度移除窗口排序和每次领取时的重复历史扫描，保留同 MR 并发栅栏、仓库轮转和重启相对公平性；事务提交失败不推进本地轮转。
- 独立事件驱动 Metrics Query Benchmark 对 1 万、10 万、100 万行合成数据执行七组交错成对测量，校验逐项目结果完全一致，留存原始样本、源码摘要与输入归档。没有新增周期巡检和模型调用。

## 性能证据的适用范围

运行 node scripts/benchmark-repository-metrics.js --output report.json。报告中的 productionQualified、webhookLatencyMeasured 和 fullServiceScrapeMeasured 均为 false。局部 SQL 改善不能等同于全服务首轮采集、真实 Webhook P95/P99 或生产 SLO 达标。首次完整采集仍包含 Store.stats()，仍须使用现场数据与流量单独验收；不要把源码优化当作生产测试完成。

## 生产验收仍须真实取证

公网代理仅开放 POST /webhooks/gitlab/<instance-id>；裸入口必须 404。管理读接口只允许受认证的管理网络。跨主机连接必须验证 TLS 对端身份或受控 VPN，不能因目标是私有别名就跳过验证。每个实例必须有独立凭据、数据库与唯一 Writer；切换前 drain、备份、验证恢复和原镜像回滚。不要在没有现场执行通道时关闭 Issue #115。

保持 Advisory，直到 Issue #114 的最终服务端 Ref 约束得到真实验证。不将 CI、不可变发行或本地 receipt 当成强制合并授权。没有明确允许的独立模型后端时，不运行真实质量 A/B、不消耗 Codex/ChatGPT Work 额度，也不伪造质量提升或 Token 节省。
