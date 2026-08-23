#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteTextFile } from "./io_runtime.js";
import {
  PATH_CONSTANTS,
  TIER_IDS,
  repoCompatFileCandidates,
  liveRegistryPath,
} from "./runtime_constants.js";

type ModelMeta = {
  name?: string;
  size?: number;
  details?: {
    parameter_size?: string;
    quantization_level?: string;
    family?: string;
  };
};

/**
 * A registry model card. The live endpoint only reports a subset of these —
 * context window, VRAM estimates and tool-use reliability are curated registry
 * data that a sync must preserve, not rebuild.
 */
export type ModelEntry = {
  name?: string;
  roles?: string[];
  size?: number;
  format?: string;
  quantization?: string;
  weightBits?: number;
  kernelFamily?: string;
  contextWindow?: number;
  estimatedVramGb?: number;
  supportsToolUse?: boolean;
  toolCallReliability?: "unknown" | "low" | "validated";
  jsonModeReliability?: "unknown" | "low" | "validated";
};

type Host = {
  id: string;
  label?: string;
  provider?: string;
  endpoint?: string;
  networkScope?: string;
  reachable?: boolean;
  executionPolicy?: {
    maxParallelSlices?: number;
    maxConcurrentModels?: number;
    contextReservePercent?: number;
    scheduling?: string;
  };
  hardware?: {
    summary?: string;
    gpu?: Array<{ name?: string; count?: number } | string>;
    detected?: {
      gpuCount?: number;
      maxModelSizeGb?: number;
      catalogedModelCount?: number;
      inventorySyncedAt?: string;
      inventorySource?: string;
    };
  };
  models?: ModelEntry[];
};

type Tier = {
  id: string;
  hosts?: Host[];
};

type Registry = {
  tiers?: Tier[];
};

type CliArgs = {
  registryPath: string;
  timeoutMs: number;
  write: boolean;
};

type HostSyncResult = {
  hostId: string;
  endpoint: string;
  reachable: boolean;
  modelCount: number;
  maxModelSizeGb: number;
  effectiveCapacity: number;
  reason?: string;
};

/**
 * Numeric CLI values must be finite: `Number("abc")` yields NaN, and a NaN
 * timeout would make every host report unreachable by aborting instantly.
 * Anything unparseable falls back to the default instead.
 */
function parseFiniteNumberArg(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    registryPath: "",
    timeoutMs: 5000,
    write: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--registry" && argv[i + 1]) {
      args.registryPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--timeout-ms" && argv[i + 1]) {
      args.timeoutMs = parseFiniteNumberArg(argv[i + 1], args.timeoutMs);
      i += 1;
      continue;
    }
    if (arg === "--no-write") {
      args.write = false;
    }
  }

  if (!args.registryPath) {
    args.registryPath = resolveRegistryPath();
  }

  return args;
}

