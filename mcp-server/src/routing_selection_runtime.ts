import {
  allocateHypothesisCohort,
  type DiversityCell,
  type QdAllocation,
} from "./finding_runtime.js";
import { computeHostMemoryPressure, type HostMemoryPressure } from "./host_memory_runtime.js";
import type { Host, Registry, RouteRecommendation } from "./platform_types.js";
import {
  checkHostModelHealth,
  fetchResidentModels,
  isModelResident,
  modelNamesForHost,
  type HostModelHealthResult,
  type ResidentModel,
} from "./routing_endpoint_runtime.js";
import { TIER_IDS } from "./runtime_constants.js";
import { assignWaves, type TaskWavePlan } from "./task_graph_runtime.js";
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

export function routableTierIds(registry: Registry): string[] {
  const allowCloud = cloudRoutingAllowed(registry);
  return registry.selectionPolicy.defaultOrder.filter(
    (tierId) => allowCloud || tierId !== TIER_IDS.cloud
  );
}

/** What a live probe was able to say about the chosen model on a lane. */
export type LaneResidency = "warm" | "cold" | "unknown";

/**
 * Ranking weight for a lane that already has the chosen model loaded, and for
 * one whose card is saturated.
 *
 * These are deliberately small. `hostCapacityScore` is dominated by
 * `maxParallelSlices * 10`, and in the shipped registry the closest two lanes
 * from different tiers sit 9.1 points apart while the two runtimes sharing one
 * physical box sit 0.25 apart. A bonus and a penalty of 2 each cap the total
 * swing between any two lanes at 4, so:
 *
 * - lanes the static score separates by more than 4 keep today's relative
 *   order no matter what the probes report — a warm model on the wrong lane
 *   never outranks a cold model on a better one;
 * - lanes the static score all but ties can be reordered, which is exactly the
 *   case the nameplate score cannot resolve and a live probe can.
 *
 * `overload` demotes by the same bounded amount and never removes a lane: a
 * saturated lane is still a lane, and a failover with one saturated candidate
 * beats a failover with none.
 */
export const RESIDENT_MODEL_BONUS = 2;
export const MEMORY_PRESSURE_PENALTY = 2;

/** Maximum distance the live signals can move one lane past another. */
export const RESIDENCY_ADJUSTMENT_CEILING = RESIDENT_MODEL_BONUS + MEMORY_PRESSURE_PENALTY;

export interface RankableLane {
  host: Host;
  residency: LaneResidency;
  overload: boolean;
}

/**
 * The live adjustment for one lane, in `hostCapacityScore` points. An unknown
 * probe scores exactly 0 — the absence of an answer must cost a lane nothing.
 */
export function residencyRankAdjustment(
  lane: Pick<RankableLane, "residency" | "overload">
): number {
  const warmth = lane.residency === "warm" ? RESIDENT_MODEL_BONUS : 0;
  const pressure = lane.overload ? MEMORY_PRESSURE_PENALTY : 0;
  return warmth - pressure;
}

/**
 * Re-rank already-probed lanes by static capacity plus the bounded live term.
 *
 * `hostCapacityScore` itself stays pure and nameplate-only; the folding happens
 * here, at the ranking site, so nothing on the offline `route_task` path is
 * affected. The sort is stable, so a set where every probe came back unknown
 * and unpressured comes out in exactly the order it went in.
 */
export function rankLanesByLiveCapacity<T extends RankableLane>(lanes: readonly T[]): T[] {
  const adjusted = (lane: T): number =>
    hostCapacityScore(lane.host) + residencyRankAdjustment(lane);
  return [...lanes].sort((left, right) => adjusted(right) - adjusted(left));
}

/**
 * Memory pressure for a lane, or `null` when it cannot be computed — either the
 * host could not be inspected or it reports no VRAM. Never guesses.
 */
