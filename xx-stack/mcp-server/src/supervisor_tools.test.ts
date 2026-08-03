import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Registry } from "./platform_types.js";
import { registerSupervisorTools } from "./supervisor_tools.js";
import {
  applySupervisorEventTransition,
  buildCompletionRepairChecklist,
  clearCompletionProof,
  computeBackoffMs,
  DEFAULT_RELIABILITY,
  emptySupervisorStore,
  evaluateCompletionReadiness,
  failureKey,
  findMalformedSessions,
  isAbortWindowActive,
  makeAttemptId,
  makeRecoveryKey,
  parseCompletionValidationReason,
  pruneSupervisorStore,
  pruningRemovedEntries,
  pushSessionEvent,
  readSupervisorStore,
  sessionEvent,
  shouldAutoReleaseLock,
  shouldDedupeContinuation,
  shouldResetFailureStreak,
  withSupervisorStoreLock,
  writeSupervisorStore,
  type ReliabilityConfig,
  type SupervisorSessionState,
  type SupervisorStore,
} from "./supervisor_runtime.js";
import type { SupervisorToolDeps } from "./supervisor_tool_deps.js";
import {
  emptyTaskStore,
  readTaskStore,
  writeTaskStore,
  type PersistentTask,
} from "./task_runtime.js";

// The supervisor and task stores live under $HOME. Every test here runs against
// a throwaway HOME so the developer's real state is never touched; node --test
// isolates each test file in its own process.
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_REPO = process.env.XX_STACK_REPO;
const SUPERVISOR_FILE = ".config/opencode/xx-stack-supervisor-state.json";

async function withTempHome<T>(work: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "xx-stack-supervisor-tools-"));
  process.env.HOME = homeDir;
  // Reliability + lifecycle-hook config also resolve from HOME / XX_STACK_REPO;
  // point both at the throwaway dir so no configured hook can fire.
  process.env.XX_STACK_REPO = homeDir;
  await mkdir(join(homeDir, ".config/opencode"), { recursive: true });
  try {
    return await work(homeDir);
  } finally {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;
    if (ORIGINAL_REPO === undefined) delete process.env.XX_STACK_REPO;
    else process.env.XX_STACK_REPO = ORIGINAL_REPO;
    await rm(homeDir, { recursive: true, force: true });
  }
}

type ToolResult = { content: Array<{ type: string; text: string }> };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

const FALLBACK_ROUTE = {
  tier: "local",
  host: "fallback-host",
  model: "qwen3",
  endpoint: "http://127.0.0.1:65535",
};

interface Captured {
  handlers: Record<string, Handler>;
  writes: () => number;
}

function captureTools(reliability: Partial<ReliabilityConfig> = {}): Captured {
  const handlers: Record<string, Handler> = {};
  const fakeServer = {
    tool: (...args: unknown[]) => {
      handlers[args[0] as string] = args[args.length - 1] as Handler;
    },
  } as unknown as McpServer;

  let writeCount = 0;
  const deps: SupervisorToolDeps = {
    withSupervisorStoreLock,
    loadRegistry: async () => ({}) as unknown as Registry,
    loadReliabilityConfig: async () => ({ ...DEFAULT_RELIABILITY, ...reliability }),
    readSupervisorStore,
    writeSupervisorStore: async (store: SupervisorStore) => {
      writeCount += 1;
      await writeSupervisorStore(store);
    },
    pruneSupervisorStore,
    buildWatchdogRouteCandidates: async () => ({
      primary: null,
      healthyPrimary: false,
      candidates: [],
      health: [],
    }),
    applySupervisorEventTransition,
    sessionEvent,
    pushSessionEvent,
    clearCompletionProof,
    makeAttemptId,
    makeRecoveryKey,
    shouldAutoReleaseLock,
    shouldDedupeContinuation,
    isAbortWindowActive,
    evaluateCompletionReadiness,
    parseCompletionValidationReason,
    buildCompletionRepairChecklist,
    computeBackoffMs,
    failureKey,
    quickPingEndpoint: async () => true,
  };

  registerSupervisorTools(fakeServer, deps);
  return { handlers, writes: () => writeCount };
}

async function call(handler: Handler, args: Record<string, unknown> = {}): Promise<any> {
  const result = await handler(args);
  assert.equal(result.content.length, 1);
  return JSON.parse(result.content[0]!.text);
}

