import test from "node:test";
import assert from "node:assert/strict";

import { runHarnessScenarios } from "./reliability_harness_scenarios.js";

const GATE_ENV_NAMES = [
  "XX_STACK_OLLAMA_P50_MS",
  "XX_STACK_OLLAMA_P95_MS",
  "XX_STACK_OLLAMA_TOKENS_PER_SEC",
  "XX_STACK_OLLAMA_PEAK_VRAM_GB",
  "XX_STACK_OLLAMA_CORRECTNESS_SCORE",
  "XX_STACK_LLAMA_CPP_P50_MS",
  "XX_STACK_LLAMA_CPP_P95_MS",
  "XX_STACK_LLAMA_CPP_TOKENS_PER_SEC",
  "XX_STACK_LLAMA_CPP_PEAK_VRAM_GB",
  "XX_STACK_LLAMA_CPP_CORRECTNESS_SCORE",
];

/**
 * Complete, sane benchmark data that passes every ratio threshold: p50 ratio
 * 1.1 (≤1.15), p95 1.15 (≤1.2), throughput 0.93 (≥0.9), VRAM 1.17 (≤1.25),
 * correctness drop 0.02 (≤0.03).
 */
const SANE_DATA: Record<string, string> = {
  XX_STACK_OLLAMA_P50_MS: "100",
  XX_STACK_OLLAMA_P95_MS: "200",
  XX_STACK_OLLAMA_TOKENS_PER_SEC: "30",
  XX_STACK_OLLAMA_PEAK_VRAM_GB: "6",
  XX_STACK_OLLAMA_CORRECTNESS_SCORE: "0.92",
  XX_STACK_LLAMA_CPP_P50_MS: "110",
  XX_STACK_LLAMA_CPP_P95_MS: "230",
  XX_STACK_LLAMA_CPP_TOKENS_PER_SEC: "28",
  XX_STACK_LLAMA_CPP_PEAK_VRAM_GB: "7",
  XX_STACK_LLAMA_CPP_CORRECTNESS_SCORE: "0.9",
};

async function withGateEnv(
  values: Record<string, string>,
  run: () => Promise<void>
): Promise<void> {
  const saved = GATE_ENV_NAMES.map((name) => [name, process.env[name]] as const);
  try {
    for (const name of GATE_ENV_NAMES) delete process.env[name];
    for (const [name, value] of Object.entries(values)) process.env[name] = value;
    await run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("a zero-valued baseline fails the regression gate instead of vacuously passing", async () => {
  await withGateEnv({ ...SANE_DATA, XX_STACK_OLLAMA_P50_MS: "0" }, async () => {
    const results = await runHarnessScenarios();
    const gate = results.find((result) => result.name === "benchmark_ollama_vs_llama_cpp");
    assert.ok(gate, "the ollama-vs-llama-cpp gate must always be reported");
    assert.equal(gate.details.skipped, false, "the run presented complete data — not a skip");
    assert.equal(
      gate.passed,
      false,
      "present-but-unusable baseline data must FAIL, not slip through as a vacuous pass"
    );
    assert.equal(gate.details.degenerateBaseline, true);
  });
});

test("sane data passes and absent data remains an honest skip", async () => {
  await withGateEnv(SANE_DATA, async () => {
    const results = await runHarnessScenarios();
    const gate = results.find((result) => result.name === "benchmark_ollama_vs_llama_cpp")!;
    assert.equal(gate.passed, true, `ratios: ${JSON.stringify(gate.details)}`);
    assert.equal(gate.details.skipped, false);
    assert.ok((gate.details.p50Ratio as number) > 0, "ratios are actually computed");
  });

  await withGateEnv({}, async () => {
    const results = await runHarnessScenarios();
    const gate = results.find((result) => result.name === "benchmark_ollama_vs_llama_cpp")!;
    assert.equal(gate.passed, true);
    assert.equal(gate.details.skipped, true);
  });
});
