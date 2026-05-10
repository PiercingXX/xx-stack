/**
 * tune-reliability.ts
 *
 * Reads the last 10 harness JSONL runs, computes p50/p90/p99 timing per scenario,
 * identifies slow-trending scenarios, and outputs an advisory config patch.
 *
 * Usage:
 *   npm run tune
 *
 * The output is advisory only — it never auto-applies config changes.
 * Paste the suggested patch into the runtime config file and run `npm run harness:ci`
 * to validate the change.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const LOG_DIR = resolve(homedir(), ".config/xx-stack/xx-stack-logs");
const MAX_RUNS = 10;

interface HarnessScenario {
  type: string;
  scenario: string;
  passed: boolean;
  durationMs: number;
  details?: Record<string, unknown>;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(Math.floor((p / 100) * sorted.length), sorted.length - 1);
  return sorted[idx];
}

async function getHarnessLogs(): Promise<string[]> {
  try {
    const files = await readdir(LOG_DIR);
    return files
      .filter((f) => f.startsWith("harness-") && f.endsWith(".jsonl"))
      .sort()
      .reverse()
      .slice(0, MAX_RUNS)
      .map((f) => join(LOG_DIR, f));
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const logFiles = await getHarnessLogs();
  if (logFiles.length === 0) {
    process.stdout.write(
      "No harness logs found. Run `npm run harness:ci` at least once first.\n"
    );
    process.exit(0);
  }

  // Collect timing samples per scenario
  const byScenario = new Map<string, number[]>();
  // Track recovery_timing_budget worstCaseMs values for config suggestions
  const worstCaseSamples: number[] = [];

  for (const logFile of logFiles) {
    try {
      const raw = await readFile(logFile, "utf-8");
      for (const line of raw.trim().split("\n").filter(Boolean)) {
        try {
          const entry = JSON.parse(line) as HarnessScenario;
          if (entry.type !== "harness.scenario" || !entry.passed) continue;
          const existing = byScenario.get(entry.scenario) ?? [];
          existing.push(entry.durationMs);
          byScenario.set(entry.scenario, existing);
          if (entry.scenario === "recovery_timing_budget" && entry.details?.worstCaseMs) {
            worstCaseSamples.push(Number(entry.details.worstCaseMs));
          }
        } catch { /* skip malformed lines */ }
      }
    } catch { /* skip unreadable files */ }
  }

  if (byScenario.size === 0) {
    process.stdout.write("No successful scenario results found in the harness logs.\n");
    process.exit(0);
  }

  process.stdout.write(`\n── Harness Timing Analysis (last ${logFiles.length} run(s)) ──\n\n`);

  const stats: Record<string, { p50: number; p90: number; p99: number; samples: number }> = {};
  for (const [name, durations] of byScenario.entries()) {
    const sorted = [...durations].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p90 = percentile(sorted, 90);
    const p99 = percentile(sorted, 99);
    stats[name] = { p50, p90, p99, samples: sorted.length };
    process.stdout.write(`  ${name}\n`);
    process.stdout.write(`    p50=${p50}ms  p90=${p90}ms  p99=${p99}ms  samples=${sorted.length}\n\n`);
  }

  // Generate advisory suggestions
  const suggestions: string[] = [];

  // recovery_timing_budget: if p90 is much faster than current budget, suggest lowering progressTimeoutMs
  const rtb = stats["recovery_timing_budget"];
  if (rtb) {
    // worst case is static (it's a sum of config values, not a wall-clock measurement)
    // but we can advise based on how fast the OTHER scenarios run
  }

  if (worstCaseSamples.length > 0) {
    const sortedWc = [...worstCaseSamples].sort((a, b) => a - b);
    const worstP90 = percentile(sortedWc, 90);
    if (worstP90 < 25_000) {
      suggestions.push(
        `Recovery budget p90 is ${worstP90}ms — well under the 40s target. ` +
          "Consider reducing progressTimeoutMs further if needed."
      );
    } else if (worstP90 > 38_000) {
      suggestions.push(
        `Recovery budget p90 is ${worstP90}ms — close to the 40s target. ` +
          "Consider tuning progressTimeoutMs or abortWindowMs downward."
      );
    }
  }

  const atomic = stats["atomic_state_write"];
  if (atomic && atomic.p90 > 100) {
    suggestions.push(
      `atomic_state_write p90 is ${atomic.p90}ms — disk write is slow. ` +
        "Check available disk I/O or tmpfs usage."
    );
  }

  // Build a sample config patch (advisory only)
  process.stdout.write("── Advisory Config Patch ──\n\n");
  process.stdout.write("The values below reflect current defaults. Adjust as needed:\n\n");
  const patch = {
    "execution-orchestrator": {
      reliability: {
        progressTimeoutMs: 25000,
        abortWindowMs: 6000,
        retryDedupeWindowMs: 4000,
      },
    },
  };
  process.stdout.write(JSON.stringify({ agent: patch }, null, 2) + "\n");

  if (suggestions.length > 0) {
    process.stdout.write("\n── Suggestions ──\n\n");
    for (const s of suggestions) process.stdout.write(`  • ${s}\n`);
  } else {
    process.stdout.write("\n── No tuning suggestions — configuration looks solid. ──\n");
  }

  process.stdout.write("\n");
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