function makeSession(overrides: Partial<SupervisorSessionState> = {}): SupervisorSessionState {
  const now = Date.now();
  return {
    sessionId: "sx-test",
    description: "supervised work",
    status: "running",
    startedAt: now,
    lastProgressAt: now,
    attemptCount: 1,
    failureCount: 0,
    currentRoute: { tier: "local", host: "primary", model: "qwen3", endpoint: "http://primary" },
    fallbackRoutes: [FALLBACK_ROUTE],
    nextFallbackIndex: 0,
    continuationCount: 0,
    recoveryInFlight: false,
    events: [],
    ...overrides,
  };
}

async function seedSession(session: SupervisorSessionState): Promise<void> {
  const store = emptySupervisorStore();
  store.sessions[session.sessionId] = session;
  await writeSupervisorStore(store);
}

// --- MCP-11: observed progress must clear the cooldown --------------------

test("progress observed after a fallback reports running, not cooldown", async () => {
  await withTempHome(async () => {
    const { handlers } = captureTools();
    const now = Date.now();
    await seedSession(makeSession({ startedAt: now - 30_000, lastProgressAt: now - 30_000 }));

    const failover = await call(handlers.supervisor_tick!, { sessionId: "sx-test" });
    assert.equal(failover.reasonCode, "fallback_applied");
    assert.ok(failover.backoffMs > 0, "the fallback opened a backoff window");

    // The lane then reports real progress inside that backoff window. Before
    // the fix the stale cooldownUntil overrode the status in the same tick and
    // this came back as cooldown / cooldown_active for the whole window.
    const progressed = await call(handlers.supervisor_tick!, {
      sessionId: "sx-test",
      progressObserved: true,
    });
    assert.equal(progressed.status, "running");
    assert.equal(progressed.reasonCode, "healthy_progress_window");

    const persisted = await readSupervisorStore();
    assert.equal(persisted.sessions["sx-test"]!.cooldownUntil, undefined);
  });
});

test("an output event clears the cooldown too, so the next tick is not reported as cooldown", async () => {
  await withTempHome(async () => {
    const { handlers } = captureTools();
    const now = Date.now();
    await seedSession(makeSession({ startedAt: now - 30_000, lastProgressAt: now - 30_000 }));
    await call(handlers.supervisor_tick!, { sessionId: "sx-test" });

    const recorded = await call(handlers.supervisor_record_event!, {
      sessionId: "sx-test",
      eventType: "message.updated.assistant",
      detail: "assistant produced output",
    });
    assert.equal(recorded.status, "running");

    const ticked = await call(handlers.supervisor_tick!, { sessionId: "sx-test" });
    assert.equal(ticked.status, "running");
    assert.equal(ticked.reasonCode, "healthy_progress_window");
  });
});

// --- MCP-11: a fallback is not progress -----------------------------------

test("a slow poller cannot zero the failure streak: a fallback is not progress", async () => {
  await withTempHome(async () => {
    const { handlers } = captureTools();
    const now = Date.now();
    // The previous tick applied a fallback (which bumps lastProgressAt) and the
    // poller came back a whole reset window later. No progress ever happened.
    await seedSession(
      makeSession({
        startedAt: now - 90_000,
        lastProgressAt: now - 6 * 60_000,
        failureCount: 3,
        attemptCount: 1,
      })
    );

    const ticked = await call(handlers.supervisor_tick!, { sessionId: "sx-test" });
    assert.equal(
      ticked.failureCount,
      4,
      "the streak must keep growing; anchoring on lastProgressAt reset it to 1 every tick"
    );
  });
});

test("genuine progress after the last failure still decays the streak once the window elapses", async () => {
  await withTempHome(async () => {
    const { handlers } = captureTools();
    const now = Date.now();
    await seedSession(
      makeSession({
        startedAt: now - 90_000,
        lastProgressAt: now - 30_000,
        lastFailureAt: now - 6 * 60_000,
        lastObservedProgressAt: now - 5 * 60_000,
        failureCount: 3,
        attemptCount: 1,
      })
    );

    const ticked = await call(handlers.supervisor_tick!, { sessionId: "sx-test" });
    assert.equal(ticked.failureCount, 1, "streak decayed to 0, then this stall counted as 1");
  });
});

