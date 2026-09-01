import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  assignWaves,
  computeReadySet,
  findCycleThrough,
  findDependencyCycle,
  findUnknownBlockers,
  formatDependencyCycle,
  narrowTaskStoreToReady,
  validateBlockedByEdges,
  type TaskGraphNode,
} from "./task_graph_runtime.js";
import { emptyTaskStore, type PersistentTask, type TaskStatus } from "./task_runtime.js";

function node(taskId: string, status: TaskStatus, blockedBy: string[] = []): TaskGraphNode {
  return { taskId, status, blockedBy };
}

// ---------------------------------------------------------------------------
// The constraint: this module computes a schedule, it never executes one.
// ---------------------------------------------------------------------------

/**
 * MANUAL §1 forbids this control plane from becoming a workflow engine. The
 * scheduling half is useful; the execution half — a runner that waits for wave
 * 1 and fires wave 2 — is the line. Prose in a header comment does not hold
 * that line on its own, so this asserts it against the compiled module.
 *
 * Comments and string literals are stripped first: the point is that no
 * execution primitive is *reachable*, not that the words never appear.
 */
test("task_graph_runtime contains no execution path — it plans, it never runs", () => {
  const compiled = readFileSync(
    fileURLToPath(new URL("./task_graph_runtime.js", import.meta.url)),
    "utf-8"
  );
  const code = compiled
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");

  const forbidden = [
    "async",
    "await",
    "Promise",
    "then(",
    "setTimeout",
    "setInterval",
    "setImmediate",
    "queueMicrotask",
    "spawn",
    "exec",
    "child_process",
    "fetch",
    "readFile",
    "writeFile",
    "node:fs",
    "node:child_process",
    "process.",
    "import(",
  ];
  for (const token of forbidden) {
    assert.ok(
      !code.includes(token),
      `task_graph_runtime must stay a pure scheduler; found execution primitive "${token}"`
    );
  }

  // Structural corollary: nothing exported can be awaited, so no caller can
  // build a dispatch loop out of this module without writing one themselves.
  const exported = [
    assignWaves,
    computeReadySet,
    findCycleThrough,
    findDependencyCycle,
    findUnknownBlockers,
    formatDependencyCycle,
    narrowTaskStoreToReady,
    validateBlockedByEdges,
  ];
  for (const fn of exported) {
    assert.notEqual(fn.constructor.name, "AsyncFunction", `${fn.name} must not be async`);
  }
});

// ---------------------------------------------------------------------------
// computeReadySet
// ---------------------------------------------------------------------------

test("computeReadySet: all three terminal statuses satisfy a blocker edge", () => {
  // done / canceled / force_synthesized come from the one shared
  // TASK_TERMINAL_STATUSES set, so a force-synthesized blocker releases its
  // dependents exactly like a finished one.
  for (const status of ["done", "canceled", "force_synthesized"] as const) {
    const tasks = [node("blocker", status), node("dependent", "todo", ["blocker"])];
    assert.deepEqual(
      computeReadySet(tasks).map((task) => task.taskId),
      ["dependent"],
      `${status} should satisfy a blocker edge`
    );
  }
});

test("computeReadySet: an open blocker withholds its dependent, a terminal one releases it", () => {
  const tasks = [
    node("open-blocker", "in_progress"),
    node("waiting", "todo", ["open-blocker"]),
    node("free", "todo"),
  ];
  assert.deepEqual(
    computeReadySet(tasks).map((task) => task.taskId),
    ["open-blocker", "free"]
  );
});

test("computeReadySet: terminal tasks are never ready, and an unknown blocker is never satisfied", () => {
  const tasks = [
    node("finished", "done"),
    node("typo", "todo", ["tsk-does-not-exist"]),
    node("ok", "todo"),
  ];
  assert.deepEqual(
    computeReadySet(tasks).map((task) => task.taskId),
    ["ok"]
  );
});

// ---------------------------------------------------------------------------
// findUnknownBlockers — the silent-deadlock diagnostic
// ---------------------------------------------------------------------------

test("findUnknownBlockers names the exact ids that reference no task", () => {
  // sanitizeIdList only trims and drops empties; it never checked existence,
  // so a typo'd blocker was a permanent deadlock with no diagnostic anywhere.
  const tasks = [
    node("a", "todo", ["b", "tsk-typo", "tsk-typo", "also-missing"]),
    node("b", "todo"),
    node("c", "todo", ["b"]),
  ];
  assert.deepEqual(findUnknownBlockers(tasks), [
    { taskId: "a", unknownBlockers: ["also-missing", "tsk-typo"] },
  ]);
});

