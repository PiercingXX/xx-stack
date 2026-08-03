import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { z } from "zod";

import { atomicWriteTextFile } from "./io_runtime.js";
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

function buildWorktreeResumeNotice(
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
  lines.push("- requirements:");
  lines.push("  - continue from existing artifacts, do not restart from scratch");
  lines.push("  - produce deterministic evidence (diff, command output, or explicit blocker)");
  lines.push("  - if blocked, include next fallback action");
  return lines.join("\n");
}

export async function readTaskStore(): Promise<TaskStore> {
  const path = getTaskStatePath();
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<TaskStore>;
    return {
      version: TASK_STORE_VERSION,
      tasks: parsed.tasks ?? {},
    };
  } catch {
    return emptyTaskStore();
  }
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
