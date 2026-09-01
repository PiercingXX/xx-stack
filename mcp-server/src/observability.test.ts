import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { __testExports } from "./test_exports.js";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");

test("lookupModelCost returns null for unknown model", () => {
  const rates = {
    "gpt-4o": { costPer1kInputTokens: 0.0025, costPer1kOutputTokens: 0.01, lane: "cloud" },
  };
  assert.equal(__testExports.lookupModelCost(rates, "unknown-model", 1000, 500), null);
});

test("lookupModelCost returns null for undefined model", () => {
  const rates = {
    "gpt-4o": { costPer1kInputTokens: 0.0025, costPer1kOutputTokens: 0.01, lane: "cloud" },
  };
  assert.equal(__testExports.lookupModelCost(rates, undefined, 1000, 500), null);
});

test("lookupModelCost returns null for null model", () => {
  const rates = {
    "gpt-4o": { costPer1kInputTokens: 0.0025, costPer1kOutputTokens: 0.01, lane: "cloud" },
  };
  assert.equal(__testExports.lookupModelCost(rates, null, 1000, 500), null);
});

test("lookupModelCost returns correct cost for known model", () => {
  const rates = {
    "gpt-4o": { costPer1kInputTokens: 0.0025, costPer1kOutputTokens: 0.01, lane: "cloud" },
  };
  // 1000 input tokens * (0.0025 / 1000) + 500 output tokens * (0.01 / 1000)
  // = 0.0025 + 0.005 = 0.0075
  assert.equal(__testExports.lookupModelCost(rates, "gpt-4o", 1000, 500), 0.0075);
});

test("lookupModelCost returns 0 for local lane model", () => {
  const rates = {
    "ollama/*": { costPer1kInputTokens: 0, costPer1kOutputTokens: 0, lane: "local" },
  };
  assert.equal(__testExports.lookupModelCost(rates, "ollama/*", 10000, 5000), 0);
});

test("loadModelRates returns valid rates file", async () => {
  const ratesFile = await __testExports.loadModelRates();
  assert.ok(ratesFile, "should return a ModelRatesFile");
  assert.ok(typeof ratesFile.comment === "string", "should have a comment");
  assert.ok(typeof ratesFile.rates === "object", "should have rates object");
});

test("telemetry.json has enabled: false by default", async () => {
  // Find telemetry.json relative to the repo root (runtime/telemetry.json)
  // Walk up from __dirname to find it
  let dir = resolve(__dirname);
  let found = false;
  for (let i = 0; i < 10; i++) {
    const candidate = resolve(dir, "..", "runtime", "telemetry.json");
    try {
      const raw = await readFile(candidate, "utf-8");
      const config = JSON.parse(raw);
      assert.equal(config.enabled, false, "telemetry must be disabled by default");
      assert.ok(Array.isArray(config.fields), "telemetry config must have a fields array");
      assert.ok(config.fields.includes("lane"), "fields must include lane");
      assert.ok(config.fields.includes("tokensIn"), "fields must include tokensIn");
      assert.ok(config.fields.includes("tokensOut"), "fields must include tokensOut");
      assert.ok(config.fields.includes("costUsd"), "fields must include costUsd");
      found = true;
      break;
    } catch {
      dir = resolve(dir, "..");
    }
  }
  assert.ok(found, "telemetry.json not found walking up from test directory");
});

test("model-rates.json exists and has expected shape", async () => {
  let dir = resolve(__dirname);
  let found = false;
  for (let i = 0; i < 10; i++) {
    const candidate = resolve(dir, "..", "runtime", "model-rates.json");
    try {
      const raw = await readFile(candidate, "utf-8");
      const config = JSON.parse(raw);
      assert.ok(typeof config.comment === "string", "should have a comment");
      assert.ok(typeof config.rates === "object", "should have rates");
      // Verify local lanes cost 0
      for (const [model, rate] of Object.entries(config.rates) as [string, any][]) {
        if (rate.lane === "local") {
          assert.equal(rate.costPer1kInputTokens, 0, `${model} input cost should be 0`);
          assert.equal(rate.costPer1kOutputTokens, 0, `${model} output cost should be 0`);
        }
      }
      found = true;
      break;
    } catch {
      dir = resolve(dir, "..");
    }
  }
  assert.ok(found, "model-rates.json not found walking up from test directory");
});
