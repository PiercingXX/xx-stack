#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CONTEXT_RESERVE_PERCENT,
  bytesToGb,
  contextHeadroomGb,
  estimatedFreeGb,
  isOverloaded,
  residentModelVramGb,
  usableVramGb,
} from "./host_memory_runtime.js";
import { PATH_CONSTANTS, liveRegistryPath, repoCompatFileCandidates } from "./runtime_constants.js";

type ModelEntry = {
  name?: string;
  size?: number;
  size_vram?: number;
};

type Host = {
  id: string;
  label?: string;
  provider?: string;
  endpoint?: string;
  capabilities?: {
    supportsResidentModelInspection?: boolean;
  };
  executionPolicy?: {
    contextReservePercent?: number;
    maxParallelSlices?: number;
    maxConcurrentModels?: number;
  };
  hardware?: {
    detected?: {
      totalGpuVramGb?: number;
      totalVramGb?: number;
      gpuCount?: number;
    };
  };
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
  contextGbPerModel: number;
  extraContextGb: number;
  timeoutMs: number;
  json: boolean;
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
  const defaults: CliArgs = {
    registryPath: "",
    contextGbPerModel: 3,
    extraContextGb: 2,
    timeoutMs: 3000,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--registry" && argv[i + 1]) {
      defaults.registryPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--context-gb-per-model" && argv[i + 1]) {
      defaults.contextGbPerModel = parseFiniteNumberArg(argv[i + 1], defaults.contextGbPerModel);
      i += 1;
      continue;
    }
    if (arg === "--extra-context-gb" && argv[i + 1]) {
      defaults.extraContextGb = parseFiniteNumberArg(argv[i + 1], defaults.extraContextGb);
      i += 1;
      continue;
    }
    if (arg === "--timeout-ms" && argv[i + 1]) {
      defaults.timeoutMs = parseFiniteNumberArg(argv[i + 1], defaults.timeoutMs);
      i += 1;
      continue;
    }
    if (arg === "--json") {
      defaults.json = true;
    }
  }

  if (!defaults.registryPath) {
    defaults.registryPath = resolveRegistryPath();
  }

  return defaults;
}

