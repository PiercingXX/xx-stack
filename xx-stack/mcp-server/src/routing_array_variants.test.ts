import test from "node:test";
import assert from "node:assert/strict";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  BATCH_ROUTE_CONCURRENCY,
  mapWithConcurrency,
  routeArchitectEditor,
  routeCompetitiveTask,
  routeTask,
} from "./routing_runtime.js";
import { registerRoutingTools } from "./routing_tools.js";
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

function makeHost(id: string, label: string, modelNames: string[]) {
  return {
    id,
    label,
    provider: "ollama",
    endpoint: `http://${id}:11434`,
    enabled: true,
    reachable: true,
    models: modelNames.map((name) => ({ name, roles: ["code", "review", "plan"] })),
    executionPolicy: { maxParallelSlices: 2 },
  };
}

function twoLaneRegistry() {
  return buildRegistryFixture([
    {
      id: TIER_IDS.local,
      label: "Local",
      hosts: [makeHost("local-box", "Local Box", ["qwen2.5-coder:7b"])],
    },
    {
      id: TIER_IDS.tailscaleOllama,
      label: "Tailscale Ollama",
      hosts: [makeHost("remote-box", "Remote Box", ["deepseek-coder-v2"])],
    },
  ]);
}

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

function captureRoutingTools(registry: unknown): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const fakeServer = {
    registerTool: (...toolArgs: unknown[]) => {
      handlers.set(toolArgs[0] as string, toolArgs[toolArgs.length - 1] as ToolHandler);
    },
  } as unknown as McpServer;
  registerRoutingTools(fakeServer, {
    loadRegistry: async () => registry as never,
  });
  return handlers;
}

async function invoke(
  handlers: Map<string, ToolHandler>,
  name: string,
  args: Record<string, unknown>
) {
  const handler = handlers.get(name);
  assert.ok(handler, `${name} must be registered by registerRoutingTools`);
  const result = await handler!(args);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0]!.type, "text");
  return JSON.parse(result.content[0]!.text);
}

// --- mapWithConcurrency: alignment + concurrency cap ---

test("mapWithConcurrency returns position-aligned results regardless of completion order", async () => {
  const items = Array.from({ length: 12 }, (_, i) => i);
  // Later items finish FIRST (decreasing delay) — alignment must still hold.
  const results = await mapWithConcurrency(items, 4, async (item) => {
    await new Promise((resolve) => setTimeout(resolve, (items.length - item) * 2));
    return item * 10;
  });
  assert.deepEqual(
    results,
    items.map((i) => i * 10),
    "result[i] must correspond to items[i]"
  );
});

test("mapWithConcurrency never exceeds the concurrency cap", async () => {
  const limit = 3;
  let inFlight = 0;
  let maxInFlight = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);

  await mapWithConcurrency(items, limit, async (item) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 2));
    inFlight--;
    return item;
  });

  assert.ok(
    maxInFlight <= limit,
    `at most ${limit} invocations may be in flight, observed ${maxInFlight}`
  );
  assert.ok(maxInFlight >= 1, "the pool actually ran work");
});

test("mapWithConcurrency rejects a non-positive concurrency limit", async () => {
  await assert.rejects(() => mapWithConcurrency([1, 2, 3], 0, async (i) => i), RangeError);
});

test("BATCH_ROUTE_CONCURRENCY is a sane bounded cap", () => {
  assert.ok(Number.isInteger(BATCH_ROUTE_CONCURRENCY));
  assert.ok(BATCH_ROUTE_CONCURRENCY >= 1 && BATCH_ROUTE_CONCURRENCY <= 64);
});

// --- route_task: single input keeps today's EXACT shape; array is aligned ---

test("route_task single-string input returns the exact singleton result shape (no wrapping)", async () => {
  const registry = twoLaneRegistry();
  const handlers = captureRoutingTools(registry);

  const payload = await invoke(handlers, "route_task", {
    description: "implement a quick fix",
  });

  // Byte-identical to the direct runtime call — zero breaking change.
  const expected = routeTask("implement a quick fix", registry as never);
  assert.deepEqual(payload, expected);
  assert.ok(!("results" in payload), "singleton path must not be wrapped in a results array");
});

test("route_task array input returns a position-aligned array of singleton results", async () => {
  const registry = twoLaneRegistry();
  const handlers = captureRoutingTools(registry);

  const descriptions = [
    "implement a quick code fix",
    "research and analyze the architecture",
    "zzz no keywords here",
  ];
  const payload = await invoke(handlers, "route_task", { description: descriptions });

  assert.ok(Array.isArray(payload.results), "array input must return { results: [...] }");
  assert.equal(payload.results.length, descriptions.length);
  for (let i = 0; i < descriptions.length; i++) {
    const expected = routeTask(descriptions[i], registry as never);
    assert.deepEqual(
      payload.results[i],
      expected,
      `results[${i}] must equal the singleton route for descriptions[${i}]`
    );
  }
});

// --- route_architect_editor: same widening contract ---

test("route_architect_editor keeps the singleton shape and adds an aligned array path", async () => {
  const registry = twoLaneRegistry();
  const handlers = captureRoutingTools(registry);

  const single = await invoke(handlers, "route_task", {
    description: "implement a new caching layer",
    mode: "architect-editor",
  });
  assert.deepEqual(
    single,
    routeArchitectEditor("implement a new caching layer", registry as never)
  );

  const descriptions = ["implement a new caching layer", "fix a small CSS bug"];
  const batch = await invoke(handlers, "route_task", {
    description: descriptions,
    mode: "architect-editor",
  });
  assert.ok(Array.isArray(batch.results));
  assert.equal(batch.results.length, 2);
  for (let i = 0; i < descriptions.length; i++) {
    assert.deepEqual(batch.results[i], routeArchitectEditor(descriptions[i], registry as never));
  }
});

// --- route_competitive_task: same widening contract ---

test("route_competitive_task keeps the singleton shape and adds an aligned array path", async () => {
  const registry = twoLaneRegistry();
  const handlers = captureRoutingTools(registry);

  const single = await invoke(handlers, "route_task", {
    description: "implement a parser",
    mode: "competitive",
    laneCount: 2,
  });
  assert.deepEqual(single, routeCompetitiveTask("implement a parser", registry as never, 2));

  const descriptions = ["implement a parser", "analyze log output"];
  const batch = await invoke(handlers, "route_task", {
    description: descriptions,
    mode: "competitive",
    laneCount: 2,
  });
  assert.ok(Array.isArray(batch.results));
  assert.equal(batch.results.length, 2);
  for (let i = 0; i < descriptions.length; i++) {
    assert.deepEqual(batch.results[i], routeCompetitiveTask(descriptions[i], registry as never, 2));
  }
});
