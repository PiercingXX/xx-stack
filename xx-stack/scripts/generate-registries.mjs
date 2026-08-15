#!/usr/bin/env node
/**
 * Fan the canonical inventory out to every consumer config.
 *
 *   inventory.json  ->  xx-stack/runtime/platforms.json                 (TS registry)
 *                   ->  opencode-orchestration/opencode/platforms.json  (TS registry)
 *                   ->  hermes-orchestration/config/orchestration.json  (lanes block only)
 *
 * A machine is described ONCE, with its hardware and the runtimes installed on
 * it. Each (machine x runtime) pair becomes a host in the TS registries and a
 * lane in Hermes, inheriting the machine's hardware and execution policy. That
 * is the redundancy this removes: previously the GPU rig's hardware block was written
 * twice in the TS registry and its endpoints a third time in Hermes.
 *
 * Usage:
 *   node xx-stack/scripts/generate-registries.mjs           # write
 *   node xx-stack/scripts/generate-registries.mjs --check   # fail if stale
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const inventoryPath = path.join(repoRoot, "inventory.json");
const checkOnly = process.argv.includes("--check");

/**
 * How each runtime kind maps onto endpoints, providers, and lane families.
 *
 * endpointFamily     — TS registry. Ollama is inspected via /api/tags, so it is
 *                      its own family there.
 * hermesEndpointType — Hermes. It only distinguishes `hermes_cli` from HTTP and
 *                      dials /v1/chat/completions for everything else, so every
 *                      HTTP runtime is openai_compatible on that side.
 */
const RUNTIMES = {
  ollama: {
    hermesEndpointType: "openai_compatible",
    endpointFamily: "ollama",
    scheme: "http",
    laneFamily: "ollama",
    v1Suffix: "/v1",
    provider: (scope) =>
      scope === "localhost" || scope === "loopback" ? "ollama-local" : "ollama",
    supportsResidentModelInspection: true,
  },
  sglang: {
    hermesEndpointType: "openai_compatible",
    endpointFamily: "openai-compatible",
    scheme: "http",
    laneFamily: "openai-compatible",
    v1Suffix: "/v1",
    provider: () => "sglang-remote",
    supportsResidentModelInspection: false,
  },
  "llama-cpp": {
    hermesEndpointType: "openai_compatible",
    endpointFamily: "openai-compatible",
    scheme: "http",
    laneFamily: "openai-compatible",
    v1Suffix: "/v1",
    provider: () => "llama-cpp-local",
    supportsResidentModelInspection: false,
  },
  vllm: {
    hermesEndpointType: "openai_compatible",
    endpointFamily: "openai-compatible",
    scheme: "http",
    laneFamily: "openai-compatible",
    v1Suffix: "/v1",
    provider: () => "vllm",
    supportsResidentModelInspection: false,
  },
  localai: {
    hermesEndpointType: "openai_compatible",
    endpointFamily: "openai-compatible",
    scheme: "http",
    laneFamily: "openai-compatible",
    v1Suffix: "/v1",
    provider: (scope) =>
      scope === "localhost" || scope === "loopback" ? "localai-local" : "localai-remote",
    supportsResidentModelInspection: false,
  },
};

function fail(message) {
  console.error(`generate-registries: ${message}`);
  process.exit(2);
}

const examplePath = path.join(repoRoot, "inventory.example.json");

if (!fs.existsSync(inventoryPath)) {
  fail(
    `no inventory.json found.\n  Start from the template:  cp inventory.example.json inventory.json`
  );
}

const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
const exampleInventory = JSON.parse(fs.readFileSync(examplePath, "utf8"));

// ── shared helpers ───────────────────────────────────────────────────────────

function runtimeSpec(kind) {
  const spec = RUNTIMES[kind];
  if (!spec) {
    fail(`unknown runtime kind "${kind}". Known kinds: ${Object.keys(RUNTIMES).join(", ")}`);
  }
  return spec;
}

function baseUrl(machine, runtime) {
  const spec = runtimeSpec(runtime.kind);
  return `${spec.scheme}://${machine.network.address}:${runtime.port}`;
}

