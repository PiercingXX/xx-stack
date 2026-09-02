import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { emitLifecycleHooks } from "./execution_policy.js";
import { guardStoreAccess } from "./supervisor_store_runtime.js";
import { narrowTaskStoreToReady, validateBlockedByEdges } from "./task_graph_runtime.js";
import { filterTasks } from "./task_list_runtime.js";
import {
  ANTI_REWARD_HACKING_CLAUSE,
  NULL_RESULT_VALID_CLAUSE,
  buildResumeDirective,
  evaluateTaskLease,
  generateTaskId,
  GOAL_CONTRACT_SCHEMA,
  LEASE_SELF_FENCING_CLAUSE,
  readTaskStore,
  sanitizeGoalContract,
  sanitizeIdList,
  sanitizeTags,
  sanitizeTaskLease,
  TASK_LEASE_SCHEMA,
  TASK_PRIORITY_SCHEMA,
  TASK_STATUS_SCHEMA,
  TASK_TERMINAL_STATUSES,
  trimOptional,
  withTaskStoreLock,
  writeTaskStore,
  type PersistentTask,
  type TaskLeaseCheck,
} from "./task_runtime.js";
import type {
  ReliabilityConfig,
  SupervisorSessionState,
  SupervisorStore,
} from "./supervisor_runtime.js";

import { jsonContent, type JsonToolResult } from "./agent_tool_helpers.js";
import { toolAnnotations } from "./observability_tools.js";
interface TaskToolDeps {
  loadReliabilityConfig: () => Promise<ReliabilityConfig>;
  readSupervisorStore: () => Promise<SupervisorStore>;
  pruneSupervisorStore: (store: SupervisorStore, reliability: ReliabilityConfig) => SupervisorStore;
}

function missingTask(taskId: string): JsonToolResult {
  return jsonContent({ status: "missing", taskId });
}

/**
 * Structured rejection for a fenced write.
 * Every path that mutates and persists a task shares this shape so a lane can
 * tell "my claim is dead" apart from "the task does not exist".
 */
function leaseRejection(
  operation: string,
  taskId: string,
  task: PersistentTask,
  leaseCheck: TaskLeaseCheck
): JsonToolResult {
  return jsonContent({
    status: "rejected",
    reasonCode: leaseCheck.reasonCode,
    operation,
    taskId,
    lease: task.lease ?? null,
    serverTime: new Date().toISOString(),
    detail:
      leaseCheck.reasonCode === "lease_revoked"
        ? `This task's lease was revoked; another lane holds the claim. The ${operation} was not applied.`
        : `This task's lease expired against the server clock. The ${operation} was not applied.`,
    selfFencingClause: LEASE_SELF_FENCING_CLAUSE,
  });
}

