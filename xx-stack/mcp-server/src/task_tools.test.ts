import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { DEFAULT_RELIABILITY, emptySupervisorStore } from "./supervisor_runtime.js";
import { filterTasks, type TaskListFilters } from "./task_list_runtime.js";
import { registerTaskTools } from "./task_tools.js";
import { emptyTaskStore, type PersistentTask, type TaskStore } from "./task_runtime.js";

type ToolResult = { content: Array<{ type: string; text: string }> };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function captureTaskTools(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const fakeServer = {
    tool: (...args: unknown[]) => {
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
