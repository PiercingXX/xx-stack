import type { Registry } from "./platform_types.js";
import { modelNamesForHost } from "./routing_endpoint_runtime.js";
import {
  chooseModelForTask,
  cloudRoutingAllowed,
  findHostById,
  hostCapacityScore,
  routableTierIds,
  routeTask,
  scoreTiers,
} from "./routing_selection_runtime.js";

/**
 * Upper bound on internal fan-out concurrency for array-accepting variants of
 * read-only routing tools. Keeps batched calls from starting an unbounded
 * number of routing evaluations at once.
 */
export const BATCH_ROUTE_CONCURRENCY = 8;

/**
 * Map `items` through an async `fn` with at most `limit` invocations in
 * flight at any moment. Results are position-aligned with the input array:
 * result[i] always corresponds to items[i], regardless of completion order.
 *
 * Fails fast: once `fn` rejects, idle workers stop picking up new items, so
 * side effects do not continue fanning out after a sibling already failed.
 * Invocations already in flight are allowed to finish.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isFinite(limit) || limit < 1) {
    throw new RangeError(`concurrency limit must be a finite number >= 1, got ${limit}`);
  }
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let stopped = false;
  const workerCount = Math.min(Math.floor(limit), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      if (stopped) return;
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Result shape for the architect+editor routing recommendation.
 * Mirrors the existing route_task output fields so callers stay uniform.
 */
export interface ArchitectEditorRoute {
  architect: {
    host: string | null;
    model: string | null;
    reasoning: string;
  };
  editor: {
    host: string | null;
    model: string | null;
    reasoning: string;
  };
  fallback: string | null;
}

/**
 * Route a task into two lanes: an architect (deep reasoning) and an editor
 * (fast execution). Reuses the existing tier-selection mechanism — the
 * architect lane targets the `coder-deep` alias (reasoning role) and the
 * editor lane targets the `coder-fast` alias (low-latency role).
 *
 * Cloud hosts are excluded by default; the existing opt-in gate
 * (XX_STACK_ALLOW_CLOUD=1 or selectionPolicy.cloudEscalation.optIn) must
 * be set to include them.
 *
 * This is a ROUTING RECOMMENDATION ONLY — no execution is performed here.
 */
export function routeArchitectEditor(
  description: string,
  registry: Registry,
  preferArchitectHost?: string,
  preferEditorHost?: string
): ArchitectEditorRoute {
  // Reuse the cloud gate from the existing selection runtime.
  const cloudBlocked = !cloudRoutingAllowed(registry);
  const cloudNote = cloudBlocked
    ? "; cloud tier excluded (cloud escalation requires opt-in via selectionPolicy.cloudEscalation.optIn or XX_STACK_ALLOW_CLOUD=1)"
    : "";

  // A caller-preferred host overrides the routed lane only when it exists in
  // a routable tier (cloud stays behind the opt-in gate) and is usable; an
  // unusable preference falls back to the routed lane with the shortfall
  // stated in the reasoning rather than silently ignored.
  const routable = new Set(routableTierIds(registry));
  const applyHostPreference = (
    route: { host: string | null; model: string | null; reasoning: string },
    preferredHost: string | undefined,
    laneDesc: string
  ): { host: string | null; model: string | null; reasoning: string } => {
    if (!preferredHost) return route;
    const found = findHostById(registry, preferredHost);
    if (!found) {
      return {
        ...route,
        reasoning: `${route.reasoning}; preferred host "${preferredHost}" not found in registry — using routed lane`,
      };
    }
    if (!routable.has(found.tierId)) {
      return {
        ...route,
        reasoning: `${route.reasoning}; preferred host "${preferredHost}" is in non-routable tier "${found.tierId}" — using routed lane`,
      };
    }
    if (found.host.enabled === false || found.host.reachable === false) {
      return {
        ...route,
        reasoning: `${route.reasoning}; preferred host "${preferredHost}" is disabled or unreachable — using routed lane`,
      };
    }
    return {
      host: found.host.id,
      model: chooseModelForTask(found.host, laneDesc),
      reasoning: `Caller-preferred host "${preferredHost}" (tier: ${found.tierId})${cloudNote}`,
    };
  };

  // --- Architect lane: reasoning-strong (coder-deep alias) ---
  // Use a description that naturally scores toward the reasoning/deep tier
  // so the existing keyword matcher picks the right lane.
  const architectDesc = `architecture planning deep reasoning synthesize analysis ${description}`;
  const architectRoute = routeTask(architectDesc, registry);

  // --- Editor lane: low-latency (coder-fast alias) ---
  // Use a description that naturally scores toward the code/fast tier.
  const editorDesc = `implement code edit fix quick fast lightweight ${description}`;
  const editorRoute = routeTask(editorDesc, registry);

  // --- Build reasoning strings ---
  const architectReasoning = architectRoute.reasoning + cloudNote;
  const editorReasoning = editorRoute.reasoning + cloudNote;

  const architectLane = applyHostPreference(
    {
      host: architectRoute.recommendedHost,
      model: architectRoute.recommendedModel,
      reasoning: architectReasoning,
    },
    preferArchitectHost,
    architectDesc
  );
  const editorLane = applyHostPreference(
    {
      host: editorRoute.recommendedHost,
      model: editorRoute.recommendedModel,
      reasoning: editorReasoning,
    },
    preferEditorHost,
    editorDesc
  );

  // --- Determine fallback ---
  // If both lanes resolved to the same host (single-lane scenario), report
  // that as the fallback with clear reasoning.
  const sameHost = architectLane.host !== null && architectLane.host === editorLane.host;

  const fallbackReasoning = sameHost
    ? `Single lane available: architect and editor both resolved to host "${architectLane.host}" (tier: ${architectRoute.recommendedTier})`
    : `Architect on "${architectRoute.recommendedTier}" (${architectLane.host}), editor on "${editorRoute.recommendedTier}" (${editorLane.host})`;

  return {
    architect: architectLane,
    editor: editorLane,
    fallback: fallbackReasoning,
  };
}

