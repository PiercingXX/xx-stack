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

test("routeCompetitiveTask tie stability: identical input produces identical output", () => {
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
          models: [
            {
              name: "deepseek-coder-v2",
              roles: ["code", "edit", "plan", "architect"],
            },
          ],
        },
      ],
    },
    {
      id: TIER_IDS.tailscaleOpenAiCompatible,
      label: "Tailscale OpenAI Compatible",
      hosts: [
        {
          id: "sglang-box",
          label: "SGLang Remote",
          enabled: true,
          reachable: true,
          provider: "sglang",
          endpoint: "http://sglang:8000",
          models: [
            {
              name: "llama-3.1-8b",
              roles: ["code", "edit", "plan", "architect"],
            },
          ],
        },
      ],
    },
  ]);

  const description = "implement a quick fix and review the code";
  const first = __testExports.routeCompetitiveTask(description, registry as never, 3);
  const second = __testExports.routeCompetitiveTask(description, registry as never, 3);

  assert.equal(first.requestedLanes, second.requestedLanes);
  assert.equal(first.returnedLanes, second.returnedLanes);
  assert.equal(first.shortfall, second.shortfall);
  assert.equal(first.fallback, second.fallback);
  assert.equal(first.lanes.length, second.lanes.length);

  for (let i = 0; i < first.lanes.length; i++) {
    assert.equal(first.lanes[i].host, second.lanes[i].host);
    assert.equal(first.lanes[i].model, second.lanes[i].model);
    assert.equal(first.lanes[i].reasoning, second.lanes[i].reasoning);
  }
});