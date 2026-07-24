#!/usr/bin/env node
/**
 * Discover inference runtimes across your Tailscale network and merge them into
 * inventory.json.
 *
 * Everything discovered is written DISABLED. Nothing starts routing traffic
 * because a scan found it — you turn lanes on deliberately:
 *
 *   npm run inventory:scan              # probe the tailnet, show what changed
 *   npm run inventory:scan -- --write   # merge findings into inventory.json
 *   npm run inventory:enable <machine>  # turn a machine's lanes on
 *   npm run inventory:sync              # regenerate the consumer configs
 *
 * Rescanning is safe and idempotent: your edits (labels, enabled flags,
 * execution policy, notes) are preserved. New machines and runtimes are added;
 * ones that have gone quiet are reported but never silently deleted.
 *
 * Flags:
 *   --write        apply changes to inventory.json (default is a dry run)
 *   --ssh          also try `tailscale ssh <host> nvidia-smi` for real GPU specs
 *   --timeout <ms> per-probe timeout (default 2000)
 *   --json         machine-readable output
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const inventoryPath = path.join(repoRoot, "inventory.json");

const argv = process.argv.slice(2);
const WRITE = argv.includes("--write");
const USE_SSH = argv.includes("--ssh");
const AS_JSON = argv.includes("--json");
const TIMEOUT = Number(argv[argv.indexOf("--timeout") + 1]) || 2000;

/**
 * Ports probed on every peer. `detect` must be cheap and unauthenticated.
 * Order matters only for output readability.
 */
const PROBES = [
  {
    kind: "ollama",
    port: 11434,
    path: "/api/tags",
    models: (b) => (b.models ?? []).map((m) => m.name),
  },
  {
    kind: "sglang",
    port: 30000,
    path: "/v1/models",
    models: (b) => (b.data ?? []).map((m) => m.id),
  },
  { kind: "vllm", port: 8000, path: "/v1/models", models: (b) => (b.data ?? []).map((m) => m.id) },
  {
    kind: "llama-cpp",
    port: 8080,
    path: "/v1/models",
    models: (b) => (b.data ?? []).map((m) => m.id),
  },
  {
    kind: "localai",
    port: 8081,
    path: "/v1/models",
    models: (b) => (b.data ?? []).map((m) => m.id),
  },
];

/** sglang and llama-cpp both answer /v1/models; disambiguate by served model id. */
const DEFAULT_HERMES_PRIORITY = { sglang: 100, vllm: 90, "llama-cpp": 80, localai: 75, ollama: 70 };

function log(...args) {
  if (!AS_JSON) console.log(...args);
}

async function tailscalePeers() {
  try {
    const { stdout } = await execFileAsync("tailscale", ["status", "--json"], { timeout: 10_000 });
    const status = JSON.parse(stdout);
    return Object.values(status.Peer ?? {})
      .filter((p) => p.Online !== false)
      .map((p) => ({
        host: (p.DNSName ?? "").replace(/\.$/, "").split(".")[0] || p.HostName,
        dnsName: (p.DNSName ?? "").replace(/\.$/, ""),
        os: p.OS ?? "",
      }))
      .filter((p) => p.host);
  } catch (error) {
    const reason = error?.code === "ENOENT" ? "tailscale CLI not found on PATH" : error.message;
    console.error(`scan-tailscale: cannot read tailnet status (${reason}).`);
    process.exit(2);
  }
}

