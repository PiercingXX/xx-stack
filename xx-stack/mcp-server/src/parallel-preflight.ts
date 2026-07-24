#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
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
  models?: Array<{
    name?: string;
    roles?: string[];
    size?: number;
    quantization?: string;
    kernelFamily?: string;
  }>;
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

function parseArgs(argv: string[]): CliArgs {
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
      args.timeoutMs = Number(argv[i + 1]);
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
    const existingRoles = new Map<string, string[]>();
    for (const entry of host.models ?? []) {
      if (!entry?.name) continue;
      existingRoles.set(entry.name, Array.isArray(entry.roles) ? entry.roles : []);
    }

    const syncedModels: NonNullable<Host["models"]> = [];
    for (const model of models) {
      const name = typeof model?.name === "string" ? model.name : "";
      if (!name) {
        continue;
      }
      const roles = existingRoles.get(name) ?? ["imported-from-live-endpoint"];
      syncedModels.push({
        name,
        roles,
        size: typeof model?.size === "number" ? model.size : undefined,
        quantization: model?.details?.quantization_level,
        kernelFamily: model?.details?.family,
      });
    }
    host.models = syncedModels;

    const maxModelSizeGb = models
      .map((model) => (typeof model?.size === "number" ? toGb(model.size) : 0))
      .reduce((max, sizeGb) => Math.max(max, sizeGb), 0);

    host.reachable = true;
    host.hardware = {
      ...(host.hardware ?? {}),
      detected: {
        ...(host.hardware?.detected ?? {}),
        gpuCount: inferGpuCount(host),
        maxModelSizeGb,
        catalogedModelCount: syncedModels.length,
        inventorySyncedAt: new Date().toISOString(),
        inventorySource: "ollama-api-tags",
      },
    };

    return {
      hostId: host.id,
      endpoint,
      reachable: true,
      modelCount: syncedModels.length,
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

  if (args.write) {
    fs.writeFileSync(args.registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  }

  const reachable = results.filter((result) => result.reachable);
  const totalCapacity = reachable.reduce((sum, result) => sum + result.effectiveCapacity, 0);
  const suggestedWave = Math.max(1, totalCapacity);

  console.log("parallel preflight summary");
  console.log(`registry: ${args.registryPath}`);
  console.log(`write mode: ${args.write ? "enabled" : "disabled"}`);
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

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`parallel-preflight failed: ${message}`);
  process.exit(1);
});