/** Tier id for a (machine, runtime) pair, matching policy.laneOrder vocabulary. */
function tierIdFor(machine, runtime) {
  const scope = machine.network.scope;
  const spec = runtimeSpec(runtime.kind);
  if (scope === "localhost" || scope === "loopback") return "local";
  if (scope === "tailscale") return `tailscale-${spec.laneFamily}`;
  return `${scope}-${spec.laneFamily}`;
}

function hostIdFor(machine, runtime) {
  // A machine running one runtime keeps its own id; multiple runtimes get
  // suffixed so both are addressable and stable across regeneration.
  const siblings = machine.runtimes.filter((r) => r.enabled !== undefined);
  return siblings.length > 1 ? `${machine.id}-${runtime.kind}` : machine.id;
}

function notesFor(machine, runtime) {
  return [machine.network.notes, runtime.notes].filter(Boolean).join(" ");
}

// ── TS registry (platforms.json) ─────────────────────────────────────────────

function buildTsHost(machine, runtime) {
  const spec = runtimeSpec(runtime.kind);
  const host = {
    id: hostIdFor(machine, runtime),
    label: `${machine.label}${machine.runtimes.length > 1 ? ` (${runtime.kind} lane)` : ""}`,
    provider: spec.provider(machine.network.scope),
    endpoint: baseUrl(machine, runtime),
    networkScope: machine.network.scope,
    enabled: runtime.enabled !== false,
  };
  if (runtime.primary) host.primary = true;
  if (runtime.reachable !== undefined) host.reachable = runtime.reachable;

  host.capabilities = {
    endpointFamily: spec.endpointFamily,
    supportsResidentModelInspection: spec.supportsResidentModelInspection,
  };
  if (machine.execution) host.executionPolicy = { ...machine.execution };
  const notes = notesFor(machine, runtime);
  if (notes) host.connectionNotes = notes;
  if (machine.delegation) host.delegationPolicy = { ...machine.delegation };
  if (machine.hardware) host.hardware = JSON.parse(JSON.stringify(machine.hardware));
  host.models = JSON.parse(JSON.stringify(runtime.models ?? []));
  return host;
}

function buildAggregatorHost(agg) {
  const host = {
    id: agg.id,
    label: agg.label,
    provider: `${agg.kind}-proxy`,
    endpoint: `http://${agg.network.address}:${agg.port}`,
    networkScope: agg.network.scope,
    enabled: agg.enabled !== false,
    capabilities: { endpointFamily: "openai-compatible", supportsResidentModelInspection: false },
  };
  if (agg.execution) host.executionPolicy = { ...agg.execution };
  if (agg.notes) host.connectionNotes = agg.notes;
  host.models = JSON.parse(JSON.stringify(agg.models ?? []));
  return host;
}

function buildCloudHosts(cloud) {
  return (cloud?.providers ?? []).map((p) => ({
    id: p.id,
    label: p.label,
    provider: p.provider,
    endpoint: p.endpoint,
    networkScope: "internet",
    enabled: p.enabled === true,
    capabilities: { endpointFamily: "openai-compatible", supportsResidentModelInspection: false },
    ...(p.notes ? { connectionNotes: p.notes } : {}),
    models: p.models ?? [],
  }));
}

function buildTsRegistry(inv) {
  const tiers = new Map();
  const ensureTier = (id, priority) => {
    if (!tiers.has(id)) tiers.set(id, { id, label: id, priority, hosts: [] });
    return tiers.get(id);
  };

  const order = inv.policy.laneOrder;
  order.forEach((id, i) => ensureTier(id, i + 1));

  for (const machine of inv.machines) {
    for (const runtime of machine.runtimes) {
      const tierId = tierIdFor(machine, runtime);
      const tier = ensureTier(tierId, order.indexOf(tierId) + 1 || order.length + 1);
      tier.hosts.push(buildTsHost(machine, runtime));
    }
  }
  for (const agg of inv.aggregators ?? []) {
    ensureTier("local", order.indexOf("local") + 1).hosts.push(buildAggregatorHost(agg));
  }
  const cloudHosts = buildCloudHosts(inv.cloud);
  if (cloudHosts.length) {
    ensureTier("cloud", order.indexOf("cloud") + 1).hosts.push(...cloudHosts);
  }

  const ordered = order.map((id) => tiers.get(id)).filter(Boolean);
  for (const [id, tier] of tiers) if (!order.includes(id)) ordered.push(tier);

  return {
    $schema: "./platforms.schema.json",
    version: 2,
    _generated:
      "Generated from inventory.json by xx-stack/scripts/generate-registries.mjs. Do not hand-edit; run `npm run inventory:sync`.",
    selectionPolicy: {
      defaultOrder: order,
      cloudEscalation: inv.policy.cloudEscalation,
      rules: inv.policy.rules ?? [],
    },
    tiers: ordered,
  };
}

