import test from "node:test";
import assert from "node:assert/strict";

import { __testExports } from "./test_exports.js";
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

test("routeCompetitiveTask reports shortfall when fewer distinct lanes exist than requested", () => {
  // A single host in a single tier — all competitive seeds resolve to the same
  // host/model, so we get 1 lane even though we request 3.
  const registry = buildRegistryFixture([
    {
      id: TIER_IDS.local,
      label: "Local",
      hosts: [
        {
          id: "local-box",
          label: "Local Workstation",
          enabled: true,
          reachable: true,
          provider: "ollama",
          endpoint: "http://127.0.0.1:11434",
          models: [
            {
              name: "qwen2.5-coder:7b",
              roles: ["code", "edit", "plan", "architect"],
            },
          ],
        },
      ],
    },
  ]);

  const result = __testExports.routeCompetitiveTask("implement a quick fix", registry as never, 3);

  // We requested 3 lanes but only 1 distinct (host,model) exists
  assert.equal(result.requestedLanes, 3);
  assert.equal(result.returnedLanes, 1);
  assert.equal(result.shortfall, 2);
  assert.ok(
    result.fallback.includes("shortfall"),
    `fallback message should mention shortfall, got: ${result.fallback}`
  );
  assert.equal(result.lanes.length, 1);
  assert.equal(result.lanes[0].host, "local-box");
});

test("scoreCandidates: every candidate carries a rationale", () => {
  const registry = buildRegistryFixture([
    {
      id: TIER_IDS.local,
      label: "Local",
      hosts: [
        {
          id: "local-box",
          label: "Local Workstation",
          enabled: true,
          reachable: true,
          provider: "ollama",
          endpoint: "http://127.0.0.1:11434",
          models: [{ name: "qwen2.5-coder:7b", roles: ["code", "edit", "plan"] }],
        },
      ],
    },
    {
      id: TIER_IDS.tailscaleOllama,
      label: "Tailscale Ollama",
      hosts: [
        {
          id: "remote-box",
          label: "Remote Ollama",
          enabled: true,
          reachable: true,
          provider: "ollama",
          endpoint: "http://remote:11434",
          models: [{ name: "deepseek-coder-v2", roles: ["code", "edit", "plan"] }],
        },
      ],
    },
  ]);

  const candidates = [
    "implement a quick fix",
    "analyze the architecture and research alternatives",
    "random unrelated text",
  ];

  const result = __testExports.scoreCandidates(candidates, registry as never);
  assert.equal(result.length, 3);

  for (const item of result) {
    assert.ok(typeof item.description === "string" && item.description.length > 0);
    assert.ok(typeof item.totalScore === "number" && item.totalScore >= 0);
    assert.ok(typeof item.tierScores === "object" && item.tierScores !== null);
    assert.ok(typeof item.rationale === "string" && item.rationale.length > 0);
  }

  // First candidate ("implement a quick fix") should score higher than unrelated text
  assert.ok(result[0].totalScore >= result[2].totalScore);
});

test("scoreCandidates tie stability: identical scores preserve input order across two runs", () => {
  const registry = buildRegistryFixture([
    {
      id: TIER_IDS.local,
      label: "Local",
      hosts: [
        {
          id: "local-box",
          label: "Local Workstation",
          enabled: true,
          reachable: true,
          provider: "ollama",
          endpoint: "http://127.0.0.1:11434",
          models: [{ name: "qwen2.5-coder:7b", roles: ["code", "edit", "plan"] }],
        },
      ],
    },
  ]);

  // Two candidates that will both get score 0 (no keyword matches) — tied.
  const candidates = ["zzz_nonexistent_keyword_alpha", "aaa_nonexistent_keyword_beta"];
  const first = __testExports.scoreCandidates(candidates, registry as never);
  const second = __testExports.scoreCandidates(candidates, registry as never);

  assert.equal(first.length, 2);
  assert.equal(second.length, 2);

  // Both should have score 0 (tied)
  assert.equal(first[0].totalScore, 0);
  assert.equal(first[1].totalScore, 0);

  // Stable tie-break: input order preserved across runs
  assert.equal(first[0].description, candidates[0]);
  assert.equal(first[1].description, candidates[1]);
  assert.equal(second[0].description, candidates[0]);
  assert.equal(second[1].description, candidates[1]);

  // Every candidate still carries rationale even at score 0
  for (const item of [...first, ...second]) {
    assert.ok(typeof item.rationale === "string" && item.rationale.length > 0);
  }
});
