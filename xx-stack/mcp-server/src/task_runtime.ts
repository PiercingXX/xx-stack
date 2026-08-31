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
 * The inverse clause, and it is not symmetric decoration.
 *
 * ANTI_REWARD_HACKING_CLAUSE guards one direction only: degrading the verifier
 * so a goal passes. The opposite failure is manufacturing work so a run looks
 * productive, and this stack has a mechanism that actively pressures an agent
 * into it. A prospecting task ("find dead code", "find performance wins")
 * whose honest answer is "nothing worth changing" has an unmet stopCondition
 * BY CONSTRUCTION — so `_Stop` objects at every end-turn until the caller's
 * rejection budget is spent, and the cheapest way for the agent to silence the
 * objection is to invent a diff.
 *
 * Stating that a null result is a valid completion is what makes the honest
 * answer available. It is carried beside the clause above wherever contracts
 * render, so both directions arrive together.
 */
export const NULL_RESULT_VALID_CLAUSE =
  "a null result is a valid completion — do not manufacture a change to look productive; " +
  "finding nothing worth changing is a real answer when the evidence shows you looked";

export const METRIC_DIRECTION_VALUES = ["maximize", "minimize", "unknown"] as const;
export type MetricDirection = (typeof METRIC_DIRECTION_VALUES)[number];

export const BASELINE_PROVENANCE_VALUES = ["measured", "placeholder", "unknown"] as const;
export type BaselineProvenance = (typeof BASELINE_PROVENANCE_VALUES)[number];

export const MATURITY_VALUES = ["smoke", "full"] as const;
export type Maturity = (typeof MATURITY_VALUES)[number];

/**
 * What a task measures. Direction `unknown` is a real answer — it is never
 * filled in as maximize, and a missing value is never stored as 0.
 */
export const METRIC_REF_SCHEMA = z.object({
  name: z.string().min(1).max(120).describe("Metric name (e.g. test-pass-rate, p95-latency)"),
  direction: z
    .enum(METRIC_DIRECTION_VALUES)
    .describe("Optimization direction; unknown stays unknown and blocks confirmed promotion"),
});
export type MetricRef = z.infer<typeof METRIC_REF_SCHEMA>;

/**
 * Where the unchanged tree currently sits. `placeholder` is an explicit
 * unmeasured stand-in, not a measured 0. Provenance `unknown` means nobody
 * has said which of those it is.
 */
export const BASELINE_REF_SCHEMA = z.object({
  value: z
    .union([z.number().finite(), z.literal("unknown")])
    .describe("Measured baseline, or the literal unknown — never a silent zero"),
  provenance: z.enum(BASELINE_PROVENANCE_VALUES),
  note: z.string().min(1).max(500).optional(),
});
export type BaselineRef = z.infer<typeof BASELINE_REF_SCHEMA>;

