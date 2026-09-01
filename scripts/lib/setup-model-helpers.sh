recommend_local_models_if_empty() {
  local registry_path="$1"

  if ! command -v node >/dev/null 2>&1; then
    echo "warning: node not found; skipping local model recommendations." >&2
    return 1
  fi

  REGISTRY_PATH="$registry_path" node <<'NODE'
const fs = require('fs');

const registryPath = process.env.REGISTRY_PATH;
const localTierId = process.env.XX_STACK_TIER_LOCAL;
const localHostId = process.env.XX_STACK_HOST_LOCAL_WORKSTATION;
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const localHost = registry.tiers.find((tier) => tier.id === localTierId)?.hosts?.find((host) => host.id === localHostId);

if (!localHost) {
  console.log('  skipped local model recommendations: local host not found');
  process.exit(0);
}

if (Array.isArray(localHost.models) && localHost.models.length > 0) {
  console.log(`  local model inventory present: ${localHost.models.length} models`);
  process.exit(0);
}

const recommendations = Array.isArray(localHost.recommendations) ? localHost.recommendations : [];
if (recommendations.length === 0) {
  console.log('  no local models found and no recommendations available');
  process.exit(0);
}

console.log('  no local Ollama models found; recommended pulls based on detected hardware:');
for (const recommendation of recommendations.slice(0, 3)) {
  console.log(`    ollama pull ${recommendation.name}    # ${recommendation.reason}`);
}
NODE
}

sync_platform_models() {
  local registry_path="$1"
  local local_url="$2"
  local remote_url="$3"
  local openai_local_url="$4"
  local openai_remote_url="$5"

  if [ "$SYNC_MODELS" != "1" ]; then
    echo "  skipped platform model sync (--skip-model-sync)"
    return 0
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "warning: node not found; skipping platform model sync." >&2
    return 1
  fi

  if ! command -v curl >/dev/null 2>&1; then
    echo "warning: curl not found; skipping platform model sync." >&2
    return 1
  fi

  if [ ! -f "$registry_path" ]; then
    echo "warning: platform registry not found for sync: $registry_path" >&2
    return 1
  fi

  REGISTRY_PATH="$registry_path" LOCAL_URL="$local_url" REMOTE_URL="$remote_url" OPENAI_LOCAL_URL="$openai_local_url" OPENAI_REMOTE_URL="$openai_remote_url" node <<'NODE'
const fs = require('fs');
const { execFileSync } = require('child_process');

const registryPath = process.env.REGISTRY_PATH;
const localTierId = process.env.XX_STACK_TIER_LOCAL;
const remoteTierId = process.env.XX_STACK_TIER_TAILSCALE_OLLAMA;
const openAiTierId = process.env.XX_STACK_TIER_TAILSCALE_OPENAI_COMPATIBLE;
const localHostId = process.env.XX_STACK_HOST_LOCAL_WORKSTATION;
const localOpenAiHostId = process.env.XX_STACK_HOST_LOCAL_OPENAI_COMPATIBLE;
const remoteOpenAiHostId = process.env.XX_STACK_HOST_TAILSCALE_OPENAI_COMPATIBLE_PRIMARY;
const remoteHostId = process.env.XX_STACK_HOST_EXAMPLE_GPU_BOX;
const ollamaProviderId = process.env.XX_STACK_PROVIDER_OLLAMA_REMOTE;
const llamaCppLocalProviderId = process.env.XX_STACK_PROVIDER_LLAMA_CPP_LOCAL;
const sglangRemoteProviderId = process.env.XX_STACK_PROVIDER_SGLANG_REMOTE;
const localhostScope = process.env.XX_STACK_NETWORK_SCOPE_LOCALHOST;
const tailscaleScope = process.env.XX_STACK_NETWORK_SCOPE_TAILSCALE;
const localUrl = process.env.LOCAL_URL;
const remoteUrl = process.env.REMOTE_URL;
const openAiLocalUrl = process.env.OPENAI_LOCAL_URL;
const openAiRemoteUrl = process.env.OPENAI_REMOTE_URL;
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));

