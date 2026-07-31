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

export * from "./routing_endpoint_runtime.js";
export * from "./routing_selection_runtime.js";
