/**
 * Task dependency graph: ready sets, blocked waves, cycle paths, dangling edges.
 *
 * ===========================================================================
 * SCOPE CONSTRAINT — READ BEFORE ADDING ANYTHING TO THIS FILE (MANUAL §1)
 * ===========================================================================
 * xx-stack **computes and returns a schedule; it never executes one.**
 *
 * Everything here is a pure function over an in-memory task list. There is no
 * dispatch loop, no waiting on completion, no "unblocked" event, no timer, no
 * subprocess, no store write, and nothing asynchronous. A wave plan comes back
 * as a *plan* — exactly the way `route_competitive_task` returns worktree paths
 * it does not create, and `route_parallel_tasks` returns host assignments it
 * does not dispatch. The calling agent decides what to run and when.
 *
 * Taking the execution half — a runner that watches wave 1 finish and then
 * fires wave 2 — would turn this control plane into a workflow engine, which
 * MANUAL §1 forbids ("It never becomes a desktop app, an editing REPL, or a
 * workflow engine. It recommends; the calling agent executes."). If you find
 * yourself needing a promise, a timer, or a filesystem handle in this module,
 * the feature belongs in the caller, not here.
 *
 * `task_graph_runtime.test.ts` asserts this mechanically: it scans the
 * compiled module for execution primitives and fails if any appear.
 * ===========================================================================
 *
 * Why this module exists: `blockedBy` was declared on `PersistentTask`,
 * accepted by `task_create`/`task_update`, sanitized, persisted — and read by
 * nothing. A typo'd blocker id was a permanent, silent deadlock with no
 * diagnostic anywhere, and `A blockedBy B` + `B blockedBy A` was accepted and
 * stored. These functions are the readers that make the field load-bearing.
 */

import { TASK_TERMINAL_STATUSES, type TaskStatus, type TaskStore } from "./task_runtime.js";

/**
 * The minimum a task must expose to be placed in the graph. `PersistentTask`
 * satisfies this structurally, so callers pass their tasks straight through
 * and get their own type back.
 */
export interface TaskGraphNode {
  taskId: string;
  status: TaskStatus;
  blockedBy: string[];
}

/** A task carrying blocker ids that match no task in the graph. */
export interface UnknownBlockerReport {
  taskId: string;
  unknownBlockers: string[];
}

/** Why a non-terminal task could not be placed in any wave. */
export type UnscheduledReason = "cycle" | "unknown_blocker" | "blocked_by_unscheduled";

export interface UnscheduledTask {
  taskId: string;
  reason: UnscheduledReason;
  detail: string;
}

/**
 * A task whose blocker closure contains a `canceled` task. `canceled` is
 * terminal, so it satisfies the edge and the dependent still schedules — but
 * the premise it was waiting on was abandoned, which is a fact a caller should
 * see rather than infer. Surfaced as a parallel diagnostic instead of being
 * dropped from the plan: silently withholding a task is the deadlock this
 * module exists to remove.
 */
export interface UnreachableTask {
  taskId: string;
  canceledBlockers: string[];
}

export interface TaskWavePlan {
  /** Wave 0 is startable now; wave n waits only on waves < n. Task ids, sorted. */
  waves: string[][];
  unscheduled: UnscheduledTask[];
  unreachable: UnreachableTask[];
}

