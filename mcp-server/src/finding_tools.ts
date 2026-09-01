import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { jsonContent } from "./agent_tool_helpers.js";
import {
  closeGeneration,
  evaluateGenerationCanary,
  FINDING_KIND_VALUES,
  FINDING_LANE_VALUES,
  ingestFinding,
  isForbiddenMechanismSurface,
  listFindings,
  openGeneration,
  readFindingStore,
  withFindingStoreLock,
  writeFindingStore,
  type CanaryOutcome,
  type DiversityCell,
  type FindingDraft,
  type FindingKind,
  type FindingLane,
} from "./finding_runtime.js";
import { toolAnnotations } from "./observability_tools.js";
import { guardStoreAccess } from "./supervisor_store_runtime.js";
import {
  BASELINE_REF_SCHEMA,
  METRIC_REF_SCHEMA,
  readTaskStore,
  type GoalContract,
} from "./task_runtime.js";

const DIVERSITY_CELL_SCHEMA = z.object({
  mechanismFamily: z.string().min(1).max(120),
  surface: z.string().min(1).max(120),
  intent: z.string().min(1).max(120),
});

function asCell(value: {
  mechanismFamily: string;
  surface: string;
  intent: string;
}): DiversityCell {
  return {
    mechanismFamily: value.mechanismFamily.trim(),
    surface: value.surface.trim(),
    intent: value.intent.trim(),
  };
}

