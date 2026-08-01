import type { Registry } from "./platform_types.js";
import { routeTask, cloudRoutingAllowed } from "./routing_selection_runtime.js";

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

  // --- Determine fallback ---
  // If both lanes resolved to the same host (single-lane scenario), report
  // that as the fallback with clear reasoning.
  const sameHost =
    architectRoute.recommendedHost !== null &&
    architectRoute.recommendedHost === editorRoute.recommendedHost;

  const fallbackReasoning = sameHost
    ? `Single lane available: architect and editor both resolved to host "${architectRoute.recommendedHost}" (tier: ${architectRoute.recommendedTier})`
    : `Architect on "${architectRoute.recommendedTier}" (${architectRoute.recommendedHost}), editor on "${editorRoute.recommendedTier}" (${editorRoute.recommendedHost})`;

  return {
    architect: {
      host: architectRoute.recommendedHost,
      model: architectRoute.recommendedModel,
      reasoning: architectReasoning,
    },
    editor: {
      host: editorRoute.recommendedHost,
      model: editorRoute.recommendedModel,
      reasoning: editorReasoning,
    },
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
export function scoreCandidates(
  candidates: string[],
  registry: Registry
): ScoredCandidate[] {
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

export * from "./routing_endpoint_runtime.js";
export * from "./routing_selection_runtime.js";