// ── Hermes lanes ─────────────────────────────────────────────────────────────

function buildHermesLanes(inv) {
  const lanes = {};
  for (const machine of inv.machines) {
    for (const runtime of machine.runtimes) {
      // Hermes drives remote self-hosted inference; loopback runtimes are the
      // orchestrator's own host and are not lanes it dials out to.
      if (machine.network.scope === "localhost" || machine.network.scope === "loopback") continue;
      const spec = runtimeSpec(runtime.kind);
      const key = machine.runtimes.length > 1 ? runtime.kind : machine.id;
      lanes[key] = {
        name: `${machine.id}-${runtime.kind}`,
        role: "self_hosted",
        priority: runtime.hermesPriority ?? 50,
        endpoint_type: spec.hermesEndpointType,
        base_url: `${baseUrl(machine, runtime)}${spec.v1Suffix}`,
        model: runtime.models?.[0]?.name ?? null,
        enabled: runtime.enabled !== false,
      };
    }
  }

  const cli = inv.cloud?.hermesCli;
  if (cli) {
    lanes.cloud = {
      name: cli.id,
      role: "cloud",
      priority: cli.hermesPriority ?? 10,
      endpoint_type: cli.endpointType,
      provider: cli.provider,
      base_url: cli.baseUrl,
      model: cli.model,
      fallback_models: cli.fallbackModels ?? [],
      catalog_models: [cli.model, ...(cli.fallbackModels ?? [])],
      chat_probe_on_models_failure: true,
      enabled: cli.enabled !== false,
    };
  }
  return lanes;
}

// ── write / check ────────────────────────────────────────────────────────────

const outputs = [];

const tsRegistry = buildTsRegistry(inventory);
outputs.push({
  file: path.join(repoRoot, "opencode-orchestration", "opencode", "platforms.json"),
  content: JSON.stringify(tsRegistry, null, 2) + "\n",
});

// xx-stack/ is the host-agnostic core, so the registry it SHIPS is built from
// the template, not from your machines. Otherwise every clone of this repo
// would carry the maintainer's hardware as its default.
outputs.push({
  file: path.join(repoRoot, "xx-stack", "runtime", "platforms.json"),
  content: JSON.stringify(buildTsRegistry(exampleInventory), null, 2) + "\n",
});

// Hermes: replace only the lanes block, preserve hand-tuned policy/execution/proxy.
const hermesPath = path.join(repoRoot, "hermes-orchestration", "config", "orchestration.json");
const hermes = JSON.parse(fs.readFileSync(hermesPath, "utf8"));
hermes.lanes = buildHermesLanes(inventory);
hermes.policy = {
  ...hermes.policy,
  self_hosted_first: inventory.policy.selfHostedFirst !== false,
  cloud_enabled_by_default: inventory.policy.cloudEscalation.optIn === true,
  require_manual_cloud_escalation: inventory.policy.cloudEscalation.optIn !== true,
  primary_lane_order: Object.keys(hermes.lanes),
};
outputs.push({ file: hermesPath, content: JSON.stringify(hermes, null, 2) + "\n" });

let stale = 0;
for (const { file, content } of outputs) {
  const rel = path.relative(repoRoot, file);
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (current === content) {
    console.log(`  ok     ${rel}`);
    continue;
  }
  if (checkOnly) {
    console.log(`  STALE  ${rel}`);
    stale++;
  } else {
    fs.writeFileSync(file, content, "utf8");
    console.log(`  wrote  ${rel}`);
  }
}

if (checkOnly && stale > 0) {
  console.error(`\n${stale} generated file(s) are stale. Run: npm run inventory:sync`);
  process.exitCode = 1;
} else if (checkOnly) {
  console.log("\nAll generated registries are current.");
}