async function probe(host, spec) {
  const url = `http://${host}:${spec.port}${spec.path}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = await res.json();
    return { kind: spec.kind, port: spec.port, models: spec.models(body).slice(0, 25) };
  } catch {
    return null;
  }
}

/** Best-effort GPU specs. Requires Tailscale SSH to be enabled for this user. */
async function probeHardwareOverSsh(host) {
  try {
    const { stdout } = await execFileAsync(
      "tailscale",
      ["ssh", host, "nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
      { timeout: 15_000 }
    );
    const rows = stdout.trim().split("\n").filter(Boolean);
    if (!rows.length) return null;
    const byName = new Map();
    let totalVramGb = 0;
    for (const row of rows) {
      const [name, mib] = row.split(",").map((x) => x.trim());
      const vramGb = Math.round(Number(mib) / 1024);
      byName.set(name, { name, count: (byName.get(name)?.count ?? 0) + 1, vramGb });
      totalVramGb += vramGb;
    }
    return {
      gpu: [...byName.values()],
      detected: { gpuCount: rows.length, totalGpuVramGb: totalVramGb },
    };
  } catch {
    return null;
  }
}

// ── scan ─────────────────────────────────────────────────────────────────────

const peers = await tailscalePeers();
log(`Scanning ${peers.length} online Tailscale peer(s)…\n`);

const found = [];
for (const peer of peers) {
  const hits = (await Promise.all(PROBES.map((spec) => probe(peer.host, spec)))).filter(Boolean);
  if (!hits.length) continue;
  const entry = { ...peer, runtimes: hits };
  if (USE_SSH) entry.hardware = await probeHardwareOverSsh(peer.host);
  found.push(entry);
  log(`  ${peer.host}`);
  for (const h of hits) {
    log(`      ${h.kind.padEnd(10)} :${String(h.port).padEnd(6)} ${h.models.length} model(s)`);
  }
  if (entry.hardware) {
    const g = entry.hardware.gpu.map((x) => `${x.count}x ${x.name}`).join(", ");
    log(`      hardware   ${g} (${entry.hardware.detected.totalGpuVramGb} GB total)`);
  }
}

if (!found.length) {
  log("\nNo peers are exposing a known inference runtime.");
  log("If you expected some: the service may be bound to 127.0.0.1 rather than the");
  log("tailnet interface. On the remote box, bind it to the tailnet address");
  log("(`tailscale ip -4`) or 0.0.0.0, then rescan.");
}

// ── merge into inventory.json ────────────────────────────────────────────────

const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
const byId = new Map(inventory.machines.map((m) => [m.id, m]));
const changes = [];

for (const peer of found) {
  let machine = byId.get(peer.host);

  if (!machine) {
    machine = {
      id: peer.host,
      label: `${peer.host}${peer.os ? ` (${peer.os})` : ""}`,
      network: { scope: "tailscale", address: peer.dnsName || peer.host },
      hardware: peer.hardware
        ? { summary: `Discovered via Tailscale scan`, ...peer.hardware }
        : {
            summary: "Discovered via Tailscale scan — hardware not detected",
            gpu: [],
            limits: ["Fill in GPU/RAM details, or rerun the scan with --ssh"],
          },
      runtimes: [],
    };
    inventory.machines.push(machine);
    byId.set(machine.id, machine);
    changes.push({ type: "machine-added", id: machine.id });
  } else if (peer.hardware && !machine.hardware?.detected) {
    machine.hardware = { ...(machine.hardware ?? {}), ...peer.hardware };
    changes.push({ type: "hardware-detected", id: machine.id });
  }

  for (const hit of peer.runtimes) {
    const existing = machine.runtimes.find((r) => r.kind === hit.kind && r.port === hit.port);
    if (existing) {
      // Never touch `enabled` — that is the user's decision, not the scan's.
      if (hit.models.length && !(existing.models ?? []).length) {
        existing.models = hit.models.map((name) => ({ name }));
        changes.push({ type: "models-discovered", id: `${machine.id}.${hit.kind}` });
      }
      continue;
    }
    machine.runtimes.push({
      kind: hit.kind,
      port: hit.port,
      enabled: false,
      hermesPriority: DEFAULT_HERMES_PRIORITY[hit.kind] ?? 50,
      notes: "Discovered by Tailscale scan. Disabled until you turn it on.",
      models: hit.models.map((name) => ({ name })),
    });
    changes.push({ type: "runtime-added", id: `${machine.id}.${hit.kind}:${hit.port}` });
  }
}

// Report machines we know about that did not answer — never auto-delete.
const seen = new Set(found.map((f) => f.host));
const quiet = inventory.machines
  .filter((m) => m.network.scope === "tailscale" && !seen.has(m.id))
  .map((m) => m.id);

if (AS_JSON) {
  console.log(JSON.stringify({ found, changes, quiet, written: WRITE }, null, 2));
} else {
  log("");
  if (!changes.length) {
    log("inventory.json is already up to date with the tailnet.");
  } else {
    log(`${changes.length} change(s):`);
    for (const c of changes) log(`  ${c.type.padEnd(20)} ${c.id}`);
  }
  if (quiet.length) {
    log(`\nKnown but did not answer this scan (left untouched): ${quiet.join(", ")}`);
  }
}

if (WRITE && changes.length) {
  fs.writeFileSync(inventoryPath, JSON.stringify(inventory, null, 2) + "\n", "utf8");
  log(`\nWrote inventory.json. Everything new is DISABLED.`);
  log(`Turn a machine on with:  npm run inventory:enable <machine-id>`);
  log(`Then regenerate configs: npm run inventory:sync`);
} else if (changes.length) {
  log(`\nDry run — nothing written. Re-run with --write to apply.`);
}
