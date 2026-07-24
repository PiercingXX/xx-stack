import type { Host, Registry, RouteRecommendation } from "./platform_types.js";
import { checkHostModelHealth, modelNamesForHost } from "./routing_endpoint_runtime.js";
import { TIER_IDS } from "./runtime_constants.js";
import {
  failureKey,
  type SupervisorRoute,
  type WatchdogRouteCandidates,
} from "./supervisor_runtime.js";

const TASK_KEYWORDS: Record<string, string[]> = {
  [TIER_IDS.local]: [
    "implement",
    "code",
    "edit",
    "fix",
    "build",
    "test",
    "review",
    "deploy",
    "release",
    "fast",
    "quick",
    "small",
    "obvious",
    "plan",
    "planner",
    "planning",
    "orchestrate",
    "orchestrator",
    "architecture",
  ],
  [TIER_IDS.tailscaleOllama]: [
    "subagent",
    "delegate",
    "delegated",
    "parallel",
    "overflow",
    "offload",
    "research",
    "analyze",
    "investigate",
    "deep-reasoning",
  ],
  [TIER_IDS.tailscaleOpenAiCompatible]: [
    "sglang",
    "openai-compatible",
    "llama-server",
    "turboquant",
    "long-context",
    "low-latency",
    "high-throughput",
  ],
  [TIER_IDS.cloud]: [
    "multimodal",
    "image",
    "vision",
    "provider-specific",
    "burst",
    "capability-gap",
    "unavailable-locally",
  ],
};

export function cloudRoutingAllowed(registry: Registry): boolean {
  const envOptIn = (process.env.XX_STACK_ALLOW_CLOUD ?? "").toLowerCase();
  if (envOptIn === "1" || envOptIn === "true") {
    return true;
  }
  return registry.selectionPolicy.cloudEscalation?.optIn === true;
}

function routableTierIds(registry: Registry): string[] {
  const allowCloud = cloudRoutingAllowed(registry);
  return registry.selectionPolicy.defaultOrder.filter(
    (tierId) => allowCloud || tierId !== TIER_IDS.cloud
  );
}

export async function buildWatchdogRouteCandidates(
  registry: Registry,
  description: string,
  preferredHost: string | null,
  preferredModel: string | null,
  maxFallbacks: number,
  banned: Set<string>
): Promise<WatchdogRouteCandidates> {
  const baseRoute = routeTask(description, registry);
  const primaryLookup = preferredHost || baseRoute.recommendedHost;
  const selectedPrimary = primaryLookup ? findHostById(registry, primaryLookup) : null;

  if (!selectedPrimary) {
    return {
      primary: null,
      healthyPrimary: false,
      candidates: [],
      health: [{ status: "unavailable", reason: "No reachable primary host" }],
    };
  }

  const primaryModel =
    preferredModel ??
    baseRoute.recommendedModel ??
    chooseModelForTask(selectedPrimary.host, description);
  const primaryHealth = await checkHostModelHealth(selectedPrimary.host, primaryModel);
  const primaryRoute: SupervisorRoute = {
    tier: selectedPrimary.tierId,
    host: selectedPrimary.host.id,
    endpoint: selectedPrimary.host.endpoint,
    model: primaryModel,
  };

  const allCandidates = routableTierIds(registry)
    .flatMap((tierId) => {
      const tier = registry.tiers.find((candidate) => candidate.id === tierId);
      return (tier?.hosts ?? []).map((host) => ({ tierId, host }));
    })
    .filter(({ host }) => host.enabled !== false && host.reachable !== false)
    .filter(({ host }) => host.id !== selectedPrimary.host.id)
    .sort((left, right) => hostCapacityScore(right.host) - hostCapacityScore(left.host));

  // Probe up to maxFallbacks * 2 candidates in parallel so we have healthy spares
  const probeCount = Math.min(allCandidates.length, maxFallbacks * 2);
  const probeResults = await Promise.all(
    allCandidates.slice(0, probeCount).map(async (candidate) => {
      const candidateModel = chooseModelForTask(candidate.host, description);
      const key = failureKey(candidate.host.id, candidateModel);
      if (banned.has(key)) {
        return {
          candidate,
          candidateModel,
          candidateHealth: {
            hostHealthy: false,
            modelAvailable: false,
            reason: "circuit breaker active",
          } as const,
          isBanned: true,
        };
      }
      const candidateHealth = await checkHostModelHealth(candidate.host, candidateModel);
      return { candidate, candidateModel, candidateHealth, isBanned: false };
    })
  );

  const candidates: SupervisorRoute[] = [];
  const health: Array<Record<string, unknown>> = [
    {
      tier: selectedPrimary.tierId,
      host: selectedPrimary.host.id,
      endpoint: selectedPrimary.host.endpoint,
      model: primaryModel,
      health: primaryHealth,
      kind: "primary",
    },
  ];

  for (const probe of probeResults) {
    health.push({
      tier: probe.candidate.tierId,
      host: probe.candidate.host.id,
      endpoint: probe.candidate.host.endpoint,
      model: probe.candidateModel,
      health: probe.candidateHealth,
      kind: "fallback",
    });

    if (
      candidates.length < maxFallbacks &&
      !probe.isBanned &&
      probe.candidateHealth.hostHealthy &&
      probe.candidateHealth.modelAvailable
    ) {
      candidates.push({
        tier: probe.candidate.tierId,
        host: probe.candidate.host.id,
        endpoint: probe.candidate.host.endpoint,
        model: probe.candidateModel,
      });
    }
  }

  return {
    primary: primaryRoute,
    healthyPrimary: primaryHealth.hostHealthy && primaryHealth.modelAvailable,
    candidates,
    health,
  };
}

