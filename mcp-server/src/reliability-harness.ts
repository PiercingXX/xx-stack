import {
  __testExports,
  atomicWriteTextFile,
  computeBackoffMs,
  emptySupervisorStore,
  pruneSupervisorStore,
  shouldAutoReleaseLock,
  shouldDedupeContinuation,
} from "./index.js";
import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";

const LOG_DIR = resolve(homedir(), ".config/xx-stack/xx-stack-logs");

type ScenarioResult = {
  name: string;
  passed: boolean;
  durationMs: number;
  details: Record<string, unknown>;
};

function readEnvNumber(name: string): number | null {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

async function writeHarnessLog(results: ScenarioResult[]): Promise<string | null> {
  try {
    await mkdir(LOG_DIR, { recursive: true });
    const timestamp = Date.now();
    const logPath = join(LOG_DIR, `harness-${timestamp}.jsonl`);
    const lines = results.map((r) =>
      JSON.stringify({
        at: new Date().toISOString(),
        type: "harness.scenario",
        scenario: r.name,
        passed: r.passed,
        durationMs: r.durationMs,
        details: r.details,
      })
    );
    const summary = {
      at: new Date().toISOString(),
      type: "harness.summary",
      passed: results.filter((r) => r.passed).length,
      total: results.length,
      successRate: results.length > 0 ? results.filter((r) => r.passed).length / results.length : 0,
    };
    lines.push(JSON.stringify(summary));
    await appendFile(logPath, lines.join("\n") + "\n", "utf-8");
    return logPath;
  } catch {
    return null;
  }
}

async function runHarness(): Promise<void> {
  const results: ScenarioResult[] = [];

  const reliability = {
    ...__testExports.DEFAULT_RELIABILITY,
    backoffInitialMs: 1000,
    backoffMaxMs: 4000,
    failureResetWindowMs: 10_000,
    staleSessionTtlMs: 10_000,
  };

  // ── Existing scenarios ──────────────────────────────────────────────────────

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
    const same = shouldDedupeContinuation("[\"a\"]", now - 500, "[\"a\"]", now, 1000);
    const changed = shouldDedupeContinuation("[\"a\"]", now - 500, "[\"b\"]", now, 1000);
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

  // ── New adversarial scenarios ───────────────────────────────────────────────

  {
    // recovery_timing_budget: verify worst-case recovery lag < 40s with tuned defaults
    const t0 = Date.now();
    const r = __testExports.DEFAULT_RELIABILITY;
    const worstCaseMs = r.progressTimeoutMs + r.abortWindowMs + r.retryDedupeWindowMs;
    const passed = worstCaseMs < 40_000;
    results.push({
      name: "recovery_timing_budget",
      passed,
      durationMs: Date.now() - t0,
      details: {
        progressTimeoutMs: r.progressTimeoutMs,
        abortWindowMs: r.abortWindowMs,
        retryDedupeWindowMs: r.retryDedupeWindowMs,
        worstCaseMs,
        budget: 40_000,
      },
    });
  }

  {
    // blocked_after_exhaustion: active breakers should be preserved; expired ones removed
    const t0 = Date.now();
    const now = Date.now();
    const r = { ...__testExports.DEFAULT_RELIABILITY, failureResetWindowMs: 5_000 };
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

    const pruned = pruneSupervisorStore(store, r);
    const passed = Boolean(pruned.hostModelFailures["live::model"])
      && !pruned.hostModelFailures["expired::model"];

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
    // breaker_reset_and_reuse: an expired breaker entry is stripped by pruning
    const t0 = Date.now();
    const now = Date.now();
    const r = { ...__testExports.DEFAULT_RELIABILITY, failureResetWindowMs: 2_000 };
    const store = emptySupervisorStore();

    store.hostModelFailures["old-host::model"] = {
      count: 3,
      lastFailureAt: now - 10_000,   // well past 2x failureResetWindowMs
      cooldownUntil: now - 8_000,    // cooldown also expired
    };

    const pruned = pruneSupervisorStore(store, r);
    const passed = !pruned.hostModelFailures["old-host::model"];

    results.push({
      name: "breaker_reset_and_reuse",
      passed,
      durationMs: Date.now() - t0,
      details: {
        breakerRemovedAfterReset: passed,
        lastFailureAge: 10_000,
        failureResetWindowMs: r.failureResetWindowMs,
      },
    });
  }

  {
    // recovery_inflight_autorelease: stale lock should be detected after grace period
    const t0 = Date.now();
    const now = Date.now();
    const gracePeriodMs = __testExports.DEFAULT_RELIABILITY.retryDedupeWindowMs * 3;

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
    // benchmark_efficiency_quality_gate: optional harness dimension for tokens-per-watt and quality drift
    const t0 = Date.now();
    const generatedTokens = readEnvNumber("XX_STACK_BENCH_GENERATED_TOKENS");
    const avgWatts = readEnvNumber("XX_STACK_BENCH_AVG_WATTS");
    const baselineQuality = readEnvNumber("XX_STACK_BENCH_BASELINE_QUALITY");
    const candidateQuality = readEnvNumber("XX_STACK_BENCH_CANDIDATE_QUALITY");

    const minTokensPerWatt = readEnvNumber("XX_STACK_MIN_TOKENS_PER_WATT") ?? 0;
    const maxQualityDriftNegative = readEnvNumber("XX_STACK_MAX_QUALITY_DRIFT_NEG") ?? 0.05;

    const tokensPerWatt = generatedTokens !== null && avgWatts !== null && avgWatts > 0
      ? generatedTokens / avgWatts
      : null;
    const qualityDrift = baselineQuality !== null && candidateQuality !== null
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
    // benchmark_local_catalog_vs_compatibility: optional same-hardware comparison for promotion evidence
    const t0 = Date.now();

    const localCatalogP50 = readEnvNumber("XX_STACK_LOCAL_CATALOG_P50_MS");
    const localCatalogP95 = readEnvNumber("XX_STACK_LOCAL_CATALOG_P95_MS");
    const localCatalogTokensPerSec = readEnvNumber("XX_STACK_LOCAL_CATALOG_TOKENS_PER_SEC");
    const localCatalogPeakVramGb = readEnvNumber("XX_STACK_LOCAL_CATALOG_PEAK_VRAM_GB");
    const localCatalogCorrectness = readEnvNumber("XX_STACK_LOCAL_CATALOG_CORRECTNESS_SCORE");

    const compatibilityP50 = readEnvNumber("XX_STACK_COMPATIBILITY_P50_MS");
    const compatibilityP95 = readEnvNumber("XX_STACK_COMPATIBILITY_P95_MS");
    const compatibilityTokensPerSec = readEnvNumber("XX_STACK_COMPATIBILITY_TOKENS_PER_SEC");
    const compatibilityPeakVramGb = readEnvNumber("XX_STACK_COMPATIBILITY_PEAK_VRAM_GB");
    const compatibilityCorrectness = readEnvNumber("XX_STACK_COMPATIBILITY_CORRECTNESS_SCORE");

    const maxP50RegressionRatio = readEnvNumber("XX_STACK_MAX_P50_REGRESSION_RATIO") ?? 1.15;
    const maxP95RegressionRatio = readEnvNumber("XX_STACK_MAX_P95_REGRESSION_RATIO") ?? 1.2;
    const minThroughputRatio = readEnvNumber("XX_STACK_MIN_THROUGHPUT_RATIO") ?? 0.9;
    const maxVramRatio = readEnvNumber("XX_STACK_MAX_VRAM_RATIO") ?? 1.25;
    const maxCorrectnessDrop = readEnvNumber("XX_STACK_MAX_CORRECTNESS_DROP") ?? 0.03;

    const hasAllData = [
      localCatalogP50,
      localCatalogP95,
      localCatalogTokensPerSec,
      localCatalogPeakVramGb,
      localCatalogCorrectness,
      compatibilityP50,
      compatibilityP95,
      compatibilityTokensPerSec,
      compatibilityPeakVramGb,
      compatibilityCorrectness,
    ].every((value) => typeof value === "number");

    let p50Ratio: number | null = null;
    let p95Ratio: number | null = null;
    let throughputRatio: number | null = null;
    let vramRatio: number | null = null;
    let correctnessDrop: number | null = null;

    if (hasAllData && localCatalogP50 && localCatalogP95 && localCatalogTokensPerSec && localCatalogPeakVramGb && localCatalogCorrectness !== null) {
      p50Ratio = (compatibilityP50 as number) / localCatalogP50;
      p95Ratio = (compatibilityP95 as number) / localCatalogP95;
      throughputRatio = (compatibilityTokensPerSec as number) / localCatalogTokensPerSec;
      vramRatio = (compatibilityPeakVramGb as number) / localCatalogPeakVramGb;
      correctnessDrop = (localCatalogCorrectness as number) - (compatibilityCorrectness as number);
    }

    const skipped = !hasAllData;
    const p50Pass = p50Ratio === null || p50Ratio <= maxP50RegressionRatio;
    const p95Pass = p95Ratio === null || p95Ratio <= maxP95RegressionRatio;
    const throughputPass = throughputRatio === null || throughputRatio >= minThroughputRatio;
    const vramPass = vramRatio === null || vramRatio <= maxVramRatio;
    const correctnessPass = correctnessDrop === null || correctnessDrop <= maxCorrectnessDrop;
    const passed = skipped || (p50Pass && p95Pass && throughputPass && vramPass && correctnessPass);

    results.push({
      name: "benchmark_local_catalog_vs_compatibility",
      passed,
      durationMs: Date.now() - t0,
      details: {
        skipped,
        localCatalogP50,
        localCatalogP95,
        localCatalogTokensPerSec,
        localCatalogPeakVramGb,
        localCatalogCorrectness,
        compatibilityP50,
        compatibilityP95,
        compatibilityTokensPerSec,
        compatibilityPeakVramGb,
        compatibilityCorrectness,
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

  // ── Report ──────────────────────────────────────────────────────────────────

  const passedCount = results.filter((r) => r.passed).length;
  const total = results.length;
  const recoverySuccessRate = total > 0 ? passedCount / total : 0;
  const benchmarkGate = results.find((r) => r.name === "benchmark_efficiency_quality_gate");
  const benchmarkTokensPerWattRaw = benchmarkGate?.details?.tokensPerWatt;
  const benchmarkQualityDriftRaw = benchmarkGate?.details?.qualityDrift;
  const benchmarkTokensPerWatt = typeof benchmarkTokensPerWattRaw === "number" ? benchmarkTokensPerWattRaw : null;
  const benchmarkQualityDrift = typeof benchmarkQualityDriftRaw === "number" ? benchmarkQualityDriftRaw : null;

  const thresholds = {
    minRecoverySuccessRate: 1.0,
    llamaCppPromotionMinTokensPerWatt: readEnvNumber("XX_STACK_PROMOTION_MIN_TOKENS_PER_WATT") ?? 0,
    llamaCppPromotionMaxQualityDriftNegative: readEnvNumber("XX_STACK_PROMOTION_MAX_QUALITY_DRIFT_NEG") ?? 0.05,
  };

  const thresholdPass = recoverySuccessRate >= thresholds.minRecoverySuccessRate;
  const promotionEfficiencyPass = benchmarkTokensPerWatt === null
    ? true
    : benchmarkTokensPerWatt >= thresholds.llamaCppPromotionMinTokensPerWatt;
  const promotionQualityPass = benchmarkQualityDrift === null
    ? true
    : benchmarkQualityDrift >= -thresholds.llamaCppPromotionMaxQualityDriftNegative;
  const llamaCppPromotionPass = thresholdPass && promotionEfficiencyPass && promotionQualityPass;
  const rollbackRecommended = !llamaCppPromotionPass;

  const logPath = await writeHarnessLog(results);

  const report = {
    status: thresholdPass ? "pass" : "fail",
    generatedAt: new Date().toISOString(),
    logWrittenTo: logPath ?? "(write failed)",
    metrics: {
      scenariosPassed: passedCount,
      scenariosTotal: total,
      recoverySuccessRate,
      benchmarkTokensPerWatt,
      benchmarkQualityDrift,
      promotionEfficiencyPass,
      promotionQualityPass,
      llamaCppPromotionPass,
      rollbackRecommended,
    },
    thresholds,
    scenarios: results,
  };

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exit(thresholdPass ? 0 : 1);
}

runHarness().catch((error) => {
  process.stderr.write(String(error) + "\n");
  process.exit(1);
});