/**
 * Five-part goal contract for supervised autonomous tasks, plus optional
 * metric/baseline/canary fields. Optional metadata on task registration;
 * when present, the supervisor completion path cites the stop condition
 * and — if validationCmd is set — expects a verify_edit result for that
 * exact command as completion evidence. The extra fields are additive:
 * a five-part contract still round-trips byte-identically.
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
  metric: METRIC_REF_SCHEMA.optional().describe(
    "Optional metric the task is optimizing. Direction unknown blocks confirmed-lane promotion."
  ),
  baseline: BASELINE_REF_SCHEMA.optional().describe(
    "Optional baseline for the metric. Placeholder provenance cannot parent a confirmed finding."
  ),
  maturity: z
    .enum(MATURITY_VALUES)
    .optional()
    .describe("smoke = canary-grade; full = parent-eligible complete protocol"),
  parentEligible: z
    .boolean()
    .optional()
    .describe(
      "Caller intent that a successful result may become a durable parent; the finding store still enforces lane policy"
    ),
  canaryCmd: z
    .string()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      "Command to run on the unchanged tree before fan-out. Defaults to validationCmd when omitted."
    ),
});
export type GoalContract = z.infer<typeof GOAL_CONTRACT_SCHEMA>;

function sanitizeMetric(metric: MetricRef | undefined): MetricRef | undefined {
  if (!metric) return undefined;
  const name = metric.name.trim();
  if (!name) return undefined;
  return { name, direction: metric.direction };
}

function sanitizeBaseline(baseline: BaselineRef | undefined): BaselineRef | undefined {
  if (!baseline) return undefined;
  return {
    value: baseline.value,
    provenance: baseline.provenance,
    ...(trimOptional(baseline.note) ? { note: trimOptional(baseline.note) } : {}),
  };
}

export function sanitizeGoalContract(contract: GoalContract | undefined): GoalContract | undefined {
  if (!contract) return undefined;
  const objective = contract.objective.trim();
  const stopCondition = contract.stopCondition.trim();
  const constraints = contract.constraints
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (!objective || !stopCondition || constraints.length === 0) return undefined;
  const metric = sanitizeMetric(contract.metric);
  const baseline = sanitizeBaseline(contract.baseline);
  const canaryCmd = trimOptional(contract.canaryCmd);
  const sanitized: GoalContract = {
    objective,
    constraints,
    validationCmd: trimOptional(contract.validationCmd),
    stopCondition,
    docsNote: trimOptional(contract.docsNote),
  };
  if (metric) sanitized.metric = metric;
  if (baseline) sanitized.baseline = baseline;
  if (contract.maturity) sanitized.maturity = contract.maturity;
  if (contract.parentEligible !== undefined) sanitized.parentEligible = contract.parentEligible;
  if (canaryCmd) sanitized.canaryCmd = canaryCmd;
  return sanitized;
}

/** The command a canary must run: canaryCmd if set, otherwise validationCmd. */
export function canaryCommandFor(contract: GoalContract): string | undefined {
  return contract.canaryCmd ?? contract.validationCmd;
}

/**
 * A verify_edit result reported against a goal contract's validationCmd.
 * Mirrors `CmdResult`'s classification from verify_edit_tools.ts; kept
 * structural rather than imported so the task store does not depend on a tool
 * module.
 */
export interface ValidationAttempt {
  /** The command as it was run, matched against the contract's validationCmd. */
  command: string;
  outcome: "pass" | "fail" | "could_not_run" | "denied";
  /** e.g. command_not_found, deps_not_installed, bad_cwd, timeout. */
  reasonCode?: string;
  /** One sentence naming the fix, carried straight into the prompt. */
  remediation?: string;
}

export interface GoalContractCompletionCheck {
  ok: boolean;
  reasonCode:
    | "goal_contract_ready"
    | "goal_contract_validation_evidence_missing"
    /**
     * The lane could not execute the validation at all. NOT a code failure and
     * NOT a pass — a third answer, so the continuation prompt can say
     * "validation could not execute on this lane" instead of "tests are
     * failing" and send the agent to fix code that is fine.
     */
    | "goal_contract_validation_could_not_run";
  stopConditionCitation: string;
  expectedValidationCmd?: string;
  /** Present only for `goal_contract_validation_could_not_run`. */
  validationBlocker?: { reasonCode: string; remediation?: string };
}

/** Did this attempt run the contract's validation command? */
function attemptMatchesValidationCmd(attempt: ValidationAttempt, validationCmd: string): boolean {
  return attempt.command.includes(validationCmd) || validationCmd.includes(attempt.command);
}

/**
 * Evaluate a goal contract against recorded completion evidence.
 * Always cites the stop condition; when validationCmd is present, the
 * completion evidence summary must reference that exact command (i.e. a
 * verify_edit result for it was recorded).
 *
 * `validationAttempts` is optional and additive. When one of them reports that
 * the contract's validationCmd `could_not_run`, that takes priority over the
 * evidence check: an agent may well have recorded an evidence summary quoting
 * the command, and "the command never executed here" must not be allowed to
 * satisfy a stop condition just because its name appears in a string.
 */
