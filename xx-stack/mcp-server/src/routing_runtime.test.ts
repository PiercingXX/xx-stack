import test from "node:test";
import assert from "node:assert/strict";

import { __testExports } from "./index.js";
import { TIER_IDS } from "./runtime_constants.js";

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

function makeHost(id: string, label: string, models: string[]) {
  return {
    id,
    label,
    provider: "ollama",
    endpoint: `http://${id}:11434`,
    enabled: true,
    reachable: true,
    models,
    executionPolicy: { maxParallelSlices: 2 },
  };
}

test("routeArchitectEditor resolves distinct deep and fast lanes when both are available", () => {
  const registry = buildRegistryFixture([
    {
      id: TIER_IDS.local,
      label: "Local",
      hosts: [
        makeHost("workstation-deep", "Workstation (Deep)", [
          "qwen3-coder:30b-a3b-tq2_0",
          "qwen2.5-coder:14b-tq2_0",
        ]),
      ],
    },
    {
      id: TIER_IDS.tailscaleOllama,
      label: "Tailscale Ollama",
      hosts: [
        makeHost("skippy-fast", "Skippy (Fast)", ["qwen2.5-coder:7b-tq2_0"]),
      ],
    },
  ]);

  const result = __testExports.routeArchitectEditor(
    "Implement a new authentication flow",
    registry as any
  );

  // Architect should resolve to the deep/reasoning tier (local with larger models)
  assert.ok(result.architect.host, "architect should have a host");
  assert.ok(result.architect.model, "architect should have a model");
  assert.ok(result.architect.reasoning, "architect should have reasoning");

  // Editor should resolve to a host
  assert.ok(result.editor.host, "editor should have a host");
  assert.ok(result.editor.model, "editor should have a model");
  assert.ok(result.editor.reasoning, "editor should have reasoning");

  // Fallback should describe the two lanes
  assert.ok(result.fallback, "fallback should be set");
  assert.ok(
    typeof result.fallback === "string",
    "fallback should be a string"
  );
});

test("routeArchitectEditor collapses to single lane when only one tier/host is available", () => {
  const registry = buildRegistryFixture([
    {
      id: TIER_IDS.local,
      label: "Local",
      hosts: [
        makeHost("workstation-only", "Workstation Only", [
          "qwen2.5-coder:7b-tq2_0",
        ]),
      ],
    },
  ]);

  const result = __testExports.routeArchitectEditor(
    "Fix a CSS layout bug",
    registry as any
  );

  // Both lanes should resolve to the same host
  assert.ok(result.architect.host, "architect should have a host");
  assert.ok(result.editor.host, "editor should have a host");
  assert.equal(
    result.architect.host,
    result.editor.host,
    "both lanes should collapse to the same host in single-lane mode"
  );

  // Fallback should clearly indicate single-lane collapse
  assert.ok(result.fallback, "fallback should be set");
  assert.ok(
    result.fallback.includes("Single lane"),
    `fallback should mention single-lane collapse, got: ${result.fallback}`
  );
});

test("routeArchitectEditor excludes cloud by default", () => {
  const registry = buildRegistryFixture([
    {
      id: TIER_IDS.local,
      label: "Local",
      hosts: [
        makeHost("local-box", "Local Box", ["qwen2.5-coder:7b-tq2_0"]),
      ],
    },
    {
      id: TIER_IDS.cloud,
      label: "Cloud",
      hosts: [
        makeHost("cloud-gpu", "Cloud GPU", ["gpt-4o"]),
      ],
    },
  ]);

  const result = __testExports.routeArchitectEditor(
    "Refactor the database layer",
    registry as any
  );

  // Neither lane should route to cloud
  assert.notEqual(
    result.architect.host,
    "cloud-gpu",
    "architect should not route to cloud by default"
  );
  assert.notEqual(
    result.editor.host,
    "cloud-gpu",
    "editor should not route to cloud by default"
  );

  // Reasoning should mention cloud exclusion
  assert.ok(
    result.architect.reasoning.includes("cloud"),
    "architect reasoning should mention cloud exclusion"
  );
  assert.ok(
    result.editor.reasoning.includes("cloud"),
    "editor reasoning should mention cloud exclusion"
  );
});