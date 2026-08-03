import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __hardwareIo,
  detectHardware,
  loadModelRates,
  lookupModelCost,
  matchModelRateKey,
  resetHardwareCache,
  type ModelRates,
} from "./platform_runtime.js";
import { xxStackRepoRoot } from "./runtime_constants.js";

// --- MCP-6: the rate table is glob-keyed ---------------------------------

const FREE = { costPer1kInputTokens: 0, costPer1kOutputTokens: 0, lane: "local" };
const PAID = { costPer1kInputTokens: 0.0025, costPer1kOutputTokens: 0.01, lane: "cloud" };

test("MCP-6: a wildcard key matches the real dispatch name provider/model", () => {
  // routing_selection_runtime dispatches `${provider}/${model}`; the shipped
  // rate file keys local lanes as globs. Exact-key lookup matched neither, so
  // every free local call was billed as "unknown".
  const rates: ModelRates = { "ollama/*": FREE, "sglang/*": FREE, "vllm/*": FREE };
  assert.equal(lookupModelCost(rates, "ollama/qwen3-coder:30b", 100_000, 50_000), 0);
  assert.equal(lookupModelCost(rates, "sglang/Qwen3-32B-AWQ", 10, 10), 0);
  assert.equal(lookupModelCost(rates, "vllm/anything-at-all", 10, 10), 0);
});

test("MCP-6: an exact key beats a wildcard that also matches", () => {
  const rates: ModelRates = { "ollama/*": FREE, "ollama/gpt-oss:120b": PAID };
  // 1000 in + 500 out against the exact entry, not the free glob.
  assert.equal(lookupModelCost(rates, "ollama/gpt-oss:120b", 1000, 500), 0.0075);
  assert.equal(matchModelRateKey(rates, "ollama/gpt-oss:120b"), "ollama/gpt-oss:120b");
  assert.equal(matchModelRateKey(rates, "ollama/other"), "ollama/*");
});

test("MCP-6: the most specific glob wins, deterministically and regardless of key order", () => {
  const specific = { costPer1kInputTokens: 1, costPer1kOutputTokens: 0, lane: "cloud" };
  const broad = { costPer1kInputTokens: 2, costPer1kOutputTokens: 0, lane: "cloud" };

  const forward: ModelRates = { "*": broad, "ollama/qwen*": specific };
  const reversed: ModelRates = { "ollama/qwen*": specific, "*": broad };
  for (const rates of [forward, reversed]) {
    assert.equal(matchModelRateKey(rates, "ollama/qwen3"), "ollama/qwen*");
    assert.equal(matchModelRateKey(rates, "gpt-4o"), "*");
  }
});

test("MCP-6: no match still returns null rather than a fabricated zero", () => {
  const rates: ModelRates = { "ollama/*": FREE, "gpt-4o": PAID };
  assert.equal(lookupModelCost(rates, "vllm/mistral", 10, 10), null);
  assert.equal(lookupModelCost(rates, "gpt-4o-mini", 10, 10), null);
  assert.equal(matchModelRateKey(rates, "vllm/mistral"), null);
  // A model name that merely contains a key is not a match — the glob is anchored.
  assert.equal(lookupModelCost(rates, "not-gpt-4o-really", 10, 10), null);
});

test("MCP-6: rate-table keys are matched literally, never as regexes", () => {
  const rates: ModelRates = { "gpt-4.0": PAID };
  // `.` must not match `-`; only `*` is a wildcard.
  assert.equal(matchModelRateKey(rates, "gpt-4-0"), null);
  assert.equal(matchModelRateKey(rates, "gpt-4.0"), "gpt-4.0");
});

test("MCP-6: an empty or absent table is not an error", () => {
  assert.equal(lookupModelCost({}, "ollama/qwen3", 10, 10), null);
  assert.equal(lookupModelCost({} as ModelRates, null, 10, 10), null);
  assert.equal(lookupModelCost(null as unknown as ModelRates, "ollama/qwen3", 10, 10), null);
});

// --- MCP-6: `"rates": null` must not reach lookupModelCost ---------------

// loadModelRates memoizes for 30s, so this file makes exactly one call to it.
// node --test gives every test file its own process, so the cache starts cold.
test("MCP-6: a rate file with a null rates object degrades to the empty fallback", async () => {
  const original = process.env.XX_STACK_REPO;
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-rates-"));
  try {
    await mkdir(join(dir, "runtime"), { recursive: true });
    // `typeof null === "object"` passed the old guard, so this file was accepted
    // verbatim and lookupModelCost then threw on `rates[modelName]` — the one
    // outcome loadModelRates' own comment promises never happens.
    await writeFile(
      join(dir, "runtime", "model-rates.json"),
      JSON.stringify({ comment: "corrupt", rates: null }),
      "utf-8"
    );
    process.env.XX_STACK_REPO = dir;
    assert.equal(xxStackRepoRoot(), dir, "the shared repo-root helper sees the override");

    const ratesFile = await loadModelRates();
    assert.deepEqual(ratesFile.rates, {}, "a null rates table degrades to empty, never null");
    assert.doesNotThrow(() => lookupModelCost(ratesFile.rates, "ollama/qwen3", 10, 10));
    assert.equal(lookupModelCost(ratesFile.rates, "ollama/qwen3", 10, 10), null);
  } finally {
    if (original === undefined) delete process.env.XX_STACK_REPO;
    else process.env.XX_STACK_REPO = original;
    await rm(dir, { recursive: true, force: true });
  }
});

