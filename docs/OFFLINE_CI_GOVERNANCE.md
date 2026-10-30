# Portable offline CI and independent release admission

**Status: opt-in development candidate, NOT an existing Core Family release bypass.**

The private Service currently has no effective native GitHub branch protection; private Ruleset requests return a plan-entitlement 403. GitHub Actions run 40867237748 had 20 failed jobs with zero Runner IDs and zero executed steps. Those records do not prove code quality. Use a separate ephemeral CI runner instead of requiring payment to continue ordinary PR testing. Do not claim optional GitLab Free approvals are enforced.

## Levels and fail-closed rules

- Development: genuine syntax and offline-unit logs signed by a trusted independent CI principal; reviewer signature optional.
- Production: **separately verified**, real `syntax`, `offline-unit`, `migration`, `node-22`, `node-24`, `security`, `codeql`, `dependency-audit`, `provider`, `gitlab-14`, `gitlab-17`, `gitlab-19`, `image`, `sbom`, `provenance` logs, **plus** a nonauthor independent current-HEAD reviewer signature over the same signed CI receipt. GitLab suffixes correspond to the existing GitLab CE 14.6.1 / 17.11.7 / 19.3.0 provider matrix. Node suites must prove actual supported 22.22.2 and 24.19.0 checks. Neither bundled no-model collector nor a renamed blank log can establish these external jobs; the independent CI signer must inspect the real runner/job provenance before signing.
- Native multi-GitLab production uses the stricter production-multi mode, additionally requiring the actual multi-offline suite. Unlike development, both production modes require the fixed root-owned trust file and separate reviewer signature.
- Missing/failed/duplicate suites, altered or missing logs, expired evidence, wrong 40-hex SHA, untrusted keys, old approval, same author/reviewer or self-selected trust root fail closed.
- The included no-model test collector can produce ONLY syntax, offline-unit, migration and the multi-offline suite when #116 test files exist. It **does not** produce genuine security/CodeQL, GitLab provider integration or image/OCI proof. Those require actual independent tests on a separate trusted CI system, with raw logs and SHA binding. Never append fake entries to a receipt. **No current production candidate is qualified by this script alone.**

**The additional production matrix does not increase the ordinary development PR requirement.** Development still requires only `syntax` and `offline-unit` under the pinned public trust root. Suites with names `codeql`, `gitlab-14` or `provenance` are claims requiring independent *genuine* supporting logs, not magic words that invoke those tools. The signing key owner must not simply trust a PR's unsigned JSON.

The offline suite is not GitHub branch protection. A free private repository can still merge without a server-enforced Ruleset; the publisher must separately refuse an unauthorized commit/artifact. Existing Core six-repository Ruleset and trusted-release controls remain unchanged unless reviewed and approved in a separate Core governance proposal.

## Protected keys and signed evidence

The independent publisher / CI verifier administrator installs /etc/codex-review/release-trust.json with mode 0644 or tighter, regular non-symlink, owned by root on Linux. **Both development and production CLI modes use this exact same pinned root**; passing a project-owned or test-generated trust file to the CLI is explicitly rejected. Do NOT generate this trust root from PR content or allow PR authors to replace it. Its format is:

    {
      "schemaVersion": 1,
      "repository": "jiying2007/codex-review-service",
      "maxAgeHours": 72,
      "ci": {"keyId":"ci-key", "allowedIdentities":["ci-operator"], "allowedRunners":["isolated-linux"], "publicKeyPem":"<public Ed25519 SPKI PEM>"},
      "review": {"keyId":"review-key", "allowedIdentities":["independent-reviewer"], "publicKeyPem":"<different public Ed25519 SPKI PEM>"}
    }

These are PUBLIC keys only. The CI runner ID must be explicitly allowlisted and cannot equal the PR author; trusted CI and reviewer identity sets must be disjoint. Keep the separate CI and reviewer PRIVATE Ed25519 keys in different protected users/machines, mode 0600, inaccessible to test jobs. A reviewer must not equal the PR author. The production verifier CLI accepts ONLY the fixed /etc/codex-review/release-trust.json path, so it cannot select a public key introduced by the PR itself. Key changes need a separately reviewed administrator action.

## Run real offline tests, no Codex/Work/model usage

Use an independently fetched, clean checkout of the exact approved SHA, with all pinned Core submodules initialized at exact commits, on an ephemeral isolated test VM/container, **not** production host 192.168.1.22. The output directory must be fresh, empty, mode 0700, physically outside the checkout, and never symlinked. Previous signed or unsigned log bundles must never be reused or overwritten. The collector invokes only hardcoded test commands using shell:false, private per-run HOME and scrubbed environment variables (no inherited GitHub/GitLab/OpenAI/Codex credentials). **Environment scrubbing is not a code sandbox**: the host operator must additionally ensure no Codex binary, credentials, provider service or network egress is accessible inside the ephemeral untrusted PR runner. Do not interpret a test suite's name as proof of zero model usage. It writes an unsigned receipt and raw logs outside the checkout:

    node scripts/collect-offline-ci.js --checkout /work/clean-checkout --output /work/evidence --sha <exact-sha> --author <trusted-pr-author> --issuer ci-operator --runner isolated-linux --suites syntax,offline-unit,migration

