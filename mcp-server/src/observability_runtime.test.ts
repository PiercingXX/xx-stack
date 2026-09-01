import test from "node:test";
import assert from "node:assert/strict";

import { diagnoseHosts } from "./observability_runtime.js";
import type { Host, Registry } from "./platform_types.js";

// diagnoseHosts fans one Promise.all out over per-host probes. The real
// defaults swallow their own network errors, but both probes are injectable,
// so a rejecting injected probe stands in for any future default that learns
// to throw — the failure must degrade only its own host, never the diagnose.

function registryWith(hosts: Host[]): Registry {
  return {
    version: 1,
    selectionPolicy: { defaultOrder: ["local"], rules: [] },
    tiers: [
      {
        id: "local",
        label: "Local",
        priority: 1,
        usageGuidance: "prefer for code",
        hosts,
      },
    ],
  } as unknown as Registry;
}

function httpHost(id: string): Host {
  return {
    id,
    label: id,
    provider: "ollama",
    endpoint: `http://${id}:11434`,
    enabled: true,
    models: [],
  } as unknown as Host;
}

test("one rejecting probe degrades only its own host", async () => {
  const registry = registryWith([httpHost("good-box"), httpHost("bad-box")]);
  const results = await diagnoseHosts(
    registry,
    async (host) => {
      if (host.id === "bad-box") throw new Error("ECONNRESET: probe exploded");
      return { ok: true, latencyMs: 7 };
    },
    async () => null
  );

  assert.equal(results.length, 2, "every host must produce a result");

  const byHost = new Map(results.map((r) => [r.host, r]));
  const good = byHost.get("good-box");
  assert.equal(good?.status, "healthy");
  assert.equal(good?.latencyMs, 7);

  const bad = byHost.get("bad-box");
  assert.equal(bad?.status, "unreachable");
  assert.equal(bad?.reason, "ECONNRESET: probe exploded");
});

test("a rejecting resident-model fetch degrades only its own host too", async () => {
  const registry = registryWith([httpHost("inspectable"), httpHost("grumpy")]);
  const results = await diagnoseHosts(
    registry,
    async () => ({ ok: true, latencyMs: 5 }),
    async (host) => {
      if (host.id === "grumpy") throw new Error("/api/ps hung up");
      return null;
    }
  );

  const byHost = new Map(results.map((r) => [r.host, r]));
  assert.equal(byHost.get("inspectable")?.status, "healthy");
  assert.equal(byHost.get("grumpy")?.status, "unreachable");
  assert.equal(byHost.get("grumpy")?.reason, "/api/ps hung up");
});