export function registerTaskTools(server: McpServer, deps: TaskToolDeps): void {
  server.registerTool(
    "task_suspend",
    {
      description: "Suspend an active task with checkpoint/error metadata for later resume",
      inputSchema: {
        taskId: z.string().min(1).describe("Task ID"),
        checkpoint: z
          .string()
          .max(4000)
          .optional()
          .describe("Checkpoint summary before suspension"),
        error: z.string().max(4000).optional().describe("Optional error or blocker summary"),
        worktreePath: z.string().max(4096).optional().describe("Optional isolated worktree path"),
        parentCwd: z.string().max(4096).optional().describe("Optional parent workspace path"),
      },
      annotations: toolAnnotations("task_suspend"),
    },
    async ({ taskId, checkpoint, error, worktreePath, parentCwd }) =>
      guardStoreAccess(() =>
        withTaskStoreLock(async () => {
          const store = await readTaskStore();
          const task = store.tasks[taskId];
          if (!task) {
            return missingTask(taskId);
          }

          // MCP-4: the lease fence guards every path that mutates and persists a
          // task, not just task_update. A lane whose claim was revoked by
          // failover must not be able to suspend the task the fallback lane now
          // owns. task_suspend carries no lease input, so there is no
          // re-lease carve-out here — re-assignment goes through task_update.
          const leaseCheck = evaluateTaskLease(task.lease, Date.now());
          if (!leaseCheck.ok) {
            return leaseRejection("task_suspend", taskId, task, leaseCheck);
          }

          // Terminal is terminal. done / canceled / force_synthesized are
          // "deliberately distinguished" outcomes (MANUAL §5); suspending one
          // rewrote a finished record into `suspended` and, for a
          // force-synthesized task, undid applyForceSynthesisOutcome. The
          // classification happens BEFORE any mutation, so the rejection path
          // writes nothing at all. task_resume carries the identical guard —
          // the lease fence stays ahead of both, unchanged.
          if (TASK_TERMINAL_STATUSES.has(task.status)) {
            return jsonContent({
              status: "rejected",
              reasonCode: "task_terminal",
              taskId,
              taskStatus: task.status,
              reason: `task is terminal (${task.status}); a terminal outcome is never reopened by suspend`,
            });
          }

          task.status = "suspended";
          task.lastCheckpoint = trimOptional(checkpoint) ?? task.lastCheckpoint;
          task.lastError = trimOptional(error) ?? task.lastError;
          task.worktreePath = trimOptional(worktreePath) ?? task.worktreePath;
          task.parentCwd = trimOptional(parentCwd) ?? task.parentCwd;
          task.resumable = task.resumable !== false;
          task.updatedAt = new Date().toISOString();
          store.tasks[taskId] = task;
          await writeTaskStore(store);

          return jsonContent({ status: "suspended", task });
        })
      )
  );

  server.registerTool(
    "task_resume",
    {
      description:
        "Resume a suspended or blocked task and emit a continuation directive with worktree context",
      inputSchema: {
        taskId: z.string().min(1).describe("Task ID"),
        checkpoint: z
          .string()
          .max(4000)
          .optional()
          .describe("Optional refreshed checkpoint before resume"),
        clearError: z.boolean().optional().describe("Clear stored lastError on resume"),
      },
      annotations: toolAnnotations("task_resume"),
    },
    async ({ taskId, checkpoint, clearError }) =>
      guardStoreAccess(() =>
        withTaskStoreLock(async () => {
          const store = await readTaskStore();
          const task = store.tasks[taskId];
          if (!task) {
            return missingTask(taskId);
          }

          // MCP-4: same fence as task_update/task_suspend. Re-assignment after a
          // failover is the supervisor's job and goes through task_update with a
          // replacement lease; a dead lane cannot resume its own claim.
          const leaseCheck = evaluateTaskLease(task.lease, Date.now());
          if (!leaseCheck.ok) {
            return leaseRejection("task_resume", taskId, task, leaseCheck);
          }

          // A terminal task is finished. Without this guard a resume flips a
          // done / canceled / force_synthesized task back to in_progress and
          // undoes applyForceSynthesisOutcome (MCP-4, related hardening).
          if (TASK_TERMINAL_STATUSES.has(task.status)) {
            return jsonContent({
              status: "rejected",
              reasonCode: "task_terminal",
              taskId,
              taskStatus: task.status,
              reason: `task is terminal (${task.status}); a terminal outcome is never reopened by resume`,
            });
          }

          if (task.resumable === false) {
            return jsonContent({ status: "blocked", reason: "task marked non-resumable", taskId });
          }

          task.status = "in_progress";
          task.attemptCount = (task.attemptCount ?? 0) + 1;
          task.resumeCount = (task.resumeCount ?? 0) + 1;
          task.lastCheckpoint = trimOptional(checkpoint) ?? task.lastCheckpoint;
          if (clearError === true) task.lastError = undefined;
          task.updatedAt = new Date().toISOString();

          let linkedSession: SupervisorSessionState | undefined;
          if (task.sessionId) {
            const reliability = await deps.loadReliabilityConfig();
            const supervisorStore = deps.pruneSupervisorStore(
              await deps.readSupervisorStore(),
              reliability
            );
            linkedSession = supervisorStore.sessions[task.sessionId];
          }

          const directive = buildResumeDirective(task, linkedSession);
          store.tasks[taskId] = task;
          await writeTaskStore(store);

          return jsonContent({
            status: "resumed",
            task,
            linkedSupervisorRoute: linkedSession?.currentRoute ?? null,
            directive,
          });
        })
      )
  );

  const LEASE_INPUT = TASK_LEASE_SCHEMA.optional().describe(
    "Optional self-enforced liveness lease for a lane on another machine. The control plane has " +
      "no kill channel, so the lane enforces its own deadline: " +
      `${LEASE_SELF_FENCING_CLAUSE}. expiresAt is compared against the server's clock at ` +
      "write-back; a task-result write-back against a revoked or expired lease is rejected."
  );

  const GOAL_CONTRACT_INPUT = GOAL_CONTRACT_SCHEMA.optional().describe(
    "Optional five-part goal contract for supervised autonomous execution. " +
      "Meta-prompting rule: before writing this contract, inspect the repo and surface hidden " +
      "constraints (build/test commands, conventions, things that must not change) so the " +
      "contract reflects reality rather than assumptions. The contract carries a mandatory " +
      `anti-reward-hacking clause: ${ANTI_REWARD_HACKING_CLAUSE}. ` +
      "For a prospecting goal (find dead code, find performance wins), write the stopCondition " +
      "so a null result can satisfy it — otherwise the honest answer 'nothing worth changing' " +
      `leaves the condition permanently unmet. ${NULL_RESULT_VALID_CLAUSE}.`
  );

  server.registerTool(
    "task_create",
    {
      description:
        "Create a persistent task item for long-running orchestrated work. For supervised " +
        "autonomous tasks, attach a goalContract (objective, constraints, validationCmd, " +
        "stopCondition, docsNote, optional metric/baseline/canaryCmd); inspect the repo and " +
        "surface hidden constraints before writing the contract, and never delete, skip, " +
        "weaken, or narrow tests to make the goal pass",
      inputSchema: {
        title: z.string().min(1).max(200).describe("Task title"),
        description: z.string().max(4000).optional().describe("Optional task description"),
        status: TASK_STATUS_SCHEMA.optional().describe("Initial status"),
        resumable: z
          .boolean()
          .optional()
          .describe("Whether this task supports structured resume directives"),
        sessionId: z.string().max(120).optional().describe("Optional linked supervisor session ID"),
        worktreePath: z
          .string()
          .max(4096)
          .optional()
          .describe("Optional worktree path where task edits are isolated"),
        parentCwd: z
          .string()
          .max(4096)
          .optional()
          .describe("Optional parent working directory for inherited context"),
        lastCheckpoint: z
          .string()
          .max(4000)
          .optional()
          .describe("Optional initial checkpoint summary"),
        goalContract: GOAL_CONTRACT_INPUT,
        lease: LEASE_INPUT,
        priority: TASK_PRIORITY_SCHEMA.optional().describe("Optional priority"),
        tags: z.array(z.string().min(1).max(64)).max(32).optional().describe("Optional tags"),
        owner: z.string().max(120).optional().describe("Optional owner hint"),
        blockedBy: z
          .array(z.string().min(1).max(64))
          .max(32)
          .optional()
          .describe(
            "Optional blocker task IDs. Each ID must name an existing task and must not close a " +
              "dependency cycle; a dangling or cycle-creating edge is rejected and nothing is " +
              "written, rather than persisted as a silent deadlock. Blockers are read by " +
              "task_list readyOnly, the _Stop hook, and route_parallel_tasks wave planning"
          ),
        dueAt: z.string().optional().describe("Optional due date as ISO-8601"),
      },
      annotations: toolAnnotations("task_create"),
    },
    async ({
      title,
      description,
      status,
      resumable,
      sessionId,
      worktreePath,
      parentCwd,
      lastCheckpoint,
      goalContract,
      lease,
      priority,
      tags,
      owner,
      blockedBy,
      dueAt,
    }) =>
      guardStoreAccess(async () => {
        // MCP-12: withTaskStoreLock is a non-reentrant promise-chain mutex and
        // lifecycle hooks are external subprocesses that may call back into
        // these very tools. The hook is emitted only after the lock is
        // released; everything it needs is captured while holding it.
        type CreateOutcome =
          { kind: "result"; result: JsonToolResult } | { kind: "created"; task: PersistentTask };

        const outcome = await withTaskStoreLock(async (): Promise<CreateOutcome> => {
          const store = await readTaskStore();
          const now = new Date().toISOString();
          const taskId = generateTaskId();

          const task: PersistentTask = {
            taskId,
            title: title.trim(),
            description: trimOptional(description),
            status: status ?? "todo",
            resumable: resumable ?? true,
            sessionId: trimOptional(sessionId),
            attemptCount: status === "in_progress" ? 1 : 0,
            resumeCount: 0,
            worktreePath: trimOptional(worktreePath),
            parentCwd: trimOptional(parentCwd),
            lastCheckpoint: trimOptional(lastCheckpoint),
            goalContract: sanitizeGoalContract(goalContract),
            lease: sanitizeTaskLease(lease),
            priority,
            tags: sanitizeTags(tags),
            owner: trimOptional(owner),
            blockedBy: sanitizeIdList(blockedBy),
            dueAt: trimOptional(dueAt),
            createdAt: now,
            updatedAt: now,
          };

          // A blocker edge is validated against the store as it would look if
          // this write landed, and rejected before anything is persisted. The
          // dangling ids are deliberately NOT pruned: silent repair is the
          // failure mode MCP-1 was about — a store that quietly edits the
          // caller's data and never says so.
          const violation = validateBlockedByEdges([...Object.values(store.tasks), task], taskId);
          if (violation) {
            return {
              kind: "result",
              result: jsonContent({ ...violation, operation: "task_create" }),
            };
          }

          store.tasks[taskId] = task;
          await writeTaskStore(store);
          return { kind: "created", task };
        });

        if (outcome.kind === "result") return outcome.result;
        const task = outcome.task;

        const hookSummary = await emitLifecycleHooks("task.created", {
          taskId: task.taskId,
          status: task.status,
          title: task.title,
        });

        return jsonContent({ status: "created", task, hooks: hookSummary });
      })
  );

  server.registerTool(
    "task_get",
    {
      description: "Get one persistent task by ID",
      inputSchema: {
        taskId: z.string().min(1).describe("Task ID"),
      },
      annotations: toolAnnotations("task_get"),
    },
    async ({ taskId }) =>
      guardStoreAccess(() =>
        withTaskStoreLock(async () => {
          const store = await readTaskStore();
          const task = store.tasks[taskId];
          if (!task) {
            return missingTask(taskId);
          }
          return jsonContent({ status: "ok", task });
        })
      )
  );

  server.registerTool(
    "task_update",
    {
      description:
        "Update persistent task fields including status and blockers. Result write-back " +
        "(status, lastCheckpoint, lastError) is always fenced: a revoked or expired lease " +
        "rejects those fields (reasonCode lease_revoked / lease_expired) even when the same " +
        "request carries a replacement lease. A lease-only update is supervisor re-assignment " +
        "and is not fenced",
      inputSchema: {
        taskId: z.string().min(1).describe("Task ID"),
        title: z.string().min(1).max(200).optional().describe("Updated title"),
        description: z.string().max(4000).optional().describe("Updated description"),
        status: TASK_STATUS_SCHEMA.optional().describe("Updated status"),
        resumable: z
          .boolean()
          .optional()
          .describe("Whether this task supports structured resume directives"),
        sessionId: z.string().max(120).optional().describe("Updated supervisor session ID"),
        worktreePath: z.string().max(4096).optional().describe("Updated worktree path"),
        parentCwd: z.string().max(4096).optional().describe("Updated parent working directory"),
        lastCheckpoint: z.string().max(4000).optional().describe("Updated checkpoint summary"),
        lastError: z.string().max(4000).optional().describe("Updated error summary"),
        goalContract: GOAL_CONTRACT_INPUT,
        lease: LEASE_INPUT,
        priority: TASK_PRIORITY_SCHEMA.optional().describe("Updated priority"),
        tags: z.array(z.string().min(1).max(64)).max(32).optional().describe("Updated tags"),
        owner: z.string().max(120).optional().describe("Updated owner"),
        blockedBy: z
          .array(z.string().min(1).max(64))
          .max(32)
          .optional()
          .describe(
            "Updated blocker task IDs. Each ID must name an existing task and must not close a " +
              "dependency cycle; a dangling or cycle-creating edge is rejected (reasonCode " +
              "blocked_by_unknown_task / blocked_by_cycle, with the unknown ID quoted or the " +
              "cycle path named) and nothing is written"
          ),
        dueAt: z.string().optional().describe("Updated due date as ISO-8601"),
      },
      annotations: toolAnnotations("task_update"),
    },
    async ({
      taskId,
      title,
      description,
      status,
      resumable,
      sessionId,
      worktreePath,
      parentCwd,
      lastCheckpoint,
      lastError,
      goalContract,
      lease,
      priority,
      tags,
      owner,
      blockedBy,
      dueAt,
    }) =>
      guardStoreAccess(async () => {
        // MCP-12: the lifecycle hook is emitted after the store lock is
        // released. The locked section returns either a finished result (the
        // paths that write nothing) or the persisted task to announce.
        type UpdateOutcome =
          { kind: "result"; result: JsonToolResult } | { kind: "updated"; task: PersistentTask };

        const outcome = await withTaskStoreLock(async (): Promise<UpdateOutcome> => {
          const store = await readTaskStore();
          const task = store.tasks[taskId];
          if (!task) {
            return { kind: "result", result: missingTask(taskId) };
          }

          // Self-enforced lease invariant. Result write-back (status,
          // lastCheckpoint, lastError) is always fenced against the *current*
          // lease: a lane whose claim was revoked by failover — or whose
          // deadline passed against the server's own clock — cannot land a
          // result by also supplying a new lease. A lease-only request is
          // supervisor re-assignment and stays unfenced. task_suspend and
          // task_resume carry the same fence with no carve-out (MCP-4).
          const replacementLease = sanitizeTaskLease(lease);
          const isWriteBack =
            status !== undefined ||
            typeof lastCheckpoint === "string" ||
            typeof lastError === "string";
          if (isWriteBack) {
            const leaseCheck = evaluateTaskLease(task.lease, Date.now());
            if (!leaseCheck.ok) {
              return {
                kind: "result",
                result: leaseRejection("write-back", taskId, task, leaseCheck),
              };
            }
          }

          if (typeof title === "string") task.title = title.trim();
          if (typeof description === "string") task.description = trimOptional(description);
          if (status) task.status = status;
          if (typeof resumable === "boolean") task.resumable = resumable;
          if (typeof sessionId === "string") task.sessionId = trimOptional(sessionId);
          if (typeof worktreePath === "string") task.worktreePath = trimOptional(worktreePath);
          if (typeof parentCwd === "string") task.parentCwd = trimOptional(parentCwd);
          if (typeof lastCheckpoint === "string")
            task.lastCheckpoint = trimOptional(lastCheckpoint);
          if (typeof lastError === "string") task.lastError = trimOptional(lastError);
          if (goalContract) task.goalContract = sanitizeGoalContract(goalContract);
          if (replacementLease) task.lease = replacementLease;
          if (priority) task.priority = priority;
          if (Array.isArray(tags)) task.tags = sanitizeTags(tags);
          if (typeof owner === "string") task.owner = trimOptional(owner);
          if (Array.isArray(blockedBy)) task.blockedBy = sanitizeIdList(blockedBy);
          if (typeof dueAt === "string") task.dueAt = trimOptional(dueAt);

          // Same write-time fence as task_create, and the only place a cycle
          // can actually be closed: `task` is the live object read from this
          // store snapshot, so the mutated edges are what gets validated — and
          // returning here persists nothing, because the store snapshot is
          // discarded with the lock.
          if (Array.isArray(blockedBy)) {
            const violation = validateBlockedByEdges(Object.values(store.tasks), taskId);
            if (violation) {
              return {
                kind: "result",
                result: jsonContent({ ...violation, operation: "task_update" }),
              };
            }
          }

          task.updatedAt = new Date().toISOString();

          store.tasks[taskId] = task;
          await writeTaskStore(store);
          return { kind: "updated", task };
        });

        if (outcome.kind === "result") return outcome.result;

        const hookSummary = await emitLifecycleHooks("task.updated", {
          taskId,
          status: outcome.task.status,
          title: outcome.task.title,
        });

        return jsonContent({ status: "updated", task: outcome.task, hooks: hookSummary });
      })
  );

  server.registerTool(
    "task_list",
    {
      description:
        "List persistent tasks with optional status, tag, owner, and dependency-readiness filters",
      inputSchema: {
        status: TASK_STATUS_SCHEMA.optional().describe("Optional status filter"),
        tag: z.string().optional().describe("Optional tag filter"),
        owner: z.string().optional().describe("Optional owner filter"),
        includeCompleted: z.boolean().optional().describe("Include done and canceled tasks"),
        readyOnly: z
          .boolean()
          .optional()
          .describe(
            "Return only tasks that can actually be started now: non-terminal, with every " +
              "blockedBy entry already terminal (done, canceled, or force_synthesized). A task " +
              "whose blocker names no existing task is never ready. This is a view, not a " +
              "dispatcher — nothing is started on your behalf"
          ),
        limit: z.number().int().min(1).max(500).optional().describe("Maximum tasks to return"),
      },
      annotations: toolAnnotations("task_list"),
    },
    async ({ status, tag, owner, includeCompleted, readyOnly, limit }) =>
      guardStoreAccess(() =>
        withTaskStoreLock(async () => {
          const store = await readTaskStore();
          // Readiness narrows the store before filterTasks so `total` and
          // `returned` describe the same population, and so terminal blockers
          // are still visible to the readiness pass that needs them.
          const scoped = readyOnly === true ? narrowTaskStoreToReady(store) : store;
          // MCP-DUP-3: the filter/sort/cap shaping is the shared runtime the
          // `xx tasks list` CLI path calls, not a second copy of it — and
          // readyOnly narrows through the same shared function on both sides.
          return jsonContent(filterTasks(scoped, { status, tag, owner, includeCompleted, limit }));
        })
      )
  );
}