export function laneMemoryPressure(
  host: Host,
  resident: ResidentModel[] | null
): HostMemoryPressure | null {
  if (resident === null) return null;
  const totalVramGb = Number(host.hardware?.detected?.totalGpuVramGb ?? 0);
  if (!(totalVramGb > 0)) return null;
  return computeHostMemoryPressure({
    totalVramGb,
    reservePercent: host.executionPolicy?.contextReservePercent,
    residentVramGb: resident.map((model) => model.vramGb),
  });
}

function reportedPressure(pressure: HostMemoryPressure): Record<string, unknown> {
  const round = (value: number): number => Math.round(value * 10) / 10;
  return {
    ...pressure,
    usableVramGb: round(pressure.usableVramGb),
    usedVramGb: round(pressure.usedVramGb),
    contextHeadroomGb: round(pressure.contextHeadroomGb),
    estimatedFreeGb: round(pressure.estimatedFreeGb),
  };
}

/**
 * Probe functions the watchdog path calls. Injectable so the ranking is
 * testable without a network; both defaults are the real endpoint probes.
 */
export interface WatchdogProbeDeps {
  checkHostModelHealth?: (host: Host, modelName: string | null) => Promise<HostModelHealthResult>;
  fetchResidentModels?: (host: Host) => Promise<ResidentModel[] | null>;
}

