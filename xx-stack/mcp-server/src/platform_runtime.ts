import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { guardedExecFile, INTERNAL_VRAM_PROBE } from "./execution_policy.js";
import type { Registry } from "./platform_types.js";
import { PATH_CONSTANTS, liveRegistryPath, repoFileCandidates } from "./runtime_constants.js";

let registryCache: { value: Registry; expiresAt: number } | null = null;
const REGISTRY_CACHE_TTL_MS = 10_000;

let hardwareCache: Record<string, unknown> | null = null;

export function invalidateRegistryCache(): void {
  registryCache = null;
}

function validateRegistry(value: unknown): Registry {
  if (!value || typeof value !== "object") {
    throw new Error("Registry is not a valid object");
  }
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.tiers)) {
    throw new Error("Registry is missing required 'tiers' array");
  }
  if (!obj.selectionPolicy || typeof obj.selectionPolicy !== "object") {
    throw new Error("Registry is missing required 'selectionPolicy' object");
  }
  const policy = obj.selectionPolicy as Record<string, unknown>;
  if (!Array.isArray(policy.defaultOrder) || (policy.defaultOrder as unknown[]).length === 0) {
    throw new Error("Registry 'selectionPolicy.defaultOrder' must be a non-empty array");
  }
  return value as Registry;
}

async function loadRegistryFromDisk(): Promise<Registry> {
  const livePath = liveRegistryPath();
  const repoRoot = resolve(
    process.env.XX_STACK_REPO || resolve(homedir(), ".config/opencode/skills/xx-stack")
  );
  // Search every known stack-source layout (runtime/, opencode/, .opencode/)
  // rather than assuming the legacy compat directory.
  const repoPaths = repoFileCandidates(repoRoot, PATH_CONSTANTS.platformsFile);

  const errors: string[] = [];
  for (const path of [livePath, ...repoPaths]) {
    try {
      const raw = await readFile(path, "utf-8");
      return validateRegistry(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
  }

  const detail = errors.length > 0 ? ` Errors: ${errors.join("; ")}` : "";
  throw new Error(`No platform registry found. Run setup.sh first.${detail}`);
}

export async function loadRegistry(): Promise<Registry> {
  const now = Date.now();
  if (registryCache && now < registryCache.expiresAt) return registryCache.value;
  const value = await loadRegistryFromDisk();
  registryCache = { value, expiresAt: now + REGISTRY_CACHE_TTL_MS };
  return value;
}

export async function detectHardware(): Promise<Record<string, unknown>> {
  if (hardwareCache) return hardwareCache;
  const hw: Record<string, unknown> = {};

  try {
    const { stdout } = await guardedExecFile(
      "free",
      ["-b"],
      { timeout: 3000 },
      { context: "internal" }
    );
    const match = stdout.match(/Mem:\s+(\d+)/);
    if (match) hw.ramGb = Math.round((Number(match[1]) / 1073741824) * 10) / 10;
  } catch {
    /* probe unavailable on this host; leave field unset */
  }

  try {
    const { stdout } = await guardedExecFile(
      "lspci",
      [],
      { timeout: 3000 },
      { context: "internal" }
    );
    const gpus = stdout
      .split("\n")
      .filter((line: string) => /vga|3d|display/i.test(line))
      .map((line: string) => line.replace(/^[\da-f:.]+\s+\w.*?:\s*/i, "").trim());
    hw.gpus = gpus;
  } catch {
    /* probe unavailable on this host; leave field unset */
  }

  try {
    const { stdout } = await guardedExecFile(
      "bash",
      ["-c", INTERNAL_VRAM_PROBE],
      { timeout: 3000 },
      { context: "internal" }
    );
    const vrams = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((value: string) => Math.round(Number(value) / 1073741824));
    hw.vramGb = vrams;
    hw.totalVramGb = vrams.reduce((left: number, right: number) => left + right, 0);
  } catch {
    /* probe unavailable on this host; leave field unset */
  }

  hardwareCache = hw;
  return hw;
}

export interface ModelRates {
  [modelPattern: string]: {
    costPer1kInputTokens: number;
    costPer1kOutputTokens: number;
    lane: string;
  };
}

export interface ModelRatesFile {
  comment: string;
  rates: ModelRates;
}

let modelRatesCache: { value: ModelRatesFile; expiresAt: number } | null = null;
const MODEL_RATES_CACHE_TTL_MS = 30_000;

/**
 * Load the per-model rate table from xx-stack/runtime/model-rates.json.
 * Returns { rates: {} } on failure so callers always get a valid shape.
 */
export async function loadModelRates(): Promise<ModelRatesFile> {
  const now = Date.now();
  if (modelRatesCache && now < modelRatesCache.expiresAt) return modelRatesCache.value;

  const repoRoot = resolve(
    process.env.XX_STACK_REPO || resolve(homedir(), ".config/opencode/skills/xx-stack")
  );
  const candidates = repoFileCandidates(repoRoot, "model-rates.json");

  for (const path of candidates) {
    try {
      const raw = await readFile(path, "utf-8");
      const parsed = JSON.parse(raw) as ModelRatesFile;
      if (parsed && typeof parsed.rates === "object") {
        modelRatesCache = { value: parsed, expiresAt: now + MODEL_RATES_CACHE_TTL_MS };
        return parsed;
      }
    } catch {
      continue;
    }
  }

  // Return empty rates on failure — never crash the server for a missing rate file.
  const fallback: ModelRatesFile = { comment: "fallback — no rate file found", rates: {} };
  modelRatesCache = { value: fallback, expiresAt: now + MODEL_RATES_CACHE_TTL_MS };
  return fallback;
}

/**
 * Look up cost for a model name. Returns null for unknown models.
 */
export function lookupModelCost(
  rates: ModelRates,
  modelName: string | null | undefined,
  tokensIn: number,
  tokensOut: number
): number | null {
  if (!modelName) return null;
  const entry = rates[modelName];
  if (!entry) return null;
  const costIn = (tokensIn / 1000) * entry.costPer1kInputTokens;
  const costOut = (tokensOut / 1000) * entry.costPer1kOutputTokens;
  return Math.round((costIn + costOut) * 1e6) / 1e6;
}

export async function quickPingEndpoint(endpoint: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const url = new URL("/v1/models", endpoint);
    const res = await fetch(url.toString(), { method: "GET", signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
