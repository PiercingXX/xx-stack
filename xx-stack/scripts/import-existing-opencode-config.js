#!/usr/bin/env node

const fs = require("fs");
const { HOST_IDS, NETWORK_SCOPES, PROVIDER_IDS, TIER_IDS } = require("./lib/runtime-constants.js");

const registryPath = process.env.REGISTRY_PATH;
const targetConfigPath = process.env.TARGET_CONFIG;
const recommendationsPath = process.env.RECOMMENDATIONS_PATH;

if (!registryPath || !targetConfigPath || !recommendationsPath) {
  console.error("missing required environment for prior config import");
  process.exit(1);
}

function writeFileAtomic(filePath, data) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, data);
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Nothing to clean up.
    }
    throw error;
  }
}

const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
const config = JSON.parse(fs.readFileSync(targetConfigPath, "utf8"));
const recommendations = fs.existsSync(recommendationsPath)
  ? JSON.parse(fs.readFileSync(recommendationsPath, "utf8"))
  : { profiles: [] };

function unique(names) {
  return [...new Set((names || []).filter(Boolean))];
}

function providerModelNames(providerValue) {
  const models = providerValue?.models;
  if (!models || typeof models !== "object") {
    return [];
  }
  return unique([
    ...Object.keys(models),
    ...Object.values(models)
      .map((model) => model?.name)
      .filter(Boolean),
  ]);
}

function ensureTierHost(tierId, providerId, hostTemplate) {
  const tier = registry.tiers.find((item) => item.id === tierId);
  if (!tier) {
    return null;
  }

  const normalizedTemplateEndpoint = (hostTemplate?.endpoint || "")
    .replace(/\/v1\/?$/, "")
    .replace(/\/$/, "");
  let host = tier.hosts.find((item) => item.id === providerId);
  if (!host && normalizedTemplateEndpoint) {
    host = tier.hosts.find(
      (item) =>
        (item?.endpoint || "").replace(/\/v1\/?$/, "").replace(/\/$/, "") ===
        normalizedTemplateEndpoint
    );
  }
  if (!host) {
    host = tier.hosts.find((item) => item.provider === providerId);
  }
  if (!host) {
    host = { ...hostTemplate, models: hostTemplate.models || [] };
    tier.hosts.push(host);
  }
  return host;
}

function mergeUniqueModels(existingModels, newModels) {
  const seen = new Set(existingModels.map((item) => item.name));
  for (const model of newModels) {
    if (!model || !model.name || seen.has(model.name)) {
      continue;
    }
    existingModels.push(model);
    seen.add(model.name);
  }
}

const providers = config.provider || {};
const disabledProviders = new Set(
  Array.isArray(config.disabled_providers) ? config.disabled_providers : []
);
let importedProviders = 0;
let importedModels = 0;

for (const [providerKey, providerValue] of Object.entries(providers)) {
  if (!providerValue || typeof providerValue !== "object") {
    continue;
  }

  const baseURL =
    providerValue.options?.baseURL || providerValue.baseURL || providerValue.url || "";
  const modelNames = new Set(providerModelNames(providerValue));

  for (const agent of Object.values(config.agent || {})) {
    if (!agent?.model || typeof agent.model !== "string") {
      continue;
    }
    const [agentProvider, agentModel] = agent.model.split("/", 2);
    if (agentProvider === providerKey && agentModel) {
      modelNames.add(agentModel);
    }
  }

  const modelEntries = [...modelNames].map((name) => ({
    name,
    roles: ["imported-from-config"],
    priority: "imported",
  }));

  if (providerKey === PROVIDER_IDS.ollamaLocal) {
    const host = ensureTierHost(TIER_IDS.local, HOST_IDS.localWorkstation, {
      id: HOST_IDS.localWorkstation,
      label: "Primary local machine",
      provider: PROVIDER_IDS.ollamaLocal,
      endpoint: baseURL ? baseURL.replace(/\/v1\/?$/, "") : "http://127.0.0.1:11434",
      networkScope: NETWORK_SCOPES.localhost,
      hardware: {
        summary: "Detected during setup",
        cpu: "Unknown",
        ram: "Unknown",
        gpu: [],
        limits: [],
      },
    });
    if (host) {
      host.endpoint = host.endpoint || "http://127.0.0.1:11434";
      mergeUniqueModels(host.models, modelEntries);
      importedProviders += 1;
      importedModels += modelEntries.length;
    }
    continue;
  }

  if (providerKey === PROVIDER_IDS.ollamaRemote || providerKey.startsWith("ollama-")) {
    const remoteHostId =
      providerKey === PROVIDER_IDS.ollamaRemote ? HOST_IDS.exampleGpuBox : providerKey;
    const remoteHostLabel =
      providerKey === PROVIDER_IDS.ollamaRemote
        ? providerValue.name || "Imported remote Ollama server"
        : providerValue.name || `Imported remote Ollama server (${providerKey})`;
    const host = ensureTierHost(TIER_IDS.tailscaleOllama, remoteHostId, {
      id: remoteHostId,
      label: remoteHostLabel,
      provider: providerKey,
      endpoint: baseURL ? baseURL.replace(/\/v1\/?$/, "") : "http://REMOTE_HOST:11434",
      networkScope: NETWORK_SCOPES.tailscale,
      primary: providerKey === PROVIDER_IDS.ollamaRemote,
      hardware: {
        summary: "Imported from prior OpenCode config",
        cpu: "Unknown",
        ram: "Unknown",
        gpu: [],
        limits: [],
      },
      models: [],
    });
    if (host) {
      if (baseURL) {
        host.endpoint = baseURL.replace(/\/v1\/?$/, "");
      }
      host.primary = providerKey === PROVIDER_IDS.ollamaRemote;
      mergeUniqueModels(host.models, modelEntries);
      importedProviders += 1;
      importedModels += modelEntries.length;
    }
    continue;
  }

  const host = ensureTierHost("cloud", providerKey, {
    id: `${providerKey}-imported`,
    label: providerValue.name || `${providerKey} imported from OpenCode config`,
    provider: providerKey,
    endpoint: baseURL || `https://${providerKey}.invalid`,
    networkScope: "internet",
    enabled: !disabledProviders.has(providerKey),
    costProfile: "variable",
    delegationPolicy: {
      preferredTaskTypes: ["provider-specific tasks", "imported from prior config"],
      avoidTaskTypes: ["local-first tasks when self-hosted models are sufficient"],
    },
    routingPolicy: {
      useWhen: [
        "Imported from prior OpenCode config; preserve user preference until explicitly changed",
      ],
      avoidWhen: ["Local or remote self-hosted tiers satisfy the request"],
    },
    models: [],
  });

  if (host) {
    host.enabled = !disabledProviders.has(providerKey);
    if (baseURL) {
      host.endpoint = baseURL;
    }
    mergeUniqueModels(host.models, modelEntries);
    importedProviders += 1;
    importedModels += modelEntries.length;
  }
}

const localHost = registry.tiers
  .find((item) => item.id === TIER_IDS.local)
  ?.hosts?.find((item) => item.id === HOST_IDS.localWorkstation);
if (localHost) {
  const totalGpuVramGb = Number(localHost.hardware?.detected?.totalGpuVramGb || 0);
  const matchedProfile = recommendations.profiles.find(
    (profile) => totalGpuVramGb >= Number(profile.match?.gpuVramGbMin || 0)
  );
  if (matchedProfile && Array.isArray(matchedProfile.recommendedModels)) {
    localHost.recommendations = matchedProfile.recommendedModels;
  }
}

writeFileAtomic(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
console.log(`  imported prior config: providers=${importedProviders} models=${importedModels}`);
