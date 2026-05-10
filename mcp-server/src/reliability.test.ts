import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  __testExports,
  applySupervisorEventTransition,
  atomicWriteTextFile,
  computeBackoffMs,
  emptySupervisorStore,
  isAbortWindowActive,
  pruneSupervisorStore,
  shouldAutoReleaseLock,
  shouldRequireCompletionValidation,
  shouldDedupeContinuation,
} from "./index.js";

test("computeBackoffMs grows exponentially and caps", () => {
  const reliability = {
    ...__testExports.DEFAULT_RELIABILITY,
    backoffInitialMs: 1000,
    backoffMaxMs: 5000,
  };

  assert.equal(computeBackoffMs(reliability, 1), 1000);
  assert.equal(computeBackoffMs(reliability, 2), 2000);
  assert.equal(computeBackoffMs(reliability, 3), 4000);
  assert.equal(computeBackoffMs(reliability, 4), 5000);
  assert.equal(computeBackoffMs(reliability, 10), 5000);
});

test("pruneSupervisorStore removes stale completed sessions", () => {
  const now = Date.now();
  const reliability = {
    ...__testExports.DEFAULT_RELIABILITY,
    failureResetWindowMs: 10_000,
    staleSessionTtlMs: 10_000,
  };

  const store = emptySupervisorStore();
  store.sessions.fresh = {
    sessionId: "fresh",
    description: "fresh session",
    status: "completed",
    startedAt: now - 5_000,
    lastProgressAt: now - 5_000,
    attemptCount: 1,
    failureCount: 0,
    currentRoute: null,
    fallbackRoutes: [],
    nextFallbackIndex: 0,
    continuationCount: 0,
    events: [],
  };
  store.sessions.stale = {
    sessionId: "stale",
    description: "stale session",
    status: "completed",
    startedAt: now - 20_000,
    lastProgressAt: now - 20_000,
    attemptCount: 1,
    failureCount: 0,
    currentRoute: null,
    fallbackRoutes: [],
    nextFallbackIndex: 0,
    continuationCount: 0,
    events: [],
  };

  const pruned = pruneSupervisorStore(store, reliability);

  assert.ok(pruned.sessions.fresh);
  assert.equal(pruned.sessions.stale, undefined);
});

test("pruneSupervisorStore removes expired host/model failures", () => {
  const now = Date.now();
  const reliability = {
    ...__testExports.DEFAULT_RELIABILITY,
    failureResetWindowMs: 10_000,
  };

  const store = emptySupervisorStore();
  store.hostModelFailures["keep::model"] = {
    count: 2,
    lastFailureAt: now - 2_000,
    cooldownUntil: now + 2_000,
  };
  store.hostModelFailures["drop::model"] = {
    count: 1,
    lastFailureAt: now - 25_000,
  };

  const pruned = pruneSupervisorStore(store, reliability);

  assert.ok(pruned.hostModelFailures["keep::model"]);
  assert.equal(pruned.hostModelFailures["drop::model"], undefined);
});

test("atomicWriteTextFile writes final content without leftover temp files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-atomic-"));
  try {
    const filePath = join(dir, "state.json");
    await atomicWriteTextFile(filePath, '{"version":1}\n');

    const content = await readFile(filePath, "utf-8");
    const entries = await readdir(dir);

    assert.equal(content, '{"version":1}\n');
    assert.equal(entries.filter((name) => name.includes(".tmp-")).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shouldDedupeContinuation returns true for same fingerprint within window", () => {
  const now = Date.now();
  const fingerprint = "[\"task-a\"]";
  const withinWindow = shouldDedupeContinuation(fingerprint, now - 500, fingerprint, now, 1000);
  const outsideWindow = shouldDedupeContinuation(fingerprint, now - 1500, fingerprint, now, 1000);
  const differentFingerprint = shouldDedupeContinuation(fingerprint, now - 500, "[\"task-b\"]", now, 1000);

  assert.equal(withinWindow, true);
  assert.equal(outsideWindow, false);
  assert.equal(differentFingerprint, false);
});

test("isAbortWindowActive honors abort window", () => {
  const now = Date.now();
  assert.equal(isAbortWindowActive(now - 500, now, 1000), true);
  assert.equal(isAbortWindowActive(now - 1500, now, 1000), false);
  assert.equal(isAbortWindowActive(undefined, now, 1000), false);
});

