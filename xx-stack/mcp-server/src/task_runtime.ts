import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { z } from "zod";

import { atomicWriteTextFile } from "./io_runtime.js";
// StoreAccessError / isMissingFileError live beside the supervisor store reader
// so both stores raise one error shape for an unreadable state file (MCP-1).
import { isMissingFileError, StoreAccessError } from "./supervisor_store_runtime.js";
import type { SupervisorSessionState } from "./supervisor_runtime.js";

export const TASK_STATUS_VALUES = [
  "todo",
  "in_progress",
  "suspended",
  "blocked",
  "done",
  "canceled",
  // Terminal outcome distinct from done/canceled: the supervisor exhausted its
  // budget and forced a best-effort synthesis from partial evidence. Never
  // presented as a normal completion.
  "force_synthesized",
] as const;
export type TaskStatus = (typeof TASK_STATUS_VALUES)[number];

export const TASK_PRIORITY_VALUES = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITY_VALUES)[number];

export const TASK_STATUS_SCHEMA = z.enum(TASK_STATUS_VALUES);
export const TASK_PRIORITY_SCHEMA = z.enum(TASK_PRIORITY_VALUES);
export const TASK_TERMINAL_STATUSES = new Set<TaskStatus>([
  "done",
  "canceled",
  "force_synthesized",
]);

/**
 * Mandatory anti-reward-hacking clause carried by every goal contract.
 * Quoted verbatim in resume directives and in runtime/AUTONOMOUS_TODO_LOOP.md.
 */
export const ANTI_REWARD_HACKING_CLAUSE =
  "do not delete, skip, weaken, or narrow tests to make the goal pass";

/**
 * Five-part goal contract for supervised autonomous tasks (UPSTREAM-BORROW task 21).
 * Optional metadata on task registration; when present, the supervisor
 * completion path cites the stop condition and — if validationCmd is set —
 * expects a verify_edit result for that exact command as completion evidence.
 */
export const GOAL_CONTRACT_SCHEMA = z.object({
  objective: z.string().min(1).max(500).describe("One-sentence objective of the task"),
  constraints: z
    .array(z.string().min(1).max(500))
    .min(1)
    .max(32)
    .describe("What must NOT change while pursuing the objective"),
  validationCmd: z
    .string()
    .min(1)
    .max(1000)
    .optional()
    .describe("Exact shell command that proves progress; run it through verify_edit"),
  stopCondition: z
    .string()
    .min(1)
    .max(1000)
    .describe("Verifiable condition that defines done; completion evaluation cites this"),
  docsNote: z
    .string()
    .min(1)
    .max(1000)
    .optional()
    .describe("Docs commitment: what documentation must be updated when the goal is met"),
});
export type GoalContract = z.infer<typeof GOAL_CONTRACT_SCHEMA>;

export function sanitizeGoalContract(contract: GoalContract | undefined): GoalContract | undefined {
  if (!contract) return undefined;
  const objective = contract.objective.trim();
  const stopCondition = contract.stopCondition.trim();
  const constraints = contract.constraints
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (!objective || !stopCondition || constraints.length === 0) return undefined;
  return {
    objective,
    constraints,
    validationCmd: trimOptional(contract.validationCmd),
    stopCondition,
    docsNote: trimOptional(contract.docsNote),
  };
}

export interface GoalContractCompletionCheck {
  ok: boolean;
  reasonCode: "goal_contract_ready" | "goal_contract_validation_evidence_missing";
  stopConditionCitation: string;
  expectedValidationCmd?: string;
}

/**
 * Evaluate a goal contract against recorded completion evidence.
 * Always cites the stop condition; when validationCmd is present, the
 * completion evidence summary must reference that exact command (i.e. a
 * verify_edit result for it was recorded).
 */
export function evaluateGoalContractCompletion(
  contract: GoalContract,
  completionEvidenceSummary: string | undefined
): GoalContractCompletionCheck {
  const stopConditionCitation = `stop-condition: ${contract.stopCondition}`;
  if (contract.validationCmd) {
    const evidence = completionEvidenceSummary ?? "";
    if (!evidence.includes(contract.validationCmd)) {
      return {
        ok: false,
        reasonCode: "goal_contract_validation_evidence_missing",
        stopConditionCitation,
        expectedValidationCmd: contract.validationCmd,
      };
    }
  }
  return {
    ok: true,
    reasonCode: "goal_contract_ready",
    stopConditionCitation,
    expectedValidationCmd: contract.validationCmd,
  };
}

// ---------------------------------------------------------------------------
// Self-enforced task leases (UPSTREAM-BORROW task 27)
// ---------------------------------------------------------------------------

/**
 * Self-fencing clause carried by continuation prompts for leased tasks.
 * The control plane holds no kill channel to a lane on another machine, so the
 * agent enforces its own liveness bound: it re-checks the lease before writing
 * anything back and stops instead of writing when the lease is dead.
 */
