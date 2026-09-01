function unique(names) {
  // "*:cloud" Ollama models proxy inference to Ollama's hosted cloud service;
  // drop them everywhere so they never bypass the cloud opt-in gate.
  return [
    ...new Set((names || []).filter(Boolean).filter((name) => !/:cloud$/i.test(String(name)))),
  ];
}

function providerModelNames(cfg, providerId) {
  const models = cfg?.provider?.[providerId]?.models;
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

function agentModelNames(cfg, providerId) {
  return unique(
    Object.values(cfg?.agent || {})
      .map((agent) => agent?.model)
      .filter((model) => typeof model === "string" && model.startsWith(`${providerId}/`))
      .map((model) => model.slice(providerId.length + 1))
  );
}

function registryTierHosts(registry, tierId) {
  const tier = registry?.tiers?.find((item) => item.id === tierId);
  return Array.isArray(tier?.hosts) ? tier.hosts : [];
}

function registryHostModels(registry, tierId, hostId) {
  const host = registryTierHosts(registry, tierId).find((item) => item.id === hostId);
  return unique((host?.models || []).map((model) => model?.name).filter(Boolean));
}

function registryHostReachable(registry, tierId, hostId) {
  const host = registryTierHosts(registry, tierId).find((item) => item.id === hostId);
  return host?.reachable !== false;
}

function providerTierHost(registry, tierId, providerId, options = {}) {
  const reachableOnly = options.reachableOnly === true;
  const hosts = registryTierHosts(registry, tierId)
    .filter((host) => host?.enabled !== false)
    .filter((host) => host?.provider === providerId);

  const reachableHost = hosts.find((host) => host?.reachable !== false);
  if (reachableHost) {
    return reachableHost;
  }

  return reachableOnly ? null : hosts[0] || null;
}

function primaryTierHost(registry, tierId) {
  const hosts = registryTierHosts(registry, tierId).filter((host) => host?.enabled !== false);
  const reachableHosts = hosts.filter((host) => host?.reachable !== false);
  return (
    reachableHosts.find((host) => host?.primary === true) ||
    reachableHosts[0] ||
    hosts.find((host) => host?.primary === true) ||
    hosts[0] ||
    null
  );
}

function hostModelNames(host) {
  return unique(
    (host?.models || [])
      .map((model) => (typeof model === "string" ? model : model?.name))
      .filter(Boolean)
  );
}

function isExcludedModel(name) {
  const value = String(name || "").toLowerCase();
  const excludePatterns = [
    /embed/,
    /embedding/,
    /rerank/,
    /bge/,
    /whisper/,
    /tts/,
    /audio/,
    /speech/,
    /transcri/,
    /sdxl/,
    /diffusion/,
    /stable-diffusion/,
    /image/,
    /vision/,
    /llava/,
    /clip/,
    /nomic-embed/,
    /minilm/,
  ];
  return excludePatterns.some((pattern) => pattern.test(value));
}

function isCodingModel(name) {
  const value = String(name || "").toLowerCase();
  const codingPatterns = [
    /coder/,
    /codestral/,
    /codellama/,
    /starcoder/,
    /deepseek.*coder/,
    /qwen.*coder/,
    /codegemma/,
    /devstral/,
  ];
  return codingPatterns.some((pattern) => pattern.test(value));
}

function isReasoningKeep(name) {
  const value = String(name || "").toLowerCase();
  const reasoningPatterns = [
    /^qwq:/,
    /^gpt-oss:/,
    /^qwen3(\.5)?:/,
    /^nemotron-cascade-2:/,
    /^nemotron-cascade-2:latest$/,
  ];
  return reasoningPatterns.some((pattern) => pattern.test(value));
}

function isTurboQuantModel(name) {
  return /(?:^|[-_.:])tq[12](?:_0)?(?:$|[-_.:])|turboquant/i.test(String(name || ""));
}

function keepModel(name, requiredNames) {
  return (
    requiredNames.has(name) ||
    (!isExcludedModel(name) && (isCodingModel(name) || isReasoningKeep(name)))
  );
}

function ensureProvider(config, providerId, fallbackName, baseUrl) {
  config.provider = config.provider || {};
  config.provider[providerId] = config.provider[providerId] || {};
  const provider = config.provider[providerId];
  provider.npm = provider.npm || "@ai-sdk/openai-compatible";
  provider.name = provider.name || fallbackName;
  provider.options = provider.options || {};
  if (baseUrl) {
    provider.options.baseURL = `${baseUrl.replace(/\/$/, "")}/v1`;
  }
  provider.models = provider.models || {};
  return provider;
}

function toModelMap(names, existingModels) {
  const map = {};
  for (const name of names) {
    map[name] = {
      ...(existingModels?.[name] || {}),
      name,
      tool_call: existingModels?.[name]?.tool_call ?? true,
    };
  }
  return map;
}

function pickPreferred(availableNames, preferredNames, fallbackName) {
  for (const preferred of preferredNames) {
    if (availableNames.includes(preferred)) {
      return preferred;
    }
  }
  return availableNames[0] || fallbackName;
}

function pickMatchingPattern(availableNames, patterns, fallbackName) {
  for (const pattern of patterns) {
    const match = availableNames.find((name) => pattern.test(name.toLowerCase()));
    if (match) {
      return match;
    }
  }
  return availableNames[0] || fallbackName;
}

function selectCloudCandidate(cloudProviders, preferredNames, preferredPatterns) {
  for (const entry of cloudProviders) {
    const preferredModel = pickPreferred(entry.availableNames, preferredNames, null);
    if (preferredModel && entry.availableNames.includes(preferredModel)) {
      return { providerId: entry.providerId, model: preferredModel };
    }
  }

  for (const entry of cloudProviders) {
    const patternedModel = pickMatchingPattern(entry.availableNames, preferredPatterns, null);
    if (patternedModel && entry.availableNames.includes(patternedModel)) {
      return { providerId: entry.providerId, model: patternedModel };
    }
  }

  const fallbackEntry = cloudProviders[0];
  if (!fallbackEntry || fallbackEntry.availableNames.length === 0) {
    return null;
  }

  return {
    providerId: fallbackEntry.providerId,
    model: fallbackEntry.availableNames[0],
  };
}

function buildAvailableModelsByProvider(entries) {
  return new Map(entries);
}

function availableModelsForProvider(availableModelsByProvider, providerId) {
  return availableModelsByProvider.get(providerId) || [];
}

function setAgentModelFromCandidates(config, availableModelsByProvider, agentName, candidates) {
  const agent = config.agent?.[agentName];
  if (!agent) {
    return;
  }

  for (const candidate of candidates) {
    if (!candidate?.providerId || !candidate?.model) {
      continue;
    }
    const available = availableModelsForProvider(availableModelsByProvider, candidate.providerId);
    if (available.includes(candidate.model)) {
      agent.model = `${candidate.providerId}/${candidate.model}`;
      return;
    }
  }
}

function firstAvailableCandidateRef(availableModelsByProvider, candidates) {
  for (const candidate of candidates || []) {
    if (!candidate?.providerId || !candidate?.model) {
      continue;
    }
    const available = availableModelsForProvider(availableModelsByProvider, candidate.providerId);
    if (available.includes(candidate.model)) {
      return `${candidate.providerId}/${candidate.model}`;
    }
  }
  return null;
}

function currentAgentModelAvailable(config, availableModelsByProvider, agentName) {
  const agent = config.agent?.[agentName];
  if (!agent || typeof agent.model !== "string" || !agent.model.includes("/")) {
    return false;
  }

  const [providerId, ...rest] = agent.model.split("/");
  const modelName = rest.join("/");
  const available = availableModelsForProvider(availableModelsByProvider, providerId);
  return available.includes(modelName);
}

function setAgentModelFromCandidatesIfUnavailable(
  config,
  availableModelsByProvider,
  agentName,
  candidates,
  options = {}
) {
  if (currentAgentModelAvailable(config, availableModelsByProvider, agentName)) {
    if (options.preferFirstCandidateWhenAvailable !== true) {
      return;
    }

    const desiredModelRef = firstAvailableCandidateRef(availableModelsByProvider, candidates);
    if (!desiredModelRef || agentConfiguredModel(config, agentName) === desiredModelRef) {
      return;
    }

    config.agent[agentName].model = desiredModelRef;
    return;
  }
  setAgentModelFromCandidates(config, availableModelsByProvider, agentName, candidates);
}

function applyAgentAssignments(config, availableModelsByProvider, assignments, options = {}) {
  const ifUnavailable = options.ifUnavailable === true;
  for (const [agentName, candidates] of assignments) {
    if (ifUnavailable) {
      setAgentModelFromCandidatesIfUnavailable(
        config,
        availableModelsByProvider,
        agentName,
        candidates,
        options
      );
      continue;
    }
    setAgentModelFromCandidates(config, availableModelsByProvider, agentName, candidates);
  }
}

function agentConfiguredModel(cfg, agentName) {
  const model = cfg?.agent?.[agentName]?.model;
  return typeof model === "string" ? model : "";
}

function parseConfiguredModel(modelRef) {
  if (typeof modelRef !== "string") {
    return null;
  }

  const separatorIndex = modelRef.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex >= modelRef.length - 1) {
    return null;
  }

  return {
    providerId: modelRef.slice(0, separatorIndex),
    model: modelRef.slice(separatorIndex + 1),
  };
}