test("shouldResetFailureStreak requires progress newer than the last failure", () => {
  const reliability = { ...DEFAULT_RELIABILITY };
  const window = reliability.failureResetWindowMs;
  const now = 10_000_000;
  const base = makeSession({ failureCount: 2 });

  assert.equal(
    shouldResetFailureStreak({ ...base, failureCount: 0 }, now, reliability),
    false,
    "no streak, nothing to decay"
  );
  assert.equal(
    shouldResetFailureStreak({ ...base, lastFailureAt: now - window - 1 }, now, reliability),
    false,
    "no progress was ever observed"
  );
  assert.equal(
    shouldResetFailureStreak(
      {
        ...base,
        lastFailureAt: now - window - 1,
        lastObservedProgressAt: now - window - 2,
      },
      now,
      reliability
    ),
    false,
    "the progress predates the failure"
  );
  assert.equal(
    shouldResetFailureStreak(
      { ...base, lastFailureAt: now - 1_000, lastObservedProgressAt: now - 500 },
      now,
      reliability
    ),
    false,
    "the reset window has not elapsed yet"
  );
  assert.equal(
    shouldResetFailureStreak(
      { ...base, lastFailureAt: now - window, lastObservedProgressAt: now - window + 1 },
      now,
      reliability
    ),
    true
  );
});

// --- MCP-4: terminal transitions revoke task leases -----------------------

