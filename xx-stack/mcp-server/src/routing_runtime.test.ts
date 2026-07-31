import test from "node:test";
import assert from "node:assert/strict";

import { __testExports } from "./index.js";
import { TIER_IDS } from "./runtime_constants.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeHost(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-host",
    label: "test",
    provider: "ollama",
    endpoint: "http://127.0.0.1:11434",
    enabled: true,
    reachable: true,
    models: [{ name: "qwen3:7b", roles: ["build", "code"] }],
    ...overrides,
  };
}

function makeDeepHost(overrides: Record<string, unknown> = {}) {
  return {
    id: "deep-host",
    label: "deep reasoning",
    provider: "ollama",
    endpoint: "http://127.0.0.1:11434",
    enabled: true,
    reachable: true,
    models: [
      { name: "qwen3:32b", roles: ["plan", "architect", "reason"] },
      { name: "qwen3:7b", roles: ["build", "code"] },
    ],
    ...overrides,
  };
}

function makeFastHost(overrides: Record<string, unknown> = {}) {
  return {
    id: "fast-host",
    label: "fast coding",
    provider: "ollama",
    endpoint: "http://127.0.0.1:11434",
    enabled: true,
    reachable: true,
    models: [{ name: "qwen3:7b", roles: ["build", "code"] }],
    ...overrides,
  };
}

function makeCloudHost(overrides: Record<string, unknown> = {}) {
  return {
    id: "cloud-host",
    label: "cloud",
    provider: "openai",
    endpoint: "https://api.openai.com/v1",
    enabled: true,
    reachable: true,
    models: [{ name: "gpt-4o", roles: ["plan", "architect", "build", "code"] }],
    ...overrides,
  };
}

function makeRegistry(
  tiers: Array<{ id: string; label: string; hosts: ReturnType<typeof makeHost>[] }>
) {
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

// ── routeArchitectEditor: distinct deep/fast lanes ────────────────────────────

test("routeArchitectEditor resolves architect and editor to different lanes when both are available", () => {
  const registry = makeRegistry([
    {
      id: TIER_IDS.local,
      label: "local",
      hosts: [makeDeepHost({ id: "deep-host" }), makeFastHost({ id: "fast-host" })],
    },
  ]);

  const result = __testExports.routeArchitectEditor(
    "refactor the authentication module to use OAuth2",
    registry as never
  );

  // Architect should land on the host with reasoning-capable models
  assert.ok(result.architect.host, "architect host should be set");
  assert.ok(result.architect.model, "architect model should be set");
  assert.ok(result.architect.reasoning, "architect reasoning should be set");

  // Editor should land on a host (may be same or different depending on registry)
  assert.ok(result.editor.host, "editor host should be set");
  assert.ok(result.editor.model, "editor model should be set");
  assert.ok(result.editor.reasoning, "editor reasoning should be set");

  // With distinct deep/fast hosts, architect and editor should differ
  assert.notEqual(
    result.architect.host,
    result.editor.host,
    "architect and editor should resolve to different hosts when distinct lanes exist"
  );
});

// ── routeArchitectEditor: single lane collapses both ─────────────────────────

test("routeArchitectEditor collapses both roles to the same host when only one lane is available", () => {
  const registry = makeRegistry([
    {
      id: TIER_IDS.local,
      label: "local",
      hosts: [makeHost({ id: "only-host", models: [{ name: "qwen3:7b", roles: ["build", "code"] }] })],
    },
  ]);

  const result = __testExports.routeArchitectEditor(
    "fix the login page styling",
    registry as never
  );

  // Both should resolve to the same host
  assert.equal(result.architect.host, "only-host", "architect should use the only available host");
  assert.equal(result.editor.host, "only-host", "editor should use the only available host");

  // Reasoning should clearly indicate the collapse
  assert.ok(
    result.architect.reasoning.includes("same host"),
    "architect reasoning should mention same-host collapse"
  );
  assert.ok(
    result.editor.reasoning.includes("same host"),
    "editor reasoning should mention same-host collapse"
  );
});

// ── routeArchitectEditor: cloud excluded by default ──────────────────────────

test("routeArchitectEditor excludes cloud hosts by default", () => {
  const originalCloud = process.env.XX_STACK_ALLOW_CLOUD;
  delete process.env.XX_STACK_ALLOW_CLOUD;

  try {
    const registry = makeRegistry([
      {
        id: TIER_IDS.local,
        label: "local",
        hosts: [makeFastHost({ id: "fast-host" })],
      },
      {
        id: TIER_IDS.cloud,
        label: "cloud",
        hosts: [makeCloudHost({ id: "cloud-host" })],
      },
    ]);

    const result = __testExports.routeArchitectEditor(
      "implement a new API endpoint",
      registry as never
    );

    // Neither architect nor editor should land on cloud
    assert.notEqual(
      result.architect.host,
      "cloud-host",
      "architect should not use cloud host when cloud is excluded"
    );
    assert.notEqual(
      result.editor.host,
      "cloud-host",
      "editor should not use cloud host when cloud is excluded"
    );
  } finally {
    if (originalCloud !== undefined) {
      process.env.XX_STACK_ALLOW_CLOUD = originalCloud;
    } else {
      delete process.env.XX_STACK_ALLOW_CLOUD;
    }
  }
});