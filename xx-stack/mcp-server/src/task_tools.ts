import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { emitLifecycleHooks } from "./execution_policy.js";
import {
  buildResumeDirective,
  generateTaskId,
  readTaskStore,
  sanitizeIdList,
  sanitizeTags,
  TASK_PRIORITY_SCHEMA,
  TASK_STATUS_SCHEMA,
  TASK_TERMINAL_STATUSES,
  trimOptional,
  withTaskStoreLock,
  writeTaskStore,
  type PersistentTask,
} from "./task_runtime.js";
import type {
  ReliabilityConfig,
  SupervisorSessionState,
  SupervisorStore,
} from "./supervisor_runtime.js";

import { jsonContent, type JsonToolResult } from "./agent_tool_helpers.js";
interface TaskToolDeps {
  loadReliabilityConfig: () => Promise<ReliabilityConfig>;
  readSupervisorStore: () => Promise<SupervisorStore>;
  pruneSupervisorStore: (store: SupervisorStore, reliability: ReliabilityConfig) => SupervisorStore;
}

function missingTask(taskId: string): JsonToolResult {
  return jsonContent({ status: "missing", taskId });
}

export function registerTaskTools(server: McpServer, deps: TaskToolDeps): void {
  server.tool(
    "task_suspend",
    "Suspend an active task with checkpoint/error metadata for later resume",
    {
      taskId: z.string().min(1).describe("Task ID"),
      checkpoint: z.string().max(4000).optional().describe("Checkpoint summary before suspension"),
      error: z.string().max(4000).optional().describe("Optional error or blocker summary"),
      worktreePath: z.string().max(4096).optional().describe("Optional isolated worktree path"),
      parentCwd: z.string().max(4096).optional().describe("Optional parent workspace path"),
    },
    async ({ taskId, checkpoint, error, worktreePath, parentCwd }) =>
      withTaskStoreLock(async () => {
        const store = await readTaskStore();
        const task = store.tasks[taskId];
        if (!task) {
          return missingTask(taskId);
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
  );

  server.tool(
    "task_resume",
    "Resume a suspended or blocked task and emit a continuation directive with worktree context",
    {
      taskId: z.string().min(1).describe("Task ID"),
      checkpoint: z
        .string()
        .max(4000)
        .optional()
        .describe("Optional refreshed checkpoint before resume"),
      clearError: z.boolean().optional().describe("Clear stored lastError on resume"),
    },
    async ({ taskId, checkpoint, clearError }) =>
      withTaskStoreLock(async () => {
        const store = await readTaskStore();
        const task = store.tasks[taskId];
        if (!task) {
          return missingTask(taskId);
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
  );

  server.tool(
    "task_create",
    "Create a persistent task item for long-running orchestrated work",
    {
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
      priority: TASK_PRIORITY_SCHEMA.optional().describe("Optional priority"),
      tags: z.array(z.string().min(1).max(64)).max(32).optional().describe("Optional tags"),
      owner: z.string().max(120).optional().describe("Optional owner hint"),
      blockedBy: z
        .array(z.string().min(1).max(64))
        .max(32)
        .optional()
        .describe("Optional blocker IDs"),
      dueAt: z.string().optional().describe("Optional due date as ISO-8601"),
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
      priority,
      tags,
      owner,
      blockedBy,
      dueAt,
    }) =>
      withTaskStoreLock(async () => {
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
          priority,
          tags: sanitizeTags(tags),
          owner: trimOptional(owner),
          blockedBy: sanitizeIdList(blockedBy),
          dueAt: trimOptional(dueAt),
          createdAt: now,
          updatedAt: now,
        };

        store.tasks[taskId] = task;
        await writeTaskStore(store);
        const hookSummary = await emitLifecycleHooks("task.created", {
          taskId,
          status: task.status,
          title: task.title,
        });

        return jsonContent({ status: "created", task, hooks: hookSummary });
      })
  );

  server.tool(
    "task_get",
    "Get one persistent task by ID",
    {
      taskId: z.string().min(1).describe("Task ID"),
    },
    async ({ taskId }) =>
      withTaskStoreLock(async () => {
        const store = await readTaskStore();
        const task = store.tasks[taskId];
        if (!task) {
          return missingTask(taskId);
        }
        return jsonContent({ status: "ok", task });
      })
  );

  server.tool(
    "task_update",
    "Update persistent task fields including status and blockers",
    {
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
      priority: TASK_PRIORITY_SCHEMA.optional().describe("Updated priority"),
      tags: z.array(z.string().min(1).max(64)).max(32).optional().describe("Updated tags"),
      owner: z.string().max(120).optional().describe("Updated owner"),
      blockedBy: z
        .array(z.string().min(1).max(64))
        .max(32)
        .optional()
        .describe("Updated blocker IDs"),
      dueAt: z.string().optional().describe("Updated due date as ISO-8601"),
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
      priority,
      tags,
      owner,
      blockedBy,
      dueAt,
    }) =>
      withTaskStoreLock(async () => {
        const store = await readTaskStore();
        const task = store.tasks[taskId];
        if (!task) {
          return missingTask(taskId);
        }

        if (typeof title === "string") task.title = title.trim();
        if (typeof description === "string") task.description = trimOptional(description);
        if (status) task.status = status;
        if (typeof resumable === "boolean") task.resumable = resumable;
        if (typeof sessionId === "string") task.sessionId = trimOptional(sessionId);
        if (typeof worktreePath === "string") task.worktreePath = trimOptional(worktreePath);
        if (typeof parentCwd === "string") task.parentCwd = trimOptional(parentCwd);
        if (typeof lastCheckpoint === "string") task.lastCheckpoint = trimOptional(lastCheckpoint);
        if (typeof lastError === "string") task.lastError = trimOptional(lastError);
        if (priority) task.priority = priority;
        if (Array.isArray(tags)) task.tags = sanitizeTags(tags);
        if (typeof owner === "string") task.owner = trimOptional(owner);
        if (Array.isArray(blockedBy)) task.blockedBy = sanitizeIdList(blockedBy);
        if (typeof dueAt === "string") task.dueAt = trimOptional(dueAt);
        task.updatedAt = new Date().toISOString();

        store.tasks[taskId] = task;
        await writeTaskStore(store);
        const hookSummary = await emitLifecycleHooks("task.updated", {
          taskId,
          status: task.status,
          title: task.title,
        });

        return jsonContent({ status: "updated", task, hooks: hookSummary });
      })
  );

  server.tool(
    "task_list",
    "List persistent tasks with optional status, tag, and owner filters",
    {
      status: TASK_STATUS_SCHEMA.optional().describe("Optional status filter"),
      tag: z.string().optional().describe("Optional tag filter"),
      owner: z.string().optional().describe("Optional owner filter"),
      includeCompleted: z.boolean().optional().describe("Include done and canceled tasks"),
      limit: z.number().int().min(1).max(500).optional().describe("Maximum tasks to return"),
    },
    async ({ status, tag, owner, includeCompleted, limit }) =>
      withTaskStoreLock(async () => {
        const store = await readTaskStore();
        const tagFilter = tag?.trim().toLowerCase();
        const ownerFilter = owner?.trim().toLowerCase();

        const tasks = Object.values(store.tasks)
          .filter((task) => !status || task.status === status)
          .filter((task) => includeCompleted === true || !TASK_TERMINAL_STATUSES.has(task.status))
          .filter(
            (task) => !tagFilter || task.tags.some((taskTag) => taskTag.toLowerCase() === tagFilter)
          )
          .filter((task) => !ownerFilter || (task.owner ?? "").toLowerCase() === ownerFilter)
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

        const capped = tasks.slice(0, limit ?? 100);
        return jsonContent({
          total: tasks.length,
          returned: capped.length,
          tasks: capped,
        });
      })
  );
}