test("shouldRequireCompletionValidation requires recent output", () => {
  const now = Date.now();
  assert.equal(shouldRequireCompletionValidation(now - 200, now, 1000), false);
  assert.equal(shouldRequireCompletionValidation(now - 1200, now, 1000), true);
  assert.equal(shouldRequireCompletionValidation(undefined, now, 1000), true);
});

test("evaluateCompletionReadiness requires evidence and judge pass", () => {
  const now = Date.now();
  const reliability = {
    ...__testExports.DEFAULT_RELIABILITY,
    completionValidationWindowMs: 1000,
  };

  const state = {
    sessionId: "s-ready",
    description: "ready",
    status: "running" as const,
    startedAt: now - 1000,
    lastProgressAt: now - 500,
    lastOutputAt: now - 200,
    completionEvidenceAt: now - 150,
    completionEvidenceSummary: "pytest and diff checks recorded",
    completionJudgeAt: now - 100,
    completionJudgeVerdict: "pass" as const,
    completionJudgeSummary: "qa-lead accepted all completion criteria",
    abortDetectedAt: undefined as number | undefined,
    pendingCompletionValidationAt: undefined as number | undefined,
    attemptCount: 1,
    failureCount: 0,
    currentRoute: null,
    fallbackRoutes: [] as never[],
    nextFallbackIndex: 0,
    continuationCount: 0,
    events: [] as never[],
  };

  const ready = __testExports.evaluateCompletionReadiness(state, now, reliability);
  assert.equal(ready.ok, true);
  assert.equal(ready.reasonCode, "completion_ready");
});

test("evaluateCompletionReadiness rejects missing judge or stale evidence", () => {
  const now = Date.now();
  const reliability = {
    ...__testExports.DEFAULT_RELIABILITY,
    completionValidationWindowMs: 1000,
  };

  const staleEvidenceState = {
    sessionId: "s-stale",
    description: "stale",
    status: "running" as const,
    startedAt: now - 2000,
    lastProgressAt: now - 500,
    lastOutputAt: now - 100,
    completionEvidenceAt: now - 300,
    completionEvidenceSummary: "old evidence",
    completionJudgeAt: now - 50,
    completionJudgeVerdict: "pass" as const,
    completionJudgeSummary: "pass",
    abortDetectedAt: undefined as number | undefined,
    pendingCompletionValidationAt: undefined as number | undefined,
    attemptCount: 1,
    failureCount: 0,
    currentRoute: null,
    fallbackRoutes: [] as never[],
    nextFallbackIndex: 0,
    continuationCount: 0,
    events: [] as never[],
  };

  const staleEvidence = __testExports.evaluateCompletionReadiness(staleEvidenceState, now, reliability);
  assert.equal(staleEvidence.ok, false);
  assert.equal(staleEvidence.reasonCode, "completion_evidence_stale");

  const noJudgeState = {
    ...staleEvidenceState,
    completionEvidenceAt: now - 50,
    completionJudgeAt: undefined,
    completionJudgeVerdict: undefined,
  };
  const noJudge = __testExports.evaluateCompletionReadiness(noJudgeState, now, reliability);
  assert.equal(noJudge.ok, false);
  assert.equal(noJudge.reasonCode, "completion_judge_missing_or_failed");
});

test("parseCompletionValidationReason extracts reason prefix", () => {
  const parsed = __testExports.parseCompletionValidationReason("completion_evidence_missing; refusing early completion");
  const fallback = __testExports.parseCompletionValidationReason(undefined);

  assert.equal(parsed, "completion_evidence_missing");
  assert.equal(fallback, "completion_validation_failed");
});

test("buildCompletionRepairChecklist includes reason-specific and common actions", () => {
  const checklist = __testExports.buildCompletionRepairChecklist("completion_judge_missing_or_failed");

  assert.ok(checklist.some((item) => item.includes("judge feedback")));
  assert.ok(checklist.some((item) => item.includes("supervisor_record_completion_check")));
  assert.ok(checklist.some((item) => item.includes("completion-judge")));
});