export const LEASE_SELF_FENCING_CLAUSE =
  "before writing back any result, re-check this task's lease; if it is expired or revoked, " +
  "emit your final state and stop — do not write";

/**
 * Optional lease on task registration. `expiresAt` is an ISO-8601 instant
 * compared against the server's own clock at write-back — there is deliberately
 * no clock reconciliation across machines. `revoked` is flipped by the failover
 * flow so a returning "dead" lane detects it lost the claim.
 */
export const TASK_LEASE_SCHEMA = z.object({
  expiresAt: z
    .string()
    .min(1)
    .max(64)
    .describe(
      "ISO-8601 instant after which this lease is dead (compared against the server clock)"
    ),
  revoked: z
    .boolean()
    .optional()
    .describe(
      "Set once the supervisor revoked this claim (failover); a revoked lease never writes"
    ),
});
export type TaskLease = z.infer<typeof TASK_LEASE_SCHEMA>;

export function sanitizeTaskLease(lease: TaskLease | undefined): TaskLease | undefined {
  if (!lease) return undefined;
  const expiresAt = lease.expiresAt.trim();
  if (!expiresAt) return undefined;
  return lease.revoked === true ? { expiresAt, revoked: true } : { expiresAt };
}

export type TaskLeaseReasonCode =
  "lease_absent" | "lease_valid" | "lease_revoked" | "lease_expired";

export interface TaskLeaseCheck {
  /** True when a write-back is allowed: no lease at all, or a live lease. */
  ok: boolean;
  reasonCode: TaskLeaseReasonCode;
  expiresAt?: string;
  revoked?: boolean;
}

/**
 * The single server-side lease check. Revocation beats expiry (a revoked lease
 * is dead regardless of its deadline). An unparseable `expiresAt` is treated as
 * expired: a lease nobody can evaluate must not authorize a write.
 */
export function evaluateTaskLease(lease: TaskLease | undefined, nowMs: number): TaskLeaseCheck {
  if (!lease) return { ok: true, reasonCode: "lease_absent" };
  if (lease.revoked === true) {
    return { ok: false, reasonCode: "lease_revoked", expiresAt: lease.expiresAt, revoked: true };
  }
  const expiresAtMs = Date.parse(lease.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    return { ok: false, reasonCode: "lease_expired", expiresAt: lease.expiresAt };
  }
  return { ok: true, reasonCode: "lease_valid", expiresAt: lease.expiresAt };
}

/** Flip a task's lease to revoked. Returns true when this call changed state. */
export function revokeTaskLease(task: PersistentTask, at: string): boolean {
  if (!task.lease || task.lease.revoked === true) return false;
  task.lease = { expiresAt: task.lease.expiresAt, revoked: true };
  task.updatedAt = at;
  return true;
}

/**
 * At-most-one-live-instance: when the supervisor fails a session over to
 * another lane, the prior lane's claim on every linked open task is revoked.
 * Writes only when something actually changed, so a fleet with no leases takes
 * the byte-identical no-op path.
 */
export async function revokeSessionTaskLeases(sessionId: string, at: string): Promise<string[]> {
  return withTaskStoreLock(async () => {
    const store = await readTaskStore();
    const revoked: string[] = [];
    for (const task of Object.values(store.tasks)) {
      if (task.sessionId !== sessionId) continue;
      if (TASK_TERMINAL_STATUSES.has(task.status)) continue;
      if (revokeTaskLease(task, at)) revoked.push(task.taskId);
    }
    if (revoked.length > 0) {
      await writeTaskStore(store);
    }
    return revoked.sort();
  });
}

/**
 * Mark a task as force_synthesized (UPSTREAM-BORROW task 14): the supervisor
 * exhausted budget/steps/stall allowance and demanded a best-effort synthesis
 * from existing evidence. Distinct from done (completed) and canceled (failed).
 */
export function applyForceSynthesisOutcome(
  task: PersistentTask,
  synthesisNote: string,
  at: string
): PersistentTask {
  task.status = "force_synthesized";
  task.lastCheckpoint = synthesisNote;
  task.updatedAt = at;
  return task;
}

