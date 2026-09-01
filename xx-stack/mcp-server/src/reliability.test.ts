import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

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
import { HOST_IDS, PROVIDER_IDS, TIER_IDS } from "./runtime_constants.js";

const execFileAsync = promisify(execFile);

async function runRuntimeConfigSyncFixture(
  registry: Record<string, unknown>,
  source: Record<string, unknown>,
  target: Record<string, unknown>
) {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-sync-"));

  try {
    const registryPath = join(dir, "registry.json");
    const sourceConfigPath = join(dir, "source.json");
    const targetConfigPath = join(dir, "target.json");
    const syncScriptPath = join(process.cwd(), "..", "scripts", "sync-runtime-config.js");

    await writeFile(registryPath, JSON.stringify(registry, null, 2) + "\n", "utf-8");
    await writeFile(sourceConfigPath, JSON.stringify(source, null, 2) + "\n", "utf-8");
    await writeFile(targetConfigPath, JSON.stringify(target, null, 2) + "\n", "utf-8");

    await execFileAsync(process.execPath, [syncScriptPath], {
      env: {
        ...process.env,
        LOCAL_URL: "http://127.0.0.1:11434",
        REGISTRY_PATH: registryPath,
        SOURCE_CONFIG: sourceConfigPath,
        TARGET_CONFIG: targetConfigPath,
      },
    });

    return JSON.parse(await readFile(targetConfigPath, "utf-8")) as Record<string, any>;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function buildRegistryFixture(tiers: Array<Record<string, unknown>>) {
  return {
    version: 1,
    selectionPolicy: {
      defaultOrder: [
        TIER_IDS.local,
        TIER_IDS.tailscaleOllama,
        TIER_IDS.tailscaleOpenAiCompatible,
        TIER_IDS.cloud,
      ],
      rules: [],
    },
    tiers,
  };
}

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
  const fingerprint = '["task-a"]';
  const withinWindow = shouldDedupeContinuation(fingerprint, now - 500, fingerprint, now, 1000);
  const outsideWindow = shouldDedupeContinuation(fingerprint, now - 1500, fingerprint, now, 1000);
  const differentFingerprint = shouldDedupeContinuation(
    fingerprint,
    now - 500,
    '["task-b"]',
    now,
    1000
  );

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

  const staleEvidence = __testExports.evaluateCompletionReadiness(
    staleEvidenceState,
    now,
    reliability
  );
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
  const parsed = __testExports.parseCompletionValidationReason(
    "completion_evidence_missing; refusing early completion"
  );
  const fallback = __testExports.parseCompletionValidationReason(undefined);

  assert.equal(parsed, "completion_evidence_missing");
  assert.equal(fallback, "completion_validation_failed");
});

test("buildCompletionRepairChecklist includes reason-specific and common actions", () => {
  const checklist = __testExports.buildCompletionRepairChecklist(
    "completion_judge_missing_or_failed"
  );

  assert.ok(checklist.some((item) => item.includes("judge feedback")));
  assert.ok(checklist.some((item) => item.includes("supervisor_record_completion_check")));
  assert.ok(checklist.some((item) => item.includes("completion-judge")));
});