An independent CI signer validates the checkout/real logs, then runs a trusted installed signer (never with a private signing key exposed to untrusted PR tests):

The signer CLI independently checks the same raw logs, exact SHA/author/issuer and mandatory suites, and refuses a private key that does not match the administrator-pinned public key. An incomplete or corrupted unsigned receipt cannot be signed as a passing CI receipt.

    node scripts/sign-offline-evidence.js --type ci --mode development --trust /etc/codex-review/release-trust.json --logs /work/evidence/logs --sha <exact-sha> --author <trusted-pr-author> --input /work/evidence/ci.unsigned.json --key /protected/ci-private.pem --key-id ci-key --output /work/evidence/ci.signed.json

Development evidence can be verified immediately, even when GitHub-hosted Actions fail to schedule:

    node scripts/offline-evidence.js verify --mode development --trust /etc/codex-review/release-trust.json --ci /work/evidence/ci.signed.json --logs /work/evidence/logs --sha <exact-sha> --author <trusted-pr-author>

This is evidence for review, not a synthetic GitHub success receipt or auto-merge authorization. Do not edit logs/receipt after signing. The CI signer must independently check that the unsigned results genuinely came from real subprocesses; a cryptographic signature cannot prove that a dishonest signer ran a test.

## 可选：GitLab Free 分级离线开发作业（模板未启用）

[ci/gitlab-free-offline.template.yml](../ci/gitlab-free-offline.template.yml) 可在一个**独立且由管理员保护**的 GitLab CI 控制项目安装。不要直接把 PR/MR 来源代码中的 pipeline YAML 当作可信控制策略：PR 作者可能修改 YAML、image、script 或 artifact，窃取 Runner 令牌或伪造日志。该模板**不是现有服务已部署的 CI**，也没有自动同步 GitHub 私有库。

**控制仓库与目标仓库不是同一份 Git checkout。** 控制项目的 `CI_COMMIT_SHA` 仅标识控制项目，**不得当成私有 Service PR 的 SHA**。由受信任的独立协调者在 Runner 启动前，将 GitHub 私有 Service 的 **`REVIEWED_SHA` 精确提交**及完整、初始化后的 Core submodule 拉取到可信临时目录，清除 Git checkout 原有凭据/remote 后以**只读**方式挂载为 `VERIFIED_SOURCE_CHECKOUT`。`REVIEWED_SHA`、`REVIEWED_AUTHOR` 必须由 GitHub API 或独立受保护记录核实，而不是 PR 本身提供。控制项目 `GIT_STRATEGY: none`，模板作业默认 **manual**，不会自动运行生产或测试错误的仓库。

使用者需要给受保护 CI 项目配好：`NODE22_VERIFIED_IMAGE_DIGEST`、`NODE24_VERIFIED_IMAGE_DIGEST`（真实不可变 `@sha256` 镜像）、`TRUSTED_COLLECTOR`（可信管理员安装在待测源码目录之外，且不能被 PR 改写）、`REVIEWED_SHA`、`REVIEWED_AUTHOR`、`VERIFIED_SOURCE_CHECKOUT`；使用真正隔离、每次丢弃、禁止访问生产主机/生产 Secret/模型服务的 `isolated-ephemeral` Runner。Collector 通过 `GIT_OPTIONAL_LOCKS=0` 只读执行 Git 检查，既可保持 Source 只读，又不会产生多余 index lock。