export async function buildWatchdogRouteCandidates(
  registry: Registry,
  description: string,
  preferredHost: string | null,
  preferredModel: string | null,
  maxFallbacks: number,
  banned: Set<string>,
  probes: WatchdogProbeDeps = {}
): Promise<WatchdogRouteCandidates> {
  const probeHealth = probes.checkHostModelHealth ?? checkHostModelHealth;
  const probeResident = probes.fetchResidentModels ?? fetchResidentModels;
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

  // The breaker set governs primaries too, not just fallback lanes: a
  // host::model pair that just tripped its circuit breaker must not be handed
  // back as PRIMARY. Demote it to candidates-only, where the same ban check
  // applies lane by lane.
  const primaryBanned = banned.has(failureKey(selectedPrimary.host.id, primaryModel));
  const primaryHealth = primaryBanned
    ? {
        hostHealthy: false,
        modelAvailable: false,
        reason: "circuit breaker active",
      }
    : await probeHealth(selectedPrimary.host, primaryModel);
  const primaryRoute: SupervisorRoute | null = primaryBanned
    ? null
    : {
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
    // An unbanned primary is never re-probed as its own fallback; a banned one
    // competes as an ordinary lane and is reported like any other candidate.
    .filter(({ host }) => primaryBanned || host.id !== selectedPrimary.host.id)
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
          host: candidate.host,
          candidateModel,
          candidateHealth: {
            hostHealthy: false,
            modelAvailable: false,
            reason: "circuit breaker active",
          } as const,
          isBanned: true,
          residency: "unknown" as LaneResidency,
          memoryPressure: null,
          overload: false,
        };
      }
      const candidateHealth = await probeHealth(candidate.host, candidateModel);
      // The residency probe rides this fan-out slot — the same slot that just
      // dialled this endpoint for health. There is no second pass over the
      // fleet, and a host without capabilities.supportsResidentModelInspection
      // is never dialled for it at all: fetchResidentModels returns null before
      // touching the network. An unreachable host is not asked either; its
      // residency is unknown, which costs it nothing in the ranking.
      const resident = candidateHealth.hostHealthy ? await probeResident(candidate.host) : null;
      const residency: LaneResidency =
        resident === null
          ? "unknown"
          : candidateModel && isModelResident(resident, candidateModel)
            ? "warm"
            : "cold";
      const memoryPressure = laneMemoryPressure(candidate.host, resident);
      return {
        candidate,
        host: candidate.host,
        candidateModel,
        candidateHealth,
        isBanned: false,
        residency,
        memoryPressure,
        overload: memoryPressure?.overload === true,
      };
    })
  );

  // Fold the live signals into the ordering here, not into hostCapacityScore:
  // the static score stays the offline route_task answer, and only this
  // already-probed path sees residency and pressure. With every probe unknown
  // this is a stable no-op sort over an already-sorted list.
  const rankedProbes = rankLanesByLiveCapacity(probeResults);

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

  for (const probe of rankedProbes) {
    health.push({
      tier: probe.candidate.tierId,
      host: probe.candidate.host.id,
      endpoint: probe.candidate.host.endpoint,
      model: probe.candidateModel,
      health: probe.candidateHealth,
      kind: "fallback",
      // Always stated, including when nothing could be learned: a lane that
      // was never inspected must be visibly uninspected, not quietly ranked as
      // if it were idle.
      residency: probe.residency,
      memoryPressure: probe.memoryPressure ? reportedPressure(probe.memoryPressure) : "unknown",
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

  // Embedding intent outranks overlapping code/reasoning keywords: "embed code
  // snippets" names an embedding job even though "code" also appears, and
  // handing an embedding task a chat model is always wrong. When the host
  // catalogues a dedicated embedder it wins outright; with none catalogued,
  // general selection stands — nothing better exists to pick.
  if (embeddingTask) {
    const embedder = candidates.find((entry) => /embed|embedding/i.test(entry.name));
    if (embedder) return embedder.name;
  }

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

/**
 * One task in the edged form of `routeParallelTasks`.
 *
 * `route_parallel_tasks` already told the caller to declare blocking edges
 * "explicitly rather than discovered mid-run", then took a flat `string[]` and
 * fanned everything out at once — it asked for the edges and threw them away.
 * This is the shape that keeps them.
 *
 * `id` defaults to the task's index as a string, so `blockedBy: ["0"]` means
 * "waits on the first task in this array" without the caller inventing ids.
 */
export interface ParallelTaskInput {
  /** Defaults to the array index as a string. */
  id?: string;
  description: string;
  /** IDs of tasks in this same array that must finish first. */
  blockedBy?: string[];
  /**
   * `hypothesis` marks competing approaches. `slice` (the default) is ordinary
   * independent work. Quality-diversity caps apply only to hypothesis members.
   */
  cohortKind?: "slice" | "hypothesis";
  /** Design cell for a hypothesis slice. Required in spirit when cohortKind is hypothesis. */
  diversityCell?: DiversityCell;
}

export interface ParallelSchedule {
  assignments: Array<Record<string, unknown>>;
  hostUtilization: Array<Record<string, unknown>>;
  /**
   * Present only for the edged input form, so flat `string[]` input returns a
   * byte-identical document to the one it always has.
   */
  dependencySchedule?: TaskWavePlan & { note: string };
  /**
   * Present only when at least one slice is a hypothesis. Never attached to
   * the flat string[] form.
   */
  qualityDiversity?: QdAllocation & { note: string };
}

/**
 * xx-stack computes and returns a schedule; it never executes one. The wave
 * plan below is a PLAN — no dispatch loop, no waiting on completion, no
 * unblocked-event mechanism — exactly like the worktree paths
 * `route_competitive_task` returns without creating them. Taking the execution
 * half would make this a workflow engine, which MANUAL §1 forbids.
 */
const DEPENDENCY_SCHEDULE_NOTE =
  "Plan only: wave 0 can start now; each later wave waits on the waves before it. " +
  "xx-stack does not dispatch, poll, or sequence these — the calling agent runs a wave, " +
  "confirms it finished, and comes back for the next.";

function normalizeParallelTasks(tasks: Array<string | ParallelTaskInput>): Array<{
  id: string;
  description: string;
  blockedBy: string[];
  cohortKind: "slice" | "hypothesis";
  diversityCell?: DiversityCell;
}> {
  return tasks.map((task, index) =>
    typeof task === "string"
      ? { id: String(index), description: task, blockedBy: [], cohortKind: "slice" as const }
      : {
          id: task.id?.trim() || String(index),
          description: task.description,
          blockedBy: (task.blockedBy ?? []).map((id) => id.trim()).filter(Boolean),
          cohortKind:
            task.cohortKind === "hypothesis" || task.diversityCell ? "hypothesis" : "slice",
          ...(task.diversityCell ? { diversityCell: task.diversityCell } : {}),
        }
  );
}

/**
 * Fan a decomposed task list across lanes.
 *
 * Accepts today's flat `string[]` and, alternatively, `ParallelTaskInput[]`
 * carrying blocking edges. The two forms share one host-assignment pass, so
 * lane selection cannot drift between them; the edged form additionally
 * carries `dependencySchedule` and a per-assignment `dependencyWave`.
 *
 * Note the two distinct senses of "wave" in this output. The long-standing
 * per-assignment `wave` is a *capacity* wave: how many rounds a host's
 * parallel-slice limit forces. `dependencyWave` is a *dependency* wave: what
 * must finish before this task may start. They are unrelated, and neither one
 * is executed by anything in this repo.
 */
export function routeParallelTasks(
  tasks: string[] | Array<string | ParallelTaskInput>,
  registry: Registry
): ParallelSchedule {
  const normalized = normalizeParallelTasks(tasks);
  const edged = tasks.some((task) => typeof task !== "string");
  const descriptions = normalized.map((task) => task.description);
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
    // Same filter routeTask applies: a blocked cloud tier must not win the
    // preferred slot on keyword score alone, or the two selectors disagree.
    const sorted = Object.entries(scores)
      .filter(([tierId]) => !(cloudBlocked && tierId === TIER_IDS.cloud))
      .sort((left, right) => right[1] - left[1]);
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

  if (!edged) {
    // The flat form returns the document it has always returned, key for key.
    return {
      assignments,
      hostUtilization,
    };
  }

  // Every synthesized node is "todo": these are proposed slices, not stored
  // tasks, so nothing here is terminal and every edge is still open.
  const plan = assignWaves(
    normalized.map((task) => ({
      taskId: task.id,
      status: "todo" as const,
      blockedBy: task.blockedBy,
    }))
  );
  const waveByTaskId = new Map<string, number>();
  plan.waves.forEach((wave, index) => {
    for (const taskId of wave) waveByTaskId.set(taskId, index);
  });

  const schedule: ParallelSchedule = {
    assignments: assignments.map((assignment, index) => ({
      ...assignment,
      taskGraphId: normalized[index]!.id,
      blockedBy: normalized[index]!.blockedBy,
      dependencyWave: waveByTaskId.get(normalized[index]!.id) ?? null,
    })),
    hostUtilization,
    dependencySchedule: { ...plan, note: DEPENDENCY_SCHEDULE_NOTE },
  };

  const hypothesis = normalized.filter((task) => task.cohortKind === "hypothesis");
  if (hypothesis.length === 0) return schedule;

  const qd = allocateHypothesisCohort(
    hypothesis.map((task) => ({
      id: task.id,
      cell: task.diversityCell ?? {
        mechanismFamily: "unspecified",
        surface: "unspecified",
        intent: "unspecified",
      },
    }))
  );
  const collided = new Set(qd.collisions.map((item) => item.id));
  schedule.assignments = schedule.assignments.map((assignment) => {
    const id = String(assignment.taskGraphId ?? "");
    if (!collided.has(id)) return assignment;
    const collision = qd.collisions.find((item) => item.id === id);
    return {
      ...assignment,
      diversityCollision: true,
      diversityReasonCode: collision?.reasonCode ?? "duplicate_cell",
    };
  });
  schedule.qualityDiversity = {
    ...qd,
    note:
      "Plan only: hypothesis slices that share a diversity cell or exceed the family cap are " +
      "flagged, not reassigned. xx-stack does not dispatch; restack the cohort before running it.",
  };
  return schedule;
}