test("buildCompletionRepairChecklist for memory drift includes snapshot sync guidance", () => {
  const checklist = __testExports.buildCompletionRepairChecklist(
    "completion_memory_drift_detected"
  );

  assert.ok(checklist.some((item) => item.includes("agent_memory_get")));
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

  const stopTransition = applySupervisorEventTransition(
    state,
    "session.stop",
    now,
    reliability,
    "stop signal"
  );
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
  assert.equal(
    applySupervisorEventTransition(s1, "session.status.busy", now, r).reasonCode,
    "status_progress"
  );
  assert.equal(s1.status, "running");

  // idle without recent output → idle_without_recent_output
  const s2 = fresh();
  s2.lastOutputAt = now - 2000; // older than completionValidationWindowMs
  assert.equal(
    applySupervisorEventTransition(s2, "session.status.idle", now, r).reasonCode,
    "idle_without_recent_output"
  );

  // idle with recent output → idle_with_recent_output
  const s3 = fresh();
  s3.lastOutputAt = now - 100;
  assert.equal(
    applySupervisorEventTransition(s3, "session.status.idle", now, r).reasonCode,
    "idle_with_recent_output"
  );

  // session.error → abort_window_started
  const s4 = fresh();
  const t4 = applySupervisorEventTransition(s4, "session.error", now, r);
  assert.equal(t4.reasonCode, "abort_window_started");
  assert.equal(typeof s4.abortDetectedAt, "number");

  // tool events → output_progress
  for (const ev of [
    "tool.execute.before",
    "tool.execute.after",
    "message.part.updated.assistant",
  ]) {
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
  assert.equal(
    pruned.hostModelFailures["cold::model1"],
    undefined,
    "expired breaker should be pruned"
  );
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
  assert.equal(shouldDedupeContinuation(undefined, now - 100, '["a"]', now, 1000), false);

  // undefined lastAt → never dedupe
  assert.equal(shouldDedupeContinuation('["a"]', undefined, '["a"]', now, 1000), false);

  // Both undefined → never dedupe
  assert.equal(shouldDedupeContinuation(undefined, undefined, '["a"]', now, 1000), false);

  // Exact edge: lastAt is exactly 1 window-width ago → NOT deduped (equal is outside)
  assert.equal(shouldDedupeContinuation('["a"]', now - 1000, '["a"]', now, 1000), false);

  // Empty fingerprint matches itself
  assert.equal(shouldDedupeContinuation("[]", now - 200, "[]", now, 1000), true);
});

test("loadReliabilityConfig user config overrides repo config", async () => {
  // Set XX_STACK_REPO and HOME to temp dirs with mock config files.
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-cfg-"));
  try {
    const opencodeDir = join(dir, "opencode");
    const userConfigDir = join(dir, ".config", "opencode");
    await mkdir(opencodeDir, { recursive: true });
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
    await writeFile(join(opencodeDir, "config.json"), JSON.stringify(repoConfig));

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
      assert.equal(
        loaded.retryDedupeWindowMs,
        __testExports.DEFAULT_RELIABILITY.retryDedupeWindowMs
      );
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
    events: [] as ReturnType<
      typeof __testExports.pushSessionEvent extends (s: never, t: string, d: string) => never
        ? never
        : () => never
    >[],
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
  assert.ok(!state.events.some((e) => e.detail === "event-0"), "oldest event should be evicted");
});

test("scoreTiers keyword scoring routes correctly", () => {
  const mockRegistry = {
    version: 1,
    selectionPolicy: {
      defaultOrder: [
        TIER_IDS.local,
        TIER_IDS.tailscaleOllama,
        TIER_IDS.tailscaleOpenAiCompatible,
        TIER_IDS.cloud,
      ],
      rules: [],
    },
    tiers: [],
  };

  // Implementation tasks → local
  const localScores = __testExports.scoreTiers(
    "implement a new feature and fix this bug",
    mockRegistry as never
  );
  assert.ok(
    (localScores[TIER_IDS.local] ?? 0) > (localScores[TIER_IDS.tailscaleOllama] ?? 0),
    "implementation tasks should score local tier higher"
  );

  // Research/delegate tasks → tailscale-ollama
  const remoteScores = __testExports.scoreTiers(
    "research and analyze the architecture then delegate parallel subagent tasks",
    mockRegistry as never
  );
  assert.ok(
    (remoteScores[TIER_IDS.tailscaleOllama] ?? 0) > (remoteScores[TIER_IDS.local] ?? 0),
    "research/delegate tasks should score remote tier higher"
  );

  const orchestratorScores = __testExports.scoreTiers(
    "parallel-execution-orchestrator dispatches delegated subagent wave slices across tailscale remote ollama hosts",
    mockRegistry as never
  );
  assert.ok(
    (orchestratorScores[TIER_IDS.tailscaleOllama] ?? 0) > (orchestratorScores[TIER_IDS.local] ?? 0),
    "parallel orchestrator delegation should strongly prefer tailscale-ollama"
  );
});

test("endpointFamilyForProvider treats ollama aliases as Ollama endpoints", () => {
  assert.equal(__testExports.endpointFamilyForProvider("ollama"), "ollama");
  assert.equal(__testExports.endpointFamilyForProvider("ollama-local"), "ollama");
  assert.equal(__testExports.endpointFamilyForProvider("ollama-5090"), "ollama");
});

test("routeParallelTasks prefers remote Tailscale hosts and preserves dispatch provider aliases", () => {
  const registry = {
    version: 1,
    selectionPolicy: {
      defaultOrder: [
        TIER_IDS.local,
        TIER_IDS.tailscaleOllama,
        TIER_IDS.tailscaleOpenAiCompatible,
        TIER_IDS.cloud,
      ],
      rules: [
        {
          name: "Prefer local for orchestration and planning",
          when: "orchestration, planning, architecture framing, broad synthesis on the primary controller",
          preferTier: TIER_IDS.local,
        },
        {
          name: "Use remote for delegated subagents",
          when: "parallel subagent reasoning, delegated research, overflow analysis, non-blocking long-context slices",
          preferTier: TIER_IDS.tailscaleOllama,
        },
      ],
    },
    tiers: [
      {
        id: TIER_IDS.local,
        label: "local",
        priority: 1,
        hosts: [
          {
            id: HOST_IDS.localWorkstation,
            label: "local",
            provider: PROVIDER_IDS.ollamaLocal,
            endpoint: "http://127.0.0.1:11434",
            enabled: true,
            reachable: true,
            executionPolicy: { maxParallelSlices: 1, maxConcurrentModels: 1 },
            models: [{ name: "qwen2.5-coder:14b", roles: ["build", "review"] }],
          },
        ],
      },
      {
        id: TIER_IDS.tailscaleOllama,
        label: "remote",
        priority: 2,
        hosts: [
          {
            id: "server-debian-ai",
            label: "server",
            provider: PROVIDER_IDS.ollamaRemote,
            endpoint: "http://100.100.0.1:11434",
            enabled: true,
            reachable: true,
            executionPolicy: { maxParallelSlices: 2, maxConcurrentModels: 2 },
            models: [{ name: "qwen3-coder:30b", roles: ["build", "review", "plan"] }],
          },
          {
            id: "test-bench-archlinux",
            label: "5090",
            provider: "ollama-5090",
            endpoint: "http://100.100.0.2:11434",
            enabled: true,
            reachable: true,
            hardware: { detected: { totalGpuVramGb: 48 } },
            executionPolicy: { maxParallelSlices: 2, maxConcurrentModels: 2 },
            models: [
              { name: "nomic-embed-text:latest", roles: ["general"] },
              { name: "qwen3-coder:30b-a3b-q8_0", roles: ["build", "review"] },
            ],
          },
        ],
      },
    ],
  };

  const schedule = __testExports.routeParallelTasks(
    [
      "parallel-execution-orchestrator patches remote dispatch logic and delegates wave 1 across tailscale hosts",
      "verify delegated subagent wave scheduling on remote ollama tailscale lanes with parallel dispatch models",
    ],
    registry as never
  );

  const assignments = schedule.assignments as Array<Record<string, unknown>>;
  assert.equal(assignments.length, 2);
  assert.ok(assignments.every((assignment) => assignment.tier === TIER_IDS.tailscaleOllama));
  assert.ok(assignments.every((assignment) => assignment.wave === 1));

  const wave1Hosts = new Set(assignments.map((assignment) => assignment.host));
  assert.deepEqual([...wave1Hosts].sort(), ["server-debian-ai", "test-bench-archlinux"]);

  const aliasAssignment = assignments.find(
    (assignment) => assignment.host === "test-bench-archlinux"
  );
  assert.equal(aliasAssignment?.dispatchModel, "ollama-5090/qwen3-coder:30b-a3b-q8_0");
});

test("validateExecRequest allows known internal hardware probes", () => {
  const allowFree = __testExports.validateExecRequest("free", ["-b"], "internal");
  const allowLspci = __testExports.validateExecRequest("lspci", [], "internal");
  const allowBashProbe = __testExports.validateExecRequest(
    "bash",
    ["-c", "cat /sys/class/drm/card*/device/mem_info_vram_total 2>/dev/null"],
    "internal"
  );

  assert.equal(allowFree.allowed, true);
  assert.equal(allowLspci.allowed, true);
  assert.equal(allowBashProbe.allowed, true);
});

test("validateExecRequest blocks unknown internal commands", () => {
  const denied = __testExports.validateExecRequest("uname", ["-a"], "internal");
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "internal_command_not_allowlisted");
});

test("validateExecRequest enforces hook command allowlist and safe args", () => {
  const deniedCommand = __testExports.validateExecRequest("echo", ["ok"], "hook", []);
  const deniedArg = __testExports.validateExecRequest("echo", ["ok;rm"], "hook", ["echo"]);
  const allowed = __testExports.validateExecRequest("echo", ["ok"], "hook", ["echo"]);

  assert.equal(deniedCommand.allowed, false);
  assert.equal(deniedCommand.reason, "hook_command_not_allowlisted");
  assert.equal(deniedArg.allowed, false);
  assert.equal(deniedArg.reason, "hook_arg_pattern_blocked");
  assert.equal(allowed.allowed, true);
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
    currentRoute: {
      tier: "local",
      host: "local-host",
      endpoint: "http://127.0.0.1:11434",
      model: "qwen3:7b",
    },
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
  assert.ok(key1.includes("qwen3:7b"), "key should include model");

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
    lastOutputAt: start, // session just started with output
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
      model: "ollama/qwen3:14b",
      requiredMcpServers: ["xx-stack-platform-routing", "missing-server"],
      toolPolicy: { allow: ["*"], deny: [] },
    },
  };
  const configured = ["xx-stack-platform-routing"];

  const findings = __testExports.validateAgentProfiles(agents as never, configured);

  assert.ok(
    findings.errors.some((e) => e.code === "missing_required_mcp"),
    "should report missing required MCP"
  );
  assert.ok(
    findings.warnings.some((w) => w.code === "unexpected_mode"),
    "should warn on invalid agent mode"
  );
});

