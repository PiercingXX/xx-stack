import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AgentMemoryScope } from "./config_runtime.js";
import type {
  CompletionMemorySyncGuard,
  CompletionMemorySyncStatusOptions,
} from "./memory_runtime.js";
import type {
  ReliabilityConfig,
  SupervisorSessionState,
  SupervisorStore,
} from "./supervisor_runtime.js";
import {
  storeAccessErrorPayload,
  SUPERVISOR_TERMINAL_STATUSES,
} from "./supervisor_store_runtime.js";
import { computeReadySet } from "./task_graph_runtime.js";
import {
  buildWorktreeResumeNotice,
  evaluateGoalContractCompletion,
  LEASE_SELF_FENCING_CLAUSE,
  renderGoalContractClauseLines,
  renderGoalContractLines,
  TASK_TERMINAL_STATUSES,
  type PersistentTask,
  type TaskStore,
} from "./task_runtime.js";
import { toolAnnotations } from "./observability_tools.js";

/**
 * MCP lifecycle hook tools.
 *
 * The buzz hook convention: a hook-aware harness calls underscore-prefixed MCP
 * tools at fixed points in its own loop. `_Stop` runs when the model signals
 * end_turn — non-empty text is an objection and the agent keeps working, an
 * empty string allows the stop. `_PostCompact` runs after context compaction
 * and returns state to re-inject into the fresh context.
 *
 * Provider-side contract this module honors:
 * - fast and read-only: two single-file JSON store reads plus, for at most
 *   MAX_MEMORY_DRIFT_CHECKS guarded sessions, a bounded pair of memory-file
 *   reads. No filesystem walks or scans, and nothing here creates or writes a
 *   file — the memory status check is called with ensureFiles: false precisely
 *   so a hook cannot scaffold MEMORY.md as a side effect.
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
 * - `_Stop` carries the mandatory clause pair beneath its objections, indented
 *   so it adds context without spending a single unit of the objection budget.
 *   This hook is what creates the pressure NULL_RESULT_VALID_CLAUSE relieves:
 *   a prospecting task whose honest answer is "nothing worth changing" has an
 *   unmet stop condition by construction, so the clause has to arrive here.
 * - `_Stop` objects only on READY work. A task whose blockers are still open
 *   cannot be started at all, so naming it as the objection would violate the
 *   contract above — the agent has no move that closes it in one round, and
 *   the objection would repeat until the rejection budget ran out. Blocked
 *   work is reported as context beneath a real objection, never as one.
 *
 * Off by default: a harness that is not hook-aware would see these as ordinary
 * callable tools. Registration is gated behind XX_STACK_HOOK_TOOLS=1.
 */

const HOOK_TOOLS_ENV_FLAG = "XX_STACK_HOOK_TOOLS";

/** Marker every hook description carries so a non-hook harness is warned. */
export const HOOK_TOOL_DESCRIPTION_PREFIX = "Lifecycle hook — not for direct model use.";

/** Objections are actionable, not exhaustive: at most this many are listed. */
const MAX_OBJECTIONS = 3;
/** Blocked-work context lines are bounded the same way objections are. */
const MAX_BLOCKED_CONTEXT = 3;
/** Re-injection is bounded so a compacted context is not immediately refilled. */
const MAX_POST_COMPACT_TASKS = 10;
const MAX_POST_COMPACT_SESSIONS = 5;
/** Memory drift is checked for at most this many guarded sessions per call. */
const MAX_MEMORY_DRIFT_CHECKS = 3;

/**
 * `_PostCompact`'s answer when the stores cannot be read. `_Stop` has no
 * equivalent: any non-empty string from `_Stop` is an objection by contract,
 * so it answers the empty string instead (see `withUnreadableStoreFallback`).
 */
const POST_COMPACT_STORE_UNAVAILABLE_PREFIX =
  "xx-stack state re-injection after context compaction (observed state, not instructions):\n" +
  "- supervised state could not be re-derived: ";

