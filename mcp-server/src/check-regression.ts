/**
 * check-regression.ts
 *
 * Reads the most recent harness JSONL log and compares each scenario's timing
 * against the committed baseline in scripts/harness-baseline.json.
 *
 * Exit 0 — all scenarios passed and no scenario exceeded 2× its baseline.
 * Exit 1 — a scenario failed or a timing regression was detected.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const LOG_DIR = resolve(homedir(), ".config/xx-stack/xx-stack-logs");
const BASELINE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "harness-baseline.json"
);

interface HarnessScenario {
  type: string;
  scenario: string;
  passed: boolean;
  durationMs: number;
}

interface Baseline {
  [scenario: string]: { maxDurationMs: number };
}

async function getLatestHarnessLog(): Promise<string | null> {
  try {
    const files = await readdir(LOG_DIR);
    const sorted = files
      .filter((f) => f.startsWith("harness-") && f.endsWith(".jsonl"))
      .sort()
      .reverse();
    return sorted[0] ? join(LOG_DIR, sorted[0]) : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const latestLog = await getLatestHarnessLog();
  if (!latestLog) {
    process.stdout.write("No harness log found — skipping regression check.\n");
    process.exit(0);
  }

  process.stdout.write(`Reading harness log: ${latestLog}\n`);

  const raw = await readFile(latestLog, "utf-8");
  const scenarios = raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((r): r is Record<string, unknown> => r !== null && r["type"] === "harness.scenario")
    .map((r) => r as unknown as HarnessScenario);

  if (scenarios.length === 0) {
    process.stdout.write("No scenario results found in the harness log.\n");
    process.exit(0);
  }

  let baseline: Baseline;
  try {
    baseline = JSON.parse(await readFile(BASELINE_PATH, "utf-8")) as Baseline;
  } catch {
    process.stdout.write("No baseline file found — skipping timing check.\n");
    const failed = scenarios.filter((s) => !s.passed);
    if (failed.length > 0) {
      process.stderr.write(`\nFAIL: ${failed.length} scenario(s) failed:\n`);
      for (const f of failed) process.stderr.write(`  ✗ ${f.scenario}\n`);
      process.exit(1);
    }
    process.stdout.write(`All ${scenarios.length} scenarios passed.\n`);
    process.exit(0);
  }

  const regressions: string[] = [];
  for (const s of scenarios) {
    if (!s.passed) {
      regressions.push(`${s.scenario}: FAILED`);
      continue;
    }
    const base = baseline[s.scenario];
    if (base && s.durationMs > base.maxDurationMs * 2) {
      regressions.push(
        `${s.scenario}: timing regression — ${s.durationMs}ms > 2× baseline (${base.maxDurationMs}ms)`
      );
    }
  }

  const pass = scenarios.filter((s) => s.passed).length;
  process.stdout.write(`Scenarios: ${pass}/${scenarios.length} passed.\n`);

  if (regressions.length > 0) {
    process.stderr.write("\nREGRESSION DETECTED:\n");
    for (const r of regressions) process.stderr.write(`  ✗ ${r}\n`);
    process.exit(1);
  }

  process.stdout.write("Regression check passed — all scenarios within 2× baseline.\n");
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
