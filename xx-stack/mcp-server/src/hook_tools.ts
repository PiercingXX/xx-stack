import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AgentMemoryScope } from "./config_runtime.js";
import type { CompletionMemorySyncGuard } from "./memory_runtime.js";
import type {
  ReliabilityConfig,
  SupervisorSessionState,
  SupervisorStore,
} from "./supervisor_runtime.js";
import {
  buildWorktreeResumeNotice,
  evaluateGoalContractCompletion,
  TASK_TERMINAL_STATUSES,
  type PersistentTask,
  type TaskStore,
} from "./task_runtime.js";

/**
 * MCP lifecycle hook tools (UPSTREAM-BORROW task 26).
 *
 * The buzz hook convention: a hook-aware harness calls underscore-prefixed MCP
 * tools at fixed points in its own loop. `_Stop` runs when the model signals
 * end_turn — non-empty text is an objection and the agent keeps working, an
 * empty string allows the stop. `_PostCompact` runs after context compaction
 * and returns state to re-inject into the fresh context.
 *
 * Provider-side contract this module honors:
 * - fast: only two single-file JSON store reads, no filesystem walks or scans.
 *   Callers time out at ~2.5s and treat a timeout as "no objection".
 * - deterministic: identical store state produces byte-identical output
 *   (every collection is explicitly sorted, every list explicitly capped).
 * - empty string from `_Stop` means "no objection".
 * - the caller injects this text at tool-result trust, not system trust, so
 *   nothing here is phrased as an instruction from the operator — the hooks
 *   report observed state and let the agent decide.
 * - `_Stop` objections are bounded: the caller enforces a rejection budget, so
 *   each objection names one concrete unmet condition (task id + stop
 *   condition) the agent can act on in a single round.
 *
 * Off by default: a harness that is not hook-aware would see these as ordinary
 * callable tools. Registration is gated behind XX_STACK_HOOK_TOOLS=1.
 */

const HOOK_TOOLS_ENV_FLAG = "XX_STACK_HOOK_TOOLS";

/** Marker every hook description carries so a non-hook harness is warned. */
export const HOOK_TOOL_DESCRIPTION_PREFIX = "Lifecycle hook — not for direct model use.";

/** Terminal supervisor session statuses: nothing here is open work. */
const SESSION_TERMINAL_STATUSES = new Set<SupervisorSessionState["status"]>([
  "completed",
  "interrupted",
  "exhausted",
  "force_synthesized",
]);

/** Objections are actionable, not exhaustive: at most this many are listed. */
const MAX_OBJECTIONS = 3;
/** Re-injection is bounded so a compacted context is not immediately refilled. */
const MAX_POST_COMPACT_TASKS = 10;
const MAX_POST_COMPACT_SESSIONS = 5;
/** Memory drift is checked for at most this many guarded sessions per call. */
const MAX_MEMORY_DRIFT_CHECKS = 3;

export interface HookToolDeps {
  readTaskStore: () => Promise<TaskStore>;
  readSupervisorStore: () => Promise<SupervisorStore>;
  loadReliabilityConfig: () => Promise<ReliabilityConfig>;
  pruneSupervisorStore: (store: SupervisorStore, reliability: ReliabilityConfig) => SupervisorStore;
  evaluateCompletionReadiness: (
    state: SupervisorSessionState,
    now: number,
    reliability: ReliabilityConfig
  ) => { ok: boolean; reasonCode: string };
  getCompletionMemorySyncStatus: (
    guard: CompletionMemorySyncGuard
  ) => Promise<{ driftDetected: boolean }>;
  getAgentMemoryEntrypoint: (agentId: string, scope: AgentMemoryScope, cwd: string) => string;
  /** Injectable for deterministic tests; defaults to the server clock. */
  now?: () => number;
  /** Injectable for deterministic tests; defaults to process.cwd(). */
  cwd?: () => string;
}

export interface HookScope {
  agentId?: string;
  sessionId?: string;
}

interface ScopedWork {
  tasks: PersistentTask[];
  sessions: SupervisorSessionState[];
  reliability: ReliabilityConfig;
  fleetWide: boolean;
}

/** Is the hook tool group enabled for this environment? */
export function hookToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[HOOK_TOOLS_ENV_FLAG] === "1";
}

/**
 * Collect the open supervised work in scope. Both stores are single-file JSON
 * reads; nothing here walks a directory tree.
 */