/**
 * A single lane in a competitive fan-out.
 */
export interface CompetitiveLane {
  host: string | null;
  model: string | null;
  reasoning: string;
}

/**
 * Result shape for competitive fan-out routing.
 * Contains up to `requestedLanes` distinct lanes plus metadata.
 */
export interface CompetitiveRoute {
  lanes: CompetitiveLane[];
  requestedLanes: number;
  returnedLanes: number;
  shortfall: number;
  fallback: string;
}

/**
 * Competitive fan-out: produce up to `laneCount` distinct routing lanes
 * for the same task description. Each lane is seeded with a different
 * competitive keyword prefix so the tier scorer explores distinct tiers.
 *
 * Lanes are deduplicated by (host, model) — if two seeds resolve to the
 * same endpoint, only the first is kept. The caller receives however many
 * distinct lanes the registry can offer, up to `laneCount`.
 *
 * Cloud hosts are excluded by default; the existing opt-in gate
 * (XX_STACK_ALLOW_CLOUD=1 or selectionPolicy.cloudEscalation.optIn) must
 * be set to include them.
 */
export function routeCompetitiveTask(
  description: string,
  registry: Registry,
  laneCount: number
): CompetitiveRoute {
  // Reject laneCount outside the supported range rather than clamping silently.
  if (laneCount < 2 || laneCount > 5) {
    throw new RangeError(
      `laneCount must be between 2 and 5 inclusive for fanout, got ${laneCount}`
    );
  }

  const cloudBlocked = !cloudRoutingAllowed(registry);
  const cloudNote = cloudBlocked
    ? "; cloud tier excluded (cloud escalation requires opt-in via selectionPolicy.cloudEscalation.optIn or XX_STACK_ALLOW_CLOUD=1)"
    : "";

  // Competitive seeds — each biases the tier scorer toward a different
  // capability axis so the fan-out explores diverse hosts/models.
  const competitiveSeeds = [
    "fast quick lightweight speed",
    "deep reasoning analysis complex",
    "code implement build generate",
    "review debug fix inspect",
    "creative design brainstorm explore",
  ];

  const seen = new Set<string>();
  const lanes: CompetitiveLane[] = [];
  const laneLimit = Math.min(laneCount, competitiveSeeds.length);

  for (let i = 0; i < laneLimit; i++) {
    const seededDesc = `${competitiveSeeds[i]} ${description}`;
    const route = routeTask(seededDesc, registry);
    const key = `${route.recommendedHost ?? "null"}::${route.recommendedModel ?? "null"}`;

    if (seen.has(key)) continue;
    seen.add(key);

    lanes.push({
      host: route.recommendedHost,
      model: route.recommendedModel,
      reasoning: route.reasoning + cloudNote,
    });
  }

  const shortfall = Math.max(0, laneCount - lanes.length);
  const fallback =
    lanes.length === 0
      ? "No lanes available from any tier"
      : lanes.length < laneCount
        ? `Requested ${laneCount} lanes, resolved ${lanes.length} distinct lanes (shortfall: ${shortfall})`
        : `All ${laneCount} lanes resolved successfully`;

  return {
    lanes,
    requestedLanes: laneCount,
    returnedLanes: lanes.length,
    shortfall,
    fallback,
  };
}