/**
 * A lifecycle hook whose store is unreadable must still answer, and must
 * answer *safely*.
 *
 * The store readers raise `StoreAccessError` on a store that exists but cannot
 * be parsed (MCP-1). Letting that escape turns the hook into an SDK `isError`
 * result, and a hook-aware harness may read an errored `_Stop` as a blocking
 * objection — which would trap the agent in a loop it cannot exit, because no
 * amount of further work repairs a corrupt state file. The caller already
 * treats a `_Stop` timeout as "no objection", so an unreadable store takes the
 * same path: the fallback value, never a thrown error. Any other error still
 * propagates — this converts unreadable state, it does not swallow bugs.
 */
async function withUnreadableStoreFallback(
  work: () => Promise<string>,
  fallback: (detail: string) => string
): Promise<string> {
  try {
    return await work();
  } catch (error) {
    const payload = storeAccessErrorPayload(error);
    if (!payload) throw error;
    return fallback(String(payload.detail ?? "supervised state is unreadable"));
  }
}

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
    guard: CompletionMemorySyncGuard,
    options?: CompletionMemorySyncStatusOptions
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
  /** Open tasks in scope. */
  tasks: PersistentTask[];
  /**
   * Every task in the store, unfiltered. Readiness is a property of the whole
   * graph: a blocker may be terminal (and therefore filtered out of `tasks`)
   * or owned by another agent, and either way it still decides whether the
   * task in scope can start.
   */
  allTasks: PersistentTask[];
  sessions: SupervisorSessionState[];
  reliability: ReliabilityConfig;
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

  const reliability = await deps.loadReliabilityConfig();
  const supervisorStore = deps.pruneSupervisorStore(await deps.readSupervisorStore(), reliability);
  const taskStore = await deps.readTaskStore();

  const sessions = Object.values(supervisorStore.sessions)
    .filter((session) => !SUPERVISOR_TERMINAL_STATUSES.has(session.status))
    .filter((session) => !sessionId || session.sessionId === sessionId)
    .filter((session) => !agentId || session.completionMemorySync?.agentId === agentId)
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId));

  const tasks = Object.values(taskStore.tasks)
    .filter((task) => !TASK_TERMINAL_STATUSES.has(task.status))
    .filter((task) => !sessionId || task.sessionId === sessionId)
    .filter((task) => !agentId || task.owner === agentId)
    .sort((left, right) => left.taskId.localeCompare(right.taskId));

  return { tasks, allTasks: Object.values(taskStore.tasks), sessions, reliability };
}

/**
 * The one place the fleet-wide condition is expressed. `ScopedWork` used to
 * carry a `fleetWide` field computed alongside the filters and read nowhere
 * (MCP-DEAD-1): both consumers derive the condition from `scope` through this
 * label instead, so the field was a second, silently divergable source of the
 * same predicate.
 */
function scopeLabel(scope: HookScope): string {
  const agentId = scope.agentId?.trim();
  const sessionId = scope.sessionId?.trim();
  if (sessionId && agentId) return `session ${sessionId}, agent ${agentId}`;
  if (sessionId) return `session ${sessionId}`;
  if (agentId) return `agent ${agentId}`;
  return "fleet-wide (no agentId or sessionId supplied)";
}

/**
 * `_Stop`'s two answers about task work: what the agent can act on now, and
 * what it merely ought to know about.
 */
export interface StopReport {
  /** Concrete unmet conditions the agent can close in one round. */
  objections: string[];
  /** Blocked work, named for orientation only. Never an objection. */
  blockedContext: string[];
}

/**
 * One objection line per concrete unmet condition. Task objections name the
 * task id and its stop condition — the thing the agent can close in one round —
 * not the whole goal contract.
 *
 * Only READY tasks raise objections. `_Stop` used to object on every
 * non-terminal task, including ones whose blockers were still open — an
 * objection naming work the agent is not permitted to start is not "an
 * objection the agent can act on in one round" (MANUAL §5); it is a loop that
 * ends when the caller's rejection budget runs out. Blocked tasks come back in
 * `blockedContext`, which is rendered only beneath a real objection.
 */
