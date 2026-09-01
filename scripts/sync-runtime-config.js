#!/usr/bin/env node

const fs = require("fs");
const { HOST_IDS, PROVIDER_IDS, TIER_IDS } = require("./lib/runtime-constants.js");
const {
  agentModelNames,
  applyAgentAssignments,
  buildAvailableModelsByProvider,
  ensureProvider,
  hostModelNames,
  isCodingModel,
  isReasoningKeep,
  isTurboQuantModel,
  keepModel,
  preserveControllerModel,
  primaryTierHost,
  providerModelNames,
  providerTierHost,
  registryHostModels,
  registryHostReachable,
  registryTierHosts,
  setAgentModelFromCandidates,
  toModelMap,
  unique,
} = require("./lib/runtime-config-sync-helpers.js");
const { buildSyncPolicy } = require("./lib/runtime-config-sync-policy.js");

const registryPath = process.env.REGISTRY_PATH;
const sourceConfigPath = process.env.SOURCE_CONFIG;
const targetConfigPath = process.env.TARGET_CONFIG;
const localUrl = process.env.LOCAL_URL;
const remoteUrl = process.env.REMOTE_URL;
const localOpenAiUrl = process.env.LOCAL_OPENAI_URL;
const remoteOpenAiUrl = process.env.REMOTE_OPENAI_URL;

const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
const source = JSON.parse(fs.readFileSync(sourceConfigPath, "utf8"));
const config = JSON.parse(fs.readFileSync(targetConfigPath, "utf8"));
const OLLAMA_LOCAL_PROVIDER = PROVIDER_IDS.ollamaLocal;
const OLLAMA_REMOTE_PROVIDER = PROVIDER_IDS.ollamaRemote;
// Legacy provider id some user configs still carry. Not a shipped constant.
// Expire this shim once no live ~/.config/opencode config names ollama-5090
// (target: drop in 1.68.0 if unused).
const OLLAMA_5090_PROVIDER = "ollama-5090";
const LLAMA_CPP_LOCAL_PROVIDER = PROVIDER_IDS.llamaCppLocal;
const SGLANG_REMOTE_PROVIDER = PROVIDER_IDS.sglangRemote;
const CLOUD_TIER = TIER_IDS.cloud;

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