test("buildCompletionRepairChecklist for memory drift includes snapshot sync guidance", () => {
  const checklist = __testExports.buildCompletionRepairChecklist("completion_memory_drift_detected");

  assert.ok(checklist.some((item) => item.includes("agent_memory_snapshot_status")));
  assert.ok(checklist.some((item) => item.includes("agent_memory_snapshot_sync")));
  assert.ok(checklist.some((item) => item.includes("driftDetected=false")));
});

test("applySupervisorEventTransition sets abort and output transitions", () => {
  const now = Date.now();
  const reliability = {
    ...__testExports.DEFAULT_RELIABILITY,
    completionValidationWindowMs: 1000,
  };

  const state = {
    sessionId: "s1",
    description: "test",
    status: "running" as const,
    startedAt: now - 1000,
    lastProgressAt: now - 1000,
    lastOutputAt: undefined,
    abortDetectedAt: undefined,
    pendingCompletionValidationAt: undefined,
    attemptCount: 1,
    failureCount: 0,
    currentRoute: null,
    fallbackRoutes: [],
    nextFallbackIndex: 0,
    continuationCount: 0,
    events: [],
  };

  const stopTransition = applySupervisorEventTransition(state, "session.stop", now, reliability, "stop signal");
  assert.equal(stopTransition.reasonCode, "abort_window_started");
  assert.equal(typeof state.abortDetectedAt, "number");
  assert.equal(state.status, "cooldown");

  const outputTransition = applySupervisorEventTransition(
    state,
    "message.updated.assistant",
    now + 50,
    reliability,
    "assistant output"
  );
  assert.equal(outputTransition.reasonCode, "output_progress");
  assert.equal(state.abortDetectedAt, undefined);
  assert.equal(typeof state.lastOutputAt, "number");
  assert.equal(state.status, "running");
});

// ── New tests ──────────────────────────────────────────────────────────────────

test("computeBackoffMs sequence with production defaults", () => {
  const r = __testExports.DEFAULT_RELIABILITY;
  // failures 1-6 with default 2000ms initial / 60000ms cap
  const seq = [1, 2, 3, 4, 5, 6].map((n) => computeBackoffMs(r, n));
  assert.equal(seq[0], 2000);
  assert.equal(seq[1], 4000);
  assert.equal(seq[2], 8000);
  assert.equal(seq[3], 16000);
  assert.equal(seq[4], 32000);
  assert.equal(seq[5], 60000); // capped
});

test("applySupervisorEventTransition covers all event branches", () => {
  const now = Date.now();
  const r = { ...__testExports.DEFAULT_RELIABILITY, completionValidationWindowMs: 500 };

  const fresh = () => ({
    sessionId: "s2",
    description: "test",
    status: "running" as const,
    startedAt: now - 2000,
    lastProgressAt: now - 2000,
    lastOutputAt: undefined as number | undefined,
    abortDetectedAt: undefined as number | undefined,
    pendingCompletionValidationAt: undefined as number | undefined,
    attemptCount: 1,
    failureCount: 0,
    currentRoute: null,
    fallbackRoutes: [] as never[],
    nextFallbackIndex: 0,
    continuationCount: 0,
    events: [] as never[],
    recoveryInFlight: false,
  });

  // busy → status_progress
  const s1 = fresh();
  assert.equal(applySupervisorEventTransition(s1, "session.status.busy", now, r).reasonCode, "status_progress");
  assert.equal(s1.status, "running");

  // idle without recent output → idle_without_recent_output
  const s2 = fresh();
  s2.lastOutputAt = now - 2000; // older than completionValidationWindowMs
  assert.equal(applySupervisorEventTransition(s2, "session.status.idle", now, r).reasonCode, "idle_without_recent_output");

  // idle with recent output → idle_with_recent_output
  const s3 = fresh();
  s3.lastOutputAt = now - 100;
  assert.equal(applySupervisorEventTransition(s3, "session.status.idle", now, r).reasonCode, "idle_with_recent_output");

  // session.error → abort_window_started
  const s4 = fresh();
  const t4 = applySupervisorEventTransition(s4, "session.error", now, r);
  assert.equal(t4.reasonCode, "abort_window_started");
  assert.equal(typeof s4.abortDetectedAt, "number");

  // tool events → output_progress
  for (const ev of ["tool.execute.before", "tool.execute.after", "message.part.updated.assistant"]) {
    const s = fresh();
    assert.equal(applySupervisorEventTransition(s, ev, now, r).reasonCode, "output_progress");
  }
});