// ---------------------------------------------------------------------------
// findDependencyCycle — the NAMED PATH, not a boolean
// ---------------------------------------------------------------------------

test("findDependencyCycle names both nodes of a two-node cycle", () => {
  const tasks = [node("a", "todo", ["b"]), node("b", "todo", ["a"])];
  assert.deepEqual(findDependencyCycle(tasks), ["a", "b"]);
  assert.equal(formatDependencyCycle(findDependencyCycle(tasks)!), "a -> b -> a");
});

test("findDependencyCycle names all three nodes of a three-node cycle, in order", () => {
  // "There is a cycle somewhere" is not a diagnostic anyone can act on.
  const tasks = [
    node("a", "todo", ["b"]),
    node("b", "todo", ["c"]),
    node("c", "todo", ["a"]),
    node("bystander", "todo"),
  ];
  const cycle = findDependencyCycle(tasks);
  assert.deepEqual(cycle, ["a", "b", "c"]);
  assert.equal(formatDependencyCycle(cycle!), "a -> b -> c -> a");
});

test("findDependencyCycle catches a self-block and returns null on an acyclic graph", () => {
  assert.deepEqual(findDependencyCycle([node("solo", "todo", ["solo"])]), ["solo"]);
  assert.equal(
    findDependencyCycle([
      node("a", "todo"),
      node("b", "todo", ["a"]),
      node("c", "todo", ["a", "b"]),
    ]),
    null
  );
});

test("findDependencyCycle is deterministic and independent of input order", () => {
  const tasks = [
    node("c", "todo", ["a"]),
    node("a", "todo", ["b"]),
    node("b", "todo", ["c"]),
    node("z", "todo", ["a"]),
  ];
  const first = findDependencyCycle(tasks);
  const shuffled = [tasks[3]!, tasks[1]!, tasks[0]!, tasks[2]!];
  assert.deepEqual(first, findDependencyCycle(shuffled));
  assert.deepEqual(first, ["a", "b", "c"]);
});

test("findCycleThrough reports only cycles the named task participates in", () => {
  const tasks = [
    node("x", "todo", ["y"]),
    node("y", "todo", ["x"]),
    node("outsider", "todo", ["x"]),
  ];
  assert.deepEqual(findCycleThrough(tasks, "x"), ["x", "y"]);
  assert.deepEqual(findCycleThrough(tasks, "y"), ["y", "x"]);
  assert.equal(findCycleThrough(tasks, "outsider"), null);
});

// ---------------------------------------------------------------------------
// assignWaves
// ---------------------------------------------------------------------------

test("assignWaves groups a chain into one task per wave and a diamond into three", () => {
  const chain = assignWaves([
    node("c", "todo", ["b"]),
    node("a", "todo"),
    node("b", "todo", ["a"]),
  ]);
  assert.deepEqual(chain.waves, [["a"], ["b"], ["c"]]);
  assert.deepEqual(chain.unscheduled, []);

  const diamond = assignWaves([
    node("root", "todo"),
    node("left", "todo", ["root"]),
    node("right", "todo", ["root"]),
    node("join", "todo", ["left", "right"]),
  ]);
  assert.deepEqual(diamond.waves, [["root"], ["left", "right"], ["join"]]);
});

test("assignWaves excludes terminal tasks and starts wave 0 from the ready set", () => {
  const plan = assignWaves([
    node("shipped", "done"),
    node("next", "todo", ["shipped"]),
    node("later", "todo", ["next"]),
  ]);
  assert.deepEqual(plan.waves, [["next"], ["later"]]);
  assert.deepEqual(
    plan.waves[0],
    computeReadySet([
      node("shipped", "done"),
      node("next", "todo", ["shipped"]),
      node("later", "todo", ["next"]),
    ]).map((task) => task.taskId)
  );
});