function buildInventorySnapshot() {
  const localDiscovered = registryHostModels(registry, TIER_IDS.local, HOST_IDS.localWorkstation);
  const remotePrimaryHost = primaryTierHost(registry, TIER_IDS.tailscaleOllama);
  const remotePrimaryDiscovered = remotePrimaryHost ? hostModelNames(remotePrimaryHost) : [];
  const remoteReachable = remotePrimaryHost
    ? registryHostReachable(registry, TIER_IDS.tailscaleOllama, remotePrimaryHost.id)
    : false;
  const remote5090Host = providerTierHost(registry, TIER_IDS.tailscaleOllama, OLLAMA_5090_PROVIDER);
  const remote5090Discovered = remote5090Host ? hostModelNames(remote5090Host) : [];
  const remote5090Reachable = remote5090Host
    ? registryHostReachable(registry, TIER_IDS.tailscaleOllama, remote5090Host.id)
    : false;
  const openAiLocalHost = providerTierHost(
    registry,
    TIER_IDS.tailscaleOpenAiCompatible,
    LLAMA_CPP_LOCAL_PROVIDER
  );
  const openAiLocalDiscovered = openAiLocalHost ? hostModelNames(openAiLocalHost) : [];
  const openAiLocalReachable = openAiLocalHost
    ? registryHostReachable(registry, TIER_IDS.tailscaleOpenAiCompatible, openAiLocalHost.id)
    : false;
  const openAiRemoteHost =
    providerTierHost(registry, TIER_IDS.tailscaleOpenAiCompatible, SGLANG_REMOTE_PROVIDER, {
      reachableOnly: true,
    }) || primaryTierHost(registry, TIER_IDS.tailscaleOpenAiCompatible);
  const openAiRemoteDiscovered = openAiRemoteHost ? hostModelNames(openAiRemoteHost) : [];
  const openAiRemoteReachable = openAiRemoteHost
    ? registryHostReachable(registry, TIER_IDS.tailscaleOpenAiCompatible, openAiRemoteHost.id)
    : false;

  const remoteConfiguredNames = unique(
    remotePrimaryDiscovered.length > 0
      ? [
          ...remotePrimaryDiscovered,
          ...providerModelNames(config, OLLAMA_REMOTE_PROVIDER),
          ...providerModelNames(source, OLLAMA_REMOTE_PROVIDER),
        ]
      : [
          ...providerModelNames(config, OLLAMA_REMOTE_PROVIDER),
          ...providerModelNames(source, OLLAMA_REMOTE_PROVIDER),
        ]
  );
  const remote5090ConfiguredNames = unique(
    remote5090Discovered.length > 0
      ? [
          ...remote5090Discovered,
          ...providerModelNames(config, OLLAMA_5090_PROVIDER),
          ...providerModelNames(source, OLLAMA_5090_PROVIDER),
        ]
      : [
          ...providerModelNames(config, OLLAMA_5090_PROVIDER),
          ...providerModelNames(source, OLLAMA_5090_PROVIDER),
        ]
  );
  const openAiLocalConfiguredNames = unique(
    openAiLocalDiscovered.length > 0
      ? [
          ...openAiLocalDiscovered,
          ...providerModelNames(config, LLAMA_CPP_LOCAL_PROVIDER),
          ...providerModelNames(source, LLAMA_CPP_LOCAL_PROVIDER),
        ]
      : [
          ...providerModelNames(config, LLAMA_CPP_LOCAL_PROVIDER),
          ...providerModelNames(source, LLAMA_CPP_LOCAL_PROVIDER),
        ]
  );
  const openAiRemoteConfiguredNames = unique(
    openAiRemoteDiscovered.length > 0
      ? [
          ...openAiRemoteDiscovered,
          ...providerModelNames(config, SGLANG_REMOTE_PROVIDER),
          ...providerModelNames(source, SGLANG_REMOTE_PROVIDER),
        ]
      : [
          ...providerModelNames(config, SGLANG_REMOTE_PROVIDER),
          ...providerModelNames(source, SGLANG_REMOTE_PROVIDER),
        ]
  );

  return {
    localDiscovered,
    localInventoryPresent: localDiscovered.length > 0,
    openAiLocalDiscovered,
    openAiLocalHost,
    openAiLocalInventoryPresent: openAiLocalReachable && openAiLocalConfiguredNames.length > 0,
    openAiLocalReachable,
    openAiRemoteDiscovered,
    openAiRemoteHost,
    openAiRemoteInventoryPresent: openAiRemoteReachable && openAiRemoteConfiguredNames.length > 0,
    openAiRemoteReachable,
    remote5090Discovered,
    remote5090Host,
    remote5090InventoryPresent: remote5090Reachable && remote5090ConfiguredNames.length > 0,
    remote5090Reachable,
    remotePrimaryDiscovered,
    remotePrimaryHost,
    remoteInventoryPresent: remoteReachable && remoteConfiguredNames.length > 0,
    remoteReachable,
  };
}