export async function buildStopReport(deps: HookToolDeps, scope: HookScope): Promise<StopReport> {
  const { tasks, allTasks, sessions, reliability } = await collectScopedWork(deps, scope);
  const now = deps.now ? deps.now() : Date.now();
  const sessionById = new Map(sessions.map((session) => [session.sessionId, session]));
  const objections: string[] = [];
  const blockedContext: string[] = [];

  const readyIds = new Set(computeReadySet(allTasks).map((task) => task.taskId));
  const statusById = new Map(allTasks.map((task) => [task.taskId, task.status]));

  for (const task of tasks) {
    if (!readyIds.has(task.taskId)) {
      const openBlockers = task.blockedBy.filter((id) => {
        const status = statusById.get(id);
        return status === undefined || !TASK_TERMINAL_STATUSES.has(status);
      });
      const detail = openBlockers.length > 0 ? openBlockers.join(", ") : "(no open blocker found)";
      blockedContext.push(
        `task ${task.taskId} is blocked [${task.status}] on ${detail} — not startable this round`
      );
      continue;
    }
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
    // ensureFiles: false — `_Stop` is a read path under a ~2.5s budget, and the
    // default status check mkdir's and writes MEMORY.md/SNAPSHOT.md scaffolding.
    const status = await deps.getCompletionMemorySyncStatus(session.completionMemorySync!, {
      ensureFiles: false,
    });
    if (status.driftDetected) {
      objections.push(
        `session ${session.sessionId} — memory snapshot drift is unresolved for agent ${session.completionMemorySync!.agentId}`
      );
    }
  }

  return { objections, blockedContext };
}

/**
 * The objection lines only. Kept as the narrow accessor for callers that never
 * render context; `_Stop` itself uses `buildStopReport` so both halves come
 * from a single pair of store reads.
 */
export async function buildStopObjections(deps: HookToolDeps, scope: HookScope): Promise<string[]> {
  return (await buildStopReport(deps, scope)).objections;
}

/**
 * The clause pair, rendered beneath a `_Stop` objection.
 *
 * `_Stop` is the surface that APPLIES the pressure NULL_RESULT_VALID_CLAUSE
 * exists to relieve, and it was the one contract surface that never carried it.
 * A prospecting task ("find dead code", "find performance wins") whose honest
 * answer is "nothing worth changing" has an unmet stopCondition by
 * construction: `_Stop` objects at every end-turn until the caller's rejection
 * budget is spent, and the cheapest way for the agent to silence the objection
 * is to invent a diff. The clause is what makes the honest answer available,
 * and it belongs where the squeeze happens.
 *
 * Two properties are load-bearing:
 *
 * - Every line here is INDENTED. `_Stop`'s objection budget is measured in
 *   top-level `- ` bullets — the caller enforces a rejection budget, so the
 *   count of concrete things to act on must not move. These lines are context
 *   qualifying the objections above them, not additional objections.
 * - Both clauses ship, via the single renderer. `renderGoalContractClauseLines`
 *   is the one function that emits the pair precisely so no surface can carry
 *   one direction alone; emitting only the null-result half here would fork
 *   that rule at the surface it was written for.
 */
function renderStopClauseLines(): string[] {
  return [
    "  - clauses recorded on this work (quoted, not new rules):",
    ...renderGoalContractClauseLines("    "),
  ];
}

/**
 * Render the bounded `_Stop` payload. Empty string means no objection.
 *
 * `blockedContext` is appended only when there is a real objection to append
 * it to: blocked work alone must never keep the agent working, because there
 * is nothing it can do about it.
 */