/**
 * Result shape for a scored candidate.
 */
export interface ScoredCandidate {
  description: string;
  totalScore: number;
  tierScores: Record<string, number>;
  rationale: string;
}

/**
 * Score and rank candidate task descriptions against the tier keyword
 * matcher. Returns a deterministic ranking with per-candidate rationale.
 *
 * Tie-breaking: when two candidates have the same totalScore, their relative
 * order is the input order (stable sort) — the caller's original sequence
 * is preserved among equal scores, making the output fully deterministic
 * across repeated calls with the same inputs.
 */
export function scoreCandidates(candidates: string[], registry: Registry): ScoredCandidate[] {
  const scored = candidates.map((desc) => {
    const scores = scoreTiers(desc, registry);
    const total = Object.values(scores).reduce((sum, s) => sum + s, 0);
    const breakdown = Object.entries(scores)
      .filter(([, v]) => v > 0)
      .map(([tier, score]) => `${tier}:${score}`)
      .join(", ");
    const topTier = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    const rationale =
      total > 0
        ? `Score ${total} — matched ${breakdown}; best tier: "${topTier?.[0] ?? "none"}"`
        : "No keyword matches against any tier";
    return { description: desc, totalScore: total, tierScores: scores, rationale };
  });

  // Stable sort by totalScore descending — equal scores keep input order.
  scored.sort((a, b) => b.totalScore - a.totalScore);

  return scored;
}

/**
 * Result shape for the reviewer-diversity routing recommendation.
 * The `reviewer` lane mirrors the per-lane shape used by
 * route_architect_editor so callers stay uniform.
 */
export interface ReviewRoute {
  reviewer: {
    host: string | null;
    model: string | null;
    reasoning: string;
  };
  /**
   * Whether the reviewer's model differs from the authoring model:
   * - "distinct": authoring model known and the reviewer model differs.
   * - "same-model": authoring model known but no routable lane offers a
   *   different model — collapsed with explicit reasoning (never silent).
   * - "unknown-author": no authoring model was declared, so the diversity
   *   constraint cannot be evaluated against a model.
   */
  modelDiversity: "distinct" | "same-model" | "unknown-author";
  authoredByModel: string | null;
  authoredByHost: string | null;
  /** Human-readable shortfall explanation when diversity could not be met; null otherwise. */
  shortfall: string | null;
  fallback: string | null;
}

/**
 * Route a review task to a lane whose model differs from the model that
 * authored the work (reviewer diversity: a different model family catches
 * what the authoring model is systematically blind to).
 *
 * When the registry offers no lane with a different model, the route
 * collapses gracefully to a same-model review with explicit reasoning and a
 * populated `shortfall` field — degradation is never silent.
 *
 * Cloud hosts are excluded by default; the existing opt-in gate
 * (XX_STACK_ALLOW_CLOUD=1 or selectionPolicy.cloudEscalation.optIn) must
 * be set to include them — identical to route_task.
 *
 * This is a ROUTING RECOMMENDATION ONLY — no execution is performed here.
 */