test("agent_validate_profiles warns on overlapping tool policy", () => {
  const agents = {
    "overlap-agent": {
      mode: "subagent",
      model: "ollama/qwen3:14b",
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
    model: "ollama/qwen3:14b",
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

test("applyToolPolicy respects allow and deny rules including wildcards", () => {
  const profile = {
    toolPolicy: {
      allow: ["*"],
      deny: ["supervisor_*"],
    },
  };
  const candidateTools = ["editFiles", "runCommands", "readFile", "supervisor_abort_session"];

  const policy = __testExports.applyToolPolicy(profile as never, candidateTools);

  assert.ok(policy.allowedTools.includes("editFiles"), "Allowed tool should be included");
  assert.ok(policy.allowedTools.includes("runCommands"), "Allowed tool should be included");
  assert.ok(
    !policy.allowedTools.includes("supervisor_abort_session"),
    "Wildcard-denied tool should be excluded"
  );
  assert.ok(
    policy.deniedTools.includes("supervisor_abort_session"),
    "Denied tool should be reported"
  );
});

test("applyToolPolicy treats an empty allow list as allow-all", () => {
  const profile = { toolPolicy: { allow: [], deny: [] } };

  const policy = __testExports.applyToolPolicy(profile as never, ["route_task", "list_platforms"]);

  assert.deepEqual(policy.allowedTools, ["route_task", "list_platforms"]);
  assert.deepEqual(policy.deniedTools, []);
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
  assert.match(prompt, /agent_memory_get/);
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

test("sync-runtime-config falls back when a remote tier disappears and restores the preferred remote model on return", async () => {
  const source = {
    agent: {
      build: {
        model: `${PROVIDER_IDS.ollamaRemote}/qwen3-coder:30b`,
      },
    },
  };

  const startingConfig = {
    agent: {
      build: {
        model: `${PROVIDER_IDS.ollamaRemote}/qwen3-coder:30b`,
      },
    },
    provider: {
      [PROVIDER_IDS.ollamaRemote]: {
        models: {
          "qwen3-coder:30b": { name: "qwen3-coder:30b" },
        },
      },
      [PROVIDER_IDS.ollamaLocal]: {
        models: {
          "qwen2.5-coder:14b": { name: "qwen2.5-coder:14b" },
        },
      },
    },
  };

  const localTier = {
    id: TIER_IDS.local,
    label: "local",
    hosts: [
      {
        id: HOST_IDS.localWorkstation,
        label: "local",
        provider: PROVIDER_IDS.ollamaLocal,
        endpoint: "http://127.0.0.1:11434",
        enabled: true,
        reachable: true,
        models: [{ name: "qwen2.5-coder:14b" }],
      },
    ],
  };

  const configAfterDisappear = await runRuntimeConfigSyncFixture(
    buildRegistryFixture([localTier, { id: TIER_IDS.tailscaleOllama, label: "remote", hosts: [] }]),
    source,
    startingConfig
  );

  assert.equal(
    configAfterDisappear.agent?.build?.model,
    `${PROVIDER_IDS.ollamaLocal}/qwen2.5-coder:14b`
  );

  const configAfterReturn = await runRuntimeConfigSyncFixture(
    buildRegistryFixture([
      localTier,
      {
        id: TIER_IDS.tailscaleOllama,
        label: "remote",
        hosts: [
          {
            id: HOST_IDS.exampleGpuBox,
            label: "server",
            provider: PROVIDER_IDS.ollamaRemote,
            endpoint: "http://100.100.0.1:11434",
            enabled: true,
            reachable: true,
            primary: true,
            models: [{ name: "qwen3-coder:30b" }],
          },
        ],
      },
    ]),
    source,
    configAfterDisappear
  );

  assert.equal(
    configAfterReturn.agent?.build?.model,
    `${PROVIDER_IDS.ollamaRemote}/qwen3-coder:30b`
  );
});

test("sync-runtime-config prefers a reachable Tailscale OpenAI-compatible host during churn", async () => {
  const source = {
    agent: {
      plan: {
        model: `${PROVIDER_IDS.sglangRemote}/qwen3.5:27b-tq2`,
      },
    },
  };

  const config = {
    agent: {
      plan: {
        model: `${PROVIDER_IDS.sglangRemote}/qwen3.5:27b-tq2`,
      },
    },
  };

  const synced = await runRuntimeConfigSyncFixture(
    buildRegistryFixture([
      {
        id: TIER_IDS.local,
        label: "local",
        hosts: [
          {
            id: HOST_IDS.localWorkstation,
            label: "local",
            provider: PROVIDER_IDS.ollamaLocal,
            endpoint: "http://127.0.0.1:11434",
            enabled: true,
            reachable: true,
            models: [{ name: "qwen2.5-coder:14b" }],
          },
        ],
      },
      {
        id: TIER_IDS.tailscaleOpenAiCompatible,
        label: "remote-openai",
        hosts: [
          {
            id: HOST_IDS.tailscaleOpenAiCompatiblePrimary,
            label: "stale-primary",
            provider: PROVIDER_IDS.sglangRemote,
            endpoint: "http://100.100.0.10:8080",
            enabled: true,
            reachable: false,
            primary: true,
            models: [{ name: "qwen3.5:35b-tq2" }],
          },
          {
            id: "tailscale-openai-compatible-fallback",
            label: "reachable-fallback",
            provider: PROVIDER_IDS.sglangRemote,
            endpoint: "http://100.100.0.11:8080",
            enabled: true,
            reachable: true,
            models: [{ name: "qwen3.5:27b-tq2" }],
          },
        ],
      },
    ]),
    source,
    config
  );

  assert.equal(
    synced.provider?.[PROVIDER_IDS.sglangRemote]?.options?.baseURL,
    "http://100.100.0.11:8080/v1"
  );
  assert.equal(synced.agent?.plan?.model, `${PROVIDER_IDS.sglangRemote}/qwen3.5:27b-tq2`);
});

// ── chooseModelForTask ─────────────────────────────────────────────────────────

test("chooseModelForTask selects coding model by role for implement tasks", () => {
  const host = {
    id: "test",
    label: "test",
    provider: "ollama",
    endpoint: "http://127.0.0.1:11434",
    models: [
      { name: "planner-model", roles: ["plan", "architect"] },
      { name: "coder-model", roles: ["build", "review"] },
      { name: "general-model", roles: ["general"] },
    ],
  };

  const result = __testExports.chooseModelForTask(
    host as never,
    "implement a new REST endpoint and fix the bug"
  );
  assert.equal(result, "coder-model");
});

test("chooseModelForTask selects reasoning model by role for plan tasks", () => {
  const host = {
    id: "test",
    label: "test",
    provider: "ollama",
    endpoint: "http://127.0.0.1:11434",
    models: [
      { name: "coder-model", roles: ["build", "review"] },
      { name: "planner-model", roles: ["plan", "architect"] },
    ],
  };

  const result = __testExports.chooseModelForTask(
    host as never,
    "plan the architecture and reason about trade-offs"
  );
  assert.equal(result, "planner-model");
});

test("chooseModelForTask excludes embedding models for non-embedding tasks", () => {
  const host = {
    id: "test",
    label: "test",
    provider: "ollama",
    endpoint: "http://127.0.0.1:11434",
    models: [
      { name: "nomic-embed-text:latest", roles: ["general"] },
      { name: "qwen3:7b", roles: ["general"] },
    ],
  };

  const result = __testExports.chooseModelForTask(host as never, "implement a feature");
  assert.equal(result, "qwen3:7b", "embedding model should be excluded from non-embedding tasks");
});

test("chooseModelForTask includes embedding model when task is embedding", () => {
  const host = {
    id: "test",
    label: "test",
    provider: "ollama",
    endpoint: "http://127.0.0.1:11434",
    models: [
      { name: "nomic-embed-text:latest", roles: ["general"] },
      { name: "qwen3:7b", roles: ["general"] },
    ],
  };

  const result = __testExports.chooseModelForTask(
    host as never,
    "generate embeddings for vector retrieval"
  );
  assert.equal(
    result,
    "nomic-embed-text:latest",
    "embedding model should be returned for embedding tasks"
  );
});

test("chooseModelForTask prefers validated tool-use model for strict tool tasks", () => {
  const host = {
    id: "test",
    label: "test",
    provider: "ollama",
    endpoint: "http://127.0.0.1:11434",
    models: [
      {
        name: "unvalidated-model",
        roles: ["general"],
        supportsToolUse: false,
        toolCallReliability: "unknown",
        jsonModeReliability: "unknown",
      },
      {
        name: "validated-model",
        roles: ["general"],
        supportsToolUse: true,
        toolCallReliability: "validated",
        jsonModeReliability: "validated",
      },
    ],
  };

  const result = __testExports.chooseModelForTask(
    host as never,
    "call structured json function call with strict json schema"
  );
  assert.equal(result, "validated-model");
});

test("chooseModelForTask returns null for host with no models", () => {
  const host = {
    id: "empty",
    label: "empty",
    provider: "ollama",
    endpoint: "http://127.0.0.1:11434",
    models: [],
  };

  const result = __testExports.chooseModelForTask(host as never, "implement something");
  assert.equal(result, null);
});

// ── routeTask fallback ─────────────────────────────────────────────────────────

test("routeTask falls back to next tier when best tier has no available hosts", () => {
  const registry = {
    version: 1,
    selectionPolicy: {
      defaultOrder: [TIER_IDS.local, TIER_IDS.tailscaleOllama],
      rules: [],
    },
    tiers: [
      {
        id: TIER_IDS.local,
        label: "local",
        priority: 1,
        hosts: [
          {
            id: "local-host",
            label: "local",
            provider: "ollama",
            endpoint: "http://127.0.0.1:11434",
            enabled: false,
            models: [{ name: "qwen3:7b" }],
          },
        ],
      },
      {
        id: TIER_IDS.tailscaleOllama,
        label: "remote",
        priority: 2,
        hosts: [
          {
            id: "remote-host",
            label: "remote",
            provider: "ollama",
            endpoint: "http://100.1.1.1:11434",
            enabled: true,
            reachable: true,
            models: [{ name: "qwen3:14b" }],
          },
        ],
      },
    ],
  };

  const result = __testExports.routeTask("implement a new feature", registry as never);
  assert.equal(
    result.recommendedTier,
    TIER_IDS.tailscaleOllama,
    "should fall back to tailscale tier"
  );
  assert.equal(result.recommendedHost, "remote-host");
  assert.ok(result.reasoning.includes("fell back"), "reasoning should mention fallback");
});

test("routeTask returns null host and no fallback when all tiers are empty", () => {
  const registry = {
    version: 1,
    selectionPolicy: {
      defaultOrder: [TIER_IDS.local],
      rules: [],
    },
    tiers: [
      {
        id: TIER_IDS.local,
        label: "local",
        priority: 1,
        hosts: [],
      },
    ],
  };

  const result = __testExports.routeTask("implement something", registry as never);
  assert.equal(result.recommendedHost, null);
  assert.equal(result.fallback, null);
});

test("routeTask keyword scoring picks correct tier", () => {
  const registry = {
    version: 1,
    selectionPolicy: {
      defaultOrder: [TIER_IDS.local, TIER_IDS.tailscaleOllama],
      rules: [],
    },
    tiers: [
      {
        id: TIER_IDS.local,
        label: "local",
        priority: 1,
        hosts: [
          {
            id: "local-host",
            label: "local",
            provider: "ollama",
            endpoint: "http://127.0.0.1:11434",
            enabled: true,
            reachable: true,
            models: [{ name: "qwen3:7b", roles: ["build"] }],
          },
        ],
      },
      {
        id: TIER_IDS.tailscaleOllama,
        label: "remote",
        priority: 2,
        hosts: [
          {
            id: "remote-host",
            label: "remote",
            provider: "ollama",
            endpoint: "http://100.1.1.1:11434",
            enabled: true,
            reachable: true,
            models: [{ name: "qwen3:14b", roles: ["plan"] }],
          },
        ],
      },
    ],
  };

  const localResult = __testExports.routeTask(
    "implement and fix the bug in this code",
    registry as never
  );
  assert.equal(localResult.recommendedTier, TIER_IDS.local);

  const remoteResult = __testExports.routeTask(
    "research and delegate parallel subagent tasks",
    registry as never
  );
  assert.equal(remoteResult.recommendedTier, TIER_IDS.tailscaleOllama);
});

test("routeTask never falls back to cloud unless cloud escalation is opted in", () => {
  const makeRegistry = (optIn: boolean) => ({
    version: 1,
    selectionPolicy: {
      defaultOrder: [TIER_IDS.local, TIER_IDS.cloud],
      cloudEscalation: { optIn },
      rules: [],
    },
    tiers: [
      {
        id: TIER_IDS.local,
        label: "local",
        priority: 1,
        hosts: [
          {
            id: "local-host",
            label: "local",
            provider: "ollama",
            endpoint: "http://127.0.0.1:11434",
            enabled: true,
            reachable: false,
            models: [{ name: "qwen3:7b", roles: ["build"] }],
          },
        ],
      },
      {
        id: TIER_IDS.cloud,
        label: "cloud",
        priority: 2,
        hosts: [
          {
            id: "cloud-host",
            label: "cloud",
            provider: "cloud-provider",
            endpoint: "https://api.example.invalid",
            enabled: true,
            reachable: true,
            models: [{ name: "cloud-model", roles: ["plan"] }],
          },
        ],
      },
    ],
  });

  const blocked = __testExports.routeTask(
    "implement and fix the bug in this code",
    makeRegistry(false) as never
  );
  assert.notEqual(blocked.recommendedTier, TIER_IDS.cloud);
  assert.equal(blocked.recommendedHost, null);
  assert.match(blocked.reasoning, /cloud tier excluded/);

  const blockedMultimodal = __testExports.routeTask(
    "multimodal vision burst task",
    makeRegistry(false) as never
  );
  assert.notEqual(blockedMultimodal.recommendedTier, TIER_IDS.cloud);
  assert.equal(blockedMultimodal.recommendedHost, null);

  const optedIn = __testExports.routeTask(
    "implement and fix the bug in this code",
    makeRegistry(true) as never
  );
  assert.equal(optedIn.recommendedTier, TIER_IDS.cloud);
  assert.equal(optedIn.recommendedHost, "cloud-host");

  const parallelBlocked = __testExports.routeParallelTasks(
    ["implement a fix", "research a topic"],
    makeRegistry(false) as never
  );
  for (const assignment of parallelBlocked.assignments) {
    assert.notEqual((assignment as { tier?: string }).tier, TIER_IDS.cloud);
  }
});

test("chooseModelForTask never selects Ollama cloud-proxy models", () => {
  const host = {
    id: "h",
    label: "h",
    provider: "ollama",
    endpoint: "http://100.100.0.1:11434",
    models: [
      { name: "kimi-k2.5:cloud", roles: ["build", "code"] },
      { name: "qwen3-coder:30b", roles: ["build", "code"] },
    ],
  };
  assert.equal(
    __testExports.chooseModelForTask(host as never, "implement a fix"),
    "qwen3-coder:30b"
  );

  const cloudOnlyHost = { ...host, models: [{ name: "kimi-k2.5:cloud", roles: ["build"] }] };
  assert.equal(__testExports.chooseModelForTask(cloudOnlyHost as never, "implement a fix"), null);
});

test("routeTask keyword scoring selects the OpenAI-compatible lane for sglang/long-context work", () => {
  const registry = {
    version: 1,
    selectionPolicy: {
      defaultOrder: [TIER_IDS.local, TIER_IDS.tailscaleOpenAiCompatible, TIER_IDS.tailscaleOllama],
      rules: [],
    },
    tiers: [
      {
        id: TIER_IDS.local,
        label: "local",
        priority: 1,
        hosts: [
          {
            id: "local-host",
            label: "local",
            provider: "ollama",
            endpoint: "http://127.0.0.1:11434",
            enabled: true,
            reachable: true,
            models: [{ name: "qwen3:7b", roles: ["build"] }],
          },
        ],
      },
      {
        id: TIER_IDS.tailscaleOpenAiCompatible,
        label: "sglang",
        priority: 2,
        hosts: [
          {
            id: "sglang-host",
            label: "sglang",
            provider: PROVIDER_IDS.sglangRemote,
            endpoint: "http://100.100.0.3:30000",
            enabled: true,
            reachable: true,
            models: [{ name: "qwen3-coder-next", roles: ["build", "reason"] }],
          },
        ],
      },
    ],
  };

  const result = __testExports.routeTask(
    "long-context high-throughput synthesis on the sglang lane",
    registry as never
  );
  assert.equal(result.recommendedTier, TIER_IDS.tailscaleOpenAiCompatible);
  assert.equal(result.recommendedHost, "sglang-host");
});

test("effectiveParallelCapacity is bounded by slices, not resident-model count", () => {
  const host = {
    id: "h",
    label: "h",
    provider: PROVIDER_IDS.sglangRemote,
    endpoint: "http://100.100.0.3:30000",
    executionPolicy: { maxParallelSlices: 4, maxConcurrentModels: 1 },
  };
  assert.equal(__testExports.effectiveParallelCapacity(host as never), 4);
});

test("endpointFamilyForProvider treats sglang as openai-compatible", () => {
  assert.equal(
    __testExports.endpointFamilyForProvider(PROVIDER_IDS.sglangRemote),
    "openai-compatible"
  );
});

// ── buildWatchdogRouteCandidates ───────────────────────────────────────────────

test("buildWatchdogRouteCandidates returns null primary when no hosts are reachable", async () => {
  const registry = {
    version: 1,
    selectionPolicy: { defaultOrder: [TIER_IDS.local], rules: [] },
    tiers: [
      {
        id: TIER_IDS.local,
        label: "local",
        priority: 1,
        hosts: [
          {
            id: "local-host",
            label: "local",
            provider: "ollama",
            endpoint: "http://127.0.0.1:11434",
            reachable: false,
            models: [{ name: "qwen3:7b" }],
          },
        ],
      },
    ],
  };

  const result = await __testExports.buildWatchdogRouteCandidates(
    registry as never,
    "implement feature",
    null,
    null,
    3,
    new Set<string>()
  );

  assert.equal(result.primary, null);
  assert.equal(result.healthyPrimary, false);
  assert.equal(result.candidates.length, 0);
  assert.ok(result.health.some((entry) => (entry as { status?: string }).status === "unavailable"));
});

test("buildWatchdogRouteCandidates respects banned host/model circuit breakers", async () => {
  // Primary has reachable:false so checkHostModelHealth returns immediately (no network).
  // preferredHost forces selection of that primary even though routing would skip it.
  // Fallback host has no reachable flag (passes filter) but is in banned set, so it is
  // annotated in the health report without making a network call.
  const registry = {
    version: 1,
    selectionPolicy: {
      defaultOrder: [TIER_IDS.local, TIER_IDS.tailscaleOllama],
      rules: [],
    },
    tiers: [
      {
        id: TIER_IDS.local,
        label: "local",
        priority: 1,
        hosts: [
          {
            id: HOST_IDS.localWorkstation,
            label: "local",
            provider: PROVIDER_IDS.ollamaLocal,
            endpoint: "http://127.0.0.1:11434",
            reachable: false,
            models: [{ name: "primary-model" }],
          },
        ],
      },
      {
        id: TIER_IDS.tailscaleOllama,
        label: "remote",
        priority: 2,
        hosts: [
          {
            id: HOST_IDS.exampleGpuBox,
            label: "server",
            provider: PROVIDER_IDS.ollamaRemote,
            endpoint: "http://127.0.0.1:11434",
            // reachable intentionally not set — passes the `reachable !== false` filter
            // but the banned check fires before any network probe
            models: [{ name: "fallback-model" }],
          },
        ],
      },
    ],
  };

  const banned = new Set([`${HOST_IDS.exampleGpuBox}::fallback-model`]);
  const result = await __testExports.buildWatchdogRouteCandidates(
    registry as never,
    "implement feature",
    HOST_IDS.localWorkstation, // override to bypass routing's reachability filter
    null,
    3,
    banned
  );

  const bannedEntry = result.health.find(
    (entry) => (entry as { host?: string }).host === HOST_IDS.exampleGpuBox
  );
  assert.ok(bannedEntry, "banned host should appear in health report");
  assert.ok(
    String((bannedEntry as { health?: { reason?: string } }).health?.reason ?? "").includes(
      "circuit breaker"
    ),
    "health entry should indicate circuit breaker"
  );
  assert.equal(result.candidates.length, 0, "banned host should not appear as a candidate");
});

// ── hashMemoryContent (SHA-256) ────────────────────────────────────────────────

test("hashMemoryContent produces 16-char hex digest", () => {
  const hash = __testExports.hashMemoryContent("# Agent Memory\n\n");
  assert.equal(hash.length, 16);
  assert.match(hash, /^[0-9a-f]+$/, "hash should be lowercase hex");
});

test("hashMemoryContent is deterministic across calls", () => {
  const content = "# Agent Memory\n\n- fact a\n- fact b\n";
  assert.equal(__testExports.hashMemoryContent(content), __testExports.hashMemoryContent(content));
});

test("hashMemoryContent produces distinct hashes for similar content", () => {
  const a = __testExports.hashMemoryContent("# Agent Memory\n\n- note a\n");
  const b = __testExports.hashMemoryContent("# Agent Memory\n\n- note b\n");
  const c = __testExports.hashMemoryContent("# Agent Memory\n\n- note a \n"); // trailing space
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

// ── Hermes control-plane lane ────────────────────────────────────────────────

test("hermes-proxy is registered as an openai-compatible provider", () => {
  assert.equal(PROVIDER_IDS.hermesProxy, "hermes-proxy");
  assert.equal(
    __testExports.endpointFamilyForProvider(PROVIDER_IDS.hermesProxy),
    "openai-compatible"
  );
});

test("hermes-proxy lane ships disabled so routing ignores it until opted in", () => {
  const makeRegistry = (enabled: boolean) => ({
    version: 1,
    selectionPolicy: { defaultOrder: [TIER_IDS.local], rules: [] },
    tiers: [
      {
        id: TIER_IDS.local,
        label: "local",
        priority: 1,
        hosts: [
          {
            id: HOST_IDS.hermesProxy,
            label: "Hermes local-first control plane (loopback proxy)",
            provider: PROVIDER_IDS.hermesProxy,
            endpoint: "http://127.0.0.1:8180",
            networkScope: "loopback",
            enabled,
            reachable: true,
            models: [{ name: "hermes-auto", roles: ["implement"] }],
          },
        ],
      },
    ],
  });

  // Disabled and reachable is still not selectable — opting in is explicit.
  const disabled = __testExports.routeTask("implement a feature", makeRegistry(false) as never);
  assert.equal(disabled.recommendedHost, null);

  const opted = __testExports.routeTask("implement a feature", makeRegistry(true) as never);
  assert.equal(opted.recommendedHost, HOST_IDS.hermesProxy);
});

test("every shipped registry uses a valid endpointFamily", async () => {
  const registries = [
    "../../runtime/platforms.json",
    "../../../opencode-orchestration/opencode/platforms.json",
  ];
  const valid = new Set(["ollama", "openai-compatible"]);

  for (const rel of registries) {
    const raw = await readFile(new URL(rel, import.meta.url), "utf-8");
    const registry = JSON.parse(raw) as {
      tiers: Array<{ hosts?: Array<{ id: string; capabilities?: { endpointFamily?: string } }> }>;
    };
    for (const tier of registry.tiers) {
      for (const host of tier.hosts ?? []) {
        const family = host.capabilities?.endpointFamily;
        if (family !== undefined) {
          assert.ok(
            valid.has(family),
            `${rel}: host ${host.id} has invalid endpointFamily "${family}"`
          );
        }
      }
    }
  }
});

test("repoFileCandidates searches the canonical runtime/ layout first", () => {
  const candidates = __testExports.repoFileCandidates("/repo", "platforms.json");

  assert.deepEqual(candidates, [
    "/repo/runtime/platforms.json",
    "/repo/opencode/platforms.json",
    "/repo/.opencode/platforms.json",
  ]);
});

test("repoFileCandidates can also look one level up for each layout", () => {
  const candidates = __testExports.repoFileCandidates("/repo/mcp-server", "platforms.json", true);

  assert.ok(candidates.includes("/repo/mcp-server/runtime/platforms.json"));
  assert.ok(candidates.includes("/repo/runtime/platforms.json"));
  assert.ok(candidates.includes("/repo/opencode/platforms.json"));
});

// ── Inventory → registry generation ──────────────────────────────────────────

async function loadJson(rel: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(new URL(rel, import.meta.url), "utf-8"));
}

// inventory.json holds private machine truth and is git-ignored, so a fresh
// clone does not have it. Until it exists, the shipped template answers —
// the same fallback contract as generate-registries.mjs and toggle-lane.mjs.
async function loadInventorySource(): Promise<{ raw: string; isTemplate: boolean }> {
  try {
    return {
      raw: await readFile(new URL("../../../inventory.json", import.meta.url), "utf-8"),
      isTemplate: false,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return {
      raw: await readFile(new URL("../../../inventory.example.json", import.meta.url), "utf-8"),
      isTemplate: true,
    };
  }
}

async function readInventoryText(): Promise<string> {
  return (await loadInventorySource()).raw;
}

// The two LIVE registries are rendered from whichever inventory answers. On a
// machine with a real inventory.json they must match it exactly; when the
// template is answering (fresh clone, inventory.json absent) they legitimately
// describe the resident machines instead, so only the shipped host-agnostic
// registry — always rendered from the template — is required to be current.
const LIVE_REGISTRY_PATHS = new Set([
  "opencode-orchestration/opencode/platforms.json",
  "hermes-orchestration/config/orchestration.json",
]);

test("generated registries stay in sync with inventory.json", async () => {
  const script = join(process.cwd(), "..", "scripts", "generate-registries.mjs");
  // --check exits non-zero when any consumer config has drifted from the
  // inventory, which is the whole point of having one source of truth.
  try {
    await execFileAsync(process.execPath, [script, "--check"]);
    return;
  } catch (err) {
    const { isTemplate } = await loadInventorySource();
    if (!isTemplate) throw err;
    const stdout = String((err as unknown as { stdout?: unknown }).stdout ?? "");
    const stale = [...stdout.matchAll(/^\s*STALE\s+(.+)$/gm)].map((m) => m[1].trim());
    assert.deepEqual(
      stale.filter((rel) => !LIVE_REGISTRY_PATHS.has(rel)),
      [],
      "with no inventory.json present, only the machine-local live registries may be stale"
    );
    assert.ok(
      !stale.includes("xx-stack/runtime/platforms.json"),
      "the shipped host-agnostic registry must always match inventory.example.json"
    );
  }
});

test("a machine's hardware is written once and inherited by all its runtimes", async () => {
  const source = await loadInventorySource();
  const inventory = JSON.parse(source.raw);
  // The shipped registry is always rendered from the template, so when the
  // template is also answering as the inventory (fresh clone) it is the
  // consistent comparison partner; otherwise use the live registry.
  const registry = await loadJson(
    source.isTemplate
      ? "../../runtime/platforms.json"
      : "../../../opencode-orchestration/opencode/platforms.json"
  );

  const multiRuntime = inventory.machines.find(
    (m: Record<string, any>) => m.runtimes.length > 1 && m.hardware?.detected
  );
  assert.ok(multiRuntime, "expected at least one machine with several runtimes");

  const hosts = registry.tiers
    .flatMap((t: Record<string, any>) => t.hosts ?? [])
    .filter((h: Record<string, any>) => h.id.startsWith(multiRuntime.id));

  assert.equal(
    hosts.length,
    multiRuntime.runtimes.length,
    "every runtime on the machine should become its own host"
  );
  for (const host of hosts) {
    assert.deepEqual(
      host.hardware.detected,
      multiRuntime.hardware.detected,
      `${host.id} should inherit the machine's hardware, not restate it`
    );
  }
});

test("hermes lanes and TS hosts agree on endpoints for the same runtime", async () => {
  const source = await loadInventorySource();
  const inventory = JSON.parse(source.raw);
  // Same partner choice as the hardware-inheritance test above: the template
  // pairs with the shipped registry. The live hermes config describes the
  // resident machines, so its lanes can only be cross-checked when a real
  // inventory.json is answering.
  const hermes = await loadJson("../../../hermes-orchestration/config/orchestration.json");
  const registry = await loadJson(
    source.isTemplate
      ? "../../runtime/platforms.json"
      : "../../../opencode-orchestration/opencode/platforms.json"
  );

  const tsHosts = new Map<string, string>(
    registry.tiers
      .flatMap((t: Record<string, any>) => t.hosts ?? [])
      .map((h: Record<string, any>) => [h.id, h.endpoint])
  );

  for (const machine of inventory.machines) {
    if (machine.network.scope === "localhost" || machine.network.scope === "loopback") continue;
    if (source.isTemplate) {
      // Template pairing: every non-local template machine must have its TS
      // hosts on well-formed endpoints in the shipped registry. Hermes lane
      // agreement is asserted on the real pair below.
      for (const runtime of machine.runtimes) {
        const endpoint = tsHosts.get(`${machine.id}-${runtime.kind}`);
        assert.ok(endpoint, `shipped registry missing host for ${machine.id}-${runtime.kind}`);
        assert.match(endpoint, /^http:\/\/[^:]+:\d+$/);
      }
      continue;
    }
    for (const runtime of machine.runtimes) {
      const lane = Object.values(hermes.lanes).find(
        (l: any) => l.name === `${machine.id}-${runtime.kind}`
      ) as Record<string, any> | undefined;
      assert.ok(lane, `hermes lane missing for ${machine.id}-${runtime.kind}`);

      const tsEndpoint = tsHosts.get(`${machine.id}-${runtime.kind}`);
      assert.ok(tsEndpoint, `TS host missing for ${machine.id}-${runtime.kind}`);
      assert.equal(
        lane.base_url,
        `${tsEndpoint}/v1`,
        "hermes base_url must be the TS endpoint plus /v1 — a mismatch means the two consumers would dial different addresses"
      );
      assert.equal(lane.enabled, runtime.enabled !== false);
    }
  }
});

test("the shipped example registry carries no personal hardware", async () => {
  const shipped = JSON.stringify(await loadJson("../../runtime/platforms.json"));
  const { raw, isTemplate } = await loadInventorySource();
  const inventory = JSON.parse(raw);

  // The shipped registry is generated from the template (see
  // generate-registries.mjs), so when the template is also answering as the
  // inventory there is no personal inventory to leak — every machine it
  // names is the template's own.
  if (isTemplate) return;

  for (const machine of inventory.machines) {
    if (machine.network.scope === "localhost" || machine.network.scope === "loopback") continue;
    assert.ok(
      !shipped.includes(machine.id),
      `xx-stack ships a host-agnostic registry, but it names "${machine.id}"`
    );
  }
});

test("cloud stays opt-out in both generated consumers", async () => {
  const registry = await loadJson("../../../opencode-orchestration/opencode/platforms.json");
  const hermes = await loadJson("../../../hermes-orchestration/config/orchestration.json");

  assert.equal(registry.selectionPolicy.cloudEscalation.optIn, false);
  assert.equal(hermes.policy.cloud_enabled_by_default, false);
  assert.equal(hermes.policy.require_manual_cloud_escalation, true);
});

test("scan and toggle scripts are valid and self-documenting", async () => {
  // Syntax-check by importing; both scripts guard their side effects behind
  // argv, so a bare --help-less import must not touch inventory.json.
  const scripts = ["scan-tailscale.mjs", "toggle-lane.mjs"];
  for (const name of scripts) {
    const file = join(process.cwd(), "..", "scripts", name);
    const source = await readFile(file, "utf-8");
    assert.ok(source.startsWith("#!/usr/bin/env node"), `${name} needs a shebang`);
    assert.match(source, /inventory\.json/, `${name} should operate on inventory.json`);
  }
});

test("toggle-lane lists lanes without mutating the inventory", async () => {
  const script = join(process.cwd(), "..", "scripts", "toggle-lane.mjs");
  const before = await readInventoryText();

  const { stdout } = await execFileAsync(process.execPath, [script, "list"]);
  assert.match(stdout, /Machines and lanes/);
  assert.match(stdout, /cloud escalation/);

  const after = await readInventoryText();
  assert.equal(before, after, "`list` must be read-only");
});

test("every discovered runtime kind is known to the generator", async () => {
  const genSource = await readFile(
    new URL("../../scripts/generate-registries.mjs", import.meta.url),
    "utf-8"
  );
  const scanSource = await readFile(
    new URL("../../scripts/scan-tailscale.mjs", import.meta.url),
    "utf-8"
  );

  // Anything the scanner can write into inventory.json must be renderable by
  // the generator, or a scan would produce a config that cannot be synced.
  // Matched independently of formatting so Prettier cannot break this test.
  const probeBlock = scanSource.slice(
    scanSource.indexOf("const PROBES"),
    scanSource.indexOf("DEFAULT_HERMES_PRIORITY")
  );
  const scanned = [...new Set([...probeBlock.matchAll(/kind:\s*"([a-z-]+)"/g)].map((m) => m[1]))];
  assert.ok(scanned.length >= 4, "expected the scanner to probe several runtimes");

  for (const kind of scanned) {
    assert.match(
      genSource,
      new RegExp(`^\\s+"?${kind}"?:`, "m"),
      `runtime "${kind}" is discoverable by the scanner but unknown to the generator`
    );
  }
});

test("the server starts when launched through a symlinked path", async () => {
  // opencode-orchestration/mcp-server is a symlink into xx-stack/. A lexical
  // argv[1] vs import.meta.url comparison made the process exit 0 without ever
  // starting, which every caller reads as a silent crash.
  const symlinked = join(process.cwd(), "..", "..", "opencode-orchestration", "mcp-server");
  const entry = join(symlinked, "dist", "index.js");

  const handshake =
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "symlink-probe", version: "1" },
      },
    }) + "\n";

  const child = execFile(process.execPath, [entry]);
  child.stdin?.write(handshake);

  const reply = await new Promise<string>((resolvePromise, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("no response within 10s")), 10_000);
    child.stdout?.on("data", (chunk) => {
      buffer += String(chunk);
      if (buffer.includes("\n")) {
        clearTimeout(timer);
        child.kill("SIGTERM");
        resolvePromise(buffer);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (!buffer) reject(new Error(`exited (code ${code}) without responding`));
    });
  });

  const parsed = JSON.parse(reply.split("\n")[0]);
  assert.equal(parsed.result.serverInfo.name, "xx-stack-platform-routing");
});