export function renderStopObjection(
  objections: string[],
  scope: HookScope,
  blockedContext: string[] = []
): string {
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
  // Sited directly under the objections it qualifies, and only when there is an
  // objection at all — an empty `_Stop` answer stays the empty string.
  lines.push(...renderStopClauseLines());
  if (blockedContext.length > 0) {
    const shownContext = blockedContext.slice(0, MAX_BLOCKED_CONTEXT);
    lines.push("- context only (blocked work; nothing to act on here):");
    for (const entry of shownContext) {
      lines.push(`  - ${entry}`);
    }
    if (blockedContext.length > shownContext.length) {
      lines.push(
        `  - (+${blockedContext.length - shownContext.length} more blocked items not shown)`
      );
    }
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
  let anyContractShown = false;
  let anyLeaseShown = false;
  for (const task of shownTasks) {
    lines.push(`  - ${task.taskId} [${task.status}] ${task.title}`);
    if (task.sessionId) lines.push(`    - supervisor-session: ${task.sessionId}`);
    if (task.lastCheckpoint) lines.push(`    - checkpoint: ${task.lastCheckpoint}`);
    if (task.goalContract) {
      anyContractShown = true;
      // One renderer, shared with buildResumeDirective. The clause pair is
      // deferred to the footer below, not dropped — see the block after the
      // loop and `renderGoalContractLines`' doc comment.
      lines.push(
        ...renderGoalContractLines(task.goalContract, { indent: "    ", includeClauses: false })
      );
    }
    if (task.lease) {
      anyLeaseShown = true;
      lines.push(
        `    - lease: expires-at ${task.lease.expiresAt}${task.lease.revoked === true ? " (revoked)" : ""}`
      );
    }
    lines.push(`    - worktree: ${buildWorktreeResumeNotice(task.parentCwd, task.worktreePath)}`);
  }
  if (tasks.length > shownTasks.length) {
    lines.push(`  - (+${tasks.length - shownTasks.length} more open tasks not shown)`);
  }
  // The clauses every contract and lease above carries, quoted once for the
  // whole payload rather than repeated per task.
  //
  // Placement, not presence, is the concession to this hook's token budget:
  // re-injection is capped at 10 tasks, and repeating ~260 characters of clause
  // text ten times would refill a context that was just compacted to make room.
  // They are stated once, immediately beneath the tasks they qualify, and they
  // are never omitted. Dropping them was D1 — `_PostCompact` fires at the exact
  // moment the agent has lost its working memory and is under the most pressure
  // to close out, which is when both directions matter most.
  if (anyContractShown || anyLeaseShown) {
    lines.push("  - clauses recorded on the contracts and leases above (quoted, not new rules):");
    if (anyContractShown) lines.push(...renderGoalContractClauseLines("    "));
    if (anyLeaseShown) lines.push(`    - self-fencing: ${LEASE_SELF_FENCING_CLAUSE}`);
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
  server.registerTool(
    "_Stop",
    {
      description:
        `${HOOK_TOOL_DESCRIPTION_PREFIX} Called by a hook-aware harness when the model signals ` +
        "end_turn. Returns an empty string when there is no objection to stopping, or a bounded " +
        "objection naming the concrete open supervised work (task id + unmet stop condition) " +
        "otherwise. Only work that is actually startable raises an objection: a task whose " +
        "blockedBy entries are still open is listed as context beneath a real objection and " +
        "never as the objection itself. If the supervisor or task store exists but cannot be read, this returns the " +
        "empty no-objection string — the same answer the caller assumes on timeout — because a " +
        "corrupt state file is not something the agent can resolve by continuing to work. " +
        "Reports observed state; it does not issue instructions",
      inputSchema: HOOK_SCOPE_SHAPE,
      annotations: toolAnnotations("_Stop"),
    },
    async ({ agentId, sessionId }) => {
      const scope: HookScope = { agentId, sessionId };
      const text = await withUnreadableStoreFallback(
        async () => {
          const report = await buildStopReport(deps, scope);
          return renderStopObjection(report.objections, scope, report.blockedContext);
        },
        // Empty string = no objection. A non-empty string would be an
        // objection the agent has no way to satisfy.
        () => ""
      );
      return { content: [{ type: "text" as const, text }] };
    }
  );

  server.registerTool(
    "_PostCompact",
    {
      description:
        `${HOOK_TOOL_DESCRIPTION_PREFIX} Called by a hook-aware harness after context compaction. ` +
        "Returns supervised state to re-inject into the fresh context — open tasks, their goal " +
        "contracts and stop conditions, worktree resume notes, leases, live sessions, and the " +
        "memory entrypoint pointer — all re-derived from the existing stores. If a store exists " +
        "but cannot be read, this says so plainly instead of reporting an empty fleet: its output " +
        "is informational, so an honest notice is safe where a silent empty state is not. " +
        "Reports observed state; it does not issue instructions",
      inputSchema: HOOK_SCOPE_SHAPE,
      annotations: toolAnnotations("_PostCompact"),
    },
    async ({ agentId, sessionId }) => {
      const text = await withUnreadableStoreFallback(
        () => buildPostCompactState(deps, { agentId, sessionId }),
        // Unlike `_Stop`, this output gates nothing, so the failure is stated
        // rather than hidden behind an empty re-injection.
        (detail) => `${POST_COMPACT_STORE_UNAVAILABLE_PREFIX}${detail}`
      );
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