function leasedTask(overrides: Partial<PersistentTask> = {}): PersistentTask {
  return {
    taskId: "tsk-leased",
    title: "leased work",
    status: "in_progress",
    sessionId: "sx-test",
    lease: { expiresAt: "2099-01-01T00:00:00.000Z" },
    tags: [],
    blockedBy: [],
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

test("aborting a session revokes every live claim on its open tasks", async () => {
  await withTempHome(async () => {
    const { handlers } = captureTools();
    await seedSession(makeSession());

    const taskStore = emptyTaskStore();
    const leased = leasedTask();
    const unleased = leasedTask({ taskId: "tsk-plain", lease: undefined });
    const otherSession = leasedTask({ taskId: "tsk-other", sessionId: "sx-elsewhere" });
    taskStore.tasks[leased.taskId] = leased;
    taskStore.tasks[unleased.taskId] = unleased;
    taskStore.tasks[otherSession.taskId] = otherSession;
    await writeTaskStore(taskStore);

    const aborted = await call(handlers.supervisor_abort_session!, {
      sessionId: "sx-test",
      reason: "operator abort",
    });
    assert.equal(aborted.status, "interrupted");
    assert.deepEqual(aborted.revokedLeases, ["tsk-leased"]);

    const after = await readTaskStore();
    assert.equal(after.tasks["tsk-leased"]!.lease!.revoked, true);
    assert.equal(after.tasks["tsk-plain"]!.lease, undefined);
    assert.equal(after.tasks["tsk-other"]!.lease!.revoked, undefined);
  });
});

test("completing a session revokes every live claim on its open tasks", async () => {
  await withTempHome(async () => {
    const { handlers } = captureTools();
    await seedSession(makeSession());

    const taskStore = emptyTaskStore();
    const leased = leasedTask();
    taskStore.tasks[leased.taskId] = leased;
    await writeTaskStore(taskStore);

    const completed = await call(handlers.supervisor_complete_session!, {
      sessionId: "sx-test",
      outcome: "completed",
      forceComplete: true,
    });
    assert.equal(completed.status, "completed");
    assert.deepEqual(
      completed.revokedLeases,
      ["tsk-leased"],
      "a terminal session leaves no lane holding a live claim"
    );
    assert.equal((await readTaskStore()).tasks["tsk-leased"]!.lease!.revoked, true);
  });
});

// --- MCP-1: an inspection tool must not write ------------------------------

test("supervisor_status writes nothing when there is nothing to prune", async () => {
  await withTempHome(async (homeDir) => {
    const { handlers, writes } = captureTools();
    await seedSession(makeSession());
    const before = await readFile(join(homeDir, SUPERVISOR_FILE), "utf-8");

    const status = await call(handlers.supervisor_status!, {});
    assert.equal(status.sessionSummary.total, 1);
    assert.equal(writes(), 0, "a status poll is read-only");
    assert.equal(await readFile(join(homeDir, SUPERVISOR_FILE), "utf-8"), before);
  });
});

test("supervisor_status still persists a prune that actually dropped a session", async () => {
  await withTempHome(async () => {
    const { handlers, writes } = captureTools();
    const now = Date.now();
    await seedSession(makeSession({ sessionId: "sx-stale", lastProgressAt: now - 40 * 60_000 }));

    const status = await call(handlers.supervisor_status!, {});
    assert.equal(status.sessionSummary.total, 0);
    assert.equal(writes(), 1, "pruning removed an entry, so the prune is persisted");
    assert.deepEqual(Object.keys((await readSupervisorStore()).sessions), []);
  });
});

test("supervisor_status on an unreadable store reports the failure and destroys nothing", async () => {
  await withTempHome(async (homeDir) => {
    const { handlers, writes } = captureTools();
    // A live store that a transient bad read must not be allowed to erase.
    await seedSession(makeSession());
    const good = await readFile(join(homeDir, SUPERVISOR_FILE), "utf-8");
    await writeFile(join(homeDir, SUPERVISOR_FILE), good.slice(0, 40), "utf-8");
    const corrupt = await readFile(join(homeDir, SUPERVISOR_FILE), "utf-8");

    const status = await call(handlers.supervisor_status!, {});
    assert.equal(status.status, "error");
    assert.equal(status.reasonCode, "store_unavailable");
    assert.equal(status.store, "supervisor");

    assert.equal(writes(), 0, "an unreadable store is never overwritten");
    assert.equal(
      await readFile(join(homeDir, SUPERVISOR_FILE), "utf-8"),
      corrupt,
      "the file on disk is untouched, so it can still be repaired by hand"
    );
  });
});

test("a session tool on an unreadable store returns a structured error instead of throwing", async () => {
  await withTempHome(async (homeDir) => {
    const { handlers } = captureTools();
    await writeFile(join(homeDir, SUPERVISOR_FILE), "{oops", "utf-8");

    for (const toolName of [
      "supervisor_tick",
      "supervisor_record_event",
      "supervisor_abort_session",
    ]) {
      const payload = await call(handlers[toolName]!, {
        sessionId: "sx-test",
        eventType: "session.status.busy",
      });
      assert.equal(payload.reasonCode, "store_unavailable", `${toolName} surfaces the failure`);
    }
  });
});

// --- MCP-DEAD-2: the self test must be able to fail ------------------------

test("supervisor_run_self_test passes on a healthy store", async () => {
  await withTempHome(async () => {
    const { handlers } = captureTools();
    await seedSession(makeSession());

    const result = await call(handlers.supervisor_run_self_test!, {});
    assert.equal(result.status, "pass");
    const readable = result.checks.find((c: any) => c.name === "store.sessions.readable");
    assert.equal(readable.pass, true);
    assert.equal(readable.value, 1);
  });
});

test("supervisor_run_self_test fails when the store cannot be read", async () => {
  await withTempHome(async (homeDir) => {
    const { handlers } = captureTools();
    await writeFile(join(homeDir, SUPERVISOR_FILE), "{ truncated", "utf-8");

    const result = await call(handlers.supervisor_run_self_test!, {});
    assert.equal(result.status, "fail", "an unreadable store is not a passing self test");
    const readable = result.checks.find((c: any) => c.name === "store.sessions.readable");
    assert.equal(readable.pass, false);
  });
});

test("supervisor_run_self_test fails on a session record the supervisor cannot run on", async () => {
  await withTempHome(async (homeDir) => {
    const { handlers } = captureTools();
    await writeFile(
      join(homeDir, SUPERVISOR_FILE),
      JSON.stringify({
        version: 1,
        sessions: { "sx-broken": { sessionId: "sx-other", status: "running" } },
        hostModelFailures: {},
      }),
      "utf-8"
    );

    const result = await call(handlers.supervisor_run_self_test!, {});
    assert.equal(result.status, "fail");
    const wellFormed = result.checks.find((c: any) => c.name === "store.sessions.wellFormed");
    assert.equal(wellFormed.pass, false);
    assert.ok(String(wellFormed.value).includes("sx-broken"));
  });
});

test("findMalformedSessions and pruningRemovedEntries report exactly what changed", () => {
  const store = emptySupervisorStore();
  store.sessions["sx-ok"] = makeSession({ sessionId: "sx-ok" });
  assert.deepEqual(findMalformedSessions(store), []);

  store.sessions["sx-mismatch"] = makeSession({ sessionId: "sx-other" });
  store.sessions["sx-noevents"] = {
    ...makeSession({ sessionId: "sx-noevents" }),
    events: undefined as unknown as SupervisorSessionState["events"],
  };
  assert.deepEqual(findMalformedSessions(store), ["sx-mismatch", "sx-noevents"]);

  const pruned = emptySupervisorStore();
  pruned.sessions["sx-ok"] = store.sessions["sx-ok"]!;
  assert.equal(pruningRemovedEntries(store, pruned), true);
  assert.equal(pruningRemovedEntries(store, store), false);
});
