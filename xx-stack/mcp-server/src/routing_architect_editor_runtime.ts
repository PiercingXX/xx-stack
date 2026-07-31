import type { Host, Registry } from "./platform_types.js";
import {
  chooseModelForTask,
  findHostById,
  hostCapacityScore,
  routeTask,
} from "./routing_selection_runtime.js";
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

  // ── Role-aware host selection within the resolved tier ────────────────
  // routeTask picks the highest-capacity host in the best-matching tier.
  // For architect/editor split we need to prefer hosts whose model roles
  // match each function — reasoning-capable models for architect,
  // code/build models for editor — so distinct lanes actually diverge.

  function hasReasoningModel(host: Host): boolean {
    return (host.models ?? []).some((m) => {
      const roles = typeof m === "string" ? [] : (m.roles ?? []);
      return roles.some((r) => /plan|architect|reason|research|orchestrator/.test(r));
    });
  }

  function hasCodeModel(host: Host): boolean {
    return (host.models ?? []).some((m) => {
      const roles = typeof m === "string" ? [] : (m.roles ?? []);
      return roles.some((r) => /build|review|code/.test(r));
    });
  }

  function routableHosts(registry: Registry): Array<{ tierId: string; host: Host }> {
    const allowCloud = cloudRoutingAllowed(registry);
    const result: Array<{ tierId: string; host: Host }> = [];
    for (const tier of registry.tiers) {
      if (!allowCloud && tier.id === TIER_IDS.cloud) continue;
      for (const host of tier.hosts ?? []) {
        if (host.enabled !== false && host.reachable !== false) {
          result.push({ tierId: tier.id, host });
        }
      }
    }
    return result;
  }

  // Resolve architect host: prefer a host with reasoning-capable models
  // within the same tier as the base route, falling back to the base route host.
  let architectHostId = architectRoute.recommendedHost;
  let architectModel = architectRoute.recommendedModel;
  let architectReasoning = architectRoute.reasoning;

  if (!preferArchitectHost) {
    const allHosts = routableHosts(registry);
    const sameTierHosts = allHosts.filter((h) => h.tierId === architectRoute.recommendedTier);
    const reasoningHosts = sameTierHosts.filter((h) => hasReasoningModel(h.host));
    if (reasoningHosts.length > 0) {
      // Pick the highest-capacity reasoning host
      reasoningHosts.sort((a, b) => hostCapacityScore(b.host) - hostCapacityScore(a.host));
      const selected = reasoningHosts[0];
      architectHostId = selected.host.id;
      architectModel = chooseModelForTask(selected.host, architectDesc);
      const distinct = selected.host.id !== architectRoute.recommendedHost;
      architectReasoning = distinct
        ? `Selected reasoning-capable host "${selected.host.id}" for architect role (distinct from editor lane). ${architectRoute.reasoning}`
        : architectRoute.reasoning;
    }
  }

  // Resolve editor host: prefer a host with code/build models, ideally different from architect.
  let editorHostId = editorRoute.recommendedHost;
  let editorModel = editorRoute.recommendedModel;
  let editorReasoning = editorRoute.reasoning;

  if (!preferEditorHost) {
    const allHosts = routableHosts(registry);
    const sameTierHosts = allHosts.filter((h) => h.tierId === editorRoute.recommendedTier);
    // Prefer a code-capable host that is NOT the architect host (if possible)
    const codeHosts = sameTierHosts
      .filter((h) => hasCodeModel(h.host))
      .sort((a, b) => hostCapacityScore(b.host) - hostCapacityScore(a.host));
    const differentCodeHost = codeHosts.find((h) => h.host.id !== architectHostId);
    const selectedEditor = differentCodeHost ?? codeHosts[0];
    if (selectedEditor) {
      editorHostId = selectedEditor.host.id;
      editorModel = chooseModelForTask(selectedEditor.host, editorDesc);
      const distinct = selectedEditor.host.id !== editorRoute.recommendedHost;
      editorReasoning = distinct
        ? `Selected code-capable host "${selectedEditor.host.id}" for editor role${differentCodeHost ? ` (distinct from architect host "${architectHostId}")` : ""}. ${editorRoute.reasoning}`
        : editorRoute.reasoning;
    }
  }

  // Resolve preferred host overrides if provided
  if (preferArchitectHost) {
    const resolved = findHostById(registry, preferArchitectHost);
    if (resolved) {
      const model = chooseModelForTask(resolved.host, architectDesc);
      const tierBlocked = cloudBlocked && resolved.tierId === TIER_IDS.cloud;
      architectHostId = resolved.host.id;
      architectModel = model;
      architectReasoning = tierBlocked
        ? `Preferred architect host "${preferArchitectHost}" is on cloud tier (excluded); using default route instead. ${architectRoute.reasoning}`
        : `Using preferred architect host "${preferArchitectHost}" (${resolved.tierId}). ${architectRoute.reasoning}`;
      if (tierBlocked) {
        architectHostId = architectRoute.recommendedHost;
        architectModel = architectRoute.recommendedModel;
        architectReasoning = architectRoute.reasoning;
      }
    }
  }

  if (preferEditorHost) {
    const resolved = findHostById(registry, preferEditorHost);
    if (resolved) {
      const model = chooseModelForTask(resolved.host, editorDesc);
      const tierBlocked = cloudBlocked && resolved.tierId === TIER_IDS.cloud;
      editorHostId = resolved.host.id;
      editorModel = model;
      editorReasoning = tierBlocked
        ? `Preferred editor host "${preferEditorHost}" is on cloud tier (excluded); using default route instead. ${editorRoute.reasoning}`
        : `Using preferred editor host "${preferEditorHost}" (${resolved.tierId}). ${editorRoute.reasoning}`;
      if (tierBlocked) {
        editorHostId = editorRoute.recommendedHost;
        editorModel = editorRoute.recommendedModel;
        editorReasoning = editorRoute.reasoning;
      }
    }
  }

  // Build combined reasoning that explains when both collapse to the same lane
  const sameHost = architectHostId && architectHostId === editorHostId;
  const sameModel = architectModel && architectModel === editorModel;
  const collapseReasoning =
    sameHost && sameModel
      ? `Both architect and editor resolved to the same host/model (${architectHostId}/${architectModel}) because only one lane is available in the current registry.`
      : sameHost
        ? `Architect and editor resolved to the same host (${architectHostId}) but different models (architect: ${architectModel}, editor: ${editorModel}).`
        : null;

  const fallback = architectRoute.fallback || editorRoute.fallback;

  return {
    architect: {
      host: architectHostId,
      model: architectModel,
      reasoning: collapseReasoning
        ? `${collapseReasoning} ${architectReasoning}`
        : architectReasoning,
    },
    editor: {
      host: editorHostId,
      model: editorModel,
      reasoning: collapseReasoning
        ? `${collapseReasoning} ${editorReasoning}`
        : editorReasoning,
    },
    fallback,
  };
}