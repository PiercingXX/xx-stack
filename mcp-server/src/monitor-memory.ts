#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

function parseArgs(argv: string[]): CliArgs {
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
      defaults.contextGbPerModel = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--extra-context-gb" && argv[i + 1]) {
      defaults.extraContextGb = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--timeout-ms" && argv[i + 1]) {
      defaults.timeoutMs = Number(argv[i + 1]);
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
  const home = os.homedir();
  const candidates = [
    path.join(home, ".config", "xx-stack", "xx-stack-platforms.json"),
    path.join(process.cwd(), ".xx-stack", "platforms.json"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

function toGb(bytes: number | null | undefined): number {
  if (!bytes || Number.isNaN(bytes)) return 0;
  return Math.round((bytes / 1073741824) * 10) / 10;
}

function formatGb(value: number): string {
  return `${Math.round(value * 10) / 10} GB`;
}

function loadedVramGb(model: ModelEntry): number {
  const raw = typeof model.size_vram === "number" && model.size_vram > 0
    ? model.size_vram
    : model.size;
  return toGb(raw);
}

async function fetchJson(url: string, timeoutMs: number): Promise<any> {
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
      return provider.includes("catalog");
    });
  });
}

async function inspectHost(host: Host, args: CliArgs): Promise<any> {
  const endpoint = (host.endpoint || "").replace(/\/$/, "");
  const reservePercent = Number(host.executionPolicy?.contextReservePercent ?? 25);
  const totalVramGb = Number(host.hardware?.detected?.totalGpuVramGb ?? host.hardware?.detected?.totalVramGb ?? 0);
  const usableVramGb = totalVramGb > 0 ? totalVramGb * (1 - reservePercent / 100) : 0;

  if (!endpoint || (!endpoint.startsWith("http://") && !endpoint.startsWith("https://"))) {
    return {
      hostId: host.id,
      hostLabel: host.label || host.id,
      endpoint,
      status: "invalid-endpoint",
      reservePercent,
      totalVramGb,
      usableVramGb,
      reason: "Host endpoint missing or invalid",
    };
  }

  try {
    const ps = await fetchJson(`${endpoint}/api/ps`, args.timeoutMs);
    const loaded = Array.isArray(ps?.models) ? ps.models as ModelEntry[] : [];
    const loadedModels = loaded.map((model) => ({
      name: model.name || "unknown",
      loadedVramGb: loadedVramGb(model),
    }));

    const usedVramGb = loadedModels.reduce((sum, model) => sum + model.loadedVramGb, 0);
    const peakLoadedModelGb = loadedModels.reduce((max, model) => Math.max(max, model.loadedVramGb), 0);

    let peakCatalogModelGb = 0;
    try {
      const tags = await fetchJson(`${endpoint}/api/tags`, args.timeoutMs);
      const catalog = Array.isArray(tags?.models) ? tags.models as ModelEntry[] : [];
      peakCatalogModelGb = catalog
        .map((model) => toGb(typeof model.size === "number" ? model.size : 0))
        .reduce((max, sizeGb) => Math.max(max, sizeGb), 0);
    } catch {
      peakCatalogModelGb = 0;
    }

    const referenceModelGb = Math.max(peakLoadedModelGb, peakCatalogModelGb);
    const contextHeadroomGb = loadedModels.length * args.contextGbPerModel + args.extraContextGb;
    const estimatedFreeGb = Math.max(0, usableVramGb - usedVramGb - contextHeadroomGb);
    const safeAdditionalLargeModels = referenceModelGb > 0
      ? Math.floor(estimatedFreeGb / referenceModelGb)
      : 0;
    const overload = usableVramGb > 0 && (usedVramGb + contextHeadroomGb) > usableVramGb;

    return {
      hostId: host.id,
      hostLabel: host.label || host.id,
      endpoint,
      status: "ok",
      reservePercent,
      totalVramGb,
      usableVramGb,
      loadedModelCount: loadedModels.length,
      loadedModels,
      usedVramGb: Math.round(usedVramGb * 10) / 10,
      referenceModelGb: Math.round(referenceModelGb * 10) / 10,
      contextHeadroomGb: Math.round(contextHeadroomGb * 10) / 10,
      estimatedFreeGb: Math.round(estimatedFreeGb * 10) / 10,
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
      usableVramGb,
      reason,
    };
  }
}

function printHuman(results: any[], args: CliArgs): void {
  console.log("xx-stack model load monitor");
  console.log(`registry: ${args.registryPath}`);
  console.log(`context headroom formula: loaded_models * ${args.contextGbPerModel} GB + ${args.extraContextGb} GB`);
  console.log("");

  for (const result of results) {
    console.log(`host: ${result.hostLabel} (${result.hostId})`);
    console.log(`endpoint: ${result.endpoint || "n/a"}`);
    console.log(`status: ${result.status}`);
    console.log(`vram total/usable: ${formatGb(result.totalVramGb || 0)} / ${formatGb(result.usableVramGb || 0)} (reserve ${result.reservePercent}%)`);

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
    console.log(`configured slices/models: ${result.configuredMaxParallelSlices}/${result.configuredMaxConcurrentModels}`);
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
    throw new Error(`No hosts with resident model inspection support found in registry: ${args.registryPath}`);
  }

  const results = await Promise.all(hosts.map((host) => inspectHost(host, args)));

  if (args.json) {
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      registryPath: args.registryPath,
      contextGbPerModel: args.contextGbPerModel,
      extraContextGb: args.extraContextGb,
      hosts: results,
    }, null, 2));
    return;
  }

  printHuman(results, args);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`monitor-memory failed: ${message}`);
  process.exit(1);
});