function modelEntries(host: Host): Array<{
  name: string;
  roles: string[];
  sizeGb: number | null;
  format: string | null;
  quantization: string | null;
  weightBits: number | null;
  kernelFamily: string | null;
  contextWindow: number | null;
  estimatedVramGb: number | null;
  supportsToolUse: boolean | null;
  toolCallReliability: "unknown" | "low" | "validated";
  jsonModeReliability: "unknown" | "low" | "validated";
}> {
  return (host.models ?? [])
    .map((model) => {
      if (typeof model === "string") {
        return {
          name: model,
          roles: [],
          sizeGb: null,
          format: null,
          quantization: null,
          weightBits: null,
          kernelFamily: null,
          contextWindow: null,
          estimatedVramGb: null,
          supportsToolUse: null,
          toolCallReliability: "unknown" as const,
          jsonModeReliability: "unknown" as const,
        };
      }
      const sizeBytes = typeof model?.size === "number" ? model.size : null;
      const inferredWeightBits =
        typeof model?.weightBits === "number"
          ? model.weightBits
          : model?.quantization?.toLowerCase().includes("q1") ||
              model?.quantization?.toLowerCase().includes("tq1")
            ? 1
            : null;
      const toolCallReliability: "unknown" | "low" | "validated" =
        model?.toolCallReliability === "low" || model?.toolCallReliability === "validated"
          ? model.toolCallReliability
          : "unknown";
      const jsonModeReliability: "unknown" | "low" | "validated" =
        model?.jsonModeReliability === "low" || model?.jsonModeReliability === "validated"
          ? model.jsonModeReliability
          : "unknown";
      return {
        name: model?.name ?? "",
        roles: Array.isArray(model?.roles) ? model.roles : [],
        sizeGb: sizeBytes ? Math.round((sizeBytes / 1073741824) * 10) / 10 : null,
        format: typeof model?.format === "string" ? model.format : null,
        quantization: typeof model?.quantization === "string" ? model.quantization : null,
        weightBits: inferredWeightBits,
        kernelFamily: typeof model?.kernelFamily === "string" ? model.kernelFamily : null,
        contextWindow: typeof model?.contextWindow === "number" ? model.contextWindow : null,
        estimatedVramGb: typeof model?.estimatedVramGb === "number" ? model.estimatedVramGb : null,
        supportsToolUse: typeof model?.supportsToolUse === "boolean" ? model.supportsToolUse : null,
        toolCallReliability,
        jsonModeReliability,
      };
    })
    .filter((entry) => Boolean(entry.name));
}

function maxParallelSlices(host: Host): number {
  const configured = Number(host.executionPolicy?.maxParallelSlices ?? 0);
  return configured > 0 ? Math.floor(configured) : 1;
}

