# Codex Provider and Relay Configuration

Codex Review Service 6.1.1 consumes the shared Codex Runtime/Provider Contract from `codex-safe-core`. The Service intentionally isolates user Codex configuration to preserve the Safe Contract, so do not rely on `~/.codex/config.toml` to inject a relay into the Service.

## Provider modes

### Built-in OpenAI

Keep the default configuration:

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

Authenticate the execution user with `codex login`, or provide `OPENAI_API_KEY` / `OPENAI_API_KEY_FILE`.

### OpenAI-compatible relay

Configure the provider explicitly:

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

Requirements:

- `providerBaseUrl` must be an HTTPS base URL;
- do not embed usernames, passwords, query parameters or fragments in the URL;
- `apiKeyEnv` is the environment-variable name, never the API key value;
- the relay must implement the OpenAI Responses API (`/v1/responses`), SSE and Structured Output;
- a relay that only implements `/v1/chat/completions` is not sufficient;
- compatible providers use Responses HTTP/SSE and do not use WebSocket transport;
- set `codex.model` explicitly when the relay exposes a custom model alias.

## systemd / inline Runner

Use a dedicated protected secret file in production:

```bash
sudo install -d -o root -g codex-review -m 0750 /etc/codex-review/secrets
printf '%s' 'sk-xxxx' | sudo tee /etc/codex-review/secrets/codex-provider-api-key >/dev/null
sudo chown root:codex-review /etc/codex-review/secrets/codex-provider-api-key
sudo chmod 0640 /etc/codex-review/secrets/codex-provider-api-key
```

Set in `/etc/codex-review-service.env`:

```text
CODEX_PROVIDER_API_KEY_FILE=/etc/codex-review/secrets/codex-provider-api-key
```

Keep the structured config set to:

```json
"apiKeyEnv": "CODEX_PROVIDER_API_KEY"
```

The `*_FILE` input is resolved into the matching runtime environment variable. Never store the key in JSON configuration, Git or command-line arguments.

## Isolated Runner

In isolated mode, only the Runner user/process should receive the provider key:

```text
Controller: GitLab credentials + state
Runner:     CODEX_PROVIDER_API_KEY + Codex executable
```

Grant the secret file only to the Runner user/group and configure `CODEX_PROVIDER_API_KEY_FILE` in the Runner environment. The Controller invokes the Safe Contract over the Unix socket and does not need the provider secret.

## Docker / Compose

Use the digest-pinned `compose.release.yaml` from the Release. Create a dedicated relay secret:

```bash
mkdir -p secrets
chmod 0700 secrets
printf '%s' 'sk-xxxx' > secrets/codex_provider_api_key
chmod 0600 secrets/codex_provider_api_key
```

Mount it as a Docker Secret/read-only file and set:

```text
CODEX_PROVIDER_API_KEY_FILE=/run/secrets/codex_provider_api_key
```

The structured config still uses `codex.apiKeyEnv=CODEX_PROVIDER_API_KEY`. Do not put the key directly in Compose YAML or `config.json`.

## Doctor verification

Before enabling the GitLab webhook, run:

```bash
cd /opt/codex-review-service
sudo -u codex-review /usr/bin/node \
  --env-file=/etc/codex-review-service.env \
  src/doctor.js
```

Doctor performs a real structured provider probe through the Service Runtime. Treat the deployment as ready only when provider configuration, credentials, Responses API, model and Structured Output round-trip all succeed.

For isolated mode, Doctor validates the actual Runner `/probe` execution path as well.

## Troubleshooting

### Terminal `codex` works but the Service does not

This can be expected. Terminal Codex may use `~/.codex/config.toml`; the Service Safe Runtime does not. Set `providerMode=openai-compatible` and `providerBaseUrl` explicitly in `config.json`, then provide credentials through `CODEX_PROVIDER_API_KEY[_FILE]`.

### Logs show `api.openai.com`

Relay mode should not fall back to the built-in OpenAI endpoint. Verify:

1. `codex.providerMode` is `openai-compatible`;
2. `codex.providerBaseUrl` is the intended HTTPS `/v1` base URL;
3. `codex.apiKeyEnv` is `CODEX_PROVIDER_API_KEY`;
4. `CODEX_PROVIDER_API_KEY` or `_FILE` is visible to the actual Codex execution process;
5. rerun Doctor.

Do not fix this by only increasing `review.timeoutSeconds` or `jobTimeoutSeconds`.

### 401 / 403

Verify the key, relay account/permissions and any relay-specific model alias requirements.

### 429

This is provider rate limiting. Reduce Review concurrency/request volume to match the relay quota instead of treating it as a network timeout.

### DNS / connect / TLS

Check DNS, egress, proxy and CA trust from the Service/Runner network namespace. In isolated mode, test from the Runner environment rather than only from the Controller host shell.

### Relay supports Chat Completions only

The compatible provider requires the Responses API. Add a `/v1/responses` + SSE/Structured Output compatibility layer to the relay first.

## Shared relay on developer workstations

Teams using Codex Commit Safe, Review Safe and PR Safe together may point all three VS Code extensions at one workstation variable such as:

```text
CODEX_RELAY_API_KEY
```

For Review Service production deployments, keep the separate server-side secret lifecycle with:

```text
CODEX_PROVIDER_API_KEY[_FILE]
```
