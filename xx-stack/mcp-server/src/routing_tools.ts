import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { logEvent } from "./log_worker.js";
import type { Registry } from "./platform_types.js";
import {
  BATCH_ROUTE_CONCURRENCY,
  buildWatchdogRouteCandidates,
  mapWithConcurrency,
  routeArchitectEditor,
  routeCompetitiveTask,
  routeParallelTasks,
  routeReview,
  routeTask,
  scoreCandidates,
} from "./routing_runtime.js";

import { jsonContent } from "./agent_tool_helpers.js";
import { toolAnnotations } from "./observability_tools.js";
interface RoutingToolDeps {
  loadRegistry: () => Promise<Registry>;
}

export function registerRoutingTools(server: McpServer, deps: RoutingToolDeps): void {
  server.registerTool(
    "route_task",
    {
      description:
        "Given a task description (or an array of descriptions for a batched, position-aligned result), recommend which platform tier, host, and model to use",
      inputSchema: {
        description: z
          .union([z.string(), z.array(z.string()).min(1).max(64)])
          .describe(
            "Description of the task to route, or an array of descriptions to route in one call (results are position-aligned with the input)"
          ),
      },
      annotations: toolAnnotations("route_task"),
    },
    async ({ description }) => {
      const registry = await deps.loadRegistry();
      if (Array.isArray(description)) {
        const results = await mapWithConcurrency(
          description,
          BATCH_ROUTE_CONCURRENCY,
          async (item) => routeTask(item, registry)
        );
        void logEvent("server", "route_task.batch_result", {
          count: description.length,
          hosts: results.map((r) => r.recommendedHost),
          models: results.map((r) => r.recommendedModel),
        });
        return jsonContent({ results });
      }
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

  server.registerTool(
    "route_parallel_tasks",
    {
      description:
        "Given multiple task descriptions, produce a hardware-aware parallel delegation schedule across local and remote hosts. Decompose work into tracer-bullet tasks before calling: each task should be a vertical slice through every layer it touches, sized to fit one fresh context window, with blocking edges between slices declared explicitly rather than discovered mid-run. Declared edges are now honored: pass objects with blockedBy and the result carries a dependencySchedule of waves. This returns a plan — xx-stack never dispatches, polls, or sequences the waves; the calling agent runs a wave, confirms it finished, and calls back for the next.",
      inputSchema: {
        tasks: z
          .union([
            z.array(z.string()).min(1).max(128),
            z
              .array(
                z.object({
                  id: z
                    .string()
                    .min(1)
                    .max(64)
                    .optional()
                    .describe("Optional slice ID; defaults to the array index as a string"),
                  description: z.string().describe("Task description for this slice"),
                  blockedBy: z
                    .array(z.string().min(1).max(64))
                    .max(32)
                    .optional()
                    .describe("IDs of slices in this same array that must finish before this one"),
                  cohortKind: z
                    .enum(["slice", "hypothesis"])
                    .optional()
                    .describe(
                      "hypothesis = competing approaches (QD caps apply). slice = ordinary independent work. Default slice."
                    ),
                  diversityCell: z
                    .object({
                      mechanismFamily: z.string().min(1).max(120),
                      surface: z.string().min(1).max(120),
                      intent: z.string().min(1).max(120),
                    })
                    .optional()
                    .describe("Design cell for a hypothesis slice; implied cohortKind=hypothesis"),
                })
              )
              .min(1)
              .max(128),
          ])
          .describe(
            "Task descriptions to schedule in parallel. Flat strings return today's schedule " +
              "unchanged; objects with blockedBy additionally return dependency waves"
          ),
      },
      annotations: toolAnnotations("route_parallel_tasks"),
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

  server.registerTool(
    "route_task_with_watchdog",
    {
      description:
        "Route a task with host/model liveness checks and automatic failover recommendations",
      inputSchema: {
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
      annotations: toolAnnotations("route_task_with_watchdog"),
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

  server.registerTool(
    "route_architect_editor",
    {
      description:
        "Given a task description (or an array of descriptions for a batched, position-aligned result), recommend two lanes: an architect (deep reasoning) and an editor (fast execution). Reuses the existing tier-selection mechanism — the architect lane targets the coder-deep alias and the editor lane targets the coder-fast alias. Cloud hosts excluded by default.",
      inputSchema: {
        description: z
          .union([z.string(), z.array(z.string()).min(1).max(64)])
          .describe(
            "Description of the task to route, or an array of descriptions to route in one call (results are position-aligned with the input)"
          ),
        preferArchitectHost: z
          .string()
          .optional()
          .describe("Optional host ID override for the architect lane"),
        preferEditorHost: z
          .string()
          .optional()
          .describe("Optional host ID override for the editor lane"),
      },
      annotations: toolAnnotations("route_architect_editor"),
    },
    async ({ description, preferArchitectHost, preferEditorHost }) => {
      const registry = await deps.loadRegistry();
      if (Array.isArray(description)) {
        const results = await mapWithConcurrency(
          description,
          BATCH_ROUTE_CONCURRENCY,
          async (item) =>
            routeArchitectEditor(
              item,
              registry,
              preferArchitectHost ?? undefined,
              preferEditorHost ?? undefined
            )
        );
        void logEvent("server", "route_architect_editor.batch_result", {
          count: description.length,
          architectHosts: results.map((r) => r.architect.host),
          editorHosts: results.map((r) => r.editor.host),
        });
        return jsonContent({ results });
      }
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

  server.registerTool(
    "route_competitive_task",
    {
      description:
        "Given a task description (or an array of descriptions for a batched, position-aligned result), produce up to N distinct routing lanes for competitive fan-out. Each lane is seeded with a different capability keyword to explore diverse hosts/models. Lanes are deduplicated by (host, model). Cloud hosts excluded by default. The caller creates one git worktree per lane and MUST bootstrap each before its agent starts — a bare worktree is the #1 way a parallel lane fails confusingly: copy (never symlink) env files into the worktree, install dependencies, pin shared-service identity/ports per lane so worktrees don't fight, and rebuild gitignored artifacts. Keep that checklist in a scripts/setup-worktree.sh at the repo root so every lane bootstraps identically.",
      inputSchema: {
        description: z
          .union([z.string(), z.array(z.string()).min(1).max(64)])
          .describe(
            "Description of the task to route, or an array of descriptions to route in one call (results are position-aligned with the input)"
          ),
        laneCount: z
          .number()
          .int()
          .min(2)
          .max(5)
          .describe("Number of competitive lanes to request (2–5)"),
      },
      annotations: toolAnnotations("route_competitive_task"),
    },
    async ({ description, laneCount }) => {
      const registry = await deps.loadRegistry();
      if (Array.isArray(description)) {
        const results = await mapWithConcurrency(
          description,
          BATCH_ROUTE_CONCURRENCY,
          async (item) => routeCompetitiveTask(item, registry, laneCount)
        );
        void logEvent("server", "route_competitive_task.batch_result", {
          count: description.length,
          returnedLanes: results.map((r) => r.returnedLanes),
          shortfalls: results.map((r) => r.shortfall),
        });
        return jsonContent({ results });
      }
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

  server.registerTool(
    "score_candidates",
    {
      description:
        "Given a list of candidate task descriptions, score each against the tier keyword matcher and return a deterministic ranking with per-candidate rationale. Useful for selecting the best-matching lane from a set of options.",
      inputSchema: {
        candidates: z
          .array(z.string())
          .min(1)
          .max(50)
          .describe("Candidate task descriptions to score and rank"),
      },
      annotations: toolAnnotations("score_candidates"),
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

  server.registerTool(
    "route_review",
    {
      description:
        "Recommend a review lane whose model differs from the model that authored the work (reviewer diversity — a different model family catches what the authoring model is systematically blind to). Collapses gracefully to same-model review with explicit reasoning when the registry offers no alternative. Cloud hosts excluded by default.",
      inputSchema: {
        description: z.string().describe("Description of the work to be reviewed"),
        authoredByModel: z
          .string()
          .optional()
          .describe(
            "Model that authored the work — the reviewer lane avoids this model where the registry allows"
          ),
        authoredByHost: z
          .string()
          .optional()
          .describe(
            "Host that authored the work — a different host is preferred for the reviewer lane"
          ),
      },
      annotations: toolAnnotations("route_review"),
    },
    async ({ description, authoredByModel, authoredByHost }) => {
      const registry = await deps.loadRegistry();
      const result = routeReview(
        description,
        registry,
        authoredByModel ?? undefined,
        authoredByHost ?? undefined
      );
      if (result.shortfall !== null) {
        // No silent degradation: the shortfall gets its own log line.
        void logEvent("server", "route_review.shortfall", {
          description: description.slice(0, 200),
          authoredByModel: result.authoredByModel,
          authoredByHost: result.authoredByHost,
          shortfall: result.shortfall,
        });
      }
      void logEvent("server", "route_review.result", {
        description: description.slice(0, 200),
        reviewerHost: result.reviewer.host,
        reviewerModel: result.reviewer.model,
        modelDiversity: result.modelDiversity,
        authoredByModel: result.authoredByModel,
        authoredByHost: result.authoredByHost,
        shortfall: result.shortfall,
        fallback: result.fallback,
      });
      return jsonContent(result);
    }
  );
}