function buildRequiredModelSets(inventory) {
  return {
    localRequired: new Set([
      ...agentModelNames(config, OLLAMA_LOCAL_PROVIDER),
      ...agentModelNames(source, OLLAMA_LOCAL_PROVIDER),
      ...agentModelNames(config, LLAMA_CPP_LOCAL_PROVIDER),
      ...agentModelNames(source, LLAMA_CPP_LOCAL_PROVIDER),
    ]),
    remoteRequired: new Set(
      inventory.remoteInventoryPresent
        ? [
            ...agentModelNames(config, OLLAMA_REMOTE_PROVIDER).filter(
              (name) => isCodingModel(name) || isReasoningKeep(name)
            ),
            ...agentModelNames(source, OLLAMA_REMOTE_PROVIDER).filter(
              (name) => isCodingModel(name) || isReasoningKeep(name)
            ),
          ]
        : []
    ),
    remote5090Required: new Set(
      inventory.remote5090InventoryPresent
        ? [
            ...agentModelNames(config, OLLAMA_5090_PROVIDER).filter(
              (name) => isCodingModel(name) || isReasoningKeep(name)
            ),
            ...agentModelNames(source, OLLAMA_5090_PROVIDER).filter(
              (name) => isCodingModel(name) || isReasoningKeep(name)
            ),
          ]
        : []
    ),
    openAiLocalRequired: new Set(
      inventory.openAiLocalInventoryPresent
        ? [
            ...agentModelNames(config, LLAMA_CPP_LOCAL_PROVIDER).filter(
              (name) => isCodingModel(name) || isReasoningKeep(name) || isTurboQuantModel(name)
            ),
            ...agentModelNames(source, LLAMA_CPP_LOCAL_PROVIDER).filter(
              (name) => isCodingModel(name) || isReasoningKeep(name) || isTurboQuantModel(name)
            ),
          ]
        : []
    ),
    openAiRemoteRequired: new Set(
      inventory.openAiRemoteInventoryPresent
        ? [
            ...agentModelNames(config, SGLANG_REMOTE_PROVIDER).filter(
              (name) => isCodingModel(name) || isReasoningKeep(name) || isTurboQuantModel(name)
            ),
            ...agentModelNames(source, SGLANG_REMOTE_PROVIDER).filter(
              (name) => isCodingModel(name) || isReasoningKeep(name) || isTurboQuantModel(name)
            ),
          ]
        : []
    ),
  };
}

function buildModelSets(inventory, required) {
  const localNames = unique(
    inventory.localInventoryPresent
      ? [...inventory.localDiscovered, ...required.localRequired]
      : [
          ...providerModelNames(config, OLLAMA_LOCAL_PROVIDER),
          ...providerModelNames(source, OLLAMA_LOCAL_PROVIDER),
          ...required.localRequired,
        ]
  ).filter((name) => keepModel(name, required.localRequired));

  const remoteNames = unique(
    inventory.remotePrimaryDiscovered.length > 0
      ? [...inventory.remotePrimaryDiscovered, ...required.remoteRequired]
      : [
          ...providerModelNames(config, OLLAMA_REMOTE_PROVIDER),
          ...providerModelNames(source, OLLAMA_REMOTE_PROVIDER),
          ...required.remoteRequired,
        ]
  ).filter((name) => keepModel(name, required.remoteRequired));

  const remote5090Names = unique(
    inventory.remote5090Discovered.length > 0
      ? [...inventory.remote5090Discovered, ...required.remote5090Required]
      : [
          ...providerModelNames(config, OLLAMA_5090_PROVIDER),
          ...providerModelNames(source, OLLAMA_5090_PROVIDER),
          ...required.remote5090Required,
        ]
  ).filter((name) => keepModel(name, required.remote5090Required));

  const openAiLocalNames = unique(
    inventory.openAiLocalDiscovered.length > 0
      ? [...inventory.openAiLocalDiscovered, ...required.openAiLocalRequired]
      : [
          ...providerModelNames(config, LLAMA_CPP_LOCAL_PROVIDER),
          ...providerModelNames(source, LLAMA_CPP_LOCAL_PROVIDER),
          ...required.openAiLocalRequired,
        ]
  ).filter((name) => keepModel(name, required.openAiLocalRequired));

  const openAiRemoteNames = unique(
    inventory.openAiRemoteDiscovered.length > 0
      ? [...inventory.openAiRemoteDiscovered, ...required.openAiRemoteRequired]
      : [
          ...providerModelNames(config, SGLANG_REMOTE_PROVIDER),
          ...providerModelNames(source, SGLANG_REMOTE_PROVIDER),
          ...required.openAiRemoteRequired,
        ]
  ).filter((name) => keepModel(name, required.openAiRemoteRequired));

  return {
    localNames,
    openAiLocalNames,
    openAiLocalUsableNames: inventory.openAiLocalReachable ? openAiLocalNames : [],
    openAiRemoteNames,
    openAiRemoteUsableNames: inventory.openAiRemoteReachable ? openAiRemoteNames : [],
    remote5090Names,
    remote5090UsableNames: inventory.remote5090Reachable ? remote5090Names : [],
    remoteNames,
    remoteUsableNames: inventory.remoteReachable ? remoteNames : [],
  };
}