export function evaluateGoalContractCompletion(
  contract: GoalContract,
  completionEvidenceSummary: string | undefined,
  validationAttempts?: ValidationAttempt[]
): GoalContractCompletionCheck {
  const stopConditionCitation = `stop-condition: ${contract.stopCondition}`;
  if (contract.validationCmd) {
    const blocked = validationAttempts?.find(
      (attempt) =>
        attempt.outcome === "could_not_run" &&
        attemptMatchesValidationCmd(attempt, contract.validationCmd!)
    );
    if (blocked) {
      return {
        ok: false,
        reasonCode: "goal_contract_validation_could_not_run",
        stopConditionCitation,
        expectedValidationCmd: contract.validationCmd,
        validationBlocker: {
          reasonCode: blocked.reasonCode ?? "could_not_run",
          ...(blocked.remediation !== undefined ? { remediation: blocked.remediation } : {}),
        },
      };
    }
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
// Self-enforced task leases
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
 * Mark a task as force_synthesized: the supervisor
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

/**
 * The two mandatory clauses, rendered together. They are a pair by design:
 * ANTI_REWARD_HACKING_CLAUSE forbids degrading the verifier, and
 * NULL_RESULT_VALID_CLAUSE keeps the honest "nothing to change" answer
 * available. Shipping one without the other leaves the agent squeezed from
 * exactly one side, so there is one function that emits both and no caller
 * that emits either alone.
 */
export function renderGoalContractClauseLines(indent = "  "): string[] {
  return [
    `${indent}- anti-reward-hacking: ${ANTI_REWARD_HACKING_CLAUSE}`,
    `${indent}- null-result: ${NULL_RESULT_VALID_CLAUSE}`,
  ];
}

/**
 * The single goal-contract renderer.
 *
 * `_PostCompact` used to hand-roll its own, emitting objective, stop condition
 * and validation command while silently dropping `constraints[]` and both
 * mandatory clauses (D1). That inverted the intent: the hook fires right after
 * a compaction, when the agent has just lost its working memory and is under
 * maximum pressure to close out, and it handed back the goal with precisely
 * the two guardrails that hold at that moment removed. Every surface that
 * renders a contract now comes through here.
 *
 * `includeClauses: false` lets a budget-constrained caller emit the clause pair
 * once for a whole payload rather than once per contract — but it must emit it,
 * via `renderGoalContractClauseLines`. The escape hatch is about placement, not
 * about whether the clauses ship.
 */
export function renderGoalContractLines(
  contract: GoalContract,
  options: { indent?: string; includeClauses?: boolean } = {}
): string[] {
  const indent = options.indent ?? "  ";
  const lines: string[] = [`${indent}- objective: ${contract.objective}`];
  lines.push(`${indent}- constraints (must NOT change):`);
  for (const constraint of contract.constraints) {
    lines.push(`${indent}  - ${constraint}`);
  }
  if (contract.validationCmd) {
    lines.push(`${indent}- validation-cmd (run via verify_edit): ${contract.validationCmd}`);
  }
  if (contract.canaryCmd) {
    lines.push(
      `${indent}- canary-cmd (run on the unchanged tree before fan-out): ${contract.canaryCmd}`
    );
  }
  lines.push(`${indent}- stop-condition: ${contract.stopCondition}`);
  if (contract.docsNote) {
    lines.push(`${indent}- docs-note: ${contract.docsNote}`);
  }
  if (contract.metric) {
    lines.push(
      `${indent}- metric: ${contract.metric.name} (${contract.metric.direction}; unknown stays unknown)`
    );
  }
  if (contract.baseline) {
    const value =
      contract.baseline.value === "unknown" ? "unknown" : String(contract.baseline.value);
    lines.push(`${indent}- baseline: ${value} (provenance ${contract.baseline.provenance})`);
    if (contract.baseline.note) {
      lines.push(`${indent}  - note: ${contract.baseline.note}`);
    }
  }
  if (contract.maturity) {
    lines.push(`${indent}- maturity: ${contract.maturity}`);
  }
  if (contract.parentEligible !== undefined) {
    lines.push(`${indent}- parent-eligible: ${contract.parentEligible ? "yes" : "no"}`);
  }
  if (options.includeClauses !== false) {
    lines.push(...renderGoalContractClauseLines(indent));
  }
  return lines;
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
    lines.push("- goal-contract:");
    lines.push(...renderGoalContractLines(task.goalContract));
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
