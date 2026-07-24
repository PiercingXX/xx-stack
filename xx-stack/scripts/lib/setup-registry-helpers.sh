disable_llama_cpp_hosts_in_registry() {
  local registry_path="$1"

  if [ -z "$registry_path" ] || [ ! -f "$registry_path" ]; then
    return 0
  fi

  if ! command -v node >/dev/null 2>&1; then
    return 0
  fi

  REGISTRY_PATH="$registry_path" node <<'NODE'
const fs = require('fs');

try {
  const registryPath = process.env.REGISTRY_PATH;
  const openAiTierId = process.env.XX_STACK_TIER_TAILSCALE_OPENAI_COMPATIBLE;
  const llamaCppLocalProviderId = process.env.XX_STACK_PROVIDER_LLAMA_CPP_LOCAL;
  const sglangRemoteProviderId = process.env.XX_STACK_PROVIDER_SGLANG_REMOTE;
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const tier = registry.tiers?.find((item) => item.id === openAiTierId);
  if (!tier || !Array.isArray(tier.hosts)) {
    process.exit(0);
  }

  for (const host of tier.hosts) {
    if (host?.provider === llamaCppLocalProviderId || host?.provider === sglangRemoteProviderId) {
      host.enabled = false;
      host.reachable = false;
    }
  }

  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
} catch {}
NODE
}