function buildCloudProviders() {
  return registryTierHosts(registry, CLOUD_TIER)
    .filter((host) => host?.enabled !== false && host?.provider)
    .map((host) => {
      const providerId = host.provider;
      const availableNames = unique([
        ...hostModelNames(host),
        ...providerModelNames(config, providerId),
        ...providerModelNames(source, providerId),
        ...agentModelNames(config, providerId),
        ...agentModelNames(source, providerId),
      ]);
      return { providerId, host, availableNames };
    })
    .filter((entry) => entry.availableNames.length > 0);
}

function syncProviders(modelSets, inventory, cloudProviders) {
  const localProvider = ensureProvider(config, OLLAMA_LOCAL_PROVIDER, "Ollama-Local", localUrl);
  const remoteProvider = ensureProvider(
    config,
    OLLAMA_REMOTE_PROVIDER,
    inventory.remotePrimaryHost?.label || "Ollama-Remote-Primary",
    remoteUrl || inventory.remotePrimaryHost?.endpoint || ""
  );
  const remote5090BaseUrl =
    inventory.remote5090Host?.endpoint ||
    config.provider?.[OLLAMA_5090_PROVIDER]?.options?.baseURL?.replace(/\/v1\/?$/, "") ||
    source.provider?.[OLLAMA_5090_PROVIDER]?.options?.baseURL?.replace(/\/v1\/?$/, "") ||
    "";
  const remote5090Provider =
    remote5090BaseUrl ||
    config.provider?.[OLLAMA_5090_PROVIDER] ||
    source.provider?.[OLLAMA_5090_PROVIDER]
      ? ensureProvider(
          config,
          OLLAMA_5090_PROVIDER,
          inventory.remote5090Host?.label || "Ollama-Remote-5090",
          remote5090BaseUrl
        )
      : null;
  const openAiLocalProvider =
    localOpenAiUrl ||
    inventory.openAiLocalHost ||
    config.provider?.[LLAMA_CPP_LOCAL_PROVIDER] ||
    source.provider?.[LLAMA_CPP_LOCAL_PROVIDER]
      ? ensureProvider(
          config,
          LLAMA_CPP_LOCAL_PROVIDER,
          inventory.openAiLocalHost?.label || "TurboQuant-llama.cpp-Local",
          localOpenAiUrl || inventory.openAiLocalHost?.endpoint || ""
        )
      : null;
  const openAiRemoteProvider =
    remoteOpenAiUrl ||
    inventory.openAiRemoteHost ||
    config.provider?.[SGLANG_REMOTE_PROVIDER] ||
    source.provider?.[SGLANG_REMOTE_PROVIDER]
      ? ensureProvider(
          config,
          SGLANG_REMOTE_PROVIDER,
          inventory.openAiRemoteHost?.label || "TurboQuant-llama.cpp-Remote",
          remoteOpenAiUrl || inventory.openAiRemoteHost?.endpoint || ""
        )
      : null;

  localProvider.models = toModelMap(modelSets.localNames, localProvider.models);
  remoteProvider.models = toModelMap(modelSets.remoteNames, remoteProvider.models);
  if (remote5090Provider) {
    remote5090Provider.models = toModelMap(modelSets.remote5090Names, remote5090Provider.models);
  }
  if (openAiLocalProvider) {
    openAiLocalProvider.models = toModelMap(modelSets.openAiLocalNames, openAiLocalProvider.models);
  }
  if (openAiRemoteProvider) {
    openAiRemoteProvider.models = toModelMap(
      modelSets.openAiRemoteNames,
      openAiRemoteProvider.models
    );
  }

  return buildAvailableModelsByProvider([
    [LLAMA_CPP_LOCAL_PROVIDER, modelSets.openAiLocalNames],
    [SGLANG_REMOTE_PROVIDER, modelSets.openAiRemoteNames],
    [OLLAMA_LOCAL_PROVIDER, modelSets.localNames],
    [OLLAMA_REMOTE_PROVIDER, modelSets.remoteNames],
    [OLLAMA_5090_PROVIDER, modelSets.remote5090Names],
    ...cloudProviders.map((entry) => [entry.providerId, entry.availableNames]),
  ]);
}