export function registerFindingTools(server: McpServer): void {
  server.registerTool(
    "finding_record",
    {
      description:
        "Record a result or finding in the evidence store. Requested lane is a hint: " +
        "force-synthesized work lands in incubator, failures in diagnostic, canaries and " +
        "mechanism contracts are never parents, and unknown metric direction never confirms. " +
        "After a generation is closed, new records stay visible as late signals and cannot " +
        "rewrite committed membership.",
      inputSchema: {
        kind: z
          .enum(FINDING_KIND_VALUES)
          .describe("result | finding | canary | mechanism_contract"),
        title: z.string().min(1).max(200),
        summary: z.string().min(1).max(4000),
        requestedLane: z.enum(FINDING_LANE_VALUES).optional(),
        taskId: z.string().min(1).max(120).optional(),
        sessionId: z.string().min(1).max(120).optional(),
        generationId: z.string().min(1).max(120).optional(),
        sourceStatus: z.string().min(1).max(64).optional(),
        metric: METRIC_REF_SCHEMA.optional(),
        metricValue: z
          .union([z.number().finite(), z.literal("unknown")])
          .optional()
          .describe("Measured value, or the literal unknown — never a silent zero"),
        baseline: BASELINE_REF_SCHEMA.optional(),
        diversityCell: DIVERSITY_CELL_SCHEMA.optional(),
        plannedDimensions: DIVERSITY_CELL_SCHEMA.optional(),
        designDimensions: DIVERSITY_CELL_SCHEMA.optional(),
        canaryOutcome: z.enum(["pass", "fail", "could_not_run", "denied"]).optional(),
        validationCmd: z.string().min(1).max(1000).optional(),
        parentEligible: z.boolean().optional(),
        caveats: z.array(z.string().min(1).max(500)).max(32).optional(),
      },
      annotations: toolAnnotations("finding_record"),
    },
    async (args) =>
      guardStoreAccess(() =>
        withFindingStoreLock(async () => {
          if (args.kind === "mechanism_contract" && args.diversityCell) {
            if (isForbiddenMechanismSurface(args.diversityCell.surface)) {
              return jsonContent({
                status: "rejected",
                reasonCode: "mechanism_forbidden_surface",
                surface: args.diversityCell.surface,
                detail:
                  "A mechanism contract cannot target tests, eval, validationCmd, CI, or metric calculation.",
              });
            }
          }
          if (args.kind === "canary" && !args.canaryOutcome) {
            return jsonContent({
              status: "rejected",
              reasonCode: "canary_outcome_required",
              detail: "A canary finding must declare pass, fail, could_not_run, or denied.",
            });
          }

          const draft: FindingDraft = {
            kind: args.kind as FindingKind,
            title: args.title,
            summary: args.summary,
            requestedLane: args.requestedLane as FindingLane | undefined,
            taskId: args.taskId,
            sessionId: args.sessionId,
            generationId: args.generationId,
            sourceStatus: args.sourceStatus,
            metric: args.metric,
            metricValue: args.metricValue,
            baseline: args.baseline,
            diversityCell: args.diversityCell ? asCell(args.diversityCell) : undefined,
            plannedDimensions: args.plannedDimensions ? asCell(args.plannedDimensions) : undefined,
            designDimensions: args.designDimensions ? asCell(args.designDimensions) : undefined,
            canaryOutcome: args.canaryOutcome as CanaryOutcome | undefined,
            validationCmd: args.validationCmd,
            parentEligible: args.parentEligible,
            caveats: args.caveats,
          };

          const store = await readFindingStore();
          const ingested = ingestFinding(store, draft, new Date().toISOString());
          await writeFindingStore(store);
          return jsonContent({
            status: ingested.late ? "late" : "recorded",
            reasonCode: ingested.late
              ? "late_after_generation_boundary"
              : ingested.finding.laneReasonCode,
            finding: ingested.finding,
            late: ingested.late,
          });
        })
      )
  );

  server.registerTool(
    "finding_list",
    {
      description:
        "List recorded findings. Filters are conjunctive. Late signals of a closed generation " +
        "are included unless generationId is omitted and you filter by lane/parentEligible.",
      inputSchema: {
        lane: z.enum(FINDING_LANE_VALUES).optional(),
        kind: z.enum(FINDING_KIND_VALUES).optional(),
        generationId: z.string().min(1).max(120).optional(),
        taskId: z.string().min(1).max(120).optional(),
        sessionId: z.string().min(1).max(120).optional(),
        parentEligible: z.boolean().optional(),
      },
      annotations: toolAnnotations("finding_list"),
    },
    async (filters) =>
      guardStoreAccess(() =>
        withFindingStoreLock(async () => {
          const store = await readFindingStore();
          return jsonContent({
            status: "ok",
            findings: listFindings(store, filters),
          });
        })
      )
  );

  server.registerTool(
    "generation_open",
    {
      description:
        "Open a research generation for a cohort of tasks. This records the freeze; it does " +
        "not dispatch work. If any cohort task has a validationCmd or canaryCmd, a canary " +
        "finding for that task must already exist. A canary fail on the unchanged tree is a " +
        "measured baseline and does not block opening; could_not_run does.",
      inputSchema: {
        cohortTaskIds: z
          .array(z.string().min(1).max(120))
          .max(128)
          .describe("Task IDs in this generation"),
        index: z
          .number()
          .int()
          .min(0)
          .max(10_000)
          .optional()
          .describe("Generation index; defaults to the count of existing generations"),
        canaryFindingId: z.string().min(1).max(120).optional(),
      },
      annotations: toolAnnotations("generation_open"),
    },
    async ({ cohortTaskIds, index, canaryFindingId }) =>
      guardStoreAccess(() =>
        withFindingStoreLock(async () => {
          const store = await readFindingStore();
          const taskStore = await readTaskStore();
          const contracts: Array<{ taskId: string; contract: GoalContract }> = [];
          const missingTasks: string[] = [];
          for (const taskId of cohortTaskIds) {
            const task = taskStore.tasks[taskId];
            if (!task) {
              missingTasks.push(taskId);
              continue;
            }
            if (task.goalContract) {
              contracts.push({ taskId, contract: task.goalContract });
            }
          }
          if (missingTasks.length > 0) {
            return jsonContent({
              status: "rejected",
              reasonCode: "cohort_task_missing",
              missingTasks,
            });
          }

          const canaries = Object.values(store.findings).filter((finding) => {
            if (finding.kind !== "canary") return false;
            if (canaryFindingId && finding.findingId === canaryFindingId) return true;
            return finding.taskId !== undefined && cohortTaskIds.includes(finding.taskId);
          });
          const canaryCheck = evaluateGenerationCanary(contracts, canaries);
          if (!canaryCheck.ok) {
            return jsonContent({
              status: "rejected",
              reasonCode: canaryCheck.reasonCode,
              missingTaskIds: canaryCheck.missingTaskIds,
              blockedTaskIds: canaryCheck.blockedTaskIds,
              detail:
                canaryCheck.reasonCode === "canary_could_not_run"
                  ? "Canary could not execute on the unchanged tree; fan-out is blocked until the harness runs."
                  : "Run the canary command on the unchanged tree, record it with finding_record kind=canary, then open the generation.",
            });
          }

          const resolvedIndex = index ?? Object.keys(store.generations).length;
          const generation = openGeneration(store, {
            index: resolvedIndex,
            cohortTaskIds,
            canaryFindingId,
            openedAt: new Date().toISOString(),
          });
          await writeFindingStore(store);
          return jsonContent({
            status: "opened",
            reasonCode: canaryCheck.reasonCode,
            generation,
            canaryRequired: canaryCheck.required,
          });
        })
      )
  );

  server.registerTool(
    "generation_close",
    {
      description:
        "Commit a generation boundary. After close, new findings that name this generation " +
        "remain visible as late signals and cannot enter committed membership. This is a " +
        "store write, not a dispatcher.",
      inputSchema: {
        generationId: z.string().min(1).max(120),
        agenda: z
          .string()
          .max(8000)
          .optional()
          .describe("Next-generation agenda synthesized from committed evidence only"),
      },
      annotations: toolAnnotations("generation_close"),
    },
    async ({ generationId, agenda }) =>
      guardStoreAccess(() =>
        withFindingStoreLock(async () => {
          const store = await readFindingStore();
          const result = closeGeneration(store, generationId, new Date().toISOString(), agenda);
          if (result.ok) {
            await writeFindingStore(store);
          }
          return jsonContent({
            status: result.ok ? "closed" : "rejected",
            reasonCode: result.reasonCode,
            generation: result.generation ?? null,
          });
        })
      )
  );

  server.registerTool(
    "generation_status",
    {
      description:
        "Inspect a generation: committed findings, late signals, canary, agenda, and cutoff. " +
        "Omit generationId to list every generation.",
      inputSchema: {
        generationId: z.string().min(1).max(120).optional(),
      },
      annotations: toolAnnotations("generation_status"),
    },
    async ({ generationId }) =>
      guardStoreAccess(() =>
        withFindingStoreLock(async () => {
          const store = await readFindingStore();
          if (!generationId) {
            return jsonContent({
              status: "ok",
              generations: Object.values(store.generations).sort((a, b) => a.index - b.index),
            });
          }
          const generation = store.generations[generationId];
          if (!generation) {
            return jsonContent({ status: "missing", generationId });
          }
          return jsonContent({
            status: "ok",
            generation,
            findings: generation.findingIds
              .map((id) => store.findings[id])
              .filter((item) => item !== undefined),
            lateFindings: generation.lateFindingIds
              .map((id) => store.findings[id])
              .filter((item) => item !== undefined),
          });
        })
      )
  );
}
