import test from "node:test";
import assert from "node:assert/strict";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { routeReview } from "./routing_runtime.js";
import { registerRoutingTools } from "./routing_tools.js";
import { TIER_IDS } from "./runtime_constants.js";

function buildRegistryFixture(tiers: Array<Record<string, unknown>>, cloudOptIn = false) {
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
      ...(cloudOptIn ? { cloudEscalation: { optIn: true } } : {}),
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

/** Ensure the cloud env opt-in never leaks into these tests. */
function withoutCloudEnv<T>(fn: () => T): T {
  const saved = process.env.XX_STACK_ALLOW_CLOUD;
  delete process.env.XX_STACK_ALLOW_CLOUD;
  try {
    return fn();
  } finally {
    if (saved === undefined) {
      delete process.env.XX_STACK_ALLOW_CLOUD;
    } else {
      process.env.XX_STACK_ALLOW_CLOUD = saved;
    }
  }
}

test("routeReview prefers a lane whose model differs from the authoring model", () => {
  withoutCloudEnv(() => {
    const registry = buildRegistryFixture([
      {
        id: TIER_IDS.local,
        label: "Local",
        hosts: [makeHost("author-box", "Author Box", ["model-a"])],
      },
      {
        id: TIER_IDS.tailscaleOllama,
        label: "Tailscale Ollama",
        hosts: [makeHost("reviewer-box", "Reviewer Box", ["model-b"])],
      },
    ]);

    const result = routeReview(
      "review the new authentication flow",
      registry as never,
      "model-a",
      "author-box"
    );

    assert.equal(result.reviewer.host, "reviewer-box", "reviewer should land on the other host");
    assert.equal(result.reviewer.model, "model-b", "reviewer model must differ from the author's");
    assert.equal(result.modelDiversity, "distinct");
    assert.equal(result.authoredByModel, "model-a");
    assert.equal(result.authoredByHost, "author-box");
    assert.equal(result.shortfall, null, "no shortfall when a distinct-model lane exists");
    assert.ok(
      result.reviewer.reasoning.includes("model-b") &&
        result.reviewer.reasoning.includes("model-a"),
      `reasoning should name both models, got: ${result.reviewer.reasoning}`
    );
  });
});

test("routeReview picks a different model on the same host when that is the only diversity available", () => {
  withoutCloudEnv(() => {
    const registry = buildRegistryFixture([
      {
        id: TIER_IDS.local,
        label: "Local",
        hosts: [makeHost("only-box", "Only Box", ["model-a", "model-b"])],
      },
    ]);

    const result = routeReview("review the refactor", registry as never, "model-a", "only-box");

    assert.equal(result.reviewer.host, "only-box");
    assert.equal(result.reviewer.model, "model-b", "should avoid the authoring model");
    assert.equal(result.modelDiversity, "distinct");
    // Same host is a declared shortfall (host preference unmet), never silent.
    assert.ok(result.shortfall, "same-host review should surface a shortfall");
    assert.ok(
      result.shortfall!.includes("authoring host"),
      `shortfall should mention the authoring host, got: ${result.shortfall}`
    );
  });
});

test("routeReview collapses to same-model review with explicit reasoning when only one lane exists", () => {
  withoutCloudEnv(() => {
    const registry = buildRegistryFixture([
      {
        id: TIER_IDS.local,
        label: "Local",
        hosts: [makeHost("only-box", "Only Box", ["model-a"])],
      },
    ]);

    const result = routeReview("review the database migration", registry as never, "model-a");

    assert.equal(result.reviewer.host, "only-box", "collapse still routes the review somewhere");
    assert.equal(result.reviewer.model, "model-a", "collapses to the authoring model");
    assert.equal(result.modelDiversity, "same-model");
    assert.ok(result.shortfall, "collapse must surface a shortfall — no silent degradation");
    assert.ok(
      result.shortfall!.includes("model-a"),
      `shortfall should name the authoring model, got: ${result.shortfall}`
    );
    assert.ok(
      result.reviewer.reasoning.includes("shortfall") ||
        result.reviewer.reasoning.includes("same-model"),
      `reasoning should carry the collapse explanation, got: ${result.reviewer.reasoning}`
    );
  });
});

test("routeReview excludes cloud lanes by default and honors the existing opt-in gate", () => {
  withoutCloudEnv(() => {
    const tiers = [
      {
        id: TIER_IDS.local,
        label: "Local",
        hosts: [makeHost("local-box", "Local Box", ["model-a"])],
      },
      {
        id: TIER_IDS.cloud,
        label: "Cloud",
        hosts: [makeHost("cloud-gpu", "Cloud GPU", ["model-b"])],
      },
    ];

    // Default: cloud excluded, so the only distinct model (on the cloud lane)
    // is unreachable — collapse to same-model local review.
    const blocked = routeReview(
      "review the API changes",
      buildRegistryFixture(tiers) as never,
      "model-a"
    );
    assert.notEqual(blocked.reviewer.host, "cloud-gpu", "cloud must be excluded by default");
    assert.equal(blocked.reviewer.host, "local-box");
    assert.equal(blocked.modelDiversity, "same-model");
    assert.ok(blocked.shortfall, "cloud-blocked collapse must surface a shortfall");
    assert.ok(
      blocked.reviewer.reasoning.includes("cloud"),
      "reasoning should mention the cloud exclusion"
    );

    // With the registry opt-in flag (same gate route_task uses), the cloud
    // lane becomes eligible and diversity is restored.
    const opted = routeReview(
      "review the API changes",
      buildRegistryFixture(tiers, true) as never,
      "model-a"
    );
    assert.equal(opted.reviewer.host, "cloud-gpu");
    assert.equal(opted.reviewer.model, "model-b");
    assert.equal(opted.modelDiversity, "distinct");
    assert.equal(opted.shortfall, null);
  });
});

test("routeReview without authoring info routes a plain review and says the constraint was not evaluated", () => {
  withoutCloudEnv(() => {
    const registry = buildRegistryFixture([
      {
        id: TIER_IDS.local,
        label: "Local",
        hosts: [makeHost("local-box", "Local Box", ["model-a"])],
      },
    ]);

    const result = routeReview("review the CSS changes", registry as never);

    assert.equal(result.reviewer.host, "local-box");
    assert.equal(result.modelDiversity, "unknown-author");
    assert.equal(result.authoredByModel, null);
    assert.equal(result.shortfall, null);
    assert.ok(
      result.reviewer.reasoning.includes("no authoring model declared"),
      `reasoning should state the constraint was not evaluated, got: ${result.reviewer.reasoning}`
    );
  });
});

// --- route_review through the REGISTERED tool, not just the runtime helper ---

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

test("route_review registered tool returns the ReviewRoute payload", async () => {
  const saved = process.env.XX_STACK_ALLOW_CLOUD;
  delete process.env.XX_STACK_ALLOW_CLOUD;
  try {
    const registry = buildRegistryFixture([
      {
        id: TIER_IDS.local,
        label: "Local",
        hosts: [makeHost("author-box", "Author Box", ["model-a"])],
      },
      {
        id: TIER_IDS.tailscaleOllama,
        label: "Tailscale Ollama",
        hosts: [makeHost("reviewer-box", "Reviewer Box", ["model-b"])],
      },
    ]);

    const handlers = captureRoutingTools(registry);
    const handler = handlers.get("route_task");
    assert.ok(handler, "route_task must be registered by registerRoutingTools");

    const result = await handler!({
      description: "review the routing changes",
      mode: "review",
      authoredByModel: "model-a",
      authoredByHost: "author-box",
    });
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0]!.type, "text");
    const payload = JSON.parse(result.content[0]!.text);

    // The tool payload must be byte-identical to the runtime result.
    const expected = routeReview(
      "review the routing changes",
      registry as never,
      "model-a",
      "author-box"
    );
    assert.deepEqual(payload, expected);
    assert.equal(payload.modelDiversity, "distinct");
    assert.equal(payload.reviewer.host, "reviewer-box");
  } finally {
    if (saved === undefined) {
      delete process.env.XX_STACK_ALLOW_CLOUD;
    } else {
      process.env.XX_STACK_ALLOW_CLOUD = saved;
    }
  }
});
