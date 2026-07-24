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
] as const;
export type TaskStatus = (typeof TASK_STATUS_VALUES)[number];

export const TASK_PRIORITY_VALUES = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITY_VALUES)[number];

export const TASK_STATUS_SCHEMA = z.enum(TASK_STATUS_VALUES);
export const TASK_PRIORITY_SCHEMA = z.enum(TASK_PRIORITY_VALUES);
export const TASK_TERMINAL_STATUSES = new Set<TaskStatus>(["done", "canceled"]);

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