function sourceAgentCandidate(source, agentName) {
  return parseConfiguredModel(agentConfiguredModel(source, agentName));
}

function prependPreferredCandidate(candidates, preferredCandidate) {
  const deduped = [];
  const seen = new Set();

  for (const candidate of [preferredCandidate, ...(candidates || [])]) {
    if (!candidate?.providerId || !candidate?.model) {
      continue;
    }

    const key = `${candidate.providerId}/${candidate.model}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(candidate);
  }

  return deduped;
}

function preserveControllerModel(config, source, agentName) {
  const configured = agentConfiguredModel(config, agentName);
  const sourceConfigured = agentConfiguredModel(source, agentName);
  return configured.startsWith("github-copilot/") || sourceConfigured.startsWith("github-copilot/");
}

module.exports = {
  agentModelNames,
  applyAgentAssignments,
  buildAvailableModelsByProvider,
  ensureProvider,
  hostModelNames,
  isCodingModel,
  isReasoningKeep,
  isTurboQuantModel,
  keepModel,
  pickMatchingPattern,
  pickPreferred,
  prependPreferredCandidate,
  preserveControllerModel,
  primaryTierHost,
  providerModelNames,
  providerTierHost,
  registryHostModels,
  registryHostReachable,
  registryTierHosts,
  selectCloudCandidate,
  setAgentModelFromCandidates,
  sourceAgentCandidate,
  toModelMap,
  unique,
};