function fetchTags(baseUrl) {
  if (!baseUrl) {
    return null;
  }

  try {
    const raw = execFileSync('curl', ['-fsS', '--max-time', '5', `${baseUrl.replace(/\/$/, '')}/api/tags`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const payload = JSON.parse(raw);
    return Array.isArray(payload.models) ? payload.models : [];
  } catch {
    return null;
  }
}

function fetchOpenAiModels(baseUrl) {
  if (!baseUrl) {
    return null;
  }

  try {
    const raw = execFileSync('curl', ['-fsS', '--max-time', '5', `${baseUrl.replace(/\/$/, '')}/v1/models`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const payload = JSON.parse(raw);
    return Array.isArray(payload.data)
      ? payload.data.map((item) => ({ name: item.id || '', size: 0, modified_at: item.created || null, digest: null, details: { source: 'openai-compatible' } })).filter((item) => item.name)
      : [];
  } catch {
    return null;
  }
}

function inferRoles(modelName) {
  const name = modelName.toLowerCase();
  const roles = [];

  if (name.includes('coder') || name.includes('code')) {
    roles.push('build', 'review', 'code-analysis');
  }
  if (name.includes('qwq') || name.includes('reason') || name.includes('think')) {
    roles.push('deep-reasoning', 'research', 'orchestrator');
  }
  if (name.includes('qwen')) {
    roles.push('plan', 'architect');
  }
  if (name.includes('mistral') || name.includes('nemo')) {
    roles.push('fast-reasoning');
  }
  if (roles.length === 0) {
    roles.push('general');
  }

  return [...new Set(roles)];
}

function updateHost(endpoint, tierId, hostId, models) {
  const tier = registry.tiers.find((item) => item.id === tierId);
  if (!tier) {
    return { count: 0, reachable: false };
  }

  const host = tier.hosts.find((item) => item.id === hostId || item.endpoint === endpoint);
  if (!host) {
    return { count: 0, reachable: false };
  }

  host.lastSync = new Date().toISOString();

  if (!models) {
    host.reachable = false;
    return { count: 0, reachable: false };
  }

  host.reachable = true;
  // "*:cloud" Ollama models proxy inference to Ollama's hosted cloud service;
  // never import them, or they would bypass the cloud opt-in gate.
  models = models.filter((model) => !/:cloud$/i.test(model.name || ''));
  host.models = models.map((model, index) => ({
    name: model.name,
    roles: inferRoles(model.name),
    priority: index === 0 ? 'primary' : 'discovered',
    size: model.size,
    modifiedAt: model.modified_at,
    digest: model.digest,
    details: model.details || {},
  }));

  const maxModelSizeGb = host.models
    .map((model) => Math.round(((Number(model.size) || 0) / 1073741824) * 10) / 10)
    .reduce((max, value) => Math.max(max, value), 0);
  const contextReservePercent = Number(host.executionPolicy?.contextReservePercent ?? 25);
  const detectedGpuVramGb = Number(host.hardware?.detected?.totalGpuVramGb || host.hardware?.detected?.totalVramGb || 0);
  const effectiveVramGb = detectedGpuVramGb > 0 ? detectedGpuVramGb * (1 - contextReservePercent / 100) : 0;

  let inferredParallelSlices = 1;
  if (effectiveVramGb > 0 && maxModelSizeGb > 0) {
    inferredParallelSlices = Math.max(1, Math.floor(effectiveVramGb / Math.max(maxModelSizeGb, 12)));
  } else if (maxModelSizeGb > 0) {
    inferredParallelSlices = Math.max(1, Math.min(3, Math.floor(60 / Math.max(maxModelSizeGb, 10))));
  }

  const detectedGpuCount = Number(host.hardware?.detected?.gpuCount || 0);
  const inferredConcurrentModels = Math.max(
    1,
    Math.min(detectedGpuCount || inferredParallelSlices, inferredParallelSlices)
  );
  const allowMultiModel = process.env.XX_STACK_ALLOW_MULTI_MODEL === '1';
  const configuredConcurrentModels = Number(host.executionPolicy?.maxConcurrentModels || 0);
  const resolvedConcurrentModels = allowMultiModel
    ? Math.max(1, configuredConcurrentModels, inferredConcurrentModels)
    : 1;

  host.executionPolicy = {
    ...(host.executionPolicy || {}),
    maxParallelSlices: Number(host.executionPolicy?.maxParallelSlices || inferredParallelSlices),
    maxConcurrentModels: resolvedConcurrentModels,
    contextReservePercent,
    scheduling: host.executionPolicy?.scheduling || 'balanced',
  };

  host.hardware = {
    ...(host.hardware || {}),
    detected: {
      ...(host.hardware?.detected || {}),
      maxModelSizeGb,
      catalogedModelCount: host.models.length,
      syncedAt: new Date().toISOString(),
    },
  };
  return { count: host.models.length, reachable: true };
}

const localModels = fetchTags(localUrl);

const localResult = updateHost(localUrl, localTierId, localHostId, localModels);
const remoteTier = registry.tiers.find((item) => item.id === remoteTierId);
const remoteHosts = Array.isArray(remoteTier?.hosts) ? remoteTier.hosts : [];

if (remoteUrl) {
  const normalizedRemoteUrl = remoteUrl.replace(/\/$/, '');
  let primaryHost = remoteHosts.find((host) => host?.primary === true) || null;
  const matchingHost = remoteHosts.find((host) => (host?.endpoint || '').replace(/\/$/, '') === normalizedRemoteUrl) || null;
  if (matchingHost) {
    primaryHost = matchingHost;
  } else if (primaryHost && ((!primaryHost.endpoint) || primaryHost.endpoint.includes('REMOTE_HOST'))) {
    primaryHost.endpoint = normalizedRemoteUrl;
  } else if (!primaryHost && remoteTier) {
    primaryHost = {
      id: remoteHostId,
      label: remoteHostId,
      provider: ollamaProviderId,
      endpoint: normalizedRemoteUrl,
      networkScope: tailscaleScope,
      primary: true,
      models: [],
    };
    remoteTier.hosts.push(primaryHost);
    remoteHosts.push(primaryHost);
  }

  if (primaryHost) {
    primaryHost.endpoint = normalizedRemoteUrl;
    for (const host of remoteHosts) {
      host.primary = host === primaryHost;
    }
  }
}

let remoteCount = 0;
let reachableRemoteHosts = 0;
for (const host of remoteHosts) {
  if (!host?.endpoint || host.provider !== ollamaProviderId) {
    continue;
  }
  const result = updateHost(host.endpoint, remoteTierId, host.id, fetchTags(host.endpoint));
  remoteCount += result.count;
  if (result.reachable) {
    reachableRemoteHosts += 1;
  }
}

const openAiTier = registry.tiers.find((item) => item.id === openAiTierId);
const openAiHosts = Array.isArray(openAiTier?.hosts) ? openAiTier.hosts : [];

if (openAiLocalUrl && openAiTier) {
  const normalizedLocalOpenAi = openAiLocalUrl.replace(/\/$/, '');
  let localOpenAiHost = openAiHosts.find((host) => host?.id === localOpenAiHostId) || null;
  if (!localOpenAiHost) {
    localOpenAiHost = {
      id: localOpenAiHostId,
      label: 'Local OpenAI-compatible endpoint',
      provider: llamaCppLocalProviderId,
      endpoint: normalizedLocalOpenAi,
      networkScope: localhostScope,
      enabled: true,
      models: [],
    };
    openAiTier.hosts.push(localOpenAiHost);
    openAiHosts.push(localOpenAiHost);
  }
  localOpenAiHost.endpoint = normalizedLocalOpenAi;
}

if (openAiRemoteUrl && openAiTier) {
  const normalizedRemoteOpenAi = openAiRemoteUrl.replace(/\/$/, '');
  let remoteOpenAiHost = openAiHosts.find((host) => host?.primary === true) || null;
  const matchingOpenAiHost = openAiHosts.find((host) => (host?.endpoint || '').replace(/\/$/, '') === normalizedRemoteOpenAi) || null;
  if (matchingOpenAiHost) {
    remoteOpenAiHost = matchingOpenAiHost;
  }
  if (!remoteOpenAiHost) {
    remoteOpenAiHost = {
      id: remoteOpenAiHostId,
      label: 'Remote OpenAI-compatible endpoint',
      provider: sglangRemoteProviderId,
      endpoint: normalizedRemoteOpenAi,
      networkScope: tailscaleScope,
      primary: true,
      enabled: true,
      models: [],
    };
    openAiTier.hosts.push(remoteOpenAiHost);
    openAiHosts.push(remoteOpenAiHost);
  }
  remoteOpenAiHost.endpoint = normalizedRemoteOpenAi;
  remoteOpenAiHost.primary = true;
  for (const host of openAiHosts) {
    if (host !== remoteOpenAiHost) {
      host.primary = false;
    }
  }
}

let openAiCount = 0;
let reachableOpenAiHosts = 0;
for (const host of openAiHosts) {
  if (!host?.endpoint || host.enabled === false) {
    continue;
  }
  const result = updateHost(host.endpoint, openAiTierId, host.id, fetchOpenAiModels(host.endpoint));
  openAiCount += result.count;
  if (result.reachable) {
    reachableOpenAiHosts += 1;
  }
}

fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
console.log(`  synced platform models: local=${localResult.count} remote=${remoteCount} remote-hosts=${reachableRemoteHosts}/${remoteHosts.length} openai-compatible=${openAiCount} openai-hosts=${reachableOpenAiHosts}/${openAiHosts.length}`);
NODE
}