setup_llama_cpp_host() {
  local registry_path="$1"
  local local_endpoint="$2"
  local remote_endpoint="$3"

  if [ -z "$registry_path" ] || [ ! -f "$registry_path" ]; then
    echo "warning: platform registry not found for llama.cpp setup: $registry_path" >&2
    return 1
  fi

  local local_models_ok=1
  local remote_models_ok=1
  check_openai_compatible_endpoint "local llama.cpp" "$local_endpoint" || local_models_ok=$?
  check_openai_compatible_endpoint "remote llama.cpp" "$remote_endpoint" || remote_models_ok=$?
  check_llama_cpp_health_endpoint "local llama.cpp" "$local_endpoint" || true
  check_llama_cpp_health_endpoint "remote llama.cpp" "$remote_endpoint" || true

  if ! command -v node >/dev/null 2>&1; then
    echo "warning: node not found; skipping llama.cpp host registration." >&2
    return 1
  fi

  REGISTRY_PATH="$registry_path" LOCAL_ENDPOINT="$local_endpoint" REMOTE_ENDPOINT="$remote_endpoint" LLAMA_CPP_MODEL_DIR="$LLAMA_CPP_MODEL_DIR" LLAMA_CPP_RUNTIME_CHANNEL="$LLAMA_CPP_RUNTIME_CHANNEL" node <<'NODE'
const fs = require('fs');

const registryPath = process.env.REGISTRY_PATH;
const openAiTierId = process.env.XX_STACK_TIER_TAILSCALE_OPENAI_COMPATIBLE;
const localOpenAiHostId = process.env.XX_STACK_HOST_LOCAL_OPENAI_COMPATIBLE;
const remoteOpenAiHostId = process.env.XX_STACK_HOST_TAILSCALE_OPENAI_COMPATIBLE_PRIMARY;
const llamaCppLocalProviderId = process.env.XX_STACK_PROVIDER_LLAMA_CPP_LOCAL;
const sglangRemoteProviderId = process.env.XX_STACK_PROVIDER_SGLANG_REMOTE;
const localhostScope = process.env.XX_STACK_NETWORK_SCOPE_LOCALHOST;
const tailscaleScope = process.env.XX_STACK_NETWORK_SCOPE_TAILSCALE;
const localEndpoint = (process.env.LOCAL_ENDPOINT || '').trim().replace(/\/$/, '');
const remoteEndpoint = (process.env.REMOTE_ENDPOINT || '').trim().replace(/\/$/, '');
const modelDir = (process.env.LLAMA_CPP_MODEL_DIR || '').trim();
const runtimeChannel = (process.env.LLAMA_CPP_RUNTIME_CHANNEL || 'stable').trim() || 'stable';
const allowMultiModel = process.env.XX_STACK_ALLOW_MULTI_MODEL === '1';

function normalize(url) {
  if (!url || typeof url !== 'string') return '';
  return url.trim().replace(/\/v1\/?$/, '').replace(/\/$/, '');
}

function inferQuantization(modelName) {
  const value = modelName.toLowerCase();
  if (value.includes('tq1_0') || value.includes('tq1')) return 'tq1_0';
  if (value.includes('tq2_0') || value.includes('tq2')) return 'tq2_0';
  if (value.includes('q8_0')) return 'q8_0';
  if (value.includes('q5_k_m')) return 'q5_k_m';
  if (value.includes('q4_k_m')) return 'q4_k_m';
  return 'unknown';
}

function inferEstimatedVramGb(quantization) {
  if (quantization === 'q8_0') return 14;
  if (quantization === 'q5_k_m') return 10;
  if (quantization === 'q4_k_m') return 8;
  if (quantization === 'tq2_0') return 5;
  if (quantization === 'tq1_0') return 4;
  return 8;
}

function buildGgufInventory() {
  if (!modelDir) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(modelDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.gguf'))
    .map((entry) => {
      const quantization = inferQuantization(entry.name);
      return {
        name: entry.name,
        roles: ['general'],
        priority: 'discovered',
        format: 'gguf',
        quantization,
        contextWindow: 32768,
        estimatedVramGb: inferEstimatedVramGb(quantization),
        supportsToolUse: !(quantization === 'tq1_0' || quantization === 'tq2_0'),
      };
    });
}

try {
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  if (!Array.isArray(registry.tiers)) {
    registry.tiers = [];
  }

  let tier = registry.tiers.find((item) => item.id === openAiTierId);
  if (!tier) {
    tier = {
      id: openAiTierId,
      label: 'Tailscale OpenAI-compatible endpoints',
      priority: 3,
      usageGuidance: 'Use for llama-server or LocalAI lanes that expose /v1 endpoints.',
      hosts: [],
    };
    registry.tiers.push(tier);
  }

  if (!Array.isArray(tier.hosts)) {
    tier.hosts = [];
  }

  const ensureHost = (hostId, label, provider, endpoint, networkScope, primary) => {
    const normalizedEndpoint = normalize(endpoint);
    let host = tier.hosts.find((item) => item.id === hostId)
      || tier.hosts.find((item) => normalize(item.endpoint) === normalizedEndpoint && normalizedEndpoint);

    if (!host) {
      host = {
        id: hostId,
        label,
        provider,
        endpoint: normalizedEndpoint,
        networkScope,
        primary,
        enabled: true,
        executionPolicy: {
          maxParallelSlices: 1,
          maxConcurrentModels: allowMultiModel ? 2 : 1,
          contextReservePercent: 25,
          scheduling: 'balanced',
        },
        capabilities: {
          endpointFamily: 'openai-compatible',
          supportsResidentModelInspection: false,
          runtimeChannel,
        },
        models: [],
      };
      tier.hosts.push(host);
    }

    if (normalizedEndpoint) {
      host.endpoint = normalizedEndpoint;
    }
    host.label = host.label || label;
    host.provider = provider;
    host.networkScope = networkScope;
    host.primary = primary;
    host.enabled = true;
    host.executionPolicy = {
      ...(host.executionPolicy || {}),
      maxParallelSlices: Number(host.executionPolicy?.maxParallelSlices || 1),
      maxConcurrentModels: allowMultiModel ? Math.max(1, Number(host.executionPolicy?.maxConcurrentModels || 2)) : 1,
      contextReservePercent: Number(host.executionPolicy?.contextReservePercent || 25),
      scheduling: host.executionPolicy?.scheduling || 'balanced',
    };
    host.capabilities = {
      ...(host.capabilities || {}),
      endpointFamily: 'openai-compatible',
      supportsResidentModelInspection: false,
      runtimeChannel,
    };
    if (!Array.isArray(host.models)) {
      host.models = [];
    }

    return host;
  };

  const localHost = localEndpoint
    ? ensureHost(localOpenAiHostId, 'Local llama.cpp endpoint', llamaCppLocalProviderId, localEndpoint, localhostScope, false)
    : null;
  const remoteHost = remoteEndpoint
    ? ensureHost(remoteOpenAiHostId, 'Tailscale llama.cpp endpoint', sglangRemoteProviderId, remoteEndpoint, tailscaleScope, true)
    : null;

  if (remoteHost) {
    for (const host of tier.hosts) {
      if (host !== remoteHost && host.id === remoteOpenAiHostId) {
        host.primary = false;
      }
    }
  }

  if (localHost && modelDir) {
    localHost.models = buildGgufInventory();
    localHost.modelSource = modelDir;
  }

  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
} catch {}
NODE

  if [ "$local_models_ok" != "0" ] && [ "$remote_models_ok" != "0" ]; then
    echo "warning: no reachable llama.cpp endpoints detected; disabling llama.cpp hosts in registry and falling back to Ollama lane." >&2
    disable_llama_cpp_hosts_in_registry "$registry_path"
    return 1
  fi

  return 0
}

apply_llama_cpp_rollout_phase() {
  local registry_path="$1"

  if [ -z "$registry_path" ] || [ ! -f "$registry_path" ]; then
    return 0
  fi

  if ! command -v node >/dev/null 2>&1; then
    return 0
  fi

  REGISTRY_PATH="$registry_path" LLAMA_CPP_ROLLOUT_PHASE="$LLAMA_CPP_ROLLOUT_PHASE" XX_STACK_ENABLE_LLAMA_CPP="$XX_STACK_ENABLE_LLAMA_CPP" XX_STACK_LLAMA_CPP_DEFAULT_ON="$XX_STACK_LLAMA_CPP_DEFAULT_ON" node <<'NODE'
const fs = require('fs');

const registryPath = process.env.REGISTRY_PATH;
const localTierId = process.env.XX_STACK_TIER_LOCAL;
const remoteTierId = process.env.XX_STACK_TIER_TAILSCALE_OLLAMA;
const openAiTierId = process.env.XX_STACK_TIER_TAILSCALE_OPENAI_COMPATIBLE;
const cloudTierId = process.env.XX_STACK_TIER_CLOUD;
const llamaCppLocalProviderId = process.env.XX_STACK_PROVIDER_LLAMA_CPP_LOCAL;
const sglangRemoteProviderId = process.env.XX_STACK_PROVIDER_SGLANG_REMOTE;
const phase = Number(process.env.LLAMA_CPP_ROLLOUT_PHASE || '1');
const enableFlag = process.env.XX_STACK_ENABLE_LLAMA_CPP === '1';
const defaultOn = process.env.XX_STACK_LLAMA_CPP_DEFAULT_ON === '1';

try {
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  registry.rollout = registry.rollout || {};
  registry.rollout.llamaCpp = {
    phase,
    enableFlag,
    defaultOn,
    updatedAt: new Date().toISOString(),
  };

  const openAiTier = registry.tiers?.find((item) => item.id === openAiTierId);
  const openAiHosts = Array.isArray(openAiTier?.hosts) ? openAiTier.hosts : [];
  for (const host of openAiHosts) {
    if (host?.provider === llamaCppLocalProviderId || host?.provider === sglangRemoteProviderId) {
      host.rollout = {
        ...(host.rollout || {}),
        phase,
        canaryEligible: phase >= 2,
      };
      if (phase === 0 && !enableFlag) {
        host.enabled = false;
      }
    }
  }

  registry.selectionPolicy = registry.selectionPolicy || {};
  registry.selectionPolicy.defaultOrder = Array.isArray(registry.selectionPolicy.defaultOrder)
    ? registry.selectionPolicy.defaultOrder
    : [localTierId, remoteTierId, openAiTierId, cloudTierId];
  registry.selectionPolicy.rules = Array.isArray(registry.selectionPolicy.rules)
    ? registry.selectionPolicy.rules
    : [];

  const canaryRuleName = 'Canary route eligible llama.cpp tasks';
  const hasCanaryRule = registry.selectionPolicy.rules.some((rule) => rule?.name === canaryRuleName);
  if (phase >= 2 && !hasCanaryRule) {
    registry.selectionPolicy.rules.push({
      name: canaryRuleName,
      when: 'canary, eligible assistant or research transforms, llama-cpp enabled',
      preferTier: openAiTierId,
    });
  }

  if (phase < 2 && hasCanaryRule) {
    registry.selectionPolicy.rules = registry.selectionPolicy.rules.filter((rule) => rule?.name !== canaryRuleName);
  }

  if (phase >= 3 && defaultOn) {
    const order = registry.selectionPolicy.defaultOrder.filter((item) => item !== openAiTierId);
    const remoteOllamaIndex = order.indexOf(remoteTierId);
    if (remoteOllamaIndex >= 0) {
      order.splice(remoteOllamaIndex, 0, openAiTierId);
    } else {
      order.push(openAiTierId);
    }
    registry.selectionPolicy.defaultOrder = order;
  }

  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
} catch {}
NODE
}

persist_openai_compatible_hosts_in_registry() {
  local registry_path="$1"
  local local_endpoint="$2"
  local remote_endpoint="$3"
  local backend_lane="$4"

  if [ -z "$registry_path" ] || [ ! -f "$registry_path" ]; then
    return 0
  fi

  if ! command -v node >/dev/null 2>&1; then
    return 0
  fi

  REGISTRY_PATH="$registry_path" LOCAL_ENDPOINT="$local_endpoint" REMOTE_ENDPOINT="$remote_endpoint" BACKEND_LANE="$backend_lane" node <<'NODE'
const fs = require('fs');

const registryPath = process.env.REGISTRY_PATH;
const openAiTierId = process.env.XX_STACK_TIER_TAILSCALE_OPENAI_COMPATIBLE;
const cloudTierId = process.env.XX_STACK_TIER_CLOUD;
const localOpenAiHostId = process.env.XX_STACK_HOST_LOCAL_OPENAI_COMPATIBLE;
const remoteOpenAiHostId = process.env.XX_STACK_HOST_TAILSCALE_OPENAI_COMPATIBLE_PRIMARY;
const llamaCppLocalProviderId = process.env.XX_STACK_PROVIDER_LLAMA_CPP_LOCAL;
const sglangRemoteProviderId = process.env.XX_STACK_PROVIDER_SGLANG_REMOTE;
const localAiLocalProviderId = process.env.XX_STACK_PROVIDER_LOCALAI_LOCAL;
const localAiRemoteProviderId = process.env.XX_STACK_PROVIDER_LOCALAI_REMOTE;
const localhostScope = process.env.XX_STACK_NETWORK_SCOPE_LOCALHOST;
const tailscaleScope = process.env.XX_STACK_NETWORK_SCOPE_TAILSCALE;
const localEndpoint = (process.env.LOCAL_ENDPOINT || '').trim().replace(/\/$/, '');
const remoteEndpoint = (process.env.REMOTE_ENDPOINT || '').trim().replace(/\/$/, '');
const backend = (process.env.BACKEND_LANE || '').trim();

function normalize(url) {
  if (!url || typeof url !== 'string') return '';
  return url.trim().replace(/\/v1\/?$/, '').replace(/\/$/, '');
}

try {
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));

  if (!Array.isArray(registry.tiers)) {
    registry.tiers = [];
  }

  let tier = registry.tiers.find((item) => item.id === openAiTierId);
  if (!tier) {
    tier = {
      id: openAiTierId,
      label: 'Tailscale OpenAI-compatible endpoints',
      priority: 3,
      usageGuidance: 'Use for llama-server or LocalAI lanes that expose /v1 endpoints.',
      hosts: [],
    };
    registry.tiers.push(tier);
  }

  if (!Array.isArray(tier.hosts)) {
    tier.hosts = [];
  }

  const localProvider = backend === 'localai' ? localAiLocalProviderId : llamaCppLocalProviderId;
  const remoteProvider = backend === 'localai' ? localAiRemoteProviderId : sglangRemoteProviderId;

  const ensureHost = (hostId, label, provider, endpoint, primary, networkScope) => {
    const normalizedEndpoint = normalize(endpoint);
    let host = tier.hosts.find((item) => item.id === hostId)
      || tier.hosts.find((item) => normalize(item.endpoint) === normalizedEndpoint && normalizedEndpoint);

    if (!host) {
      host = {
        id: hostId,
        label,
        provider,
        endpoint: normalizedEndpoint,
        networkScope,
        primary,
        enabled: true,
        executionPolicy: {
          maxParallelSlices: 1,
          maxConcurrentModels: 2,
          contextReservePercent: 25,
          scheduling: 'balanced',
        },
        capabilities: {
          endpointFamily: 'openai-compatible',
          supportsResidentModelInspection: false,
        },
        models: [],
      };
      tier.hosts.push(host);
    }

    if (normalizedEndpoint) {
      host.endpoint = normalizedEndpoint;
    }
    host.provider = provider;
    host.label = host.label || label;
    host.networkScope = host.networkScope || networkScope;
    host.enabled = true;
    host.primary = primary;
    host.capabilities = {
      ...(host.capabilities || {}),
      endpointFamily: 'openai-compatible',
      supportsResidentModelInspection: false,
    };
    host.executionPolicy = {
      maxParallelSlices: Number(host.executionPolicy?.maxParallelSlices || 1),
      maxConcurrentModels: Number(host.executionPolicy?.maxConcurrentModels || 1),
      contextReservePercent: Number(host.executionPolicy?.contextReservePercent || 25),
      scheduling: host.executionPolicy?.scheduling || 'balanced',
    };
    if (!Array.isArray(host.models)) {
      host.models = [];
    }
    return host;
  };

  const normalizedLocal = normalize(localEndpoint);
  const normalizedRemote = normalize(remoteEndpoint);

  if (normalizedLocal) {
    ensureHost(
      localOpenAiHostId,
      backend === 'localai' ? 'Local LocalAI endpoint' : 'Local llama.cpp endpoint',
      localProvider,
      normalizedLocal,
      false,
      localhostScope
    );
  }

  if (normalizedRemote) {
    ensureHost(
      remoteOpenAiHostId,
      backend === 'localai' ? 'Tailscale LocalAI endpoint' : 'Tailscale llama.cpp endpoint',
      remoteProvider,
      normalizedRemote,
      true,
      tailscaleScope
    );
  }

  if (!registry.selectionPolicy || !Array.isArray(registry.selectionPolicy.defaultOrder)) {
    registry.selectionPolicy = registry.selectionPolicy || { defaultOrder: [], rules: [] };
    registry.selectionPolicy.defaultOrder = registry.selectionPolicy.defaultOrder || [];
  }

  if (!registry.selectionPolicy.defaultOrder.includes(openAiTierId)) {
    const cloudIndex = registry.selectionPolicy.defaultOrder.indexOf(cloudTierId);
    if (cloudIndex >= 0) {
      registry.selectionPolicy.defaultOrder.splice(cloudIndex, 0, openAiTierId);
    } else {
      registry.selectionPolicy.defaultOrder.push(openAiTierId);
    }
  }

  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
} catch {
  process.exit(0);
}
NODE
}

install_platform_registry() {
  local source_registry="$1"
  local target_registry="$2"

  if [ ! -f "$source_registry" ]; then
    echo "warning: platform registry not found: $source_registry" >&2
    return 1
  fi

  mkdir -p "$(dirname "$target_registry")"
  cp -f "$source_registry" "$target_registry"
  echo "  installed platform registry: $target_registry"
}