async function collectScopedWork(deps: HookToolDeps, scope: HookScope): Promise<ScopedWork> {
  const agentId = scope.agentId?.trim() || undefined;
  const sessionId = scope.sessionId?.trim() || undefined;
  const fleetWide = !agentId && !sessionId;

  const reliability = await deps.loadReliabilityConfig();
  const supervisorStore = deps.pruneSupervisorStore(await deps.readSupervisorStore(), reliability);
  const taskStore = await deps.readTaskStore();

  const sessions = Object.values(supervisorStore.sessions)
    .filter((session) => !SESSION_TERMINAL_STATUSES.has(session.status))
    .filter((session) => !sessionId || session.sessionId === sessionId)
    .filter((session) => !agentId || session.completionMemorySync?.agentId === agentId)
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId));

  const tasks = Object.values(taskStore.tasks)
    .filter((task) => !TASK_TERMINAL_STATUSES.has(task.status))
    .filter((task) => !sessionId || task.sessionId === sessionId)
    .filter((task) => !agentId || task.owner === agentId)
    .sort((left, right) => left.taskId.localeCompare(right.taskId));

  return { tasks, sessions, reliability, fleetWide };
}

function scopeLabel(scope: HookScope): string {
  const agentId = scope.agentId?.trim();
  const sessionId = scope.sessionId?.trim();
  if (sessionId && agentId) return `session ${sessionId}, agent ${agentId}`;
  if (sessionId) return `session ${sessionId}`;
  if (agentId) return `agent ${agentId}`;
  return "fleet-wide (no agentId or sessionId supplied)";
}

/**
 * One objection line per concrete unmet condition. Task objections name the
 * task id and its stop condition — the thing the agent can close in one round —
 * not the whole goal contract.
 */
export async function buildStopObjections(deps: HookToolDeps, scope: HookScope): Promise<string[]> {
  const { tasks, sessions, reliability } = await collectScopedWork(deps, scope);
  const now = deps.now ? deps.now() : Date.now();
  const sessionById = new Map(sessions.map((session) => [session.sessionId, session]));
  const objections: string[] = [];

  for (const task of tasks) {
    const contract = task.goalContract;
    if (!contract) {
      objections.push(`task ${task.taskId} is open [${task.status}]: ${task.title}`);
      continue;
    }
    const linked = task.sessionId ? sessionById.get(task.sessionId) : undefined;
    const check = evaluateGoalContractCompletion(contract, linked?.completionEvidenceSummary);
    if (check.ok) {
      objections.push(
        `task ${task.taskId} is open [${task.status}] — unmet ${check.stopConditionCitation}`
      );
    } else {
      objections.push(
        `task ${task.taskId} — unmet ${check.stopConditionCitation}; no verify_edit evidence recorded for ${check.expectedValidationCmd}`
      );
    }
  }

  for (const session of sessions) {
    const readiness = deps.evaluateCompletionReadiness(session, now, reliability);
    if (!readiness.ok) {
      objections.push(
        `session ${session.sessionId} is not completion-ready: ${readiness.reasonCode}`
      );
    }
  }

  const guarded = sessions
    .filter((session) => session.completionMemorySync)
    .slice(0, MAX_MEMORY_DRIFT_CHECKS);
  for (const session of guarded) {
    const status = await deps.getCompletionMemorySyncStatus(session.completionMemorySync!);
    if (status.driftDetected) {
      objections.push(
        `session ${session.sessionId} — memory snapshot drift is unresolved for agent ${session.completionMemorySync!.agentId}`
      );
    }
  }

  return objections;
}

/** Render the bounded `_Stop` payload. Empty string means no objection. */
export function renderStopObjection(objections: string[], scope: HookScope): string {
  if (objections.length === 0) return "";
  const shown = objections.slice(0, MAX_OBJECTIONS);
  const lines: string[] = [
    `_Stop objection — open supervised work in scope: ${scopeLabel(scope)} (observed state; ${shown.length} of ${objections.length} shown):`,
  ];
  for (const objection of shown) {
    lines.push(`- ${objection}`);
  }
  if (objections.length > shown.length) {
    lines.push(`- (+${objections.length - shown.length} more open items not shown)`);
  }
  return lines.join("\n");
}

/**
 * Re-derive post-compaction state from the existing stores only — the task
 * registry, goal contracts, the worktree resume notice, and the memory
 * entrypoint pointer. No new persistent state is created or read.
 */