export function effectiveParallelCapacity(host: Host): number {
  // Parallel request capacity is bounded by slices, not resident-model count:
  // one resident model on an OpenAI-compatible server can serve many
  // concurrent requests. executionPolicy.maxConcurrentModels is consumed by the
  // parallel preflight/smoke tooling, not by routing capacity.
  return Math.max(1, maxParallelSlices(host));
}

export function hostCapacityScore(host: Host): number {
  const baseParallel = effectiveParallelCapacity(host);
  const detectedVram = Number(host.hardware?.detected?.totalGpuVramGb ?? 0);
  const modelCount = modelEntries(host).length;
  const primaryBoost = host.primary ? 0.25 : 0;
  return baseParallel * 10 + detectedVram * 0.2 + modelCount * 0.5 + primaryBoost;
}

export function chooseModelForTask(host: Host | null, description: string): string | null {
  const entries = host ? modelEntries(host) : [];
  if (entries.length === 0) return null;

  const desc = description.toLowerCase();
  const wantsCode = /implement|code|fix|edit|build|review|test|verify|validation/.test(desc);
  const wantsReason = /plan|architect|reason|research|analy|investigate|synthes/.test(desc);
  const embeddingTask = /embed|embedding|vector|retrieval/.test(desc);
  const strictToolTask = /tool|function\s*call|structured\s*json|strict\s*json|json\s*schema/.test(
    desc
  );
  const longContextTask = /long-context|long context|large-context|synthesis/.test(desc);

  let candidates = [...entries];

  // Ollama "*:cloud" models proxy inference to Ollama's hosted service and
  // would silently bypass the cloud opt-in gate; never auto-select them.
  candidates = candidates.filter((entry) => !/:cloud$/i.test(entry.name));
  if (candidates.length === 0) return null;

  if (!embeddingTask) {
    const nonEmbedding = candidates.filter(
      (entry) => !/embed|embedding|text-embedding/i.test(entry.name)
    );
    if (nonEmbedding.length > 0) {
      candidates = nonEmbedding;
    }
  }

  if (strictToolTask) {
    const validated = candidates.filter(
      (entry) =>
        entry.supportsToolUse === true &&
        entry.toolCallReliability === "validated" &&
        entry.jsonModeReliability === "validated"
    );
    if (validated.length > 0) {
      candidates = validated;
    }
  }

  if (longContextTask) {
    const turboquant = candidates.filter((entry) =>
      (entry.quantization ?? "").toLowerCase().startsWith("tq")
    );
    if (turboquant.length > 0) {
      candidates = turboquant;
    }
  }

  if (wantsCode) {
    const coding = candidates.find((entry) =>
      entry.roles.some((role) => /build|review|code/.test(role))
    );
    if (coding) return coding.name;
  }

  if (wantsReason) {
    const reasoning = candidates.find((entry) =>
      entry.roles.some((role) => /plan|architect|reason|research|orchestrator/.test(role))
    );
    if (reasoning) return reasoning.name;
  }

  const safeGeneral = candidates.find(
    (entry) =>
      !strictToolTask ||
      (entry.supportsToolUse === true &&
        entry.toolCallReliability !== "low" &&
        entry.jsonModeReliability !== "low")
  );

  return safeGeneral?.name ?? candidates[0].name;
}

export function findHostById(
  registry: Registry,
  hostId: string
): { tierId: string; host: Host } | null {
  for (const tier of registry.tiers) {
    const host = tier.hosts.find((candidate) => candidate.id === hostId);
    if (host) {
      return { tierId: tier.id, host };
    }
  }
  return null;
}

export function scoreTiers(description: string, registry: Registry): Record<string, number> {
  const desc = description.toLowerCase();
  const scores: Record<string, number> = {};

  for (const [tier, keywords] of Object.entries(TASK_KEYWORDS)) {
    scores[tier] = keywords.filter((keyword) => desc.includes(keyword)).length;
  }

  for (const rule of registry.selectionPolicy.rules) {
    const ruleWords = rule.when.toLowerCase().split(/[,\s]+/);
    const matches = ruleWords.filter((word) => word.length > 3 && desc.includes(word)).length;
    if (matches > 0 && rule.preferTier !== "next-available") {
      scores[rule.preferTier] = (scores[rule.preferTier] || 0) + matches * 2;
    }
  }

  return scores;
}