默认提供两条 manual Node 22.22.2 / 24.19.0 开发检查，分别执行 `syntax,offline-unit,migration`；另有单独的 **manual `multi-gitlab-dev` Node 24**，仅对已准备好完整 [Service #116](https://github.com/jiying2007/codex-review-service/pull/116) 源码的 checkout 增加 `multi-offline` 真实离线测试。Node 镜像必须包含 `node` 和 `git`，且由管理员以完整 digest 锁定，不允许从不可信 PR 改写。其 GitLab Artifact 仅为**原始、未签名的** `ci.unsigned.json` 和 raw logs，不能变成受信任的自动审批。受控签名方必须独立验证 Git commit、子模块、Runner 来源、真实退出码与日志，随后使用**不同身份和密钥**签署。离线开发通过不满足生产 `security`、`codeql`、`dependency-audit`、`gitlab-14/17/19`、`image`、`sbom`、`provenance` 门禁。

GitLab 提供的 `CI_JOB_TOKEN` 等作业身份本身也可能被执行代码接触；脚本里取消环境变量并不构成安全沙箱。需要通过隔离 Executor、最小的作业令牌权限、可信的受保护 pipeline 配置、独立 Git checkout 和 Runner 生命周期控制真正减少攻击面。GitHub 官方也明确警告自托管 Runner 运行不可信 PR 的风险。选择既有 GitLab Free 是**运行工具的替代手段**，不是产品安全资格自动放宽。

## CodeQL 许可边界与免费 SAST（开发用途）

截至 2026-10-30，GitHub [CodeQL CLI 官方说明](https://docs.github.com/en/code-security/concepts/code-scanning/codeql/codeql-cli) 与 [CodeQL CLI License](https://github.com/github/codeql-cli-binaries/blob/main/LICENSE.md) 指出：对未公开/闭源私有代码库进行自动化 CodeQL 扫描，不因把 Runner 从 GitHub Actions 搬到自托管 GitLab 就自动获得授权。**在未确认满足 CodeQL 商业许可前，不运行 CodeQL CLI 扫描私有 Service，也不通过虚构 `codeql` PASS 解除原门禁。**

免费的开发期可选手段：受保护 [GitLab Free CI 模板](../ci/gitlab-free-offline.template.yml) 新增手动 `oss-sast-dev`，通过管理员验证的 `SEMGREP_CE_VERIFIED_IMAGE_DIGEST` 镜像、源代码外受保护的 `TRUSTED_SEMGREP_RULES` 本地规则包、`--metrics=off`，在隔离 Runner 上只读扫描准备好的精确 Git SHA。Semgrep Community Edition 以 LGPL-2.1 开源；GitLab SAST 基础能力也有 Free Self-Managed 版本。Community/Rule 包许可与具体安全覆盖需独立审查，避免使用需付费的 Pro 规则、未经许可的第三方规则或自动将私有源码上传外部平台。

扫描结果只是一份开发期 OSS SAST 报告，**不是** CodeQL 的授权替代或当前生产 Required CI Gate 的豁免。现有 `production` / `production-multi` 完整 CodeQL 等检查继续 fail-closed；若希望完全不付费闭环生产，必须在 Core [#91](https://github.com/jiying2007/codex-safe-core/issues/91) 正式审查并批准版本化的安全检测替代合同（含 SAST 敏感规则、依赖/Secret/容器扫描、假阳性处理和可信审查），然后通过单独的受保护发布链验证。不能简单删掉 `codeql` 项宣称标准不变。

## Production (not yet wired to release)

After genuine CodeQL/dependency, compatible GitLab provider, migration/recovery and OCI/image verification are completed, a separate reviewer actually reviews the current SHA and evidence and signs:

    node scripts/sign-offline-evidence.js --type review --mode production --trust /etc/codex-review/release-trust.json --logs /work/evidence/logs --ci /work/evidence/ci.signed.json --sha <exact-sha> --author <trusted-pr-author> --reviewer independent-reviewer --key /protected/review-private.pem --key-id review-key --output /work/evidence/review.signed.json

    node scripts/offline-evidence.js verify --mode production --trust /etc/codex-review/release-trust.json --ci /work/evidence/ci.signed.json --review /work/evidence/review.signed.json --logs /work/evidence/logs --sha <exact-sha> --author <trusted-pr-author>

The trusted publisher must authenticate the PR author and SHA independently from the repository, verify the immutable source/artifact digest, ensure neither signer key is controlled by the author, and prevent already-published artifacts from changing. The pinned CI/public trust root must not be writable by the source author. The supported offline installer must pin the CI runner identity in allowedRunners; different CI and reviewer signers, unrelated to the source author, are required. There is no endorsement here that external evidence and native GitHub Ruleset are equivalent security guarantees.

**This PR does not modify existing release.yml, Core Family release, Service #113/#116 merge controls, Secrets, branch protection, tag publishing or production deployment.** A separately reviewed publishing-adapter PR is needed to enforce this gate before deployment. It must not waive the current six-repository Core Ruleset contract without explicit independent security-policy approval.

## Offline verifier self-tests

    node --test test/offline-evidence.test.js test/offline-collector.test.js test/offline-signer-cli.test.js

The tests use temporary synthetic keys and logs to verify the validator only, never as real product CI evidence. They reject wrong SHA/signatures, altered logs, missing/failed suites, old receipts, untrusted reviewer/self-approval, insecure private keys and changing the production trust root. Rotated keys need a new key ID and preserved immutable historical receipts. October 2026 restriction on Codex Cloud/CLI and ChatGPT Work shared quota remains active.
