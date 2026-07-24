import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const LOG_DIR = resolve(homedir(), ".config/opencode/xx-stack-logs");

export type ScenarioResult = {
  name: string;
  passed: boolean;
  durationMs: number;
  details: Record<string, unknown>;
};

export function readEnvNumber(name: string): number | null {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function writeHarnessLog(results: ScenarioResult[]): Promise<string | null> {
  try {
    await mkdir(LOG_DIR, { recursive: true });
    const timestamp = Date.now();
    const logPath = join(LOG_DIR, `harness-${timestamp}.jsonl`);
    const lines = results.map((result) =>
      JSON.stringify({
        at: new Date().toISOString(),
        type: "harness.scenario",
        scenario: result.name,
        passed: result.passed,
        durationMs: result.durationMs,
        details: result.details,
      })
    );
    const summary = {
      at: new Date().toISOString(),
      type: "harness.summary",
      passed: results.filter((result) => result.passed).length,
      total: results.length,
      successRate:
        results.length > 0 ? results.filter((result) => result.passed).length / results.length : 0,
    };
    lines.push(JSON.stringify(summary));
    await appendFile(logPath, lines.join("\n") + "\n", "utf-8");
    return logPath;
  } catch {
    return null;
  }
}

export function buildHarnessReport(
  results: ScenarioResult[],
  logPath: string | null
): {
  report: Record<string, unknown>;
  exitCode: number;
} {
  const passedCount = results.filter((result) => result.passed).length;
  const total = results.length;
  const recoverySuccessRate = total > 0 ? passedCount / total : 0;
  const benchmarkGate = results.find(
    (result) => result.name === "benchmark_efficiency_quality_gate"
  );
  const benchmarkTokensPerWattRaw = benchmarkGate?.details?.tokensPerWatt;
  const benchmarkQualityDriftRaw = benchmarkGate?.details?.qualityDrift;
  const benchmarkTokensPerWatt =
    typeof benchmarkTokensPerWattRaw === "number" ? benchmarkTokensPerWattRaw : null;
  const benchmarkQualityDrift =
    typeof benchmarkQualityDriftRaw === "number" ? benchmarkQualityDriftRaw : null;

  const thresholds = {
    minRecoverySuccessRate: 1.0,
    llamaCppPromotionMinTokensPerWatt: readEnvNumber("XX_STACK_PROMOTION_MIN_TOKENS_PER_WATT") ?? 0,
    llamaCppPromotionMaxQualityDriftNegative:
      readEnvNumber("XX_STACK_PROMOTION_MAX_QUALITY_DRIFT_NEG") ?? 0.05,
  };

  const thresholdPass = recoverySuccessRate >= thresholds.minRecoverySuccessRate;
  const promotionEfficiencyPass =
    benchmarkTokensPerWatt === null
      ? true
      : benchmarkTokensPerWatt >= thresholds.llamaCppPromotionMinTokensPerWatt;
  const promotionQualityPass =
    benchmarkQualityDrift === null
      ? true
      : benchmarkQualityDrift >= -thresholds.llamaCppPromotionMaxQualityDriftNegative;
  const llamaCppPromotionPass = thresholdPass && promotionEfficiencyPass && promotionQualityPass;
  const rollbackRecommended = !llamaCppPromotionPass;

  return {
    report: {
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
    },
    exitCode: thresholdPass ? 0 : 1,
  };
}