function resolveRegistryPath(): string {
  const workspaceCandidates = repoCompatFileCandidates(process.cwd(), PATH_CONSTANTS.platformsFile);
  const candidates = [liveRegistryPath(), ...workspaceCandidates];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

function formatGb(value: number): string {
  return `${Math.round(value * 10) / 10} GB`;
}

async function fetchJson(url: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function collectHosts(registry: Registry): Host[] {
  const tiers = Array.isArray(registry.tiers) ? registry.tiers : [];
  return tiers.flatMap((tier) => {
    const hosts = Array.isArray(tier.hosts) ? tier.hosts : [];
    return hosts.filter((host) => {
      if (typeof host.capabilities?.supportsResidentModelInspection === "boolean") {
        return host.capabilities.supportsResidentModelInspection;
      }
      const provider = (host.provider || "").toLowerCase();
      return provider === "ollama" || provider === "ollama-local";
    });
  });
}

type HostMemoryReportBase = {
  hostId: string;
  hostLabel: string;
  endpoint: string;
  reservePercent: number;
  totalVramGb: number;
  usableVramGb: number;
};

type HostMemoryReportUnavailable = HostMemoryReportBase & {
  status: "invalid-endpoint" | "unreachable";
  reason: string;
};

type HostMemoryReportOk = HostMemoryReportBase & {
  status: "ok";
  loadedModelCount: number;
  loadedModels: Array<{ name: string; loadedVramGb: number }>;
  usedVramGb: number;
  referenceModelGb: number;
  contextHeadroomGb: number;
  estimatedFreeGb: number;
  safeAdditionalLargeModels: number;
  overload: boolean;
  configuredMaxParallelSlices: number;
  configuredMaxConcurrentModels: number;
};

/**
 * Discriminated on `status` so the success-only fields are unreachable until
 * the caller has narrowed past the unavailable cases.
 */
type HostMemoryReport = HostMemoryReportOk | HostMemoryReportUnavailable;

async function inspectHost(host: Host, args: CliArgs): Promise<HostMemoryReport> {
  const endpoint = (host.endpoint || "").replace(/\/$/, "");
  const reservePercent = Number(
    host.executionPolicy?.contextReservePercent ?? DEFAULT_CONTEXT_RESERVE_PERCENT
  );
  const totalVramGb = Number(
    host.hardware?.detected?.totalGpuVramGb ?? host.hardware?.detected?.totalVramGb ?? 0
  );
  const usableVram = usableVramGb(totalVramGb, reservePercent);

  if (!endpoint || (!endpoint.startsWith("http://") && !endpoint.startsWith("https://"))) {
    return {
      hostId: host.id,
      hostLabel: host.label || host.id,
      endpoint,
      status: "invalid-endpoint",
      reservePercent,
      totalVramGb,
      usableVramGb: usableVram,
      reason: "Host endpoint missing or invalid",
    };
  }

  try {
    const ps = await fetchJson(`${endpoint}/api/ps`, args.timeoutMs);
    const loaded = Array.isArray(ps?.models) ? (ps.models as ModelEntry[]) : [];
    const loadedModels = loaded.map((model) => ({
      name: model.name || "unknown",
      loadedVramGb: residentModelVramGb(model),
    }));

    const usedVramGb = loadedModels.reduce((sum, model) => sum + model.loadedVramGb, 0);
    const peakLoadedModelGb = loadedModels.reduce(
      (max, model) => Math.max(max, model.loadedVramGb),
      0
    );

    let peakCatalogModelGb = 0;
    try {
      const tags = await fetchJson(`${endpoint}/api/tags`, args.timeoutMs);
      const catalog = Array.isArray(tags?.models) ? (tags.models as ModelEntry[]) : [];
      peakCatalogModelGb = catalog
        .map((model) => bytesToGb(typeof model.size === "number" ? model.size : 0))
        .reduce((max, sizeGb) => Math.max(max, sizeGb), 0);
    } catch {
      peakCatalogModelGb = 0;
    }

    const referenceModelGb = Math.max(peakLoadedModelGb, peakCatalogModelGb);
    const headroomGb = contextHeadroomGb(
      loadedModels.length,
      args.contextGbPerModel,
      args.extraContextGb
    );
    const freeGb = estimatedFreeGb(usableVram, usedVramGb, headroomGb);
    const safeAdditionalLargeModels =
      referenceModelGb > 0 ? Math.floor(freeGb / referenceModelGb) : 0;
    const overload = isOverloaded(usableVram, usedVramGb, headroomGb);

    return {
      hostId: host.id,
      hostLabel: host.label || host.id,
      endpoint,
      status: "ok",
      reservePercent,
      totalVramGb,
      usableVramGb: usableVram,
      loadedModelCount: loadedModels.length,
      loadedModels,
      usedVramGb: Math.round(usedVramGb * 10) / 10,
      referenceModelGb: Math.round(referenceModelGb * 10) / 10,
      contextHeadroomGb: Math.round(headroomGb * 10) / 10,
      estimatedFreeGb: Math.round(freeGb * 10) / 10,
      safeAdditionalLargeModels,
      overload,
      configuredMaxParallelSlices: Number(host.executionPolicy?.maxParallelSlices ?? 1),
      configuredMaxConcurrentModels: Number(host.executionPolicy?.maxConcurrentModels ?? 1),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      hostId: host.id,
      hostLabel: host.label || host.id,
      endpoint,
      status: "unreachable",
      reservePercent,
      totalVramGb,
      usableVramGb: usableVram,
      reason,
    };
  }
}

function printHuman(results: HostMemoryReport[], args: CliArgs): void {
  console.log("xx-stack model load monitor");
  console.log(`registry: ${args.registryPath}`);
  console.log(
    `context headroom formula: loaded_models * ${args.contextGbPerModel} GB + ${args.extraContextGb} GB`
  );
  console.log("");

  for (const result of results) {
    console.log(`host: ${result.hostLabel} (${result.hostId})`);
    console.log(`endpoint: ${result.endpoint || "n/a"}`);
    console.log(`status: ${result.status}`);
    console.log(
      `vram total/usable: ${formatGb(result.totalVramGb || 0)} / ${formatGb(result.usableVramGb || 0)} (reserve ${result.reservePercent}%)`
    );

    if (result.status !== "ok") {
      if (result.reason) {
        console.log(`reason: ${result.reason}`);
      }
      console.log("");
      continue;
    }

    console.log(`loaded models: ${result.loadedModelCount}`);
    for (const model of result.loadedModels) {
      console.log(`  - ${model.name}: ${formatGb(model.loadedVramGb)}`);
    }
    console.log(`estimated used VRAM: ${formatGb(result.usedVramGb)}`);
    console.log(`reference large-model size: ${formatGb(result.referenceModelGb || 0)}`);
    console.log(`context headroom: ${formatGb(result.contextHeadroomGb)}`);
    console.log(`estimated free VRAM: ${formatGb(result.estimatedFreeGb)}`);
    console.log(`safe additional large models: ${result.safeAdditionalLargeModels}`);
    console.log(
      `configured slices/models: ${result.configuredMaxParallelSlices}/${result.configuredMaxConcurrentModels}`
    );
    if (result.overload) {
      console.log("warning: projected load exceeds usable VRAM after context headroom");
    }
    console.log("");
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const raw = fs.readFileSync(args.registryPath, "utf8");
  const registry = JSON.parse(raw) as Registry;
  const hosts = collectHosts(registry);

  if (hosts.length === 0) {
    throw new Error(
      `No hosts with resident model inspection support found in registry: ${args.registryPath}`
    );
  }

  const results = await Promise.all(hosts.map((host) => inspectHost(host, args)));

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          registryPath: args.registryPath,
          contextGbPerModel: args.contextGbPerModel,
          extraContextGb: args.extraContextGb,
          hosts: results,
        },
        null,
        2
      )
    );
    return;
  }

  printHuman(results, args);
}

// --- Direct execution guard (same realpath pattern as cli.ts / index.ts) ---
// Without it, importing this module from a test would run the monitor.

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
    console.error(`monitor-memory failed: ${message}`);
    process.exit(1);
  });
}