test("circuit breaker: open and reset via pruneSupervisorStore", () => {
  const now = Date.now();
  const r = { ...__testExports.DEFAULT_RELIABILITY, failureResetWindowMs: 5_000 };
  const store = emptySupervisorStore();

  // Breaker just opened: cooldown in the future, recent failure
  store.hostModelFailures["hot::model1"] = {
    count: 2,
    lastFailureAt: now - 1000,
    cooldownUntil: now + 60_000,
  };

  // Breaker expired: cooldown in the past, failure old enough to prune
  store.hostModelFailures["cold::model1"] = {
    count: 2,
    lastFailureAt: now - 11_000,
    cooldownUntil: now - 1_000,
  };

  const pruned = pruneSupervisorStore(store, r);
  assert.ok(pruned.hostModelFailures["hot::model1"], "active breaker should be kept");
  assert.equal(pruned.hostModelFailures["cold::model1"], undefined, "expired breaker should be pruned");
});

test("shouldAutoReleaseLock identifies stale lock correctly", () => {
  const now = Date.now();
  const gracePeriodMs = 12_000;

  // Lock set 5s ago — within grace period, should NOT release
  assert.equal(shouldAutoReleaseLock(true, now - 5_000, now, gracePeriodMs), false);

  // Lock set 15s ago — past grace period, should release
  assert.equal(shouldAutoReleaseLock(true, now - 15_000, now, gracePeriodMs), true);

  // Lock is false — nothing to release
  assert.equal(shouldAutoReleaseLock(false, now - 15_000, now, gracePeriodMs), false);

  // No lastRecoveryAt — cannot know when it was set, do NOT release
  assert.equal(shouldAutoReleaseLock(true, undefined, now, gracePeriodMs), false);
});

test("shouldDedupeContinuation edge cases", () => {
  const now = Date.now();

  // undefined lastFingerprint → never dedupe
  assert.equal(shouldDedupeContinuation(undefined, now - 100, "[\"a\"]", now, 1000), false);

  // undefined lastAt → never dedupe
  assert.equal(shouldDedupeContinuation("[\"a\"]", undefined, "[\"a\"]", now, 1000), false);

  // Both undefined → never dedupe
  assert.equal(shouldDedupeContinuation(undefined, undefined, "[\"a\"]", now, 1000), false);

  // Exact edge: lastAt is exactly 1 window-width ago → NOT deduped (equal is outside)
  assert.equal(shouldDedupeContinuation("[\"a\"]", now - 1000, "[\"a\"]", now, 1000), false);

  // Empty fingerprint matches itself
  assert.equal(shouldDedupeContinuation("[]", now - 200, "[]", now, 1000), true);
});

