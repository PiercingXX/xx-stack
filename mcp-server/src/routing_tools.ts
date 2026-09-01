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
} from "./routing_runtime.js";

import { jsonContent } from "./agent_tool_helpers.js";
import { toolAnnotations } from "./observability_tools.js";

interface RoutingToolDeps {
  loadRegistry: () => Promise<Registry>;
}

const descriptionInput = z
  .union([z.string(), z.array(z.string()).min(1).max(64)])
  .describe(
    "Description of the task to route, or an array of descriptions to route in one call (results are position-aligned with the input). Arrays are valid for mode default, architect-editor, and competitive."
  );

export function registerRoutingTools(server: McpServer, deps: RoutingToolDeps): void {
  server.registerTool(
    "route_task",
    {
      description:
        "Recommend which platform tier, host, and model to use. Optional mode selects a specialized planner: default (single lane), watchdog (liveness + failover), architect-editor (reasoning + fast pair), competitive (N diverse lanes), review (reviewer-model diversity).",
      inputSchema: {
        description: descriptionInput,
        mode: z
          .enum(["default", "watchdog", "architect-editor", "competitive", "review"])
          .optional()
          .describe("Routing planner. Default is a single-lane recommendation."),
        preferredHost: z
          .string()
          .optional()
          .describe("Watchdog: optional host ID override for the primary attempt"),
        preferredModel: z
          .string()
          .optional()
          .describe("Watchdog: optional model override for the primary attempt"),
        maxFallbacks: z
          .number()
          .int()
          .min(1)
          .max(8)
          .optional()
          .describe("Watchdog: maximum fallback hosts to probe"),
        preferArchitectHost: z
          .string()
          .optional()
          .describe("architect-editor: optional host ID override for the architect lane"),
        preferEditorHost: z
          .string()
          .optional()
          .describe("architect-editor: optional host ID override for the editor lane"),
        laneCount: z
          .number()
          .int()
          .min(2)
          .max(5)
          .optional()
          .describe("competitive: number of diverse lanes to request (2–5)"),
        authoredByModel: z
          .string()
          .optional()
          .describe("review: model that authored the work — avoided where the registry allows"),
        authoredByHost: z
          .string()
          .optional()
          .describe("review: host that authored the work — a different host is preferred"),
      },
      annotations: toolAnnotations("route_task"),
    },
    async (args) => {
      const registry = await deps.loadRegistry();
      const mode = args.mode ?? "default";
      const { description } = args;

      if (mode === "watchdog") {
        if (Array.isArray(description)) {
          return jsonContent({
            error: "watchdog mode accepts a single description, not an array",
          });
        }
        const baseRoute = routeTask(description, registry);
        const candidates = await buildWatchdogRouteCandidates(
          registry,
          description,
          args.preferredHost ?? null,
          args.preferredModel ?? null,
          args.maxFallbacks ?? 3,
          new Set<string>()
        );
        const selectedFailover = candidates.candidates[0] ?? null;
        const primaryHealthy = candidates.healthyPrimary;
        const status = primaryHealthy ? "healthy" : selectedFailover ? "degraded" : "unavailable";
        const primaryHealth =
          candidates.health.find((entry) => (entry as { kind?: string }).kind === "primary") ??
          null;
        const failoverCandidates = candidates.health.filter(
          (entry) => (entry as { kind?: string }).kind === "fallback"
        );
        const reason = primaryHealthy
          ? "Primary route passed liveness checks"
          : selectedFailover
            ? "Primary route failed liveness checks; failover candidate selected"
            : "Primary route failed and no healthy failover was found";
        void logEvent("server", "route_task.watchdog_result", {
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

      if (mode === "architect-editor") {
        const runOne = async (item: string): Promise<ReturnType<typeof routeArchitectEditor>> =>
          routeArchitectEditor(
            item,
            registry,
            args.preferArchitectHost ?? undefined,
            args.preferEditorHost ?? undefined
          );
        if (Array.isArray(description)) {
          const results = await mapWithConcurrency(description, BATCH_ROUTE_CONCURRENCY, runOne);
          void logEvent("server", "route_task.architect_editor_batch_result", {
            count: description.length,
            architectHosts: results.map((r) => r.architect.host),
            editorHosts: results.map((r) => r.editor.host),
          });
          return jsonContent({ results });
        }
        const result = await runOne(description);
        void logEvent("server", "route_task.architect_editor_result", {
          description: description.slice(0, 200),
          architectHost: result.architect.host,
          architectModel: result.architect.model,
          editorHost: result.editor.host,
          editorModel: result.editor.model,
          fallback: result.fallback,
        });
        return jsonContent(result);
      }

      if (mode === "competitive") {
        const laneCount = args.laneCount ?? 3;
        if (Array.isArray(description)) {
          const results = await mapWithConcurrency(
            description,
            BATCH_ROUTE_CONCURRENCY,
            async (item) => routeCompetitiveTask(item, registry, laneCount)
          );
          void logEvent("server", "route_task.competitive_batch_result", {
            count: description.length,
            returnedLanes: results.map((r) => r.returnedLanes),
            shortfalls: results.map((r) => r.shortfall),
          });
          return jsonContent({ results });
        }
        const result = routeCompetitiveTask(description, registry, laneCount);
        void logEvent("server", "route_task.competitive_result", {
          description: description.slice(0, 200),
          requestedLanes: result.requestedLanes,
          returnedLanes: result.returnedLanes,
          shortfall: result.shortfall,
          fallback: result.fallback,
        });
        return jsonContent(result);
      }

      if (mode === "review") {
        if (Array.isArray(description)) {
          return jsonContent({
            error: "review mode accepts a single description, not an array",
          });
        }
        const result = routeReview(
          description,
          registry,
          args.authoredByModel ?? undefined,
          args.authoredByHost ?? undefined
        );
        if (result.shortfall !== null) {
          void logEvent("server", "route_task.review_shortfall", {
            description: description.slice(0, 200),
            authoredByModel: result.authoredByModel,
            authoredByHost: result.authoredByHost,
            shortfall: result.shortfall,
          });
        }
        void logEvent("server", "route_task.review_result", {
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
}
