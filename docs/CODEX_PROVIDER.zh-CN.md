# Codex Provider 与中转站配置

Codex Review Service 6.1.1 使用 `codex-safe-core` 的共享 Codex Runtime/Provider Contract。Service 为保持 Safe Contract，会主动隔离用户 Codex 配置，因此不要依赖 `~/.codex/config.toml` 给 Service 注入中转站。

## 两种 Provider 模式

### 官方 OpenAI

保留默认配置：

```json
{
  "codex": {
    "path": "codex",
    "model": "",
    "providerMode": "openai",
    "providerBaseUrl": "",
    "apiKeyEnv": "OPENAI_API_KEY",
    "connectTimeoutSeconds": 15,
    "requestTimeoutSeconds": 180,
    "streamIdleTimeoutSeconds": 60
  }
}
```

可使用执行用户的 `codex login`，或通过 `OPENAI_API_KEY` / `OPENAI_API_KEY_FILE` 提供 API Key。

### OpenAI-compatible 中转站

显式配置：

```json
{
  "codex": {
    "path": "codex",
    "model": "gpt-5.2",
    "providerMode": "openai-compatible",
    "providerBaseUrl": "https://relay.example.com/v1",
    "apiKeyEnv": "CODEX_PROVIDER_API_KEY",
    "connectTimeoutSeconds": 15,
    "requestTimeoutSeconds": 180,
    "streamIdleTimeoutSeconds": 60
  }
}
```

要求：

- `providerBaseUrl` 必须是 HTTPS base URL；
- URL 不能嵌入用户名、密码、query 或 fragment；
- `apiKeyEnv` 是环境变量名，不是 API Key 值；
- 中转站必须支持 OpenAI Responses API（`/v1/responses`）、SSE 和 Structured Output；
- 只兼容 `/v1/chat/completions` 的中转站不能直接作为 Service Provider；
- compatible Provider 固定使用 Responses HTTP/SSE，不使用 WebSocket；
- 中转站使用自定义模型别名时，应显式设置 `codex.model`。

## systemd / inline Runner

生产环境推荐使用专用 Secret 文件：

```bash
sudo install -d -o root -g codex-review -m 0750 /etc/codex-review/secrets
printf '%s' 'sk-xxxx' | sudo tee /etc/codex-review/secrets/codex-provider-api-key >/dev/null
sudo chown root:codex-review /etc/codex-review/secrets/codex-provider-api-key
sudo chmod 0640 /etc/codex-review/secrets/codex-provider-api-key
```

在 `/etc/codex-review-service.env` 中配置：

```text
CODEX_PROVIDER_API_KEY_FILE=/etc/codex-review/secrets/codex-provider-api-key
```

配置文件中的 `codex.apiKeyEnv` 应保持：

```json
"apiKeyEnv": "CODEX_PROVIDER_API_KEY"
```

`*_FILE` 会在启动时安全解析成对应的运行时环境变量；Key 本身不要写入 JSON 配置、Git 仓库或命令行参数。

## isolated Runner

isolated 模式下，Provider Key 只应提供给 Runner 用户/进程，不应给 Controller：

```text
Controller: GitLab credentials + state
Runner:     CODEX_PROVIDER_API_KEY + Codex executable
```

将 Secret 文件权限授予 Runner 用户/组，并在 Runner 的环境文件中设置 `CODEX_PROVIDER_API_KEY_FILE`。Controller 通过 Unix Socket 调用 Runner 的 Safe Contract，不需要读取 Provider Key。

## Docker / Compose

使用 Release 发布的 digest 固定 `compose.release.yaml`。为中转站创建独立 Secret：

```bash
mkdir -p secrets
chmod 0700 secrets
printf '%s' 'sk-xxxx' > secrets/codex_provider_api_key
chmod 0600 secrets/codex_provider_api_key
```

将该文件以 Docker Secret/只读文件挂载到容器，并让：

```text
CODEX_PROVIDER_API_KEY_FILE=/run/secrets/codex_provider_api_key
```

配置中的 `codex.apiKeyEnv` 仍使用 `CODEX_PROVIDER_API_KEY`。不要把 Key 直接写进 Compose YAML 或 `config.json`。

## Doctor 验证

配置后，在启用 GitLab Webhook 前执行：

```bash
cd /opt/codex-review-service
sudo -u codex-review /usr/bin/node \
  --env-file=/etc/codex-review-service.env \
  src/doctor.js
```

Doctor 会使用实际 Service Runtime/Provider 做真实结构化 Provider probe。只有 Provider、凭据、Responses API、模型与 Structured Output round-trip 均通过，才应把部署视为可用。

如果使用 isolated Runner，Doctor 还会通过 Runner `/probe` 路径验证真实隔离执行链。

## 常见故障

### 终端 `codex` 能用，但 Service 不工作

这是预期可能出现的差异。终端 Codex 可能读取 `~/.codex/config.toml`，Service Safe Runtime 不会。必须在 `config.json` 中显式设置 `providerMode=openai-compatible` 和 `providerBaseUrl`，并通过 `CODEX_PROVIDER_API_KEY[_FILE]` 提供凭据。

### 日志访问 `api.openai.com`

中转站模式不应回退到官方 endpoint。检查：

1. `codex.providerMode` 是否为 `openai-compatible`；
2. `codex.providerBaseUrl` 是否为正确 HTTPS `/v1` base URL；
3. `codex.apiKeyEnv` 是否为 `CODEX_PROVIDER_API_KEY`；
4. `CODEX_PROVIDER_API_KEY` 或 `_FILE` 是否对实际 Codex 执行进程可见；
5. 重新运行 Doctor。

不要只提高 `review.timeoutSeconds` 或 `jobTimeoutSeconds`。

### 401 / 403

检查 Key 是否正确、是否属于该中转站，以及中转站是否要求与 OpenAI 不同的模型名或权限。

### 429

这是 Provider 限流。应按中转站限额降低 Review concurrency/调用量，而不是把它当成网络超时。

### DNS / Connect / TLS

检查 Service/Runner 所在网络命名空间的 DNS、出口、代理与 CA 信任。isolated Runner 场景尤其要在 Runner 用户/容器内验证，而不是只在 Controller 主机 shell 中验证。

### 中转站只支持 Chat Completions

Service compatible Provider 需要 Responses API。请让中转站补齐 `/v1/responses` + SSE/Structured Output 兼容层。

## 三个 VS Code Safe 插件共享中转站

如果团队同时使用 Codex Commit Safe、Review Safe、PR Safe，可以让三个插件统一使用：

```text
CODEX_RELAY_API_KEY
```

而 Review Service 生产部署建议继续使用专用：

```text
CODEX_PROVIDER_API_KEY[_FILE]
```

这样开发者工作站与服务器 Secret 生命周期保持独立。

## Provider Contract v2：auth.json 与局域网 HTTP

Review Service 7.3.0 / Config Schema 7 新增 `codex.credentialSource`（`auto|env|auth-json`）和 `codex.allowInsecureHttp`（默认 `false`）。`auto` 优先读取 `codex.apiKeyEnv`；若不存在，配置了 `codex.home` 时 Core 读取 `<codex.home>/auth.json`，否则读取 `${CODEX_HOME}/auth.json` 或 `~/.codex/auth.json`。文件必须使用 `auth_mode=apikey` 并包含 `OPENAI_API_KEY`。非 loopback HTTP 只有显式设置 `allowInsecureHttp: true` 才允许，仓库 `.codex-safe.json` 无权开启。