function isMultimodalTask(description: string): boolean {
  const desc = description.toLowerCase();
  return /multimodal|image|vision|audio|video|speech|transcribe|ocr/.test(desc);
}

function isSelfHostedOpenAiLane(host: Host): boolean {
  const provider = host.provider.toLowerCase();
  return (
    provider.includes("localai") || provider.includes("llama-cpp") || provider.includes("sglang")
  );
}

function hostAllowedForTask(host: Host, description: string): boolean {
  return !(isMultimodalTask(description) && isSelfHostedOpenAiLane(host));
}

export function routeTask(description: string, registry: Registry): RouteRecommendation {
  const isAvailableHost = (host: Host): boolean =>
    host.enabled !== false && host.reachable !== false && hostAllowedForTask(host, description);
  const prioritizeHosts = (hosts: Host[]): Host[] =>
    [...hosts].sort((left, right) => hostCapacityScore(right) - hostCapacityScore(left));

  const orderedTierIds = routableTierIds(registry);
  const cloudBlocked = !cloudRoutingAllowed(registry);
  const scores = scoreTiers(description, registry);
  const sorted = Object.entries(scores)
    .filter(([tierId]) => !(cloudBlocked && tierId === TIER_IDS.cloud))
    .sort((left, right) => right[1] - left[1]);
  const bestTier = sorted[0]?.[1] > 0 ? sorted[0][0] : orderedTierIds[0];
  const requestedTier = registry.tiers.find((tier) => tier.id === bestTier) ?? null;
  const requestedHosts = prioritizeHosts(requestedTier?.hosts.filter(isAvailableHost) ?? []);

  let resolvedTierId = bestTier;
  let resolvedHosts = requestedHosts;
  let usedFallback = false;

  if (resolvedHosts.length === 0) {
    for (const tierId of orderedTierIds) {
      if (tierId === bestTier) continue;
      const candidateTier = registry.tiers.find((tier) => tier.id === tierId);
      const candidateHosts = prioritizeHosts(candidateTier?.hosts.filter(isAvailableHost) ?? []);
      if (candidateTier && candidateHosts.length > 0) {
        resolvedTierId = tierId;
        resolvedHosts = candidateHosts;
        usedFallback = true;
        break;
      }
    }
  }

  const host = resolvedHosts[0] ?? null;
  const models = modelNamesForHost(host);
  const fallbackId =
    orderedTierIds
      .filter((tierId) => tierId !== resolvedTierId)
      .find((tierId) => {
        const tier = registry.tiers.find((candidate) => candidate.id === tierId);
        return Boolean(tier?.hosts.some(isAvailableHost));
      }) ?? null;
  const requestedScore = sorted[0]?.[1] ?? 0;
  const selectedModel = chooseModelForTask(host, description);
  const baseReasoning =
    requestedScore > 0
      ? `Matched keywords for "${bestTier}" tier (score: ${requestedScore})${usedFallback ? `; fell back to "${resolvedTierId}" because no reachable hosts were available on "${bestTier}"` : ""}`
      : `No strong keyword match; defaulting to "${resolvedTierId}" per selection policy${usedFallback ? ` after "${bestTier}" had no reachable hosts` : ""}`;
  const multimodalReasoning = isMultimodalTask(description)
    ? `${baseReasoning}; denied self-hosted OpenAI-compatible multimodal routing by policy (text/chat/embeddings only)`
    : baseReasoning;
  const reasoning = cloudBlocked
    ? `${multimodalReasoning}; cloud tier excluded (cloud escalation requires opt-in via selectionPolicy.cloudEscalation.optIn or XX_STACK_ALLOW_CLOUD=1)`
    : multimodalReasoning;

  return {
    recommendedTier: resolvedTierId,
    recommendedHost: host?.id ?? null,
    recommendedModel: selectedModel,
    reasoning: selectedModel
      ? `${reasoning}; selected model "${selectedModel}" using host roles and task intent`
      : reasoning,
    availableModels: models,
    fallback: fallbackId,
  };
}

