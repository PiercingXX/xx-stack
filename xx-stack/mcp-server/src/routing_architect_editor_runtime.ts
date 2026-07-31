import type { Registry } from "./platform_types.js";
import { chooseModelForTask, findHostById, routeTask } from "./routing_selection_runtime.js";
import { cloudRoutingAllowed } from "./routing_selection_runtime.js";
import { TIER_IDS } from "./runtime_constants.js";

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
 * Route a task to an architect (reasoning-strong, coder-deep lane) and an
 * editor (low-latency, coder-fast lane) using the existing registry.
 *
 * The architect is selected by routing a reasoning-oriented description
 * through the existing `routeTask` machinery, which matches keywords against
 * tier policies and host roles. The editor is selected similarly with a
 * coding-oriented description.
 *
 * Cloud hosts are excluded unless `XX_STACK_ALLOW_CLOUD=1` or the registry's
 * `selectionPolicy.cloudEscalation.optIn` is set, reusing the existing gate.
 */
export function routeArchitectEditor(
  description: string,
  registry: Registry,
  preferArchitectHost?: string,
  preferEditorHost?: string
): ArchitectEditorRoute {
  const cloudBlocked = !cloudRoutingAllowed(registry);

  // Route architect using a reasoning-oriented description so the existing
  // keyword/role machinery selects the coder-deep lane.
  const architectDesc = `plan architecture for ${description}`;
  const architectRoute = routeTask(architectDesc, registry);

  // Route editor using a coding-oriented description so the existing
  // keyword/role machinery selects the coder-fast lane.
  const editorDesc = `implement code for ${description}`;
  const editorRoute = routeTask(editorDesc, registry);

  // Resolve preferred host overrides if provided
  let architectHost = architectRoute.recommendedHost;
  let architectModel = architectRoute.recommendedModel;
  let architectReasoning = architectRoute.reasoning;

  if (preferArchitectHost) {
    const resolved = findHostById(registry, preferArchitectHost);
    if (resolved) {
      const model = chooseModelForTask(resolved.host, architectDesc);
      const tierBlocked = cloudBlocked && resolved.tierId === TIER_IDS.cloud;
      architectHost = resolved.host.id;
      architectModel = model;
      architectReasoning = tierBlocked
        ? `Preferred architect host "${preferArchitectHost}" is on cloud tier (excluded); using default route instead. ${architectRoute.reasoning}`
        : `Using preferred architect host "${preferArchitectHost}" (${resolved.tierId}). ${architectRoute.reasoning}`;
      if (tierBlocked) {
        architectHost = architectRoute.recommendedHost;
        architectModel = architectRoute.recommendedModel;
        architectReasoning = architectRoute.reasoning;
      }
    }
  }

  let editorHost = editorRoute.recommendedHost;
  let editorModel = editorRoute.recommendedModel;
  let editorReasoning = editorRoute.reasoning;

  if (preferEditorHost) {
    const resolved = findHostById(registry, preferEditorHost);
    if (resolved) {
      const model = chooseModelForTask(resolved.host, editorDesc);
      const tierBlocked = cloudBlocked && resolved.tierId === TIER_IDS.cloud;
      editorHost = resolved.host.id;
      editorModel = model;
      editorReasoning = tierBlocked
        ? `Preferred editor host "${preferEditorHost}" is on cloud tier (excluded); using default route instead. ${editorRoute.reasoning}`
        : `Using preferred editor host "${preferEditorHost}" (${resolved.tierId}). ${editorRoute.reasoning}`;
      if (tierBlocked) {
        editorHost = editorRoute.recommendedHost;
        editorModel = editorRoute.recommendedModel;
        editorReasoning = editorRoute.reasoning;
      }
    }
  }

  // Build combined reasoning that explains when both collapse to the same lane
  const sameHost = architectHost && architectHost === editorHost;
  const sameModel = architectModel && architectModel === editorModel;
  const collapseReasoning =
    sameHost && sameModel
      ? `Both architect and editor resolved to the same host/model (${architectHost}/${architectModel}) because only one lane is available in the current registry.`
      : sameHost
        ? `Architect and editor resolved to the same host (${architectHost}) but different models (architect: ${architectModel}, editor: ${editorModel}).`
        : null;

  const fallback = architectRoute.fallback || editorRoute.fallback;

  return {
    architect: {
      host: architectHost,
      model: architectModel,
      reasoning: collapseReasoning
        ? `${collapseReasoning} ${architectReasoning}`
        : architectReasoning,
    },
    editor: {
      host: editorHost,
      model: editorModel,
      reasoning: collapseReasoning
        ? `${collapseReasoning} ${editorReasoning}`
        : editorReasoning,
    },
    fallback,
  };
}