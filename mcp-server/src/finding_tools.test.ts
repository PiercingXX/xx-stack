import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerFindingTools } from "./finding_tools.js";
import { emptyFindingStore, readFindingStore } from "./finding_runtime.js";
import {
  emptyTaskStore,
  writeTaskStore,
  type PersistentTask,
  type TaskStore,
} from "./task_runtime.js";

type ToolResult = { content: Array<{ type: string; text: string }> };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function captureFindingTools(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const fakeServer = {
    registerTool: (...args: unknown[]) => {
      handlers[args[0] as string] = args[args.length - 1] as Handler;
    },
  } as unknown as McpServer;
  registerFindingTools(fakeServer);
  return handlers;
}

async function call(handler: Handler, args: Record<string, unknown> = {}): Promise<any> {
  const result = await handler(args);
  return JSON.parse(result.content[0]!.text);
}

function makeTask(overrides: Partial<PersistentTask> = {}): PersistentTask {
  return {
    taskId: "tsk-a",
    title: "work",
    status: "todo",
    tags: [],
    blockedBy: [],
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
    ...overrides,
  };
}

const ORIGINAL_HOME = process.env.HOME;

async function withTempHome<T>(work: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "xx-stack-finding-tools-"));
  process.env.HOME = homeDir;
  await mkdir(join(homeDir, ".config/opencode"), { recursive: true });
  try {
    return await work(homeDir);
  } finally {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;
    await rm(homeDir, { recursive: true, force: true });
  }
}

test("finding_record refuses to confirm a force-synthesized salvage", async () => {
  await withTempHome(async () => {
    const tools = captureFindingTools();
    const payload = await call(tools.finding_record!, {
      kind: "finding",
      title: "salvage",
      summary: "best effort",
      requestedLane: "confirmed",
      sourceStatus: "force_synthesized",
      sessionId: "ses-1",
      taskId: "tsk-1",
    });
    assert.equal(payload.status, "recorded");
    assert.equal(payload.finding.lane, "incubator");
    assert.equal(payload.finding.role, "partial_output");
    assert.equal(payload.finding.parentEligible, false);
    assert.equal(payload.finding.laneReasonCode, "forced_to_incubator");
  });
});

test("finding_record parks a failed experiment in diagnostic, not confirmed", async () => {
  await withTempHome(async () => {
    const tools = captureFindingTools();
    const payload = await call(tools.finding_record!, {
      kind: "result",
      title: "failed run",
      summary: "tests red for a real reason",
      requestedLane: "confirmed",
      sourceStatus: "blocked",
      taskId: "tsk-fail",
    });
    assert.equal(payload.finding.lane, "diagnostic");
    assert.equal(payload.finding.parentEligible, false);
  });
});

test("generation_open requires a canary when the contract has a validation command", async () => {
  await withTempHome(async () => {
    const tools = captureFindingTools();
    const tasks: TaskStore = emptyTaskStore();
    tasks.tasks["tsk-a"] = makeTask({
      taskId: "tsk-a",
      goalContract: {
        objective: "Make tests pass",
        constraints: ["Do not weaken tests"],
        validationCmd: "npm test",
        stopCondition: "npm test exits 0",
      },
    });
    await writeTaskStore(tasks);

    const rejected = await call(tools.generation_open!, { cohortTaskIds: ["tsk-a"] });
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.reasonCode, "canary_required");

    await call(tools.finding_record!, {
      kind: "canary",
      title: "unchanged-tree canary",
      summary: "npm test is currently red on main",
      taskId: "tsk-a",
      canaryOutcome: "fail",
      validationCmd: "npm test",
    });

    const opened = await call(tools.generation_open!, { cohortTaskIds: ["tsk-a"] });
    assert.equal(opened.status, "opened");
    assert.equal(opened.generation.status, "open");
  });
});

test("generation_open blocks when the canary could not run", async () => {
  await withTempHome(async () => {
    const tools = captureFindingTools();
    const tasks: TaskStore = emptyTaskStore();
    tasks.tasks["tsk-a"] = makeTask({
      taskId: "tsk-a",
      goalContract: {
        objective: "Make tests pass",
        constraints: ["Do not weaken tests"],
        validationCmd: "npm test",
        stopCondition: "npm test exits 0",
      },
    });
    await writeTaskStore(tasks);

    await call(tools.finding_record!, {
      kind: "canary",
      title: "canary",
      summary: "npm missing",
      taskId: "tsk-a",
      canaryOutcome: "could_not_run",
      validationCmd: "npm test",
    });

    const rejected = await call(tools.generation_open!, { cohortTaskIds: ["tsk-a"] });
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.reasonCode, "canary_could_not_run");
  });
});

test("generation_close freezes membership; later records are late signals", async () => {
  await withTempHome(async () => {
    const tools = captureFindingTools();
    const tasks: TaskStore = emptyTaskStore();
    tasks.tasks["tsk-a"] = makeTask({ taskId: "tsk-a" });
    await writeTaskStore(tasks);

    const opened = await call(tools.generation_open!, { cohortTaskIds: ["tsk-a"] });
    const generationId = opened.generation.generationId as string;

    const first = await call(tools.finding_record!, {
      kind: "result",
      title: "on time",
      summary: "in the generation",
      generationId,
      requestedLane: "confirmed",
    });
    assert.equal(first.status, "recorded");

    const closed = await call(tools.generation_close!, {
      generationId,
      agenda: "Try the cache approach next.",
    });
    assert.equal(closed.status, "closed");
    assert.equal(closed.generation.agenda, "Try the cache approach next.");

    const late = await call(tools.finding_record!, {
      kind: "result",
      title: "late",
      summary: "after cutoff",
      generationId,
      requestedLane: "confirmed",
    });
    assert.equal(late.status, "late");
    assert.equal(late.finding.parentEligible, false);

    const status = await call(tools.generation_status!, { generationId });
    assert.equal(status.findings.length, 1);
    assert.equal(status.lateFindings.length, 1);
    assert.equal(status.findings[0].findingId, first.finding.findingId);
  });
});

test("mechanism_contract targeting tests is rejected", async () => {
  await withTempHome(async () => {
    const tools = captureFindingTools();
    const payload = await call(tools.finding_record!, {
      kind: "mechanism_contract",
      title: "weaken tests",
      summary: "delete the failing suite",
      diversityCell: { mechanismFamily: "cheat", surface: "tests", intent: "pass" },
    });
    assert.equal(payload.status, "rejected");
    assert.equal(payload.reasonCode, "mechanism_forbidden_surface");
    assert.deepEqual(await readFindingStore(), emptyFindingStore());
  });
});

test("unknown metric value is stored as unknown, not 0", async () => {
  await withTempHome(async () => {
    const tools = captureFindingTools();
    const payload = await call(tools.finding_record!, {
      kind: "result",
      title: "no reading",
      summary: "gauge missing",
      requestedLane: "confirmed",
      metric: { name: "score", direction: "maximize" },
      metricValue: "unknown",
    });
    assert.equal(payload.finding.metricValue, "unknown");
    assert.equal(payload.finding.lane, "incubator");
    assert.notEqual(payload.finding.metricValue, 0);
  });
});