test("assignWaves reports what it cannot place, with the reason named — never drops it", () => {
  const plan = assignWaves([
    node("fine", "todo"),
    node("typo", "todo", ["nope"]),
    node("loop-a", "todo", ["loop-b"]),
    node("loop-b", "todo", ["loop-a"]),
    node("downstream", "todo", ["loop-a"]),
  ]);
  assert.deepEqual(plan.waves, [["fine"]]);
  assert.deepEqual(
    plan.unscheduled.map((entry) => [entry.taskId, entry.reason]),
    [
      ["downstream", "blocked_by_unscheduled"],
      ["loop-a", "cycle"],
      ["loop-b", "cycle"],
      ["typo", "unknown_blocker"],
    ]
  );
  const typo = plan.unscheduled.find((entry) => entry.taskId === "typo")!;
  assert.ok(typo.detail.includes('"nope"'), "the unknown id must be quoted in the diagnostic");
  const loop = plan.unscheduled.find((entry) => entry.taskId === "loop-a")!;
  assert.ok(loop.detail.includes("loop-a -> loop-b -> loop-a"), loop.detail);
});

test("assignWaves surfaces dependents of a canceled task as unreachable rather than pending forever", () => {
  const plan = assignWaves([
    node("abandoned", "canceled"),
    node("direct", "todo", ["abandoned"]),
    node("transitive", "todo", ["direct"]),
    node("unrelated", "todo"),
  ]);
  // canceled is terminal, so the edge is satisfied and the work still
  // schedules — withholding it would be the silent deadlock this module
  // exists to remove. The abandoned premise is reported alongside it.
  assert.deepEqual(plan.waves, [["direct", "unrelated"], ["transitive"]]);
  assert.deepEqual(plan.unreachable, [
    { taskId: "direct", canceledBlockers: ["abandoned"] },
    { taskId: "transitive", canceledBlockers: ["abandoned"] },
  ]);
});

// ---------------------------------------------------------------------------
// validateBlockedByEdges — write-time rejection
// ---------------------------------------------------------------------------

test("validateBlockedByEdges rejects a dangling edge with the unknown id quoted, and prunes nothing", () => {
  const tasks = [node("a", "todo", ["ghost"]), node("b", "todo")];
  const violation = validateBlockedByEdges(tasks, "a");
  assert.equal(violation?.reasonCode, "blocked_by_unknown_task");
  assert.deepEqual(violation?.unknownBlockers, ["ghost"]);
  assert.ok(violation!.reason.includes('"ghost"'));
  // Silent repair is the MCP-1 failure mode: the input is untouched.
  assert.deepEqual(tasks[0]!.blockedBy, ["ghost"]);
});

test("validateBlockedByEdges rejects a cycle-creating edge with the path named", () => {
  const tasks = [node("a", "todo", ["b"]), node("b", "todo", ["a"])];
  const violation = validateBlockedByEdges(tasks, "a");
  assert.equal(violation?.reasonCode, "blocked_by_cycle");
  assert.deepEqual(violation?.cyclePath, ["a", "b"]);
  assert.ok(violation!.reason.includes("a -> b -> a"), violation!.reason);
});

test("validateBlockedByEdges ignores violations that belong to some other task", () => {
  // A pre-existing dangling edge elsewhere must not make an unrelated write
  // impossible.
  const tasks = [
    node("clean", "todo", ["ok"]),
    node("ok", "todo"),
    node("dirty", "todo", ["gone"]),
  ];
  assert.equal(validateBlockedByEdges(tasks, "clean"), null);
  assert.equal(validateBlockedByEdges(tasks, "dirty")?.reasonCode, "blocked_by_unknown_task");
});

// ---------------------------------------------------------------------------
// narrowTaskStoreToReady
// ---------------------------------------------------------------------------

test("narrowTaskStoreToReady computes readiness against the whole store, terminal blockers included", () => {
  const store = emptyTaskStore();
  const tasks: PersistentTask[] = [
    {
      taskId: "done-blocker",
      title: "blocker",
      status: "done",
      tags: [],
      blockedBy: [],
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    },
    {
      taskId: "ready",
      title: "ready",
      status: "todo",
      tags: [],
      blockedBy: ["done-blocker"],
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    },
    {
      taskId: "waiting",
      title: "waiting",
      status: "todo",
      tags: [],
      blockedBy: ["ready"],
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    },
  ];
  for (const task of tasks) store.tasks[task.taskId] = task;

  const narrowed = narrowTaskStoreToReady(store);
  assert.deepEqual(Object.keys(narrowed.tasks), ["ready"]);
  assert.equal(narrowed.version, store.version);
  // The input store is not mutated.
  assert.deepEqual(Object.keys(store.tasks).sort(), ["done-blocker", "ready", "waiting"]);
});