// --- MCP-DUP-2: one repo-root helper, always absolute --------------------

test("MCP-DUP-2: xxStackRepoRoot normalizes a relative XX_STACK_REPO", () => {
  const original = process.env.XX_STACK_REPO;
  try {
    process.env.XX_STACK_REPO = "some/relative/path";
    const root = xxStackRepoRoot();
    assert.ok(root.startsWith("/"), `repo root must be absolute, got ${root}`);
    assert.equal(root, join(process.cwd(), "some/relative/path"));

    delete process.env.XX_STACK_REPO;
    assert.equal(
      xxStackRepoRoot("/home/tester"),
      "/home/tester/.config/opencode/skills/xx-stack",
      "without the override the default is derived from the supplied home directory"
    );
  } finally {
    if (original === undefined) delete process.env.XX_STACK_REPO;
    else process.env.XX_STACK_REPO = original;
  }
});

// ---------------------------------------------------------------------------
// §11.1: detectHardware runs three probes, each independently try/caught, and
// used to cache whatever came back — so a probe that was transiently missing at
// the first call could never contribute again for the life of the process. This
// is a long-lived stdio server; the probes are stubbed here because whether
// `free` and `lspci` exist is a property of the machine running the suite.
// ---------------------------------------------------------------------------

const PROBE_OUTPUT: Record<string, string> = {
  free: "              total        used\nMem:    17179869184   123\n",
  lspci: "01:00.0 VGA compatible controller: Some Vendor Fast GPU\n00:1f.0 ISA bridge: chipset\n",
  bash: "8589934592\n",
};

interface HardwareHarness {
  calls: string[];
  /** Commands that should fail on this attempt. */
  failing: Set<string>;
  restore: () => void;
}

function stubHardwareProbes(): HardwareHarness {
  const real = { ...__hardwareIo };
  const harness: HardwareHarness = {
    calls: [],
    failing: new Set(),
    restore: () => {
      Object.assign(__hardwareIo, real);
      resetHardwareCache();
    },
  };
  __hardwareIo.guardedExecFile = (async (command: string) => {
    harness.calls.push(command);
    if (harness.failing.has(command)) throw new Error(`${command}: command not found`);
    return { stdout: PROBE_OUTPUT[command] ?? "", stderr: "" };
  }) as unknown as typeof __hardwareIo.guardedExecFile;
  resetHardwareCache();
  return harness;
}

test("§11.1: a probe that was missing on the first call is retried on the next one", async () => {
  const io = stubHardwareProbes();
  try {
    io.failing.add("lspci");
    const first = await detectHardware();
    // Pre-existing contract: an unavailable probe leaves its field unset and
    // never throws.
    assert.equal(first.gpus, undefined);
    assert.equal(first.ramGb, 16);

    io.failing.delete("lspci");
    const second = await detectHardware();
    assert.deepEqual(
      second.gpus,
      ["Some Vendor Fast GPU"],
      "the partial result was cached forever — a recovered probe must be able to contribute"
    );
    assert.equal(second.ramGb, 16);
    assert.equal(second.totalVramGb, 8);
  } finally {
    io.restore();
  }
});

test("§11.1: a probe that already succeeded is never run a second time", async () => {
  const io = stubHardwareProbes();
  try {
    io.failing.add("bash");
    await detectHardware();
    assert.deepEqual(io.calls, ["free", "lspci", "bash"]);

    io.calls.length = 0;
    io.failing.delete("bash");
    await detectHardware();
    assert.deepEqual(io.calls, ["bash"], "only the probe that failed should be re-attempted");
  } finally {
    io.restore();
  }
});

test("§11.1: a fully successful detection is still cached wholesale", async () => {
  const io = stubHardwareProbes();
  try {
    const first = await detectHardware();
    assert.deepEqual(io.calls, ["free", "lspci", "bash"]);

    io.calls.length = 0;
    const second = await detectHardware();
    assert.deepEqual(io.calls, [], "three 3s shell-outs must not be repeated on a complete result");
    assert.equal(second, first, "the cached object is returned as-is");
  } finally {
    io.restore();
  }
});

test("§11.1: a genuinely absent tool stops being probed after the attempt budget", async () => {
  const io = stubHardwareProbes();
  try {
    io.failing.add("lspci");
    for (let i = 0; i < 6; i += 1) {
      const hw = await detectHardware();
      assert.equal(hw.gpus, undefined);
      assert.equal(hw.ramGb, 16, "the probes that work keep working");
    }
    assert.equal(
      io.calls.filter((command) => command === "lspci").length,
      3,
      "a missing binary should cost a bounded number of attempts, not one per call"
    );
    assert.equal(
      io.calls.filter((command) => command === "free").length,
      1,
      "and the succeeding probes are still memoized while it retries"
    );
  } finally {
    io.restore();
  }
});
