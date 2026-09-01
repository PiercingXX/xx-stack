import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { DEFAULT_RELIABILITY, emptySupervisorStore } from "./supervisor_runtime.js";
import { filterTasks, type TaskListFilters } from "./task_list_runtime.js";
import { narrowTaskStoreToReady } from "./task_graph_runtime.js";
import { registerTaskTools } from "./task_tools.js";
import { emptyTaskStore, type PersistentTask, type TaskStore } from "./task_runtime.js";

type ToolResult = { content: Array<{ type: string; text: string }> };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function captureTaskTools(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const fakeServer = {
    registerTool: (...args: unknown[]) => {
      handlers[args[0] as string] = args[args.length - 1] as Handler;
    },
  } as unknown as McpServer;

  registerTaskTools(fakeServer, {
    loadReliabilityConfig: async () => ({ ...DEFAULT_RELIABILITY }),
    readSupervisorStore: async () => emptySupervisorStore(),
    pruneSupervisorStore: (store) => store,
  });
  return handlers;
}

function makeTask(overrides: Partial<PersistentTask>): PersistentTask {
  return {
    taskId: "tsk-0000",
    title: "fixture",
    status: "in_progress",
    tags: [],
    blockedBy: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function buildStore(): TaskStore {
  const store = emptyTaskStore();
  for (const task of [
    makeTask({
      taskId: "task-a",
      status: "in_progress",
      tags: ["ci"],
      owner: "Skippy",
      updatedAt: "2026-08-02T10:00:00.000Z",
    }),
    makeTask({
      taskId: "task-b",
      status: "done",
      tags: ["ci", "docs"],
      updatedAt: "2026-08-03T10:00:00.000Z",
    }),
    makeTask({
      taskId: "task-c",
      status: "todo",
      tags: ["docs"],
      owner: "other",
      updatedAt: "2026-08-01T10:00:00.000Z",
    }),
  ]) {
    store.tasks[task.taskId] = task;
  }
  return store;
}

/**
 * MCP-DUP-3: `task_list` and `xx tasks list` used to carry independent copies of
 * the same filter/sort/cap shaping, with tests on the CLI copy only. Both now
 * call filterTasks, and this drives the registered tool against the same store
 * to prove the tool's output is exactly what the shared runtime produces — for
 * every filter combination, not just the default one.
 */
test("MCP-DUP-3: task_list returns exactly filterTasks output for every filter shape", async () => {
  const originalHome = process.env.HOME;
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-task-list-"));
  try {
    process.env.HOME = dir;
    await mkdir(join(dir, ".config/opencode"), { recursive: true });
    const store = buildStore();
    await writeFile(
      join(dir, ".config/opencode/xx-stack-task-state.json"),
      JSON.stringify(store),
      "utf-8"
    );

    const tools = captureTaskTools();
    const cases: TaskListFilters[] = [
      {},
      { includeCompleted: true },
      { status: "todo" },
      { tag: "CI" },
      { owner: "skippy" },
      { limit: 1 },
      { includeCompleted: true, tag: "docs", limit: 1 },
    ];

    for (const filters of cases) {
      const result = await tools.task_list!(filters as Record<string, unknown>);
      const payload = JSON.parse(result.content[0]!.text);
      assert.deepEqual(
        payload,
        JSON.parse(JSON.stringify(filterTasks(store, filters))),
        `task_list drifted from filterTasks for ${JSON.stringify(filters)}`
      );
    }
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// BORROW A — blockedBy is load-bearing: write-time rejection + readyOnly
// ---------------------------------------------------------------------------

const STORE_RELATIVE_PATH = ".config/opencode/xx-stack-task-state.json";

/**
 * Run `work` with HOME pointed at a throwaway task store seeded with `store`.
 * `readStoreBytes` returns the file exactly as it sits on disk, so a test can
 * assert that a rejected write left zero bytes changed rather than merely that
 * the returned payload looked right.
 */
async function withTaskStore<T>(
  store: TaskStore,
  work: (ctx: {
    tools: Record<string, Handler>;
    readStoreBytes: () => Promise<string>;
  }) => Promise<T>
): Promise<T> {
  const originalHome = process.env.HOME;
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-task-graph-"));
  const path = join(dir, STORE_RELATIVE_PATH);
  try {
    process.env.HOME = dir;
    await mkdir(join(dir, ".config/opencode"), { recursive: true });
    await writeFile(path, JSON.stringify(store, null, 2) + "\n", "utf-8");
    return await work({
      tools: captureTaskTools(),
      readStoreBytes: () => readFile(path, "utf-8"),
    });
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(dir, { recursive: true, force: true });
  }
}

function payloadOf(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text);
}

function graphStore(): TaskStore {
  const store = emptyTaskStore();
  for (const task of [
    makeTask({ taskId: "blocker-open", status: "in_progress", title: "open blocker" }),
    makeTask({ taskId: "blocker-done", status: "done", title: "finished blocker" }),
    makeTask({
      taskId: "waiting",
      status: "todo",
      title: "waits on an open blocker",
      blockedBy: ["blocker-open"],
    }),
    makeTask({
      taskId: "startable",
      status: "todo",
      title: "waits on a finished blocker",
      blockedBy: ["blocker-done"],
    }),
  ]) {
    store.tasks[task.taskId] = task;
  }
  return store;
}

test("task_create rejects a blocker ID that names no task, quoting it, and writes nothing", async () => {
  // Before this fix sanitizeIdList only trimmed: the typo was accepted and
  // stored, producing a permanent silent deadlock with no diagnostic anywhere.
  await withTaskStore(graphStore(), async ({ tools, readStoreBytes }) => {
    const before = await readStoreBytes();
    const payload = payloadOf(
      await tools.task_create!({ title: "new work", blockedBy: ["tsk-typo-9999"] })
    );
    assert.equal(payload.status, "rejected");
    assert.equal(payload.reasonCode, "blocked_by_unknown_task");
    assert.equal(payload.operation, "task_create");
    assert.deepEqual(payload.unknownBlockers, ["tsk-typo-9999"]);
    assert.ok(String(payload.reason).includes('"tsk-typo-9999"'), String(payload.reason));
    assert.equal(await readStoreBytes(), before, "a rejected create must write nothing");
  });
});

test("task_create does NOT silently prune the dangling blocker — it refuses the write", async () => {
  // Silent repair is exactly the MCP-1 failure mode: a store that quietly
  // edits the caller's data and never says so.
  await withTaskStore(graphStore(), async ({ tools, readStoreBytes }) => {
    await tools.task_create!({ title: "new work", blockedBy: ["ghost", "blocker-done"] });
    const after = JSON.parse(await readStoreBytes()) as TaskStore;
    assert.deepEqual(Object.keys(after.tasks).sort(), [
      "blocker-done",
      "blocker-open",
      "startable",
      "waiting",
    ]);
  });
});

test("task_create accepts a blocker that exists", async () => {
  await withTaskStore(graphStore(), async ({ tools }) => {
    const payload = payloadOf(
      await tools.task_create!({ title: "legit", blockedBy: ["blocker-open"] })
    );
    assert.equal(payload.status, "created");
    assert.deepEqual((payload.task as PersistentTask).blockedBy, ["blocker-open"]);
  });
});

test("task_update rejects a cycle-creating edge with the cycle path named, and writes nothing", async () => {
  // `A blockedBy B` + `B blockedBy A` used to be accepted and stored. The
  // rejection names the whole path, not "there is a cycle somewhere".
  const store = graphStore();
  store.tasks["b"] = makeTask({ taskId: "b", status: "todo", blockedBy: ["a"] });
  store.tasks["a"] = makeTask({ taskId: "a", status: "todo", blockedBy: [] });

  await withTaskStore(store, async ({ tools, readStoreBytes }) => {
    const before = await readStoreBytes();
    const payload = payloadOf(await tools.task_update!({ taskId: "a", blockedBy: ["b"] }));
    assert.equal(payload.status, "rejected");
    assert.equal(payload.reasonCode, "blocked_by_cycle");
    assert.equal(payload.operation, "task_update");
    assert.deepEqual(payload.cyclePath, ["a", "b"]);
    assert.ok(String(payload.reason).includes("a -> b -> a"), String(payload.reason));
    assert.equal(await readStoreBytes(), before, "a rejected update must write nothing");
  });
});

test("task_update rejects a self-block and a dangling edge; an unrelated update still lands", async () => {
  await withTaskStore(graphStore(), async ({ tools }) => {
    const selfBlock = payloadOf(
      await tools.task_update!({ taskId: "waiting", blockedBy: ["waiting"] })
    );
    assert.equal(selfBlock.reasonCode, "blocked_by_cycle");
    assert.deepEqual(selfBlock.cyclePath, ["waiting"]);

    const dangling = payloadOf(
      await tools.task_update!({ taskId: "waiting", blockedBy: ["nope"] })
    );
    assert.equal(dangling.reasonCode, "blocked_by_unknown_task");

    // A write that does not touch blockedBy is never fenced by graph checks.
    const ok = payloadOf(await tools.task_update!({ taskId: "waiting", title: "renamed" }));
    assert.equal(ok.status, "updated");
    assert.equal((ok.task as PersistentTask).title, "renamed");
  });
});

test("task_list readyOnly returns only startable work and matches the shared runtime exactly", async () => {
  const store = graphStore();
  await withTaskStore(store, async ({ tools }) => {
    const payload = payloadOf(await tools.task_list!({ readyOnly: true }));
    assert.deepEqual(
      (payload.tasks as PersistentTask[]).map((task) => task.taskId).sort(),
      ["blocker-open", "startable"],
      "a task whose blocker is still open is not startable"
    );
    assert.equal(payload.total, 2);

    // MCP-DUP-3: the tool must be exactly narrowTaskStoreToReady + filterTasks.
    assert.deepEqual(
      payload,
      JSON.parse(JSON.stringify(filterTasks(narrowTaskStoreToReady(store), {})))
    );

    // Omitted, the filter changes nothing.
    const unfiltered = payloadOf(await tools.task_list!({}));
    assert.deepEqual(unfiltered, JSON.parse(JSON.stringify(filterTasks(store, {}))));
  });
});

test("task_list readyOnly never returns a task blocked by an ID that does not exist", async () => {
  const store = graphStore();
  store.tasks["orphan"] = makeTask({ taskId: "orphan", status: "todo", blockedBy: ["gone"] });
  await withTaskStore(store, async ({ tools }) => {
    const payload = payloadOf(await tools.task_list!({ readyOnly: true }));
    assert.ok(
      !(payload.tasks as PersistentTask[]).some((task) => task.taskId === "orphan"),
      "a blocker that cannot ever close does not make its dependent ready"
    );
  });
});

// ---------------------------------------------------------------------------
// BORROW B — terminal is terminal: task_suspend
// ---------------------------------------------------------------------------

test("task_suspend refuses every terminal status and writes nothing", async () => {
  // `task.status = "suspended"` had no terminal guard, so a done task could be
  // resurrected into `suspended` — and a force_synthesized one had
  // applyForceSynthesisOutcome undone.
  for (const status of ["done", "canceled", "force_synthesized"] as const) {
    const store = emptyTaskStore();
    store.tasks["finished"] = makeTask({ taskId: "finished", status });
    await withTaskStore(store, async ({ tools, readStoreBytes }) => {
      const before = await readStoreBytes();
      const payload = payloadOf(
        await tools.task_suspend!({ taskId: "finished", checkpoint: "late note" })
      );
      assert.equal(payload.status, "rejected");
      assert.equal(payload.reasonCode, "task_terminal");
      assert.equal(payload.taskStatus, status);
      assert.ok(String(payload.reason).includes(status), String(payload.reason));
      assert.equal(
        await readStoreBytes(),
        before,
        `suspending a ${status} task must write nothing`
      );
    });
  }
});

test("task_suspend still suspends a live task, and the lease fence stays ahead of the terminal check", async () => {
  const store = emptyTaskStore();
  store.tasks["live"] = makeTask({ taskId: "live", status: "in_progress" });
  store.tasks["dead-lease"] = makeTask({
    taskId: "dead-lease",
    status: "done",
    lease: { expiresAt: "2020-01-01T00:00:00.000Z" },
  });

  await withTaskStore(store, async ({ tools }) => {
    const ok = payloadOf(await tools.task_suspend!({ taskId: "live", checkpoint: "paused here" }));
    assert.equal(ok.status, "suspended");
    assert.equal((ok.task as PersistentTask).status, "suspended");

    // Ordering matters: an expired lease is reported as a lease failure even
    // though the task is also terminal. The fence is unchanged and first.
    const fenced = payloadOf(await tools.task_suspend!({ taskId: "dead-lease" }));
    assert.equal(fenced.reasonCode, "lease_expired");

    // Absent id is still `missing`, not `rejected`.
    const gone = payloadOf(await tools.task_suspend!({ taskId: "nope" }));
    assert.equal(gone.status, "missing");
  });
});