function indexById<T extends TaskGraphNode>(tasks: T[]): Map<string, T> {
  const byId = new Map<string, T>();
  for (const task of tasks) byId.set(task.taskId, task);
  return byId;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Blocker ids that reference no task in the graph.
 *
 * `sanitizeIdList` trims and drops empties; it never checked that the target
 * exists, so a typo'd id produced a task nothing would ever unblock. Returned
 * sorted by task id with each id list sorted and deduped, so the diagnostic is
 * stable enough to assert on.
 */
export function findUnknownBlockers<T extends TaskGraphNode>(tasks: T[]): UnknownBlockerReport[] {
  const byId = indexById(tasks);
  const reports: UnknownBlockerReport[] = [];
  for (const task of tasks) {
    const unknown = uniqueSorted(task.blockedBy.filter((id) => !byId.has(id)));
    if (unknown.length > 0) reports.push({ taskId: task.taskId, unknownBlockers: unknown });
  }
  return reports.sort((left, right) => left.taskId.localeCompare(right.taskId));
}

/**
 * The cycle path through `startId`, or null. Returns the NAMED PATH — a
 * two-node cycle names both nodes, a three-node cycle names all three in
 * order — because "there is a cycle somewhere" is not a diagnostic anyone can
 * act on. A task that blocks itself returns `[startId]`.
 *
 * Blockers are walked in sorted order so the same graph always yields the same
 * path.
 */
export function findCycleThrough<T extends TaskGraphNode>(
  tasks: T[],
  startId: string
): string[] | null {
  const byId = indexById(tasks);
  if (!byId.has(startId)) return null;

  const path: string[] = [];
  const onPath = new Set<string>();
  const exhausted = new Set<string>();

  const walk = (id: string): string[] | null => {
    path.push(id);
    onPath.add(id);
    const blockers = uniqueSorted(byId.get(id)?.blockedBy ?? []);
    for (const blocker of blockers) {
      if (blocker === startId) return [...path];
      if (!byId.has(blocker) || onPath.has(blocker) || exhausted.has(blocker)) continue;
      const found = walk(blocker);
      if (found) return found;
    }
    path.pop();
    onPath.delete(id);
    exhausted.add(id);
    return null;
  };

  return walk(startId);
}

/**
 * The first dependency cycle in the graph, as a named path, or null.
 * Deterministic: task ids are probed in sorted order, so the reported cycle
 * always starts at the lexicographically smallest node that participates in
 * one.
 */
export function findDependencyCycle<T extends TaskGraphNode>(tasks: T[]): string[] | null {
  const ids = tasks.map((task) => task.taskId).sort();
  for (const id of ids) {
    const cycle = findCycleThrough(tasks, id);
    if (cycle) return cycle;
  }
  return null;
}

/** Render a cycle path the way a human reads it: `a -> b -> a`. */
export function formatDependencyCycle(cycle: string[]): string {
  return [...cycle, cycle[0]].join(" -> ");
}

function isTerminal(status: TaskStatus): boolean {
  return TASK_TERMINAL_STATUSES.has(status);
}

/**
 * Non-terminal tasks whose every blocker is terminal.
 *
 * All three terminal statuses satisfy an edge — `done`, `canceled`, and
 * `force_synthesized` — via the one shared `TASK_TERMINAL_STATUSES` set, so a
 * force-synthesized blocker releases its dependents exactly like a finished
 * one. A blocker that names no existing task is NOT satisfied: nothing will
 * ever close it, so treating it as satisfied would hide the dangling edge
 * instead of surfacing it. Input order is preserved.
 */
export function computeReadySet<T extends TaskGraphNode>(tasks: T[]): T[] {
  const byId = indexById(tasks);
  return tasks.filter((task) => {
    if (isTerminal(task.status)) return false;
    return task.blockedBy.every((id) => {
      const blocker = byId.get(id);
      return blocker !== undefined && isTerminal(blocker.status);
    });
  });
}

/** Every non-terminal task whose blocker closure contains a `canceled` task. */
function findUnreachable<T extends TaskGraphNode>(tasks: T[]): UnreachableTask[] {
  const byId = indexById(tasks);
  const unreachable: UnreachableTask[] = [];
  for (const task of tasks) {
    if (isTerminal(task.status)) continue;
    const canceled: string[] = [];
    const seen = new Set<string>([task.taskId]);
    const frontier = [...task.blockedBy];
    while (frontier.length > 0) {
      const id = frontier.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const blocker = byId.get(id);
      if (!blocker) continue;
      if (blocker.status === "canceled") canceled.push(id);
      frontier.push(...blocker.blockedBy);
    }
    if (canceled.length > 0) {
      unreachable.push({ taskId: task.taskId, canceledBlockers: uniqueSorted(canceled) });
    }
  }
  return unreachable.sort((left, right) => left.taskId.localeCompare(right.taskId));
}

/**
 * Group the open tasks into blocked waves.
 *
 * Wave 0 is the ready set. Wave n holds tasks whose blockers are all terminal
 * or placed in an earlier wave. What cannot be placed at all is reported in
 * `unscheduled` with the reason named, never silently dropped: a task that
 * disappears from a schedule is the same silent deadlock as a task that waits
 * on a blocker that does not exist.
 *
 * This is a PLAN. Nothing here starts, waits for, or sequences any work — see
 * the scope constraint at the top of this file.
 */
export function assignWaves<T extends TaskGraphNode>(tasks: T[]): TaskWavePlan {
  const byId = indexById(tasks);
  const open = tasks.filter((task) => !isTerminal(task.status));
  const unknownByTask = new Map(
    findUnknownBlockers(tasks).map((report) => [report.taskId, report.unknownBlockers])
  );

  const placed = new Set<string>();
  const waves: string[][] = [];
  let remaining = [...open];

  for (;;) {
    const wave = remaining.filter((task) =>
      task.blockedBy.every((id) => {
        const blocker = byId.get(id);
        if (blocker === undefined) return false;
        return isTerminal(blocker.status) || placed.has(id);
      })
    );
    if (wave.length === 0) break;
    for (const task of wave) placed.add(task.taskId);
    waves.push(wave.map((task) => task.taskId).sort());
    remaining = remaining.filter((task) => !placed.has(task.taskId));
  }

  const unscheduled: UnscheduledTask[] = remaining
    .map((task): UnscheduledTask => {
      const unknown = unknownByTask.get(task.taskId);
      if (unknown) {
        return {
          taskId: task.taskId,
          reason: "unknown_blocker",
          detail: `blocked by ${unknown.map((id) => `"${id}"`).join(", ")}, which name no existing task`,
        };
      }
      const cycle = findCycleThrough(tasks, task.taskId);
      if (cycle) {
        return {
          taskId: task.taskId,
          reason: "cycle",
          detail: `dependency cycle: ${formatDependencyCycle(cycle)}`,
        };
      }
      return {
        taskId: task.taskId,
        reason: "blocked_by_unscheduled",
        detail: "every path to this task passes through a task that can never be scheduled",
      };
    })
    .sort((left, right) => left.taskId.localeCompare(right.taskId));

  return { waves, unscheduled, unreachable: findUnreachable(tasks) };
}

// ---------------------------------------------------------------------------
// Write-time validation
// ---------------------------------------------------------------------------

export type TaskGraphViolationCode = "blocked_by_unknown_task" | "blocked_by_cycle";

export interface TaskGraphViolation {
  status: "rejected";
  reasonCode: TaskGraphViolationCode;
  taskId: string;
  /** Present for blocked_by_unknown_task. */
  unknownBlockers?: string[];
  /** Present for blocked_by_cycle, named in order. */
  cyclePath?: string[];
  reason: string;
}

/**
 * Validate the blocker edges a single write is introducing, against the store
 * as it would look if the write landed.
 *
 * Rejection happens at write time so a deadlock is never persisted in the
 * first place. The alternative — accepting the edge and pruning it later — is
 * silent repair, which is precisely the failure mode MANUAL §11 MCP-1 was
 * about: a store that quietly heals itself loses the operator's data and never
 * says so. Nothing here mutates or prunes anything; the caller writes nothing
 * when a violation comes back.
 *
 * Only violations attributable to `subjectTaskId` are reported. A pre-existing
 * dangling edge on some unrelated task must not make an unrelated write
 * impossible.
 */
export function validateBlockedByEdges<T extends TaskGraphNode>(
  prospectiveTasks: T[],
  subjectTaskId: string
): TaskGraphViolation | null {
  const subject = prospectiveTasks.find((task) => task.taskId === subjectTaskId);
  if (!subject) return null;

  const byId = indexById(prospectiveTasks);
  const unknown = uniqueSorted(subject.blockedBy.filter((id) => !byId.has(id)));
  if (unknown.length > 0) {
    return {
      status: "rejected",
      reasonCode: "blocked_by_unknown_task",
      taskId: subjectTaskId,
      unknownBlockers: unknown,
      reason:
        `blockedBy names no existing task: ${unknown.map((id) => `"${id}"`).join(", ")}. ` +
        "A blocker that does not exist can never close, so the edge was rejected rather than " +
        "stored as a silent deadlock. Nothing was written; the unknown ids were not pruned.",
    };
  }

  const cycle = findCycleThrough(prospectiveTasks, subjectTaskId);
  if (cycle) {
    return {
      status: "rejected",
      reasonCode: "blocked_by_cycle",
      taskId: subjectTaskId,
      cyclePath: cycle,
      reason:
        `blockedBy would create a dependency cycle: ${formatDependencyCycle(cycle)}. ` +
        "Every task on that path waits on the next, so none of them could ever start. " +
        "Nothing was written.",
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Store shaping (still pure: takes a store value, returns a store value)
// ---------------------------------------------------------------------------

/**
 * A copy of the store containing only the ready tasks, for `readyOnly` list
 * filters.
 *
 * Readiness is computed against **every** task in the store, including the
 * terminal ones a list filter would hide: a blocker that is `done` is exactly
 * what makes its dependent ready, so narrowing before the readiness pass would
 * make finished blockers look unknown. The narrowing happens before
 * `filterTasks` so `total`/`returned` stay coherent with what was returned.
 */
export function narrowTaskStoreToReady(store: TaskStore): TaskStore {
  const ready = computeReadySet(Object.values(store.tasks));
  const tasks: TaskStore["tasks"] = {};
  for (const task of ready) tasks[task.taskId] = task;
  return { version: store.version, tasks };
}
