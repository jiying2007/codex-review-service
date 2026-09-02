'use strict';

const {
  resolveCodexRuntime,
  inspectCodexRuntime
}=require('./codex-safe-core/codex-runtime-resolver');
const {
  normalizeCodexRuntimeOptions,
  resolveProviderCredential
}=require('./codex-safe-core/codex-runtime');

const CHILD_ENV_KEYS=Object.freeze(['PATH','HOME','USERPROFILE','LANG','LC_ALL','TMPDIR','TEMP','TMP','HTTPS_PROXY','HTTP_PROXY','NO_PROXY','NODE_EXTRA_CA_CERTS']);

function runtimeEnvironment(config,sourceEnv=process.env){
  const env={...sourceEnv};
  if(config?.codexHome)env.CODEX_HOME=config.codexHome;
  return env;
}

function runtimeSelectionFromConfig(config={}){
  const mode=String(config.codexProviderMode||'auto').trim()||'auto';
  const provider=mode==='openai-compatible'?{
    mode,
    baseUrl:config.codexProviderBaseUrl||'',
    apiKeyEnv:config.codexProviderApiKeyEnv||'CODEX_PROVIDER_API_KEY',
    credentialSource:config.codexProviderCredentialSource||'auto',
    allowInsecureHttp:Boolean(config.codexProviderAllowInsecureHttp)
  }:{mode};
  return Object.freeze({provider,timeouts:Object.freeze({
    connectMs:(config.codexConnectTimeoutSeconds||15)*1000,
    requestMs:(config.codexRequestTimeoutSeconds||180)*1000,
    operationMs:(config.reviewTimeoutSeconds||180)*1000,
    idleMs:(config.codexStreamIdleTimeoutSeconds||60)*1000
  })});
}

function runtimeResolutionFromConfig(config={},sourceEnv=process.env){
  const env=runtimeEnvironment(config,sourceEnv);
  return resolveCodexRuntime(runtimeSelectionFromConfig(config),{env});
}

function inspectRuntimeFromConfig(config={},sourceEnv=process.env){
  const env=runtimeEnvironment(config,sourceEnv);
  return inspectCodexRuntime(runtimeSelectionFromConfig(config),{env});
}

function filteredRuntimeEnv(config,runtime,sourceEnv={}){
  const env={};
  for(const key of CHILD_ENV_KEYS)if(sourceEnv[key])env[key]=sourceEnv[key];
  if(config?.codexHome)env.CODEX_HOME=config.codexHome;
  else if(sourceEnv.CODEX_HOME)env.CODEX_HOME=sourceEnv.CODEX_HOME;
  const names=new Set([
    String(config?.codexProviderApiKeyEnv||'').trim(),
    String(runtime?.provider?.apiKeyEnv||'').trim(),
    runtime?.provider?.mode==='openai'?'OPENAI_API_KEY':''
  ].filter(Boolean));
  for(const name of names)if(sourceEnv[name])env[name]=sourceEnv[name];
  return env;
}

function prepareRuntimeFromConfig(config={},sourceEnv=process.env){
  const baseEnv=runtimeEnvironment(config,sourceEnv);
  const resolution=resolveCodexRuntime(runtimeSelectionFromConfig(config),{env:baseEnv});
  const credential=resolveProviderCredential(resolution.runtime,{env:baseEnv});
  let runtime=resolution.runtime;
  if(runtime.provider.mode==='openai-compatible'){
    runtime=normalizeCodexRuntimeOptions({
      provider:{
        mode:'openai-compatible',
        baseUrl:runtime.provider.baseUrl,
        apiKeyEnv:runtime.provider.apiKeyEnv,
        credentialSource:'env',
        allowInsecureHttp:runtime.provider.allowInsecureHttp
      },
      timeouts:runtime.timeouts
    });
  }
  const childEnv=Object.freeze(filteredRuntimeEnv(config,runtime,credential.environment));
  return Object.freeze({
    runtime,
    childEnv,
    source:resolution.source,
    configPath:resolution.configPath,
    providerId:resolution.providerId,
    credentialSource:credential.source,
    credentialEnv:credential.credentialEnv||'',
    authJsonPath:credential.authJsonPath||''
  });
}

module.exports={
  CHILD_ENV_KEYS,
  runtimeEnvironment,
  runtimeSelectionFromConfig,
  runtimeResolutionFromConfig,
  inspectRuntimeFromConfig,
  filteredRuntimeEnv,
  prepareRuntimeFromConfig
};
