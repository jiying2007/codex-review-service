# Codex Review 覆盖率与低成本深度审查

## v7.7.11：不可信 Diff 拒绝错误行锚

- 精确固定已发布的 Safe Core 4.18.10：任一 Unified Diff Hunk 长度、坐标或顺序出现矛盾，则整个 MR Diff 不产生 `anchor_verified`；高风险 Finding 保留并标记证据不完整，不自动抑制或删除。
- 函数影响中的候选调用仅来自源码文件，不把 Markdown 等自然语言误当作实际调用；仍不声称词法匹配等于编译器解析。
- 离线 Benchmark 输出使用真实数据集摘要；真实召回率、误报率和 Token 改善必须通过额外受控 Holdout 评测，不以静态测试冒充。


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


## 第二轮覆盖与成本收敛（2026-11-16 候选）

- Coverage Ledger 不再将筛选前的 scheduledChangedLines/scheduledChunks/scheduledEvidenceUnits 拼接到筛选后的字段上。预算选块之后与模型执行结束之后均调用同一个纯函数重建全部计划、调度、完成计数；保留原始 plannedEvidenceUnits 作为独立基线。对无模型结果、部分 Chunk 和未知预算结果仍保持 incomplete。
- Impact 取证对 Tree 未分页完成、超过 20,000 节点、超过 64 个正向候选、原始源码缺失/读取异常、文件超长或图证据预算截断，明确输出 bounded degradationReasons；相应 Advisory 进入 Review 证据摘要，不得报告完整依赖覆盖。
- 可选静态报告缺失、Test Impact 退化只形成明确 Advisory；required 的报告继续阻断。普通上下文缺失不自动扩大安全门禁，不把 Advisory 冒充已验证的缺陷。
- Finding 候选量在 **MR 级**分配；默认总量最多约为最终 maxFindings 的 1.5 倍（为每个 Chunk 最少提供一个候选位置时允许超过该比例），不再给每个高风险 Chunk 独立膨胀至 18 条。分配遵循风险加权且有上界，最终展示仍受 maxFindings/maxPublishedFindings 限制。
- 仅在单次 Job 中缓存精确 (projectId, refSHA, path) 原始文件读取，默认最多 48 个条目、1 MiB 总量、96 KiB/文件。超限、不存在或读取失败不写入缓存；不持久化源码或共享不同 Review Job / GitLab 实例的结果。
- Finding line 不接受小数/字符串取整，endLine 必须是同侧当前 Chunk 真实变更行，禁止跨块或任意补全出虚假的代码范围。

### 新增离线回归

~~~bash
node --test test/review-coverage.test.js test/impact-completeness.test.js test/quality-degradation.test.js test/source-cache.test.js test/cost-planner.test.js test/review.test.js
npm run ci
~~~

真实模型 A/B 缺陷召回、误报率、Token/有效 Finding、p50/p95 延迟仍需要显式批准的模型额度与可复现实测数据；上述离线测试不会调用模型，不能据此声称实测成本下降。正式部署仍需不可变 Core Release、Service 精确 Pin、新版 Service Release/完整性验证以及现场 SQLite 备份、唯一 Writer 和可执行回滚。不得修改现有生产 7.6.1 数据库或直接启动 Sensor 的模型审查。

## v7.7.8：吸收 OpenCodeReview 的确定性方法

本轮复用精确固定的 Safe Core 4.18.8（不引入外部 Go 运行时依赖）：