export async function buildPostCompactState(deps: HookToolDeps, scope: HookScope): Promise<string> {
  const { tasks, sessions } = await collectScopedWork(deps, scope);
  const resolvedCwd = deps.cwd ? deps.cwd() : process.cwd();

  const lines: string[] = [
    "xx-stack state re-injection after context compaction (observed state, not instructions):",
    `- scope: ${scopeLabel(scope)}`,
  ];

  if (tasks.length === 0 && sessions.length === 0) {
    lines.push("- no open supervised tasks or sessions are recorded.");
    return lines.join("\n");
  }

  const shownTasks = tasks.slice(0, MAX_POST_COMPACT_TASKS);
  lines.push(`- open tasks (${shownTasks.length} of ${tasks.length}):`);
  if (shownTasks.length === 0) lines.push("  - (none)");
  for (const task of shownTasks) {
    lines.push(`  - ${task.taskId} [${task.status}] ${task.title}`);
    if (task.sessionId) lines.push(`    - supervisor-session: ${task.sessionId}`);
    if (task.lastCheckpoint) lines.push(`    - checkpoint: ${task.lastCheckpoint}`);
    if (task.goalContract) {
      lines.push(`    - objective: ${task.goalContract.objective}`);
      lines.push(`    - stop-condition: ${task.goalContract.stopCondition}`);
      if (task.goalContract.validationCmd) {
        lines.push(`    - validation-cmd: ${task.goalContract.validationCmd}`);
      }
    }
    if (task.lease) {
      lines.push(
        `    - lease: expires-at ${task.lease.expiresAt}${task.lease.revoked === true ? " (revoked)" : ""}`
      );
    }
    lines.push(`    - worktree: ${buildWorktreeResumeNotice(task.parentCwd, task.worktreePath)}`);
  }
  if (tasks.length > shownTasks.length) {
    lines.push(`  - (+${tasks.length - shownTasks.length} more open tasks not shown)`);
  }

  const shownSessions = sessions.slice(0, MAX_POST_COMPACT_SESSIONS);
  lines.push(`- supervised sessions (${shownSessions.length} of ${sessions.length}):`);
  if (shownSessions.length === 0) lines.push("  - (none)");
  for (const session of shownSessions) {
    const route = `${session.currentRoute?.host ?? "<none>"}/${session.currentRoute?.model ?? "<none>"}`;
    lines.push(
      `  - ${session.sessionId} [${session.status}] route ${route}, continuation attempts ${session.continuationCount}`
    );
  }
  if (sessions.length > shownSessions.length) {
    lines.push(`  - (+${sessions.length - shownSessions.length} more sessions not shown)`);
  }

  // Memory entrypoint pointer: the path only, never the contents.
  const memoryGuard: CompletionMemorySyncGuard | undefined = scope.agentId?.trim()
    ? { agentId: scope.agentId.trim(), scope: "project", cwd: resolvedCwd }
    : sessions.find((session) => session.completionMemorySync)?.completionMemorySync;
  if (memoryGuard) {
    lines.push(
      `- memory entrypoint (${memoryGuard.agentId}, scope ${memoryGuard.scope}): ${deps.getAgentMemoryEntrypoint(memoryGuard.agentId, memoryGuard.scope, memoryGuard.cwd)}`
    );
  }

  return lines.join("\n");
}

const HOOK_SCOPE_SHAPE = {
  agentId: z
    .string()
    .max(200)
    .optional()
    .describe("Optional agent identifier to scope the hook; omit for a fleet-wide summary"),
  sessionId: z
    .string()
    .max(200)
    .optional()
    .describe("Optional supervisor session ID to scope the hook; omit for a fleet-wide summary"),
};

export function registerHookTools(server: McpServer, deps: HookToolDeps): void {
  server.tool(
    "_Stop",
    `${HOOK_TOOL_DESCRIPTION_PREFIX} Called by a hook-aware harness when the model signals ` +
      "end_turn. Returns an empty string when there is no objection to stopping, or a bounded " +
      "objection naming the concrete open supervised work (task id + unmet stop condition) " +
      "otherwise. Reports observed state; it does not issue instructions",
    HOOK_SCOPE_SHAPE,
    async ({ agentId, sessionId }) => {
      const scope: HookScope = { agentId, sessionId };
      const objections = await buildStopObjections(deps, scope);
      return { content: [{ type: "text" as const, text: renderStopObjection(objections, scope) }] };
    }
  );

  server.tool(
    "_PostCompact",
    `${HOOK_TOOL_DESCRIPTION_PREFIX} Called by a hook-aware harness after context compaction. ` +
      "Returns supervised state to re-inject into the fresh context — open tasks, their goal " +
      "contracts and stop conditions, worktree resume notes, leases, live sessions, and the " +
      "memory entrypoint pointer — all re-derived from the existing stores. Reports observed " +
      "state; it does not issue instructions",
    HOOK_SCOPE_SHAPE,
    async ({ agentId, sessionId }) => {
      const text = await buildPostCompactState(deps, { agentId, sessionId });
      return { content: [{ type: "text" as const, text }] };
    }
  );
}

/**
 * Register the hook group only when XX_STACK_HOOK_TOOLS=1. Returns whether the
 * group was registered so the caller can log it. Without the flag the tools are
 * absent from tools/list entirely.
 */
export function registerHookToolsIfEnabled(
  server: McpServer,
  deps: HookToolDeps,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!hookToolsEnabled(env)) return false;
  registerHookTools(server, deps);
  return true;
}