function clearManagedDisabledProviders() {
  if (!Array.isArray(config.disabled_providers)) {
    return;
  }

  const managedProviders = new Set([
    OLLAMA_REMOTE_PROVIDER,
    OLLAMA_LOCAL_PROVIDER,
    OLLAMA_5090_PROVIDER,
    LLAMA_CPP_LOCAL_PROVIDER,
    SGLANG_REMOTE_PROVIDER,
  ]);

  config.disabled_providers = config.disabled_providers.filter(
    (providerId) => !managedProviders.has(providerId)
  );
}

function applyDefaultModels(policy) {
  if (!policy.defaultModels) {
    return;
  }

  const { model, providerId, smallModel, smallProviderId } = policy.defaultModels;
  config.model = providerId && model ? `${providerId}/${model}` : config.model;
  config.small_model =
    smallProviderId && smallModel
      ? `${smallProviderId}/${smallModel}`
      : config.small_model || config.model;
}

function applyControllerAssignments(policy, availableModelsByProvider) {
  for (const assignment of policy.controllerAssignments) {
    if (
      assignment.preserveCopilot &&
      preserveControllerModel(config, source, assignment.agentName)
    ) {
      continue;
    }
    setAgentModelFromCandidates(
      config,
      availableModelsByProvider,
      assignment.agentName,
      assignment.candidates
    );
  }
}

const inventory = buildInventorySnapshot();
const required = buildRequiredModelSets(inventory);
const modelSets = buildModelSets(inventory, required);
const cloudProviders = buildCloudProviders();
// Called for its side effect: registering/updating providers on `config`. Its
// return value maps providers to their RAW model names and is deliberately
// discarded — every downstream assignment uses `assignableModelsByProvider`
// below, which is built from the *usable* name sets (the ones that have already
// been filtered for cloud opt-in). Binding the raw map here invited using it by
// mistake and bypassing that filter.
syncProviders(modelSets, inventory, cloudProviders);
const assignableModelsByProvider = buildAvailableModelsByProvider([
  [LLAMA_CPP_LOCAL_PROVIDER, modelSets.openAiLocalUsableNames],
  [SGLANG_REMOTE_PROVIDER, modelSets.openAiRemoteUsableNames],
  [OLLAMA_LOCAL_PROVIDER, modelSets.localNames],
  [OLLAMA_REMOTE_PROVIDER, modelSets.remoteUsableNames],
  [OLLAMA_5090_PROVIDER, modelSets.remote5090UsableNames],
  ...cloudProviders.map((entry) => [entry.providerId, entry.availableNames]),
]);
const policy = buildSyncPolicy({
  cloudProviders,
  config,
  localNames: modelSets.localNames,
  openAiLocalUsableNames: modelSets.openAiLocalUsableNames,
  openAiRemoteUsableNames: modelSets.openAiRemoteUsableNames,
  remote5090UsableNames: modelSets.remote5090UsableNames,
  remoteUsableNames: modelSets.remoteUsableNames,
  source,
});

clearManagedDisabledProviders();
applyDefaultModels(policy);

config.agent = config.agent || {};
applyAgentAssignments(config, assignableModelsByProvider, policy.ifUnavailableAssignments, {
  ifUnavailable: true,
  preferFirstCandidateWhenAvailable: true,
});
applyControllerAssignments(policy, assignableModelsByProvider);
applyAgentAssignments(config, assignableModelsByProvider, policy.alwaysAssignments);

writeFileAtomic(targetConfigPath, `${JSON.stringify(config, null, 2)}\n`);
const cloudModelCount = cloudProviders.reduce(
  (total, entry) => total + entry.availableNames.length,
  0
);
console.log(
  `  synced runtime config: ${LLAMA_CPP_LOCAL_PROVIDER}=${modelSets.openAiLocalNames.length} ${SGLANG_REMOTE_PROVIDER}=${modelSets.openAiRemoteNames.length} ${OLLAMA_LOCAL_PROVIDER}=${modelSets.localNames.length} ${OLLAMA_REMOTE_PROVIDER}=${modelSets.remoteNames.length} cloud=${cloudModelCount} cloud-providers=${cloudProviders.length}`
);
