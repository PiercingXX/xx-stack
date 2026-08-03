import test from "node:test";
import assert from "node:assert/strict";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  buildPostCompactState,
  buildStopObjections,
  hookToolsEnabled,
  registerHookTools,
  registerHookToolsIfEnabled,
  renderStopObjection,
  HOOK_TOOL_DESCRIPTION_PREFIX,
  type HookScope,
  type HookToolDeps,
} from "./hook_tools.js";
import { DEFAULT_RELIABILITY, emptySupervisorStore } from "./supervisor_runtime.js";
import type { SupervisorSessionState, SupervisorStore } from "./supervisor_runtime.js";
import { emptyTaskStore, type PersistentTask, type TaskStore } from "./task_runtime.js";

// --- fixtures -------------------------------------------------------------

function makeTask(overrides: Partial<PersistentTask> = {}): PersistentTask {
  return {
    taskId: "tsk-0001",
    title: "Finish the payment migration",
    status: "in_progress",
    tags: [],
    blockedBy: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeSession(overrides: Partial<SupervisorSessionState> = {}): SupervisorSessionState {
  return {
    sessionId: "sx-0001",
    description: "hook fixture",
    status: "running",
    startedAt: 1_000,
    lastProgressAt: 1_000,
    attemptCount: 1,
    failureCount: 0,
    currentRoute: {
      host: "localhost",
      model: "qwen3",
      endpoint: "http://localhost:11434",
      tier: "local",
    },
    fallbackRoutes: [],
    nextFallbackIndex: 0,
    continuationCount: 2,
    events: [],
    ...overrides,
  };
}

function storeOf(tasks: PersistentTask[]): TaskStore {
  const store = emptyTaskStore();
  for (const task of tasks) store.tasks[task.taskId] = task;
  return store;
}

function supervisorStoreOf(sessions: SupervisorSessionState[]): SupervisorStore {
  const store = emptySupervisorStore();
  for (const session of sessions) store.sessions[session.sessionId] = session;
  return store;
}

interface DepOverrides {
  tasks?: PersistentTask[];
  sessions?: SupervisorSessionState[];
  /** Default: every session is completion-ready, so sessions raise no objection. */
  readiness?: (state: SupervisorSessionState) => { ok: boolean; reasonCode: string };
  driftDetected?: boolean;
}

function makeDeps(overrides: DepOverrides = {}): HookToolDeps {
  return {
    readTaskStore: async () => storeOf(overrides.tasks ?? []),
    readSupervisorStore: async () => supervisorStoreOf(overrides.sessions ?? []),
    loadReliabilityConfig: async () => ({ ...DEFAULT_RELIABILITY }),
    pruneSupervisorStore: (store) => store,
    evaluateCompletionReadiness: (state) =>
      overrides.readiness
        ? overrides.readiness(state)
        : { ok: true, reasonCode: "completion_ready" },
    getCompletionMemorySyncStatus: async () => ({
      driftDetected: overrides.driftDetected === true,
    }),
    getAgentMemoryEntrypoint: (agentId, scope, cwd) =>
      `${cwd}/.memory/${scope}/${agentId}/MEMORY.md`,
    now: () => 10_000,
    cwd: () => "/tmp/xx-stack-hook-fixture",
  };
}

async function runStop(deps: HookToolDeps, scope: HookScope = {}): Promise<string> {
  return renderStopObjection(await buildStopObjections(deps, scope), scope);
}

// --- registration / flag gating -------------------------------------------

interface CapturedTool {
  name: string;
  description: string;
  handler: (args: HookScope) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

function captureTools(register: (server: McpServer) => void): CapturedTool[] {
  const captured: CapturedTool[] = [];
  const fakeServer = {
    tool: (...args: unknown[]) => {
      captured.push({
        name: args[0] as string,
        description: args[1] as string,
        handler: args[args.length - 1] as CapturedTool["handler"],
      });
    },
  } as unknown as McpServer;
  register(fakeServer);
  return captured;
}

test("hook tools are absent from tools/list by default and present only with XX_STACK_HOOK_TOOLS=1", () => {
  const deps = makeDeps();

  assert.equal(hookToolsEnabled({}), false, "no flag means disabled");
  assert.equal(hookToolsEnabled({ XX_STACK_HOOK_TOOLS: "0" }), false);
  assert.equal(hookToolsEnabled({ XX_STACK_HOOK_TOOLS: "true" }), false, "only '1' enables");
  assert.equal(hookToolsEnabled({ XX_STACK_HOOK_TOOLS: "1" }), true);

  const off = captureTools((server) => {
    const registered = registerHookToolsIfEnabled(server, deps, {});
    assert.equal(registered, false);
  });
  assert.deepEqual(off, [], "without the flag no hook tool reaches tools/list");

  const on = captureTools((server) => {
    const registered = registerHookToolsIfEnabled(server, deps, { XX_STACK_HOOK_TOOLS: "1" });
    assert.equal(registered, true);
  });
  assert.deepEqual(
    on.map((tool) => tool.name),
    ["_Stop", "_PostCompact"],
    "with the flag exactly the two underscore-prefixed lifecycle hooks are registered"
  );
});

test("hook descriptions carry the not-for-direct-model-use marker as the fallback defense", () => {
  const tools = captureTools((server) => registerHookTools(server, makeDeps()));
  for (const tool of tools) {
    assert.ok(
      tool.description.startsWith(HOOK_TOOL_DESCRIPTION_PREFIX),
      `${tool.name} must declare itself a lifecycle hook`
    );
    assert.ok(tool.name.startsWith("_"), `${tool.name} must keep the underscore prefix`);
  }
});

// --- _Stop: empty vs objection --------------------------------------------

test("_Stop returns an empty string when there is no open supervised work", async () => {
  const text = await runStop(makeDeps());
  assert.equal(text, "", "empty string is the no-objection signal");

  // Terminal tasks and terminal sessions are not open work.
  const terminal = makeDeps({
    tasks: [makeTask({ taskId: "tsk-done", status: "done" })],
    sessions: [makeSession({ sessionId: "sx-done", status: "completed" })],
  });
  assert.equal(await runStop(terminal), "");
});

test("_Stop objects with the concrete task id and unmet stop condition, not the whole contract", async () => {
  const deps = makeDeps({
    tasks: [
      makeTask({
        taskId: "tsk-payments",
        sessionId: "sx-0001",
        goalContract: {
          objective: "Make npm test pass on the payment module",
          constraints: [
            "Do not change the public API of charge()",
            "Do not touch billing fixtures",
          ],
          stopCondition: "npm test exits 0 with all payment suites green",
          docsNote: "Update docs/payments.md",
        },
      }),
    ],
    sessions: [makeSession()],
  });

  const text = await runStop(deps, { sessionId: "sx-0001" });
  assert.notEqual(text, "");
  assert.ok(text.includes("tsk-payments"), "the objection names the task id");
  assert.ok(
    text.includes("stop-condition: npm test exits 0 with all payment suites green"),
    "the objection names the unmet stop condition"
  );
  // Bounded: the rest of the contract is not restated.
  assert.ok(!text.includes("Do not change the public API of charge()"));
  assert.ok(!text.includes("Update docs/payments.md"));
});

test("_Stop names the missing verify_edit evidence when a goal contract has a validationCmd", async () => {
  const contract = {
    objective: "Ship the loader fix",
    constraints: ["No schema changes"],
    validationCmd: "npm test -- --filter loader",
    stopCondition: "loader suite green",
  };

  const missing = await runStop(
    makeDeps({
      tasks: [makeTask({ taskId: "tsk-loader", sessionId: "sx-0001", goalContract: contract })],
      sessions: [makeSession()],
    })
  );
  assert.ok(missing.includes("tsk-loader"));
  assert.ok(missing.includes("stop-condition: loader suite green"));
  assert.ok(missing.includes("npm test -- --filter loader"));

  // Evidence citing the exact command flips the objection to the plain
  // open-work form; the stop condition is still the named condition.
  const cited = await runStop(
    makeDeps({
      tasks: [makeTask({ taskId: "tsk-loader", sessionId: "sx-0001", goalContract: contract })],
      sessions: [
        makeSession({
          completionEvidenceSummary: "verify_edit result for `npm test -- --filter loader`: ok",
        }),
      ],
    })
  );
  assert.ok(cited.includes("stop-condition: loader suite green"));
  assert.ok(!cited.includes("no verify_edit evidence recorded"));
});

test("_Stop reports an unready session and unresolved memory drift as concrete conditions", async () => {
  const notReady = await runStop(
    makeDeps({
      sessions: [makeSession({ sessionId: "sx-unready" })],
      readiness: () => ({ ok: false, reasonCode: "completion_evidence_missing" }),
    })
  );
  assert.ok(notReady.includes("sx-unready"));
  assert.ok(notReady.includes("completion_evidence_missing"));

  const drift = await runStop(
    makeDeps({
      sessions: [
        makeSession({
          sessionId: "sx-drift",
          completionMemorySync: { agentId: "researcher", scope: "project", cwd: "/repo" },
        }),
      ],
      driftDetected: true,
    })
  );
  assert.ok(drift.includes("sx-drift"));
  assert.ok(drift.includes("memory snapshot drift"));
  assert.ok(drift.includes("researcher"));
});

test("_Stop objections are bounded to a caller-actionable few with an explicit remainder", async () => {
  const tasks = Array.from({ length: 7 }, (_, index) =>
    makeTask({ taskId: `tsk-${String(index).padStart(3, "0")}` })
  );
  const text = await runStop(makeDeps({ tasks }));

  const bulletLines = text.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(bulletLines.length, 4, "3 objections plus one remainder line");
  assert.ok(text.includes("(+4 more open items not shown)"));
  assert.ok(text.includes("tsk-000"));
  assert.ok(!text.includes("tsk-006"), "beyond the bound nothing is listed");
});

test("_Stop never phrases its objection as an operator instruction", async () => {
  const text = await runStop(makeDeps({ tasks: [makeTask()] }));
  assert.ok(text.includes("observed state"));
  for (const imperative of [
    "Keep working",
    "You must",
    "You should",
    "Do not stop",
    "Continue working",
  ]) {
    assert.ok(
      !text.includes(imperative),
      `hook output must not read as an instruction: ${imperative}`
    );
  }
});

test("_Stop is deterministic for fixed state and answers well inside the 2.5s hook budget", async () => {
  const deps = makeDeps({
    tasks: [makeTask({ taskId: "tsk-b" }), makeTask({ taskId: "tsk-a", title: "Second item" })],
    sessions: [makeSession({ sessionId: "sx-b" }), makeSession({ sessionId: "sx-a" })],
    readiness: () => ({ ok: false, reasonCode: "completion_evidence_missing" }),
  });

  const started = Date.now();
  const first = await runStop(deps);
  const elapsed = Date.now() - started;
  const second = await runStop(deps);
  const third = await runStop(deps);

  assert.equal(first, second, "identical state must produce byte-identical objections");
  assert.equal(second, third);
  assert.ok(
    first.indexOf("tsk-a") < first.indexOf("tsk-b"),
    "ordering is explicit, not store-iteration order"
  );
  assert.ok(elapsed < 2_500, `hook must answer under the 2.5s caller timeout, took ${elapsed}ms`);
});

test("_Stop degrades to a fleet-wide summary without scope and narrows with one", async () => {
  const deps = makeDeps({
    tasks: [
      makeTask({ taskId: "tsk-mine", sessionId: "sx-0001", owner: "lane-a" }),
      makeTask({ taskId: "tsk-theirs", sessionId: "sx-9999", owner: "lane-b" }),
    ],
  });

  const fleet = await runStop(deps);
  assert.ok(fleet.includes("fleet-wide (no agentId or sessionId supplied)"));
  assert.ok(fleet.includes("tsk-mine"));
  assert.ok(fleet.includes("tsk-theirs"));

  const scoped = await runStop(deps, { sessionId: "sx-0001" });
  assert.ok(scoped.includes("session sx-0001"));
  assert.ok(scoped.includes("tsk-mine"));
  assert.ok(!scoped.includes("tsk-theirs"));

  const byAgent = await runStop(deps, { agentId: "lane-b" });
  assert.ok(byAgent.includes("agent lane-b"));
  assert.ok(byAgent.includes("tsk-theirs"));
  assert.ok(!byAgent.includes("tsk-mine"));
});

// --- _PostCompact ---------------------------------------------------------

test("_PostCompact re-derives open tasks, contracts, worktree notes, leases, and the memory pointer", async () => {
  const deps = makeDeps({
    tasks: [
      makeTask({
        taskId: "tsk-compact",
        sessionId: "sx-0001",
        parentCwd: "/repo",
        worktreePath: "/repo/.worktrees/lane-a",
        lastCheckpoint: "loader migration half applied",
        lease: { expiresAt: "2026-08-02T12:00:00.000Z" },
        goalContract: {
          objective: "Migrate the loader",
          constraints: ["No schema changes"],
          validationCmd: "npm test",
          stopCondition: "loader suite green",
        },
      }),
    ],
    sessions: [
      makeSession({
        completionMemorySync: { agentId: "researcher", scope: "project", cwd: "/repo" },
      }),
    ],
  });

  const text = await buildPostCompactState(deps, { sessionId: "sx-0001" });

  assert.ok(text.includes("tsk-compact [in_progress]"));
  assert.ok(text.includes("checkpoint: loader migration half applied"));
  assert.ok(text.includes("objective: Migrate the loader"));
  assert.ok(text.includes("stop-condition: loader suite green"));
  assert.ok(text.includes("validation-cmd: npm test"));
  assert.ok(text.includes("lease: expires-at 2026-08-02T12:00:00.000Z"));
  // Worktree resume notice comes from the shared task_runtime formatter.
  assert.ok(text.includes("Resume inside isolated worktree /repo/.worktrees/lane-a"));
  assert.ok(text.includes("sx-0001 [running] route localhost/qwen3, continuation attempts 2"));
  // Memory pointer is a path, never contents.
  assert.ok(text.includes("/repo/.memory/project/researcher/MEMORY.md"));
  assert.ok(text.includes("observed state, not instructions"));
});

test("_PostCompact is deterministic and states plainly when nothing is open", async () => {
  const empty = await buildPostCompactState(makeDeps(), {});
  assert.ok(empty.includes("no open supervised tasks or sessions are recorded."));
  assert.ok(empty.includes("fleet-wide (no agentId or sessionId supplied)"));

  const deps = makeDeps({
    tasks: [makeTask({ taskId: "tsk-z" }), makeTask({ taskId: "tsk-a" })],
    sessions: [makeSession({ sessionId: "sx-z" }), makeSession({ sessionId: "sx-a" })],
  });
  const first = await buildPostCompactState(deps, {});
  const second = await buildPostCompactState(deps, {});
  assert.equal(first, second, "identical state must produce byte-identical re-injection");
  assert.ok(first.indexOf("tsk-a") < first.indexOf("tsk-z"));
  assert.ok(first.indexOf("sx-a") < first.indexOf("sx-z"));
});

test("_PostCompact bounds re-injection so a compacted context is not immediately refilled", async () => {
  const tasks = Array.from({ length: 14 }, (_, index) =>
    makeTask({ taskId: `tsk-${String(index).padStart(3, "0")}` })
  );
  const sessions = Array.from({ length: 8 }, (_, index) =>
    makeSession({ sessionId: `sx-${String(index).padStart(3, "0")}` })
  );
  const text = await buildPostCompactState(makeDeps({ tasks, sessions }), {});

  assert.ok(text.includes("- open tasks (10 of 14):"));
  assert.ok(text.includes("(+4 more open tasks not shown)"));
  assert.ok(text.includes("- supervised sessions (5 of 8):"));
  assert.ok(text.includes("(+3 more sessions not shown)"));
});

test("_PostCompact derives only from the stores it reads — no new persistent state", async () => {
  // The dep surface is the proof: the hook group is handed read-only accessors
  // and pure formatters. Any write path would have to appear here.
  const deps = makeDeps({ tasks: [makeTask()] });
  const depNames = Object.keys(deps).sort();
  assert.deepEqual(depNames, [
    "cwd",
    "evaluateCompletionReadiness",
    "getAgentMemoryEntrypoint",
    "getCompletionMemorySyncStatus",
    "loadReliabilityConfig",
    "now",
    "pruneSupervisorStore",
    "readSupervisorStore",
    "readTaskStore",
  ]);

  // Driving the registered handler must not mutate the stores it was given.
  const taskStore = storeOf([makeTask()]);
  const supervisorStore = supervisorStoreOf([makeSession()]);
  const snapshot = JSON.stringify({ taskStore, supervisorStore });
  const liveDeps: HookToolDeps = {
    ...deps,
    readTaskStore: async () => taskStore,
    readSupervisorStore: async () => supervisorStore,
  };

  const tools = captureTools((server) => registerHookTools(server, liveDeps));
  for (const tool of tools) {
    const result = await tool.handler({});
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0]!.type, "text");
  }
  assert.equal(JSON.stringify({ taskStore, supervisorStore }), snapshot, "stores are untouched");
});

test("registered _Stop handler returns the empty-string no-objection signal through MCP content", async () => {
  const tools = captureTools((server) => registerHookTools(server, makeDeps()));
  const stop = tools.find((tool) => tool.name === "_Stop");
  assert.ok(stop);

  const clean = await stop.handler({});
  assert.equal(clean.content[0]!.text, "", "no open work must yield the empty allow-stop signal");

  const objecting = captureTools((server) =>
    registerHookTools(server, makeDeps({ tasks: [makeTask({ taskId: "tsk-open" })] }))
  ).find((tool) => tool.name === "_Stop")!;
  const objection = await objecting.handler({});
  assert.ok(objection.content[0]!.text.includes("tsk-open"));
});

// ---------------------------------------------------------------------------
// MCP-9b: `_Stop` documents itself as a read path. The default memory status
// check mkdir's and atomically writes MEMORY.md/SNAPSHOT.md, so the hook must
// ask for the non-mutating mode explicitly.
// ---------------------------------------------------------------------------

test("_Stop asks for the non-mutating memory status check", async () => {
  const guard = { agentId: "reviewer", scope: "project" as const, cwd: "/tmp/xx-stack-fixture" };
  const calls: Array<{ guard: unknown; options: unknown }> = [];
  const deps: HookToolDeps = {
    ...makeDeps({
      sessions: [makeSession({ completionMemorySync: guard })],
    }),
    getCompletionMemorySyncStatus: async (g, options) => {
      calls.push({ guard: g, options });
      return { driftDetected: true };
    },
  };

  const text = await runStop(deps, {});
  assert.ok(text.includes("memory snapshot drift is unresolved"));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].guard, guard);
  assert.deepEqual(
    calls[0].options,
    { ensureFiles: false },
    "_Stop must never scaffold memory files as a side effect of checking drift"
  );
});

test("_Stop passes ensureFiles:false for every guarded session it checks", async () => {
  const sessions = [1, 2, 3, 4, 5].map((n) =>
    makeSession({
      sessionId: `sx-000${n}`,
      completionMemorySync: { agentId: `agent-${n}`, scope: "project", cwd: "/tmp/fixture" },
    })
  );
  const seen: Array<boolean | undefined> = [];
  const deps: HookToolDeps = {
    ...makeDeps({ sessions }),
    getCompletionMemorySyncStatus: async (_guard, options) => {
      seen.push(options?.ensureFiles);
      return { driftDetected: false };
    },
  };

  await runStop(deps, {});
  // Bounded by MAX_MEMORY_DRIFT_CHECKS, and every one of them read-only.
  assert.equal(seen.length, 3);
  assert.deepEqual(seen, [false, false, false]);
});