test("loadReliabilityConfig user config overrides repo config", async () => {
  // Set XX_STACK_REPO and HOME to temp dirs with mock config files.
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-cfg-"));
  try {
    const stackDir = join(dir, ".xx-stack");
    const userConfigDir = join(dir, ".config", "xx-stack");
    await mkdir(stackDir, { recursive: true });
    await mkdir(userConfigDir, { recursive: true });

    const repoConfig = {
      agent: {
        "execution-orchestrator": {
          reliability: {
            progressTimeoutMs: 11_111,
            abortWindowMs: 2_222,
            hardSessionTimeoutMs: 333_333,
          },
        },
      },
    };
    await writeFile(join(stackDir, "config.json"), JSON.stringify(repoConfig));

    const userConfig = {
      agent: {
        "execution-orchestrator": {
          reliability: {
            abortWindowMs: 4_444,
          },
        },
      },
    };
    await writeFile(join(userConfigDir, "config.json"), JSON.stringify(userConfig));

    // Temporarily point XX_STACK_REPO and HOME at the temp dir.
    const orig = process.env.XX_STACK_REPO;
    const origHome = process.env.HOME;
    process.env.XX_STACK_REPO = dir;
    process.env.HOME = dir;
    try {
      const loaded = await __testExports.loadReliabilityConfig();

      // Repo config is loaded.
      assert.equal(loaded.progressTimeoutMs, 11_111);
      assert.equal(loaded.hardSessionTimeoutMs, 333_333);

      // User config overrides repo config.
      assert.equal(loaded.abortWindowMs, 4_444);

      // Fields not set in either config use defaults.
      assert.equal(loaded.retryDedupeWindowMs, __testExports.DEFAULT_RELIABILITY.retryDedupeWindowMs);
    } finally {
      if (orig === undefined) {
        delete process.env.XX_STACK_REPO;
      } else {
        process.env.XX_STACK_REPO = orig;
      }

      if (origHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = origHome;
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session event buffer evicts oldest at 64 entries", () => {
  const now = Date.now();
  const state = {
    sessionId: "buf-test",
    description: "buffer overflow test",
    status: "running" as const,
    startedAt: now,
    lastProgressAt: now,
    attemptCount: 1,
    failureCount: 0,
    currentRoute: null,
    fallbackRoutes: [] as never[],
    nextFallbackIndex: 0,
    continuationCount: 0,
    events: [] as ReturnType<typeof __testExports.pushSessionEvent extends (s: never, t: string, d: string) => never ? never : () => never>[],
  } as Parameters<typeof __testExports.pushSessionEvent>[0];

  for (let i = 0; i < 65; i++) {
    __testExports.pushSessionEvent(state, "test.event", `event-${i}`);
  }

  assert.equal(state.events.length, 64, "buffer should be capped at 64");
  // Oldest (event-0) should have been evicted; newest (event-64) should be present
  assert.ok(
    state.events.some((e) => e.detail === "event-64"),
    "newest event should be retained"
  );
  assert.ok(
    !state.events.some((e) => e.detail === "event-0"),
    "oldest event should be evicted"
  );
});

test("scoreTiers keyword scoring routes correctly", () => {
  const mockRegistry = {
    version: 1,
    selectionPolicy: { defaultOrder: ["primary", "reasoning", "local", "overflow", "compatibility", "cloud"], rules: [] },
    tiers: [],
  };

  // Implementation tasks → primary execution lane
  const localScores = __testExports.scoreTiers("implement a new feature and fix this bug", mockRegistry as never);
  assert.ok(
    (localScores["primary"] ?? 0) > (localScores["local"] ?? 0),
    "implementation tasks should score the primary lane higher than local fallback"
  );

  // Architecture and long-context tasks → reasoning lane
  const remoteScores = __testExports.scoreTiers("research and analyze the architecture with long-context synthesis", mockRegistry as never);
  assert.ok(
    (remoteScores["reasoning"] ?? 0) > (remoteScores["primary"] ?? 0),
    "architecture and long-context tasks should score the reasoning lane higher than the main implementation lane"
  );

  const overflowScores = __testExports.scoreTiers("delegate parallel overflow subagent work", mockRegistry as never);
  assert.ok(
    (overflowScores["overflow"] ?? 0) > (overflowScores["local"] ?? 0),
    "overflow subagent tasks should still prefer the overflow fallback tier"
  );
});

test("makeRecoveryKey produces consistent dedup keys", () => {
  const state = {
    sessionId: "dedup-test",
    description: "test",
    status: "running" as const,
    startedAt: Date.now(),
    lastProgressAt: Date.now(),
    attemptCount: 2,
    failureCount: 1,
    currentRoute: { tier: "local", host: "local-host", endpoint: "http://local-agent.example.invalid", model: "coder-fast" },
    fallbackRoutes: [],
    nextFallbackIndex: 0,
    continuationCount: 0,
    events: [],
  } as Parameters<typeof __testExports.makeRecoveryKey>[0];

  const key1 = __testExports.makeRecoveryKey(state);
  const key2 = __testExports.makeRecoveryKey(state);

  assert.equal(key1, key2, "same state should produce same recovery key");
  assert.ok(key1.includes("dedup-test"), "key should include sessionId");
  assert.ok(key1.includes("local-host"), "key should include host");
  assert.ok(key1.includes("coder-fast"), "key should include model");

  // Changing failure count changes the key
  const stateModified = { ...state, failureCount: 2 };
  const keyModified = __testExports.makeRecoveryKey(stateModified);
  assert.notEqual(key1, keyModified, "different failureCount should produce different key");
});

test("applySupervisorEventTransition full event lifecycle simulation", () => {
  const start = Date.now();
  const r = { ...__testExports.DEFAULT_RELIABILITY, completionValidationWindowMs: 1000 };

  const state = {
    sessionId: "lifecycle-test",
    description: "lifecycle simulation",
    status: "running" as const,
    startedAt: start,
    lastProgressAt: start,
    lastOutputAt: start,              // session just started with output
    abortDetectedAt: undefined as number | undefined,
    pendingCompletionValidationAt: undefined as number | undefined,
    attemptCount: 1,
    failureCount: 0,
    currentRoute: null,
    fallbackRoutes: [] as never[],
    nextFallbackIndex: 0,
    continuationCount: 0,
    events: [] as never[],
    recoveryInFlight: false,
  };

  // Step 1: agent becomes busy
  let t = applySupervisorEventTransition(state, "session.status.busy", start + 100, r);
  assert.equal(t.reasonCode, "status_progress");
  assert.equal(state.status, "running");

  // Step 2: agent produces output
  t = applySupervisorEventTransition(state, "tool.execute.after", start + 2000, r);
  assert.equal(t.reasonCode, "output_progress");
  assert.equal(typeof state.lastOutputAt, "number");

  // Step 3: session stops unexpectedly → abort window opens
  t = applySupervisorEventTransition(state, "session.stop", start + 3000, r);
  assert.equal(t.reasonCode, "abort_window_started");
  assert.equal(state.status, "cooldown");
  assert.equal(typeof state.abortDetectedAt, "number");

  // Step 4: recovery produces new output → abort window clears
  t = applySupervisorEventTransition(state, "message.updated.assistant", start + 4000, r);
  assert.equal(t.reasonCode, "output_progress");
  assert.equal(state.abortDetectedAt, undefined);
  assert.equal(state.status, "running");

  // Step 5: agent goes idle with recent output → no validation required
  t = applySupervisorEventTransition(state, "session.status.idle", start + 4500, r);
  assert.equal(t.reasonCode, "idle_with_recent_output");
  assert.equal(state.events.length > 0, true);
});

test("agent_validate_profiles reports invalid mode and missing MCP", () => {
  const agents = {
    "bad-agent": {
      mode: "worker",
      model: "local-catalog-api/coder-main",
      requiredMcpServers: ["xx-stack-platform-routing", "missing-server"],
      toolPolicy: { allow: ["*"], deny: [] },
    },
  };
  const configured = ["xx-stack-platform-routing"];

  const findings = __testExports.validateAgentProfiles(agents as never, configured);

  assert.ok(findings.errors.some((e) => e.code === "missing_required_mcp"), "should report missing required MCP");
  assert.ok(findings.warnings.some((w) => w.code === "unexpected_mode"), "should warn on invalid agent mode");
});

test("agent_validate_profiles warns on overlapping tool policy", () => {
  const agents = {
    "overlap-agent": {
      mode: "subagent",
      model: "self-hosted-api/coder-main",
      requiredMcpServers: [],
      toolPolicy: { allow: ["route_*", "task_*"], deny: ["task_*"] },
    },
  };

  const findings = __testExports.validateAgentProfiles(agents as never, []);
  assert.ok(findings.warnings.some((w) => w.code === "overlapping_tool_rules"));
});

test("async-safe filtering strips blocked tools from preflight/filter policy", () => {
  const profile = {
    mode: "subagent",
    model: "self-hosted-api/coder-main",
    toolPolicy: { allow: ["*"], deny: [] },
  };

  const candidateTools = [
    "route_task",
    "supervisor_abort_session",
    "task_suspend",
    "task_resume",
    "list_platforms",
  ];

  const basePolicy = __testExports.applyToolPolicy(profile as never, candidateTools);
  const asyncPolicy = __testExports.applyAsyncToolSafety(basePolicy);

  assert.ok(asyncPolicy.allowedTools.includes("route_task"));
  assert.ok(asyncPolicy.allowedTools.includes("list_platforms"));
  assert.ok(!asyncPolicy.allowedTools.includes("supervisor_abort_session"));
  assert.ok(!asyncPolicy.allowedTools.includes("task_suspend"));
  assert.ok(!asyncPolicy.allowedTools.includes("task_resume"));
  assert.ok(asyncPolicy.deniedTools.includes("supervisor_abort_session"));
});

test("memory snapshot drift hash detects mismatch", () => {
  const memory = "# Agent Memory\n\n- note a\n";
  const snapshot = "# Agent Memory\n\n- note b\n";
  const memoryHash = __testExports.hashMemoryContent(memory);
  const snapshotHash = __testExports.hashMemoryContent(snapshot);
  assert.notEqual(memoryHash, snapshotHash, "hashes should differ for drifted snapshot");
});

test("lineDiffSummary returns added/removed/changed counts for drifted memory", () => {
  const snapshot = "# Agent Memory\n\n- note a\n- note b\n";
  const memory = "# Agent Memory\n\n- note a\n- note c\n";
  const diff = __testExports.lineDiffSummary(snapshot, memory);

  assert.deepEqual(diff, {
    added: 1,
    removed: 1,
    changed: 1,
  });
});

test("buildMemoryResyncHelperPrompt includes sync guidance and tool names", () => {
  const prompt = __testExports.buildMemoryResyncHelperPrompt("execution-orchestrator", "project", {
    added: 2,
    removed: 1,
    changed: 1,
  });

  assert.match(prompt, /agent_memory_snapshot_sync/);
  assert.match(prompt, /direction='capture'/);
  assert.match(prompt, /direction='apply'/);
  assert.match(prompt, /agent_memory_snapshot_status/);
});

test("readSnapshotMeta returns null for malformed metadata file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-meta-"));
  try {
    const metaPath = join(dir, ".snapshot-meta.json");
    await writeFile(metaPath, "{ malformed-json", "utf-8");
    const parsed = await __testExports.readSnapshotMeta(metaPath);
    assert.equal(parsed, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("execution-orchestrator prompts require accountable completion across surfaces", async () => {
  const repoRoot = resolve(process.cwd(), "..");
  const runtimePath = join(repoRoot, "runtime", "agents", "execution-orchestrator.md");
  const adapterPath = join(repoRoot, "adapters", "agents", "execution-orchestrator.agent.md");

  const [runtimePrompt, adapterPrompt] = await Promise.all([
    readFile(runtimePath, "utf-8"),
    readFile(adapterPath, "utf-8"),
  ]);

  for (const prompt of [runtimePrompt, adapterPrompt]) {
    assert.match(prompt, /Accountable Delegation \(default\)/);
    assert.match(prompt, /completion-judge/);
    assert.match(prompt, /supervisor_start_session/);
    assert.match(prompt, /supervisor_record_completion_check/);
    assert.doesNotMatch(prompt, /This agent exits the loop/);
    assert.doesNotMatch(prompt, /always prefer Handoff/);
    assert.doesNotMatch(prompt, /end the response/);
  }
});

test("shared instructions default to accountable delegation instead of transfer-and-exit", async () => {
  const repoRoot = resolve(process.cwd(), "..");
  const sharedPath = join(repoRoot, "runtime", "shared_instructions.md");
  const shared = await readFile(sharedPath, "utf-8");

  assert.match(shared, /Accountable Delegation \(default\)/);
  assert.match(shared, /do not assume host-level agent transfer preserves execution state/i);
  assert.doesNotMatch(shared, /routing agent exits the loop/);
  assert.doesNotMatch(shared, /always use Handoff/);
});

test("specialist prompts prefer accountable delegation over automatic transfer", async () => {
  const repoRoot = resolve(process.cwd(), "..");
  const specialistPaths = [
    join(repoRoot, "runtime", "agents", "plan.md"),
    join(repoRoot, "runtime", "agents", "fast-build.md"),
    join(repoRoot, "runtime", "agents", "release-manager.md"),
    join(repoRoot, "runtime", "agents", "incident-commander.md"),
  ];

  const prompts = await Promise.all(specialistPaths.map((filePath) => readFile(filePath, "utf-8")));

  for (const prompt of prompts) {
    assert.match(prompt, /Use accountable delegation/i);
    assert.match(prompt, /Only use true handoff/i);
    assert.doesNotMatch(prompt, /Transfer automatically/);
  }
});