export interface PersistentTask {
  taskId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  resumable?: boolean;
  sessionId?: string;
  attemptCount?: number;
  resumeCount?: number;
  lastCheckpoint?: string;
  lastError?: string;
  worktreePath?: string;
  parentCwd?: string;
  goalContract?: GoalContract;
  lease?: TaskLease;
  priority?: TaskPriority;
  tags: string[];
  owner?: string;
  blockedBy: string[];
  dueAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskStore {
  version: number;
  tasks: Record<string, PersistentTask>;
}

const TASK_STORE_VERSION = 1;

let taskStoreLock: Promise<void> = Promise.resolve();

export async function withTaskStoreLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = taskStoreLock;
  let release: () => void = () => {};
  taskStoreLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

export function emptyTaskStore(): TaskStore {
  return {
    version: TASK_STORE_VERSION,
    tasks: {},
  };
}

function getTaskStatePath(): string {
  return resolve(homedir(), ".config/opencode/xx-stack-task-state.json");
}

export function buildWorktreeResumeNotice(
  parentCwd: string | undefined,
  worktreePath: string | undefined
): string {
  if (!worktreePath) {
    return "No isolated worktree path is recorded for this task. Re-open files from the current workspace before resuming.";
  }
  if (!parentCwd) {
    return `Task is linked to isolated worktree ${worktreePath}. Re-read all target files there before editing.`;
  }
  return [
    `Task context was originally gathered from parent workspace ${parentCwd}.`,
    `Resume inside isolated worktree ${worktreePath}.`,
    "Translate inherited file paths from parent workspace to this worktree root before editing.",
    "Re-open each file before patching in case parent and worktree diverged.",
  ].join(" ");
}

export function buildResumeDirective(
  task: PersistentTask,
  linkedSession: SupervisorSessionState | undefined
): string {
  const lines: string[] = [
    "Resume directive:",
    `- task-id: ${task.taskId}`,
    `- title: ${task.title}`,
    `- attempt: ${task.attemptCount ?? 0}`,
    `- resumes: ${task.resumeCount ?? 0}`,
  ];
  if (task.lastCheckpoint) lines.push(`- checkpoint: ${task.lastCheckpoint}`);
  if (task.lastError) lines.push(`- previous-error: ${task.lastError}`);
  if (task.sessionId) lines.push(`- supervisor-session: ${task.sessionId}`);
  if (linkedSession?.currentRoute) {
    lines.push(
      `- current-route: ${linkedSession.currentRoute.host}/${linkedSession.currentRoute.model ?? "<none>"}`
    );
  }
  lines.push(`- worktree-note: ${buildWorktreeResumeNotice(task.parentCwd, task.worktreePath)}`);
  if (task.goalContract) {
    const contract = task.goalContract;
    lines.push("- goal-contract:");
    lines.push(`  - objective: ${contract.objective}`);
    lines.push("  - constraints (must NOT change):");
    for (const constraint of contract.constraints) {
      lines.push(`    - ${constraint}`);
    }
    if (contract.validationCmd) {
      lines.push(`  - validation-cmd (run via verify_edit): ${contract.validationCmd}`);
    }
    lines.push(`  - stop-condition: ${contract.stopCondition}`);
    if (contract.docsNote) {
      lines.push(`  - docs-note: ${contract.docsNote}`);
    }
    lines.push(`  - anti-reward-hacking: ${ANTI_REWARD_HACKING_CLAUSE}`);
  }
  if (task.lease) {
    lines.push("- lease:");
    lines.push(`  - expires-at: ${task.lease.expiresAt}`);
    lines.push(`  - revoked: ${task.lease.revoked === true ? "yes" : "no"}`);
    lines.push(`  - self-fencing: ${LEASE_SELF_FENCING_CLAUSE}`);
  }
  lines.push("- requirements:");
  lines.push("  - continue from existing artifacts, do not restart from scratch");
  lines.push("  - produce deterministic evidence (diff, command output, or explicit blocker)");
  lines.push("  - if blocked, include next fallback action");
  return lines.join("\n");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the task store. Only a genuinely missing file means "empty store"
 * (MCP-1): every handler is read → mutate → write-whole-document, so healing a
 * parse error or an EACCES into an empty store makes the next write delete
 * every task. Anything but ENOENT raises StoreAccessError and the caller fails
 * loudly. StoreAccessError is shared with the supervisor store so both readers
 * report one error shape.
 */
export async function readTaskStore(): Promise<TaskStore> {
  const path = getTaskStatePath();
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    if (isMissingFileError(error)) return emptyTaskStore();
    throw new StoreAccessError("task", path, error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new StoreAccessError("task", path, error);
  }

  if (!isPlainRecord(parsed)) {
    throw new StoreAccessError("task", path, new Error("store root is not a JSON object"));
  }
  const tasks = parsed.tasks;
  if (tasks !== undefined && !isPlainRecord(tasks)) {
    throw new StoreAccessError("task", path, new Error("tasks is not a JSON object"));
  }

  return {
    version: TASK_STORE_VERSION,
    tasks: (tasks as TaskStore["tasks"]) ?? {},
  };
}

export async function writeTaskStore(store: TaskStore): Promise<void> {
  const path = getTaskStatePath();
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteTextFile(path, JSON.stringify(store, null, 2) + "\n");
}

export function generateTaskId(): string {
  return `tsk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function sanitizeTags(tags: string[] | undefined): string[] {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))].slice(0, 32);
}

export function sanitizeIdList(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((value) => value.trim()).filter(Boolean);
}

export function trimOptional(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}
