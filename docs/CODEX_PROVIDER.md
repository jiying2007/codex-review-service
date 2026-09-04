# Codex Provider and Relay Configuration

Codex Review Service 7.4.0 consumes Codex Safe Core 4.13.0 Runtime/Provider Contract v3. The normal path is **Auto**: if `codex` already works for the Service OS account, isolated Runner account, or container, Review Service reuses that machine runtime instead of asking operators to duplicate the relay URL.

## Runtime Contract v3 — zero-config

## Zero-config resolution

`codex.providerMode` defaults to `auto`. Resolution is machine-local and deterministic: Family Runtime (`~/.codex-safe/runtime.json`) and Codex configuration (`${CODEX_HOME}/config.toml` or `~/.codex/config.toml`) are consumed through Core Runtime v3. No LAN scanning or implicit DNS discovery is performed.

For remote or container deployments, “machine” means the actual process account/container filesystem. Mount or provision the intended Codex home there.

## Credentials and secret isolation

Provider credentials stay in the configured provider environment variable or Codex `auth.json`. Secret values never enter JSON config, argv, receipts, Doctor output, or logs. Review Service additionally filters the Codex child environment: only the resolved provider credential and bounded runtime variables are forwarded; GitLab and notification secrets are not.

File-backed Service secrets such as `OPENAI_API_KEY_FILE` / `CODEX_PROVIDER_API_KEY_FILE` remain available for explicit provider overrides. In Auto mode, prefer the machine Codex credential source rather than duplicating secrets into Service configuration.

## Private-network HTTP

HTTPS remains preferred. A literal private-IP HTTP relay already present in machine-owned Codex configuration may be inherited by Runtime v3 and is reported by Doctor with a plaintext warning. Public/non-IP HTTP remains fail-closed unless the machine-level Family Runtime explicitly establishes trust. Repository policy cannot enable plaintext provider transport.

## Advanced explicit override

Use an explicit override only when this Service instance intentionally differs from the machine Codex runtime:

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

The relay must implement the OpenAI Responses API, SSE, and Structured Output. A Chat-Completions-only relay is insufficient. Never embed credentials, query parameters, or fragments in `providerBaseUrl`.

To force built-in OpenAI behavior independently of machine provider configuration, set `providerMode` to `openai` explicitly.

## systemd and isolated Runner

The Service and isolated Runner resolve Runtime v3 in the account that actually launches Codex. Set `CODEX_HOME` when the intended Codex home is not the account default. In isolated mode, provision the provider credential only for the Runner account; the Controller keeps GitLab credentials and state and communicates over the Unix socket.

## Docker / Compose

The official image uses the same Runtime v3 contract. Persist or mount the intended Codex home into the container and make only the provider credential available to the Codex execution process. Production should consume the digest-pinned `compose.release.yaml` published by the Release rather than rebuilding source on the target host.

## Doctor

Run `npm run doctor` (or `node src/doctor.js`) before enabling GitLab webhooks. Doctor performs a live structured Codex probe and reports runtime source/config path, provider, endpoint host, transport, credential presence, version policy, and plaintext warnings without exposing credential values.

If terminal `codex` works but Doctor does not, first verify that the terminal and Service/Runner are the same OS account/container and use the same `CODEX_HOME`. Do not duplicate provider settings until that identity mismatch is ruled out.

## Failure guidance

- `401/403`: verify the provider credential and model/account permissions.
- `429`: reduce review concurrency/request volume to the relay quota.
- DNS/connect/TLS failures: test from the Service/Runner network namespace and install the private CA through `NODE_EXTRA_CA_CERTS` when required; do not disable TLS verification.
- Chat-Completions-only relay: add a Responses API + SSE/Structured Output compatibility layer first.