export function routeParallelTasks(
  descriptions: string[],
  registry: Registry
): {
  assignments: Array<Record<string, unknown>>;
  hostUtilization: Array<Record<string, unknown>>;
} {
  const orderedTierIds = routableTierIds(registry);
  const cloudBlocked = !cloudRoutingAllowed(registry);
  const allHostsByTier = new Map<string, Host[]>();

  for (const tier of registry.tiers) {
    if (cloudBlocked && tier.id === TIER_IDS.cloud) {
      continue;
    }
    allHostsByTier.set(
      tier.id,
      [...(tier.hosts ?? [])]
        .filter((host) => host.enabled !== false && host.reachable !== false)
        .sort((left, right) => hostCapacityScore(right) - hostCapacityScore(left))
    );
  }

  const hostLoad = new Map<string, number>();
  for (const hosts of allHostsByTier.values()) {
    for (const host of hosts) {
      hostLoad.set(host.id, 0);
    }
  }

  const assignments = descriptions.map((description, index) => {
    const scores = scoreTiers(description, registry);
    const sorted = Object.entries(scores).sort((left, right) => right[1] - left[1]);
    const preferredTierId = sorted[0]?.[1] > 0 ? sorted[0][0] : orderedTierIds[0];
    const orderedTiers = [
      preferredTierId,
      ...orderedTierIds.filter((tierId) => tierId !== preferredTierId),
    ];

    let selectedTierId = orderedTiers[0] ?? preferredTierId;
    let selectedHost: Host | null = null;

    for (const tierId of orderedTiers) {
      const candidates = (allHostsByTier.get(tierId) ?? []).filter((host) =>
        hostAllowedForTask(host, description)
      );
      if (candidates.length === 0) continue;

      const ranked = [...candidates].sort((left, right) => {
        const leftCapacity = effectiveParallelCapacity(left);
        const rightCapacity = effectiveParallelCapacity(right);
        const leftLoad = hostLoad.get(left.id) ?? 0;
        const rightLoad = hostLoad.get(right.id) ?? 0;
        const leftPressure = leftLoad / leftCapacity;
        const rightPressure = rightLoad / rightCapacity;
        if (leftPressure !== rightPressure) return leftPressure - rightPressure;
        return hostCapacityScore(right) - hostCapacityScore(left);
      });

      selectedHost = ranked[0] ?? null;
      selectedTierId = tierId;
      if (selectedHost) break;
    }

    if (!selectedHost) {
      return {
        taskIndex: index,
        description,
        status: "unassigned",
        reason: "No reachable host available across configured tiers",
      };
    }

    const currentLoad = hostLoad.get(selectedHost.id) ?? 0;
    const capacity = effectiveParallelCapacity(selectedHost);
    hostLoad.set(selectedHost.id, currentLoad + 1);

    const wave = Math.floor(currentLoad / capacity) + 1;
    const slot = (currentLoad % capacity) + 1;
    const selectedModel = chooseModelForTask(selectedHost, description);

    return {
      taskIndex: index,
      description,
      tier: selectedTierId,
      host: selectedHost.id,
      provider: selectedHost.provider,
      endpoint: selectedHost.endpoint,
      dispatchModel: selectedModel ? `${selectedHost.provider}/${selectedModel}` : null,
      model: selectedModel,
      wave,
      slot,
      capacity,
      queueDepthOnHost: currentLoad,
      schedulingReason: `Assigned to lowest-pressure host with capacity-aware balancing (wave ${wave}, slot ${slot}/${capacity})`,
    };
  });

  const hostUtilization = Array.from(hostLoad.entries())
    .map(([hostId, assigned]) => {
      let host: Host | null = null;
      let tierId = "unknown";
      for (const tier of registry.tiers) {
        const match = tier.hosts.find((candidate) => candidate.id === hostId) ?? null;
        if (match) {
          host = match;
          tierId = tier.id;
          break;
        }
      }
      const capacity = host ? effectiveParallelCapacity(host) : 1;
      return {
        host: hostId,
        tier: tierId,
        assignedTasks: assigned,
        parallelCapacity: capacity,
        estimatedWaves: Math.max(1, Math.ceil(assigned / capacity)),
      };
    })
    .sort((left, right) => Number(right.assignedTasks) - Number(left.assignedTasks));

  return {
    assignments,
    hostUtilization,
  };
}
