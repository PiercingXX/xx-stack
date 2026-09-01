import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteTextFile } from "./io_runtime.js";
import {
  computeBackoffMs,
  DEFAULT_RELIABILITY,
  emptySupervisorStore,
  pruneSupervisorStore,
  shouldAutoReleaseLock,
  shouldDedupeContinuation,
} from "./supervisor_runtime.js";
import { readEnvNumber, type ScenarioResult } from "./reliability_harness_runtime.js";

export async function runHarnessScenarios(): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];

  const reliability = {
    ...DEFAULT_RELIABILITY,
    backoffInitialMs: 1000,
    backoffMaxMs: 4000,
    failureResetWindowMs: 10_000,
    staleSessionTtlMs: 10_000,
  };

  {
    const t0 = Date.now();
    const sequence = [1, 2, 3, 4, 5].map((n) => computeBackoffMs(reliability, n));
    const passed = sequence.join(",") === "1000,2000,4000,4000,4000";
    results.push({
      name: "timeout_recovery_backoff",
      passed,
      durationMs: Date.now() - t0,
      details: { sequence, expected: [1000, 2000, 4000, 4000, 4000] },
    });
  }

  {
    const t0 = Date.now();
    const now = Date.now();
    const store = emptySupervisorStore();
    store.sessions.active = {
      sessionId: "active",
      description: "active",
      status: "running",
      startedAt: now - 1000,
      lastProgressAt: now - 1000,
      attemptCount: 2,
      failureCount: 1,
      currentRoute: null,
      fallbackRoutes: [],
      nextFallbackIndex: 0,
      continuationCount: 0,
      events: [],
    };
    store.sessions.stale = {
      sessionId: "stale",
      description: "stale",
      status: "completed",
      startedAt: now - 25_000,
      lastProgressAt: now - 25_000,
      attemptCount: 1,
      failureCount: 0,
      currentRoute: null,
      fallbackRoutes: [],
      nextFallbackIndex: 0,
      continuationCount: 0,
      events: [],
    };

    const pruned = pruneSupervisorStore(store, reliability);
    const passed = Boolean(pruned.sessions.active) && !pruned.sessions.stale;
    results.push({
      name: "fallback_exhaustion_pruning_guard",
      passed,
      durationMs: Date.now() - t0,
      details: { kept: Object.keys(pruned.sessions), dropped: "stale" },
    });
  }

  {
    const t0 = Date.now();
    const now = Date.now();
    const same = shouldDedupeContinuation('["a"]', now - 500, '["a"]', now, 1000);
    const changed = shouldDedupeContinuation('["a"]', now - 500, '["b"]', now, 1000);
    const passed = same && !changed;
    results.push({
      name: "continuation_dedup",
      passed,
      durationMs: Date.now() - t0,
      details: { sameFingerprintWithinWindow: same, changedFingerprint: changed },
    });
  }

  {
    const t0 = Date.now();
    const dir = await mkdtemp(join(tmpdir(), "xx-stack-harness-"));
    try {
      const statePath = join(dir, "state.json");
      await atomicWriteTextFile(statePath, '{"ok":true}\n');
      const content = await readFile(statePath, "utf-8");
      const passed = content.trim() === '{"ok":true}';
      results.push({
        name: "atomic_state_write",
        passed,
        durationMs: Date.now() - t0,
        details: { bytes: content.length },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  {
    const t0 = Date.now();
    const runtime = DEFAULT_RELIABILITY;
    const worstCaseMs =
      runtime.progressTimeoutMs + runtime.abortWindowMs + runtime.retryDedupeWindowMs;
    const passed = worstCaseMs < 40_000;
    results.push({
      name: "recovery_timing_budget",
      passed,
      durationMs: Date.now() - t0,
      details: {
        progressTimeoutMs: runtime.progressTimeoutMs,
        abortWindowMs: runtime.abortWindowMs,
        retryDedupeWindowMs: runtime.retryDedupeWindowMs,
        worstCaseMs,
        budget: 40_000,
      },
    });
  }

  {
    const t0 = Date.now();
    const now = Date.now();
    const runtime = { ...DEFAULT_RELIABILITY, failureResetWindowMs: 5_000 };
    const store = emptySupervisorStore();

    store.hostModelFailures["live::model"] = {
      count: 2,
      lastFailureAt: now - 1_000,
      cooldownUntil: now + 60_000,
    };
    store.hostModelFailures["expired::model"] = {
      count: 2,
      lastFailureAt: now - 20_000,
      cooldownUntil: now - 1_000,
    };

    const pruned = pruneSupervisorStore(store, runtime);
    const passed =
      Boolean(pruned.hostModelFailures["live::model"]) &&
      !pruned.hostModelFailures["expired::model"];

    results.push({
      name: "blocked_after_exhaustion",
      passed,
      durationMs: Date.now() - t0,
      details: {
        activeBreakerKept: Boolean(pruned.hostModelFailures["live::model"]),
        expiredBreakerPruned: !pruned.hostModelFailures["expired::model"],
      },
    });
  }

  {
    const t0 = Date.now();
    const now = Date.now();
    const runtime = { ...DEFAULT_RELIABILITY, failureResetWindowMs: 2_000 };
    const store = emptySupervisorStore();

    store.hostModelFailures["old-host::model"] = {
      count: 3,
      lastFailureAt: now - 10_000,
      cooldownUntil: now - 8_000,
    };

    const pruned = pruneSupervisorStore(store, runtime);
    const passed = !pruned.hostModelFailures["old-host::model"];

    results.push({
      name: "breaker_reset_and_reuse",
      passed,
      durationMs: Date.now() - t0,
      details: {
        breakerRemovedAfterReset: passed,
        lastFailureAge: 10_000,
        failureResetWindowMs: runtime.failureResetWindowMs,
      },
    });
  }

  {
    const t0 = Date.now();
    const now = Date.now();
    const gracePeriodMs = DEFAULT_RELIABILITY.retryDedupeWindowMs * 3;

    const staleLock = shouldAutoReleaseLock(true, now - gracePeriodMs - 1, now, gracePeriodMs);
    const freshLock = shouldAutoReleaseLock(true, now - gracePeriodMs + 1000, now, gracePeriodMs);
    const noLock = shouldAutoReleaseLock(false, now - gracePeriodMs - 1, now, gracePeriodMs);

    const passed = staleLock && !freshLock && !noLock;
    results.push({
      name: "recovery_inflight_autorelease",
      passed,
      durationMs: Date.now() - t0,
      details: {
        staleLockReleased: staleLock,
        freshLockKept: !freshLock,
        falseNotReleased: !noLock,
        gracePeriodMs,
      },
    });
  }

  {
    const t0 = Date.now();
    const generatedTokens = readEnvNumber("XX_STACK_BENCH_GENERATED_TOKENS");
    const avgWatts = readEnvNumber("XX_STACK_BENCH_AVG_WATTS");
    const baselineQuality = readEnvNumber("XX_STACK_BENCH_BASELINE_QUALITY");
    const candidateQuality = readEnvNumber("XX_STACK_BENCH_CANDIDATE_QUALITY");

    const minTokensPerWatt = readEnvNumber("XX_STACK_MIN_TOKENS_PER_WATT") ?? 0;
    const maxQualityDriftNegative = readEnvNumber("XX_STACK_MAX_QUALITY_DRIFT_NEG") ?? 0.05;

    const tokensPerWatt =
      generatedTokens !== null && avgWatts !== null && avgWatts > 0
        ? generatedTokens / avgWatts
        : null;
    const qualityDrift =
      baselineQuality !== null && candidateQuality !== null
        ? candidateQuality - baselineQuality
        : null;

    const hasEfficiencyData = tokensPerWatt !== null;
    const hasQualityData = qualityDrift !== null;
    const skipped = !hasEfficiencyData && !hasQualityData;

    const efficiencyPass = !hasEfficiencyData || tokensPerWatt >= minTokensPerWatt;
    const qualityPass = !hasQualityData || qualityDrift >= -maxQualityDriftNegative;
    const passed = efficiencyPass && qualityPass;

    results.push({
      name: "benchmark_efficiency_quality_gate",
      passed,
      durationMs: Date.now() - t0,
      details: {
        skipped,
        generatedTokens,
        avgWatts,
        tokensPerWatt,
        minTokensPerWatt,
        baselineQuality,
        candidateQuality,
        qualityDrift,
        maxQualityDriftNegative,
        efficiencyPass,
        qualityPass,
      },
    });
  }

  {
    const t0 = Date.now();

    const ollamaP50 = readEnvNumber("XX_STACK_OLLAMA_P50_MS");
    const ollamaP95 = readEnvNumber("XX_STACK_OLLAMA_P95_MS");
    const ollamaTokensPerSec = readEnvNumber("XX_STACK_OLLAMA_TOKENS_PER_SEC");
    const ollamaPeakVramGb = readEnvNumber("XX_STACK_OLLAMA_PEAK_VRAM_GB");
    const ollamaCorrectness = readEnvNumber("XX_STACK_OLLAMA_CORRECTNESS_SCORE");

    const llamaP50 = readEnvNumber("XX_STACK_LLAMA_CPP_P50_MS");
    const llamaP95 = readEnvNumber("XX_STACK_LLAMA_CPP_P95_MS");
    const llamaTokensPerSec = readEnvNumber("XX_STACK_LLAMA_CPP_TOKENS_PER_SEC");
    const llamaPeakVramGb = readEnvNumber("XX_STACK_LLAMA_CPP_PEAK_VRAM_GB");
    const llamaCorrectness = readEnvNumber("XX_STACK_LLAMA_CPP_CORRECTNESS_SCORE");

    const maxP50RegressionRatio = readEnvNumber("XX_STACK_MAX_P50_REGRESSION_RATIO") ?? 1.15;
    const maxP95RegressionRatio = readEnvNumber("XX_STACK_MAX_P95_REGRESSION_RATIO") ?? 1.2;
    const minThroughputRatio = readEnvNumber("XX_STACK_MIN_THROUGHPUT_RATIO") ?? 0.9;
    const maxVramRatio = readEnvNumber("XX_STACK_MAX_VRAM_RATIO") ?? 1.25;
    const maxCorrectnessDrop = readEnvNumber("XX_STACK_MAX_CORRECTNESS_DROP") ?? 0.03;

    const hasAllData = [
      ollamaP50,
      ollamaP95,
      ollamaTokensPerSec,
      ollamaPeakVramGb,
      ollamaCorrectness,
      llamaP50,
      llamaP95,
      llamaTokensPerSec,
      llamaPeakVramGb,
      llamaCorrectness,
    ].every((value) => typeof value === "number");

    // The baseline values feed divisions, so each must be present AND
    // positive. A truthiness gate here once turned degenerate data (a zero or
    // missing denominator in an otherwise complete run) into a vacuous pass:
    // ratios stayed null and every `=== null` short-circuit reported true.
    const usableBaseline =
      hasAllData &&
      ollamaP50 !== null &&
      ollamaP50 > 0 &&
      ollamaP95 !== null &&
      ollamaP95 > 0 &&
      ollamaTokensPerSec !== null &&
      ollamaTokensPerSec > 0 &&
      ollamaPeakVramGb !== null &&
      ollamaPeakVramGb > 0;

    let p50Ratio: number | null = null;
    let p95Ratio: number | null = null;
    let throughputRatio: number | null = null;
    let vramRatio: number | null = null;
    let correctnessDrop: number | null = null;

    if (usableBaseline) {
      p50Ratio = (llamaP50 as number) / (ollamaP50 as number);
      p95Ratio = (llamaP95 as number) / (ollamaP95 as number);
      throughputRatio = (llamaTokensPerSec as number) / (ollamaTokensPerSec as number);
      vramRatio = (llamaPeakVramGb as number) / (ollamaPeakVramGb as number);
      correctnessDrop = (ollamaCorrectness as number) - (llamaCorrectness as number);
    }

    const skipped = !hasAllData;
    // Present but unusable is a FAILURE, not a skip: the run claimed to have
    // benchmark data and the data cannot answer the question it was asked.
    const degenerateBaseline = hasAllData && !usableBaseline;
    const p50Pass = p50Ratio === null || p50Ratio <= maxP50RegressionRatio;
    const p95Pass = p95Ratio === null || p95Ratio <= maxP95RegressionRatio;
    const throughputPass = throughputRatio === null || throughputRatio >= minThroughputRatio;
    const vramPass = vramRatio === null || vramRatio <= maxVramRatio;
    const correctnessPass = correctnessDrop === null || correctnessDrop <= maxCorrectnessDrop;
    const metricsPass = p50Pass && p95Pass && throughputPass && vramPass && correctnessPass;
    const passed = skipped ? true : degenerateBaseline ? false : metricsPass;

    results.push({
      name: "benchmark_ollama_vs_llama_cpp",
      passed,
      durationMs: Date.now() - t0,
      details: {
        skipped,
        degenerateBaseline,
        ollamaP50,
        ollamaP95,
        ollamaTokensPerSec,
        ollamaPeakVramGb,
        ollamaCorrectness,
        llamaP50,
        llamaP95,
        llamaTokensPerSec,
        llamaPeakVramGb,
        llamaCorrectness,
        p50Ratio,
        p95Ratio,
        throughputRatio,
        vramRatio,
        correctnessDrop,
        maxP50RegressionRatio,
        maxP95RegressionRatio,
        minThroughputRatio,
        maxVramRatio,
        maxCorrectnessDrop,
        p50Pass,
        p95Pass,
        throughputPass,
        vramPass,
        correctnessPass,
      },
    });
  }

  return results;
}
