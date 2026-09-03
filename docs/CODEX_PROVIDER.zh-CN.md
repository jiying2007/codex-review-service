# Codex Provider 与中转站配置

Codex Review Service 7.4.0 使用 Codex Safe Core 4.13.0 Runtime/Provider Contract v3。正常路径是 **Auto**：只要 Service 操作系统用户、隔离 Runner 用户或容器里的 `codex` 已经可用，Review Service 就直接复用这台机器的 Runtime，不再要求重复填写中转站 URL。

## 零配置解析

`codex.providerMode` 默认是 `auto`。Core Runtime v3 按机器级契约解析 Family Runtime（`~/.codex-safe/runtime.json`）以及 Codex 配置（`${CODEX_HOME}/config.toml` 或 `~/.codex/config.toml`）。不会扫描局域网，也不会做隐式 DNS 发现。

远端或容器部署中的“机器”指真正运行 Service/Runner 的用户与容器文件系统；需要把目标 Codex Home 正确挂载或配置进去。

## 凭据与 Secret 隔离

Provider 凭据仍来自 Provider 指定的环境变量或 Codex `auth.json`。Secret 值不会进入 JSON 配置、argv、Receipt、Doctor 输出或日志。Review Service 还会过滤 Codex 子进程环境：只转发解析后的 Provider 凭据和受限 Runtime 环境变量，GitLab Token 与通知 Secret 不会被带入 Codex 子进程。

显式 Provider override 仍可使用 `OPENAI_API_KEY_FILE` / `CODEX_PROVIDER_API_KEY_FILE` 等 Service 文件型 Secret；默认 Auto 模式优先复用机器 Codex Runtime/凭据来源，不应再复制一套中转站配置。

## 私网 HTTP

优先使用 HTTPS。机器级 Codex 配置中已经存在的“字面量私网 IP HTTP”中转站可以由 Runtime v3 继承，Doctor 会明确提示明文传输风险。公网/非 IP HTTP 继续 fail-closed，除非机器级 Family Runtime 明确建立信任。仓库策略不能开启明文 Provider 传输。

## 高级显式覆盖

只有当本 Service 实例确实需要和机器 Codex Runtime 不同时才使用显式覆盖：

```json
{
  "codex": {
    "providerMode": "openai-compatible",
    "providerBaseUrl": "https://relay.example.internal/v1",
    "apiKeyEnv": "CODEX_PROVIDER_API_KEY",
    "credentialSource": "auto",
    "allowInsecureHttp": false
  }
}
```

中转站必须实现 OpenAI Responses API、SSE 和 Structured Output；只有 Chat Completions API 不足以满足契约。`providerBaseUrl` 不允许包含凭据、查询参数或 fragment。

如需强制使用官方 OpenAI、完全忽略机器上的 compatible provider，可显式设置 `providerMode: "openai"`。

## systemd 与隔离 Runner

Service 与隔离 Runner 都在真正启动 Codex 的操作系统账号下解析 Runtime v3。目标 Codex Home 不是账号默认目录时设置 `CODEX_HOME`。isolated 模式只给 Runner 用户 Provider 凭据；Controller 保留 GitLab 凭据和状态，通过 Unix Socket 调用 Runner。

## Docker / Compose

官方镜像使用同一 Runtime v3 契约。把目标 Codex Home 持久化或挂载到容器，并只向 Codex 执行进程提供 Provider 凭据。生产环境应直接使用 Release 发布的 digest 固定 `compose.release.yaml`，不要在目标机器重新构建源码。

## Doctor

启用 GitLab Webhook 前执行 `npm run doctor`（或 `node src/doctor.js`）。Doctor 会进行真实结构化 Codex 探测，并报告 Runtime 来源/配置路径、Provider、Endpoint Host、Transport、凭据是否存在、版本策略和明文 HTTP 风险，但不会输出凭据值。

如果终端里的 `codex` 能用而 Doctor 不能，首先确认终端和 Service/Runner 是否是同一个用户或容器、是否使用同一个 `CODEX_HOME`；不要第一时间重新复制一套 Provider 配置。

## 故障指引

- `401/403`：检查 Provider 凭据、模型与账号权限。
- `429`：降低 Review 并发/请求量以匹配中转站配额。
- DNS/连接/TLS：必须从 Service/Runner 的真实网络命名空间测试；私有 CA 使用 `NODE_EXTRA_CA_CERTS`，不要关闭 TLS 校验。
- 仅支持 Chat Completions：先增加 Responses API + SSE + Structured Output 兼容层。
