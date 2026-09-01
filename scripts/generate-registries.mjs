#!/usr/bin/env node
/**
 * Fan the canonical inventory out to every consumer config.
 *
 *   inventory.json  ->  runtime/platforms.json                 (TS registry)
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
 *   node scripts/generate-registries.mjs           # write
 *   node scripts/generate-registries.mjs --check   # fail if stale
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inventoryPath = path.join(repoRoot, "inventory.json");
const fallbackInventoryPath = path.join(repoRoot, "inventory.example.json");
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

// Live registries are read by running systems; a half-written file would be
// worse than a stale one, so content lands via rename in the same directory.
function writeFileAtomic(filePath, data) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, data);
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Nothing to clean up.
    }
    throw error;
  }
}

// inventory.json holds your private machine truth (MagicDNS names, hardware)
// and is git-ignored. Until you create it, the shipped template answers, so a
// fresh clone can sync and check without carrying anyone's real inventory.
let inventorySourcePath = inventoryPath;
if (!fs.existsSync(inventoryPath)) {
  inventorySourcePath = fallbackInventoryPath;
  console.log(
    `generate-registries: ${path.basename(inventoryPath)} not found — ` +
      `falling back to ${path.basename(fallbackInventoryPath)}. ` +
      `To describe your own machines: cp ${path.basename(fallbackInventoryPath)} ${path.basename(inventoryPath)}`
  );
}

const exampleInventory = JSON.parse(fs.readFileSync(fallbackInventoryPath, "utf8"));
const inventory =
  inventorySourcePath === fallbackInventoryPath
    ? exampleInventory
    : JSON.parse(fs.readFileSync(inventorySourcePath, "utf8"));

// ── shared helpers ───────────────────────────────────────────────────────────

function runtimeSpec(kind) {
  const spec = RUNTIMES[kind];
  if (!spec) {
    fail(`unknown runtime kind "${kind}". Known kinds: ${Object.keys(RUNTIMES).join(", ")}`);
  }
  return spec;
}

// ── network-scope guard ──────────────────────────────────────────────────────

function ipv4Octets(address) {
  const octets = address.split(".");
  if (octets.length !== 4 || !octets.every((part) => /^[0-9]{1,3}$/.test(part))) return null;
  const numbers = octets.map(Number);
  return numbers.every((number) => number <= 255) ? numbers : null;
}

function isLoopbackAddress(address) {
  const octets = ipv4Octets(address);
  if (octets) return octets[0] === 127;
  return ["localhost", "::1", "[::1]"].includes(address.toLowerCase());
}

const MAGIC_DNS_HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

function isTailscaleAddress(address) {
  // Tailscale assigns out of 100.64.0.0/10 (CGNAT space); a raw IPv4 literal
  // must come from there, while anything else may only be a MagicDNS name.
  const octets = ipv4Octets(address);
  if (octets) return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
  return MAGIC_DNS_HOSTNAME.test(address);
}

/**
 * The rule every emitted endpoint URL must satisfy: the address a lane dials
 * has to be plausible for the scope its machine declares. A "loopback" machine
 * pointing at a routable IP, or a tailscale machine at something that is not a
 * tailnet address or MagicDNS name, is either a typo or a misdeclared machine
 * — both stop generation here instead of shipping as a dialable URL.
 * "internet" scopes declare public reachability themselves, so they are exempt.
 */
function scopedAddressViolation(scope, address) {
  if (scope === "localhost" || scope === "loopback") {
    if (!isLoopbackAddress(address)) {
      return `scope "${scope}" requires an address in 127.0.0.0/8, ::1, or "localhost"`;
    }
    return null;
  }
  if (scope === "tailscale") {
    if (!isTailscaleAddress(address)) {
      return 'scope "tailscale" requires a 100.64.0.0/10 IP or a MagicDNS hostname (.ts.net preferred)';
    }
    return null;
  }
  return null;
}

/** Fail closed: a contradicting endpoint stops generation at the offending machine. */
function assertScopedAddress(network, owner) {
  const address = String(network?.address ?? "").trim();
  if (!address) {
    fail(`${owner}: network.address is empty`);
  }
  const violation = scopedAddressViolation(network?.scope, address);
  if (violation) {
    fail(`${owner}: ${violation}, got "${address}"`);
  }
}

function baseUrl(machine, runtime) {
  assertScopedAddress(machine.network, `machine "${machine.id}" (${runtime.kind})`);
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
  return machine.runtimes.length > 1 ? `${machine.id}-${runtime.kind}` : machine.id;
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
  assertScopedAddress(agg.network, `aggregator "${agg.id}"`);
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
    ensureTier("local", order.indexOf("local") + 1 || order.length + 1).hosts.push(
      buildAggregatorHost(agg)
    );
  }
  const cloudHosts = buildCloudHosts(inv.cloud);
  if (cloudHosts.length) {
    // Same fallback as the tiers above: a laneOrder missing "cloud" must not
    // silently assign priority 0.
    ensureTier("cloud", order.indexOf("cloud") + 1 || order.length + 1).hosts.push(...cloudHosts);
  }

  const ordered = order.map((id) => tiers.get(id)).filter(Boolean);
  for (const [id, tier] of tiers) if (!order.includes(id)) ordered.push(tier);

  return {
    $schema: "./platforms.schema.json",
    version: 2,
    _generated:
      "Generated from inventory.json by scripts/generate-registries.mjs. Do not hand-edit; run `npm run inventory:sync`.",
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
  file: path.join(repoRoot, "runtime", "platforms.json"),
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
    writeFileAtomic(file, content);
    console.log(`  wrote  ${rel}`);
  }
}

if (checkOnly && stale > 0) {
  console.error(`\n${stale} generated file(s) are stale. Run: npm run inventory:sync`);
  process.exitCode = 1;
} else if (checkOnly) {
  console.log("\nAll generated registries are current.");
}
