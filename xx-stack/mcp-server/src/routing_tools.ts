import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { logEvent } from "./log_worker.js";
import type { Registry } from "./platform_types.js";
import {
  buildWatchdogRouteCandidates,
  routeArchitectEditor,
  routeCompetitiveTask,
  routeParallelTasks,
  routeTask,
  scoreCandidates,
} from "./routing_runtime.js";

import { jsonContent } from "./agent_tool_helpers.js";
interface RoutingToolDeps {
  loadRegistry: () => Promise<Registry>;
}

export function registerRoutingTools(server: McpServer, deps: RoutingToolDeps): void {
  server.tool(
    "route_task",
    "Given a task description, recommend which platform tier, host, and model to use",
    { description: z.string().describe("Description of the task to route") },
    async ({ description }) => {
      const registry = await deps.loadRegistry();
      const result = routeTask(description, registry);
      void logEvent("server", "route_task.result", {
        description: description.slice(0, 200),
        tier: result.recommendedTier,
        host: result.recommendedHost,
        model: result.recommendedModel,
        fallback: result.fallback,
        reasoning: result.reasoning,
      });
      return jsonContent(result);
    }
  );

  server.tool(
    "route_parallel_tasks",
    "Given multiple task descriptions, produce a hardware-aware parallel delegation schedule across local and remote hosts",
    {
      tasks: z
        .array(z.string())
        .min(1)
        .max(128)
        .describe("Task descriptions to schedule in parallel"),
    },
    async ({ tasks }) => {
      const registry = await deps.loadRegistry();
      const schedule = routeParallelTasks(tasks, registry);
      const assignments = schedule.assignments as Array<Record<string, unknown>>;
      void logEvent("server", "route_parallel_tasks.result", {
        taskCount: tasks.length,
        assignedCount: assignments.filter((a) => a["status"] !== "unassigned").length,
        unassignedCount: assignments.filter((a) => a["status"] === "unassigned").length,
        hostUtilization: schedule.hostUtilization,
      });
      return jsonContent(schedule);
    }
  );

  server.tool(
    "route_task_with_watchdog",
    "Route a task with host/model liveness checks and automatic failover recommendations",
    {
      description: z.string().describe("Description of the task to route"),
      preferredHost: z
        .string()
        .optional()
        .describe("Optional host ID override for the primary attempt"),
      preferredModel: z
        .string()
        .optional()
        .describe("Optional model override for the primary attempt"),
      maxFallbacks: z
        .number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .describe("Maximum fallback hosts to probe"),
    },
    async ({ description, preferredHost, preferredModel, maxFallbacks }) => {
      const registry = await deps.loadRegistry();
      const baseRoute = routeTask(description, registry);
      const candidates = await buildWatchdogRouteCandidates(
        registry,
        description,
        preferredHost ?? null,
        preferredModel ?? null,
        maxFallbacks ?? 3,
        new Set<string>()
      );

      const selectedFailover = candidates.candidates[0] ?? null;
      const primaryHealthy = candidates.healthyPrimary;
      const status = primaryHealthy ? "healthy" : selectedFailover ? "degraded" : "unavailable";
      const primaryHealth =
        candidates.health.find((entry) => (entry as { kind?: string }).kind === "primary") ?? null;
      const failoverCandidates = candidates.health.filter(
        (entry) => (entry as { kind?: string }).kind === "fallback"
      );
      const reason = primaryHealthy
        ? "Primary route passed liveness checks"
        : selectedFailover
          ? "Primary route failed liveness checks; failover candidate selected"
          : "Primary route failed and no healthy failover was found";

      void logEvent("server", "route_task_with_watchdog.result", {
        description: description.slice(0, 200),
        status,
        primaryHost: candidates.primary?.host ?? null,
        primaryModel: candidates.primary?.model ?? null,
        selectedFailoverHost: selectedFailover?.host ?? null,
        fallbackCount: candidates.candidates.length,
      });

return jsonContent({
        status,
        reason,
        baseRoute,
        primary: candidates.primary
          ? {
              ...candidates.primary,
              health: primaryHealth
                ? ((primaryHealth as { health?: unknown }).health ?? null)
                : null,
            }
          : null,
        selectedFailover,
        failoverCandidates,
      });
    }
  );

  server.tool(
    "route_architect_editor",
    "Given a task description, recommend two lanes: an architect (deep reasoning) and an editor (fast execution). Reuses the existing tier-selection mechanism — the architect lane targets the coder-deep alias and the editor lane targets the coder-fast alias. Cloud hosts excluded by default.",
    {
      description: z.string().describe("Description of the task to route"),
      preferArchitectHost: z
        .string()
        .optional()
        .describe("Optional host ID override for the architect lane"),
      preferEditorHost: z
        .string()
        .optional()
        .describe("Optional host ID override for the editor lane"),
    },
    async ({ description, preferArchitectHost, preferEditorHost }) => {
      const registry = await deps.loadRegistry();
      const result = routeArchitectEditor(
        description,
        registry,
        preferArchitectHost ?? undefined,
        preferEditorHost ?? undefined
      );
      void logEvent("server", "route_architect_editor.result", {
        description: description.slice(0, 200),
        architectHost: result.architect.host,
        architectModel: result.architect.model,
        editorHost: result.editor.host,
        editorModel: result.editor.model,
        fallback: result.fallback,
      });
      return jsonContent(result);
    }
  );

  server.tool(
    "route_competitive_task",
    "Given a task description, produce up to N distinct routing lanes for competitive fan-out. Each lane is seeded with a different capability keyword to explore diverse hosts/models. Lanes are deduplicated by (host, model). Cloud hosts excluded by default.",
    {
      description: z.string().describe("Description of the task to route"),
      laneCount: z
        .number()
        .int()
        .min(2)
        .max(5)
        .describe("Number of competitive lanes to request (2–5)"),
    },
    async ({ description, laneCount }) => {
      const registry = await deps.loadRegistry();
      const result = routeCompetitiveTask(description, registry, laneCount);
      void logEvent("server", "route_competitive_task.result", {
        description: description.slice(0, 200),
        requestedLanes: result.requestedLanes,
        returnedLanes: result.returnedLanes,
        shortfall: result.shortfall,
        fallback: result.fallback,
      });
      return jsonContent(result);
    }
  );

  server.tool(
    "score_candidates",
    "Given a list of candidate task descriptions, score each against the tier keyword matcher and return a deterministic ranking with per-candidate rationale. Useful for selecting the best-matching lane from a set of options.",
    {
      candidates: z
        .array(z.string())
        .min(1)
        .max(50)
        .describe("Candidate task descriptions to score and rank"),
    },
    async ({ candidates }) => {
      const registry = await deps.loadRegistry();
      const ranked = scoreCandidates(candidates, registry);

      void logEvent("server", "score_candidates.result", {
        candidateCount: candidates.length,
        topScore: ranked[0]?.totalScore ?? 0,
        topCandidate: ranked[0]?.description.slice(0, 100) ?? "",
      });
      return jsonContent({ ranked });
    }
  );
}