function resolveRegistryPath(): string {
  const cwd = process.cwd();
  const workspaceCandidates = repoCompatFileCandidates(cwd, PATH_CONSTANTS.platformsFile);
  for (const candidate of workspaceCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const home = os.homedir();
  const candidates = [liveRegistryPath(home), workspaceCandidates[0]];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

function toGb(bytes: number): number {
  return Math.round((bytes / 1073741824) * 10) / 10;
}

function effectiveCapacity(host: Host): number {
  const slices = Math.max(1, Number(host.executionPolicy?.maxParallelSlices ?? 1));
  const models = Math.max(1, Number(host.executionPolicy?.maxConcurrentModels ?? 1));
  return Math.max(1, Math.min(slices, models));
}

function inferGpuCount(host: Host): number {
  const entries = Array.isArray(host.hardware?.gpu) ? host.hardware?.gpu : [];
  let count = 0;
  for (const entry of entries) {
    if (typeof entry === "string") {
      count += 1;
      continue;
    }
    const maybeCount = Number(entry?.count ?? 1);
    if (Number.isFinite(maybeCount) && maybeCount > 0) {
      count += maybeCount;
    }
  }
  return count;
}

async function fetchJson(url: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fold a live /api/tags catalog into the registry's model cards.
 *
 * The probe is authoritative for name, size, quantization and kernel family,
 * and for nothing else. Everything a card already carries — curated roles,
 * context window, VRAM estimates, tool-use reliability — merges through
 * untouched: rebuilding the entry here once permanently degraded the registry
 * every time a preflight ran.
 */
export function mergeSyncedModels(existing: ModelEntry[], probed: ModelMeta[]): ModelEntry[] {
  const previousByName = new Map<string, ModelEntry>();
  for (const entry of existing) {
    if (!entry?.name) continue;
    previousByName.set(entry.name, entry);
  }

  const merged: ModelEntry[] = [];
  for (const model of probed) {
    const name = typeof model?.name === "string" ? model.name : "";
    if (!name) {
      continue;
    }
    const previous = previousByName.get(name);
    merged.push({
      ...(previous ?? {}),
      name,
      roles: previous
        ? Array.isArray(previous.roles)
          ? previous.roles
          : []
        : ["imported-from-live-endpoint"],
      size: typeof model?.size === "number" ? model.size : undefined,
      quantization: model?.details?.quantization_level,
      kernelFamily: model?.details?.family,
    });
  }
  return merged;
}

async function syncHost(host: Host, timeoutMs: number): Promise<HostSyncResult> {
  const endpoint = (host.endpoint ?? "").replace(/\/$/, "");
  if (!endpoint.startsWith("http://") && !endpoint.startsWith("https://")) {
    host.reachable = false;
    return {
      hostId: host.id,
      endpoint,
      reachable: false,
      modelCount: 0,
      maxModelSizeGb: 0,
      effectiveCapacity: effectiveCapacity(host),
      reason: "invalid endpoint",
    };
  }

  try {
    const tags = await fetchJson(`${endpoint}/api/tags`, timeoutMs);
    const models: ModelMeta[] = Array.isArray(tags?.models) ? tags.models : [];
    host.models = mergeSyncedModels(host.models ?? [], models);

    const maxModelSizeGb = models
      .map((model) => (typeof model?.size === "number" ? toGb(model.size) : 0))
      .reduce((max, sizeGb) => Math.max(max, sizeGb), 0);

    host.reachable = true;
    const syncedCount = host.models?.length ?? 0;
    host.hardware = {
      ...(host.hardware ?? {}),
      detected: {
        ...(host.hardware?.detected ?? {}),
        gpuCount: inferGpuCount(host),
        maxModelSizeGb,
        catalogedModelCount: syncedCount,
        inventorySyncedAt: new Date().toISOString(),
        inventorySource: "ollama-api-tags",
      },
    };

    return {
      hostId: host.id,
      endpoint,
      reachable: true,
      modelCount: syncedCount,
      maxModelSizeGb,
      effectiveCapacity: effectiveCapacity(host),
    };
  } catch (error) {
    host.reachable = false;
    return {
      hostId: host.id,
      endpoint,
      reachable: false,
      modelCount: 0,
      maxModelSizeGb: 0,
      effectiveCapacity: effectiveCapacity(host),
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const raw = fs.readFileSync(args.registryPath, "utf8");
  const registry = JSON.parse(raw) as Registry;
  const remoteTier = (registry.tiers ?? []).find((tier) => tier.id === TIER_IDS.tailscaleOllama);
  const hosts = (remoteTier?.hosts ?? []).filter((host) =>
    (host.provider ?? "").toLowerCase().includes("ollama")
  );

  if (hosts.length === 0) {
    throw new Error(`No remote Ollama hosts found in registry ${args.registryPath}`);
  }

  const results = await Promise.all(hosts.map((host) => syncHost(host, args.timeoutMs)));
  const reachable = results.filter((result) => result.reachable);

  // A probe outage must never become a durable registry change: persist only
  // when something was actually reachable, and then atomically — a plain
  // write here once left the LIVE registry truncated on a crash mid-write.
  let persisted = false;
  if (args.write && reachable.length > 0) {
    await atomicWriteTextFile(args.registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    persisted = true;
  }

  const totalCapacity = reachable.reduce((sum, result) => sum + result.effectiveCapacity, 0);
  const suggestedWave = Math.max(1, totalCapacity);

  console.log("parallel preflight summary");
  console.log(`registry: ${args.registryPath}`);
  console.log(
    `registry write: ${
      !args.write ? "disabled" : persisted ? "applied (atomic)" : "skipped: no reachable hosts"
    }`
  );
  for (const result of results) {
    console.log(`- ${result.hostId} @ ${result.endpoint}`);
    console.log(`  reachable: ${result.reachable}`);
    console.log(`  models: ${result.modelCount}`);
    console.log(`  max-model-size-gb: ${result.maxModelSizeGb}`);
    console.log(`  effective-capacity: ${result.effectiveCapacity}`);
    if (result.reason) {
      console.log(`  reason: ${result.reason}`);
    }
  }
  console.log(`recommended-wave-size: ${suggestedWave}`);

  if (reachable.length === 0) {
    process.exitCode = 1;
  }
}

// --- Direct execution guard (same realpath pattern as cli.ts / index.ts) ---
// Without it, importing this module from a test would run a live preflight.

const isDirectExecution = ((): boolean => {
  if (!process.argv[1]) return false;
  const realOrSelf = (candidate: string): string => {
    try {
      return fs.realpathSync(candidate);
    } catch {
      return path.resolve(candidate);
    }
  };
  return realOrSelf(process.argv[1]) === realOrSelf(fileURLToPath(import.meta.url));
})();

if (isDirectExecution) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`parallel-preflight failed: ${message}`);
    process.exit(1);
  });
}
