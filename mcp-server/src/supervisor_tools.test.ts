import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Registry } from "./platform_types.js";
import { emitContinuationPrompt } from "./supervisor_completion_tools.js";
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
  deps: SupervisorToolDeps;
}

function captureTools(reliability: Partial<ReliabilityConfig> = {}): Captured {
  const handlers: Record<string, Handler> = {};
  const fakeServer = {
    registerTool: (...args: unknown[]) => {
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
  return { handlers, writes: () => writeCount, deps };
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

test("supervisor_complete_session does not rewrite a terminal session", async () => {
  await withTempHome(async () => {
    const { handlers } = captureTools();
    for (const status of ["completed", "interrupted", "exhausted", "force_synthesized"] as const) {
      await seedSession(makeSession({ sessionId: `sx-${status}`, status }));
      const payload = await call(handlers.supervisor_complete_session!, {
        sessionId: `sx-${status}`,
        forceComplete: true,
        note: "should not land",
      });
      assert.equal(payload.status, "already_terminal", `${status} must not report a new outcome`);
      assert.equal(payload.reasonCode, "session_terminal");
      assert.equal(payload.priorStatus, status);

      const stored = (await readSupervisorStore()).sessions[`sx-${status}`]!;
      assert.equal(stored.status, status, "the terminal outcome survives the complete attempt");
      assert.equal(stored.events.length, 0, "no session.completed event on a finished record");
    }
  });
});

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

// --- "could not run" is not "failed" (goal-contract gate) -------------------
//
// xx-stack dispatches to heterogeneous machines: the lane that got the task is
// exactly the one most likely to be missing the toolchain. When a goal
// contract's validationCmd could not EXECUTE here, reading that as a failing
// validation tells the agent to fix code that is fine, spends the failure
// budget on a misdiagnosis, and can walk the session to `force_synthesized`
// over an environment problem.

const VALIDATION_CMD = "npm test -- --filter loader";

function contractTask(overrides: Partial<PersistentTask> = {}): PersistentTask {
  return {
    taskId: "tsk-contract",
    title: "loader migration",
    status: "in_progress",
    sessionId: "sx-test",
    goalContract: {
      objective: "Migrate the config loader",
      constraints: ["do not delete, skip, weaken, or narrow tests"],
      validationCmd: VALIDATION_CMD,
      stopCondition: "the loader suite passes",
    },
    tags: [],
    blockedBy: [],
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

/** A session that clears every completion gate ahead of the contract check. */
function completionReadySession(): SupervisorSessionState {
  const now = Date.now();
  return makeSession({
    lastOutputAt: now - 1_000,
    completionEvidenceAt: now - 500,
    completionEvidenceSummary: `verify_edit result for ${VALIDATION_CMD}: recorded`,
    completionJudgeAt: now - 100,
    completionJudgeVerdict: "pass",
  });
}

test("a validationCmd that could not run blocks completion as an environment problem, not a code failure", async () => {
  await withTempHome(async () => {
    const { handlers, deps } = captureTools();
    await seedSession(completionReadySession());

    const taskStore = emptyTaskStore();
    const task = contractTask();
    taskStore.tasks[task.taskId] = task;
    await writeTaskStore(taskStore);

    const blocked = await call(handlers.supervisor_complete_session!, {
      sessionId: "sx-test",
      outcome: "completed",
      validationAttempts: [
        {
          command: VALIDATION_CMD,
          outcome: "could_not_run",
          reasonCode: "deps_not_installed",
          remediation: "/repo has a package.json but no node_modules — run the install step.",
        },
      ],
    });

    // Neither a pass nor a code failure: a distinct blocker.
    assert.equal(blocked.status, "running", "an unrun validation never satisfies a stop condition");
    assert.equal(blocked.reasonCode, "validation_could_not_run");
    assert.notEqual(
      blocked.reasonCode,
      "goal_contract_validation_evidence_missing",
      "the evidence summary quoted the command; without the outcome this looked ready"
    );
    assert.equal(blocked.validationBlockers.length, 1);
    assert.equal(blocked.validationBlockers[0].reasonCode, "deps_not_installed");
    assert.ok(blocked.validationBlockers[0].remediation.includes("node_modules"));
    assert.ok(
      blocked.continuationDirective.includes("Validation could not execute on this lane"),
      "the directive must name the environment, not the code"
    );
    assert.ok(
      !/tests? (are |is )?failing/i.test(JSON.stringify(blocked)),
      "nothing in the response may claim the tests failed"
    );

    const persisted = await readSupervisorStore();
    const state = persisted.sessions["sx-test"]!;

    // The code-failure budget is untouched: no failure counted, and nothing
    // recorded on the `completion.validation_failed` channel.
    assert.equal(state.failureCount, 0, "an environment problem is not a code failure");
    assert.equal(state.lastFailureAt, undefined);
    assert.deepEqual(
      state.events.filter((event) => event.type === "completion.validation_failed"),
      [],
      "a could_not_run must not accumulate on the code-failure event channel"
    );
    assert.equal(
      state.events.filter((event) => event.type === "completion.validation_blocked").length,
      1,
      "it is recorded on its own channel instead"
    );

    // And the continuation prompt says so.
    const continuation = await call(
      async (args) =>
        emitContinuationPrompt(deps, args as { sessionId: string; remainingTasks?: string[] }),
      {
        sessionId: "sx-test",
        remainingTasks: ["finish the loader migration"],
      }
    );
    assert.equal(continuation.completionRecoveryReason, "validation_could_not_run");
    assert.ok(
      continuation.prompt.includes("Validation could not execute on this lane"),
      "the prompt must state the environment blocker"
    );
    assert.ok(
      continuation.prompt.includes("deps_not_installed"),
      "the prompt must carry the concrete reason"
    );
    // The remediation checklist is the environment one, not the code-repair
    // one — telling an agent to run the validationCmd and record its result is
    // exactly the instruction that misdiagnoses a missing toolchain.
    assert.ok(
      !continuation.remediationChecklist.some((item: string) =>
        item.startsWith("Run the goal contract's validationCmd through verify_edit")
      ),
      "the code-repair checklist is the wrong instruction when nothing was checked"
    );
    assert.ok(
      continuation.remediationChecklist[0].startsWith("Validation could not execute on this lane"),
      "the checklist leads with the environment blocker"
    );
    assert.ok(
      continuation.prompt.includes("not a code failure"),
      "the prompt must say outright that this is not a code failure"
    );
  });
});

test("a validationCmd that ran and failed still takes the ordinary code-failure path", async () => {
  await withTempHome(async () => {
    const { handlers } = captureTools();
    // Evidence that does NOT cite the command: the historical missing-evidence
    // branch must be untouched by the new classification.
    const session = completionReadySession();
    session.completionEvidenceSummary = "ran the linter, all clean";
    await seedSession(session);

    const taskStore = emptyTaskStore();
    const task = contractTask();
    taskStore.tasks[task.taskId] = task;
    await writeTaskStore(taskStore);

    const failed = await call(handlers.supervisor_complete_session!, {
      sessionId: "sx-test",
      outcome: "completed",
      validationAttempts: [{ command: VALIDATION_CMD, outcome: "fail" }],
    });

    assert.equal(failed.reasonCode, "goal_contract_validation_evidence_missing");
    const persisted = await readSupervisorStore();
    assert.equal(
      persisted.sessions["sx-test"]!.events.filter(
        (event) => event.type === "completion.validation_failed"
      ).length,
      1,
      "a genuine code failure still lands on the code-failure channel"
    );
  });
});

test("with no validationAttempts the goal-contract gate behaves exactly as before", async () => {
  await withTempHome(async () => {
    const { handlers } = captureTools();
    await seedSession(completionReadySession());

    const taskStore = emptyTaskStore();
    const task = contractTask();
    taskStore.tasks[task.taskId] = task;
    await writeTaskStore(taskStore);

    const completed = await call(handlers.supervisor_complete_session!, {
      sessionId: "sx-test",
      outcome: "completed",
    });
    assert.equal(completed.status, "completed");
    assert.equal(completed.reasonCode, "session_finalized");
    assert.equal(completed.goalContractCitations.length, 1);
    assert.equal(
      completed.goalContractCitations[0].stopConditionCitation,
      "stop-condition: the loader suite passes"
    );
  });
});
