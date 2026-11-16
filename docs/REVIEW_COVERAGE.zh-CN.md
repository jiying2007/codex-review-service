# Codex Review 覆盖率与低成本深度审查

## 五种不同的覆盖证据

1. Provider completeness：验证 GitLab Classic overflow=false 或 Modern 分页与 versions.real_size，证明从 GitLab 枚举完整，不等同于模型审查完整。
2. Diff coverage：已准入的文本文件与变更行需要逐项映射到待审 Chunk。策略排除、二进制和 rename-only 必须单独记录。
3. Model coverage：仅当模型实际完成该 Chunk 的结构化审核，才算其变更行完成审查。预算中断、失败或未执行不能冒充完成。
4. Context coverage：统计精确 SOURCE_HEAD / TARGET_START 的源码窗口请求、完成与遗漏；文件数、字节数、网络或缺文件都要说明原因。
5. Semantic / analyzer evidence：每个 Chunk 获取相关的 Profile、依赖影响、CI Analyzer 与 Test Impact 推荐。测试推荐不意味着已执行；模型完整推理也不意味着 100% 缺陷召回。

## 本次实现

- src/review.js 按每个 Chunk 的真实 Diff 计算合法 Finding old/new 行号，拒绝引用不在本块中的变更行。
- Safe Core context-builder.js 把可安全分割的大 Hunk 按完整 Diff 行切段，重算行号，保留 No newline 标记；真正超长单行继续留下覆盖缺口。该项需要 Core 正式 Release 和 Service 的精确 SHA Pin 后才可成为集成能力。
- src/service.js 区分覆盖规划 coverageLedger 和实际成功返回的 modelCoverage，不把计划当执行。
- src/context.js 逐项记录缺失的上下文窗口，结果只包含路径、方向和分类原因，不携带原始错误与凭据。
- src/quality.js 向对应 Chunk 注入相关依赖证据和静态分析；通用 Profile 压缩重复上下文，高风险工程 Profile 保留完整检查点。
- src/cost-planner.js 通过有限的风险加权避免高风险 Chunk 的 Finding 输出配额被平均稀释，且不突破全局 maxFindings。
- 发现输出达到单块上限时报告 finding_capacity_saturated，不自动触发无限补审或消耗额外模型额度。

## 低成本离线回归

~~~bash
npm run precheck
node --test test/review.test.js test/context.test.js test/cost-planner.test.js test/quality-chunk.test.js test/review-coverage.test.js
npm run ci
~~~

测试不调用真实 Codex/OpenAI 模型，也不访问生产 GitLab。Safe Core 同时执行 node --test test/context-policy.test.js 及 npm run ci。

## 质量与成本验收口径

固定保留集应覆盖多文件、大 Hunk、中文与 Git C-quoted 文件名、++/-- 代码行、跨文件接口、MCU ISR/DMA、OTA/掉电、Linux 驱动生命周期、权限/资源泄露、无缺陷对照。每条测试记录真实标签、精确 SHA、缺陷行号和严重性。

- 结构目标：每条支持的文本变更行有实际规划记录或明确遗漏原因；二进制、策略排除与元数据变更不能计入模型文本覆盖率。
- 质量指标：critical/high recall、precision、false-positive/review、invalid-line rate、token/true-positive 和 p50/p95 延迟。必须与相同模型、相同样本集、同样预算的 Baseline 比较。
- 成本：现有 MR Token Budget、项目预算与未决模型调用账本不放宽；只有明确批准真实模型额度后才进行真实效果 A/B，不得以 mock 通过宣称模型缺陷召回提升。
- 安全：开发源码更新不等于 GitLab 生产主机升级；当前 7.6.1 生产容器及旧数据库不能由本次 PR 自动切换。