export function routeReview(
  description: string,
  registry: Registry,
  authoredByModel?: string,
  authoredByHost?: string
): ReviewRoute {
  const cloudBlocked = !cloudRoutingAllowed(registry);
  const cloudNote = cloudBlocked
    ? "; cloud tier excluded (cloud escalation requires opt-in via selectionPolicy.cloudEscalation.optIn or XX_STACK_ALLOW_CLOUD=1)"
    : "";

  // Seed the description so the existing tier scorer treats this as review work.
  const reviewDesc = `review inspect verify code quality ${description}`;
  const base = routeTask(reviewDesc, registry);

  const authorModel = authoredByModel ?? null;
  const authorHost = authoredByHost ?? null;

  // No authoring info at all — the diversity constraint is not evaluable;
  // fall through to the plain review route and say so.
  if (authorModel === null && authorHost === null) {
    return {
      reviewer: {
        host: base.recommendedHost,
        model: base.recommendedModel,
        reasoning: `${base.reasoning}; no authoring model declared, reviewer-diversity constraint not evaluated`,
      },
      modelDiversity: "unknown-author",
      authoredByModel: null,
      authoredByHost: null,
      shortfall: null,
      fallback: base.fallback,
    };
  }

  // Enumerate every routable lane (cloud already excluded by routableTierIds
  // unless opted in) that can offer a model different from the authoring model.
  const candidates: Array<{
    tierId: string;
    hostId: string;
    model: string;
    differentHost: boolean;
    score: number;
  }> = [];

  for (const tierId of routableTierIds(registry)) {
    const tier = registry.tiers.find((candidate) => candidate.id === tierId);
    for (const host of tier?.hosts ?? []) {
      if (host.enabled === false || host.reachable === false) continue;
      // Never auto-select Ollama "*:cloud" proxy models — they would silently
      // bypass the cloud opt-in gate (same rule as chooseModelForTask).
      const names = modelNamesForHost(host).filter((name) => !/:cloud$/i.test(name));
      const eligible = authorModel === null ? names : names.filter((name) => name !== authorModel);
      if (eligible.length === 0) continue;
      // Prefer the model the review-task heuristic would pick when it is
      // itself eligible; otherwise take the host's first eligible model.
      const preferred = chooseModelForTask(host, reviewDesc);
      const model = preferred !== null && eligible.includes(preferred) ? preferred : eligible[0];
      candidates.push({
        tierId,
        hostId: host.id,
        model,
        differentHost: authorHost === null || host.id !== authorHost,
        score: hostCapacityScore(host),
      });
    }
  }

  // Rank: a different host beats the authoring host; then higher capacity.
  candidates.sort((left, right) => {
    if (left.differentHost !== right.differentHost) {
      return left.differentHost ? -1 : 1;
    }
    return right.score - left.score;
  });

  const chosen = candidates[0] ?? null;

  if (chosen !== null) {
    const diversity: ReviewRoute["modelDiversity"] =
      authorModel === null ? "unknown-author" : "distinct";
    const hostNote =
      authorHost !== null && !chosen.differentHost
        ? `; no alternate host available, review runs on the authoring host "${authorHost}"`
        : authorHost !== null
          ? `; reviewer host "${chosen.hostId}" differs from authoring host "${authorHost}"`
          : "";
    const modelNote =
      authorModel !== null
        ? `reviewer model "${chosen.model}" differs from authoring model "${authorModel}"`
        : `reviewer model "${chosen.model}" selected (authoring model not declared)`;
    const shortfall =
      authorHost !== null && !chosen.differentHost
        ? `Reviewer-diversity shortfall: no routable lane on a host other than authoring host "${authorHost}"; review runs on the authoring host`
        : null;
    return {
      reviewer: {
        host: chosen.hostId,
        model: chosen.model,
        reasoning: `Reviewer-diversity routing: ${modelNote} on host "${chosen.hostId}" (tier "${chosen.tierId}")${hostNote}${cloudNote}`,
      },
      modelDiversity: diversity,
      authoredByModel: authorModel,
      authoredByHost: authorHost,
      shortfall,
      fallback: base.fallback,
    };
  }

  // Collapse: the registry offers no lane with a different model. Fall back
  // to the plain review route (same model as the author) with explicit
  // reasoning — the shortfall is surfaced, never silent.
  const shortfall =
    base.recommendedHost === null
      ? "Reviewer-diversity shortfall: no routable lanes are available at all"
      : `Reviewer-diversity shortfall: no routable lane offers a model different from authoring model "${authorModel}"; collapsing to same-model review with reduced blind-spot coverage`;

  return {
    reviewer: {
      host: base.recommendedHost,
      model: base.recommendedModel,
      reasoning: `${base.reasoning}; ${shortfall}${cloudNote}`,
    },
    modelDiversity: "same-model",
    authoredByModel: authorModel,
    authoredByHost: authorHost,
    shortfall,
    fallback: base.fallback,
  };
}

export * from "./routing_endpoint_runtime.js";
export * from "./routing_selection_runtime.js";