1. **Semantic Review Group**：按实现/头文件/测试、变更 include/import 和相邻语义身份将相关文件排列在同一 Review Group。分组不消耗模型调用、不排除文件，也不改变 Hunk 行号。组预算不足仍交给 Core Chunk Planner，并保留显式覆盖缺口。
2. **Scoped Review Rules**：针对每个 Chunk 的文件选取至多三个可信规则（OTA、FOC、电机、MCU ISR/DMA、驱动、接口、CI、配置、翻译和测试）。仓库路径和源码始终是非可信选择器，规则不能覆盖 Safe Contract、权限、结果 Schema、行号锚点。
3. **Review Preview**：开发侧零模型、零 GitLab API 入口，只接收显式 MR/Diff/Policy fixture，输出计划/排除状态、组、Chunk 和覆盖缺口，不表示实际已运行模型。
4. **Conservative Claim Audit**：显式的缺失字面量与同文件新增代码冲突时，只报告事实冲突 Advisory；所有 Finding 均保留，安全/并发/资源/API 高风险 Finding 绝不自动删除。不额外调用 Review 模型。

离线预览命令：

~~~bash
node scripts/review-preview.js < /tmp/review-fixture.json
~~~

fixture 需显式包含 GitLab 格式的 mr、diffResult:{complete,items} 与实际 policy；本命令不读取生产凭据、不操作数据库、不启动 Worker。

外部质量评测：使用 Core 的 scripts/review-quality-compare.js 对已经产生的标准化结果进行同语料、同模型、同 Provider、同预算对照。仅能报告实测结果，静态单测不证明 AACR-Bench 真实召回率或 Token 优化。不得照搬 OCR 默认排除大量测试文件、额外 LLM 分组或无限 Agent 循环。

v7.7.8 源码接入后，Core/Service 的精确不可变发行及生产现场验收仍为独立门禁，不能因为通过 PR CI 就宣称线上已部署。

## v7.7.9：有界函数证据与真实 Finding 行锚核验

- 使用已通过受保护 CI 和不可变 Release 的 Safe Core 4.18.9。`buildFunctionImpactEvidence` 仅从目标 MR 精确 HEAD 的候选源码构造词法调用关系，携带函数名、文件、原始行号、source SHA、置信度与读取截断原因；**不声称编译器/Tree-sitter 已完成跨模块指针调用解析**。
- `buildReviewRiskEvidence` 只按 GitLab changed-line 识别 ISR 阻塞调用、OTA Flash 修改、C 字符串复制、CI 信任边界和危险配置等证据，默认只是 Reviewer 提示，不创建 deterministic blocker，也不自动多调用模型。
- `qualityContextForChunk` 对词法调用证据和风险提示按当前 Chunk 文件及其真实 new-side 变更行筛选，并受现有 32 KiB 质量上下文预算限制，报告裁剪结果；质量退化保持可观测。
- `verifyFindingEvidence` 在 Review Service 输出最终 Review Receipt 前重新核对原始 GitLab MR Diff 的路径、old/new 侧及起止行。无法核对或与明确的证据摘要冲突，则 Verdict 为 `incomplete`，不删除 High/Critical Finding。Anchor verified **不是 semantic defect confirmed**。
- Evidence Manifest 另纳入风险证据摘要与原有 Impact 内容（含函数候选），避免不同质量上下文共享同一历史判断身份。

### 外部评测（不调用模型）

Core `scripts/review-benchmark-import.js` 通过本地已有的 ReviewBench golden 或 AACR-Bench 规范化 ReviewInstance 创建带 SHA/标签来源的 `quality/corpus.json` 兼容数据。ReviewBench 仅导入 `tp_fp=tp` 的 `introduced-by-pr` 记录；AACR 必须有独立人工认可的缺陷标签。缺少实际正例的 PR 不得当作 Clean Negative。与模型运行结果的比较仍通过 `scripts/review-quality-compare.js` 的相同模型/Provider/预算基线完成。

新增八个嵌入式结构化假设测试，包括 Clean Negative，**不是实际 Recall/Precision 评测结果**。若未取得模型额度，禁止通过真实 Reviewer 或生产 GitLab 运行对照实验。

生产部署依然是独立门禁：不得直接替换旧 7.6.1 内网容器，不得未经现场 SQLite 一致性备份/回滚验收启用 Sensor Worker。
