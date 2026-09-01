import { readFile } from "node:fs/promises";

import { guardedExecFile, INTERNAL_VRAM_PROBE } from "./execution_policy.js";
import type { Registry } from "./platform_types.js";
import {
  PATH_CONSTANTS,
  liveRegistryPath,
  repoFileCandidates,
  xxStackRepoRoot,
} from "./runtime_constants.js";

let registryCache: { value: Registry; expiresAt: number } | null = null;
const REGISTRY_CACHE_TTL_MS = 10_000;

/**
 * Test seam for the process-spawning call the hardware probes make.
 *
 * A probe's failure path is only reachable from a test that can decide whether
 * `free` / `lspci` / the VRAM probe succeed, which is not a property of the
 * machine running the suite. Swapped only by `platform_runtime.test.ts`;
 * production never reassigns it.
 */
export const __hardwareIo = { guardedExecFile };

/**
 * The whole-result fast path: set only when every probe has succeeded, so a
 * fully-successful first call still costs three `execFile`s exactly once.
 * Hardware does not change while the process lives, so there is no TTL — but
 * there *is* now an invalidation path, because a partial result is no longer
 * allowed to become permanent (§11.1).
 */
let hardwareCache: Record<string, unknown> | null = null;

/**
 * Per-probe memoization, so a transient failure is not baked in for the life of
 * a long-running stdio server. A probe that succeeds is never run again; a probe
 * that fails is retried on the next call until it has failed
 * MAX_PROBE_ATTEMPTS times, after which it is treated as genuinely absent on
 * this host and costs nothing further. That keeps both properties that matter:
 * a missing `lspci` costs a bounded number of attempts, not one per call, and a
 * probe that was merely busy at startup still gets to report later.
 */
interface HardwareProbeState {
  /** Fields contributed by the probe, set once it succeeds. */
  fields: Record<string, unknown> | null;
  failures: number;
}
const MAX_PROBE_ATTEMPTS = 3;
const hardwareProbes = new Map<string, HardwareProbeState>();

/**
 * Run one probe unless its result is already known. Returns null when the probe
 * did not (or may no longer) contribute — the caller leaves the field unset
 * rather than throwing, which is the pre-existing contract.
 */
async function memoizedProbe(
  name: string,
  probe: () => Promise<Record<string, unknown>>
): Promise<Record<string, unknown> | null> {
  let state = hardwareProbes.get(name);
  if (!state) {
    state = { fields: null, failures: 0 };
    hardwareProbes.set(name, state);
  }
  if (state.fields !== null) return state.fields;
  if (state.failures >= MAX_PROBE_ATTEMPTS) return null;
  try {
    state.fields = await probe();
    return state.fields;
  } catch {
    /* probe unavailable on this attempt; retried until the budget runs out */
    state.failures += 1;
    return null;
  }
}

/** Test-only: drop the whole-result cache and every per-probe memo. */
export function resetHardwareCache(): void {
  hardwareCache = null;
  hardwareProbes.clear();
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
  const repoRoot = xxStackRepoRoot();
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

async function probeRam(): Promise<Record<string, unknown>> {
  const { stdout } = await __hardwareIo.guardedExecFile(
    "free",
    ["-b"],
    { timeout: 3000 },
    { context: "internal" }
  );
  const match = stdout.match(/Mem:\s+(\d+)/);
  // A `free` that runs but prints something unrecognizable is a success with no
  // field, exactly as before — not a failure worth retrying.
  return match ? { ramGb: Math.round((Number(match[1]) / 1073741824) * 10) / 10 } : {};
}

async function probeGpus(): Promise<Record<string, unknown>> {
  const { stdout } = await __hardwareIo.guardedExecFile(
    "lspci",
    [],
    { timeout: 3000 },
    { context: "internal" }
  );
  const gpus = stdout
    .split("\n")
    .filter((line: string) => /vga|3d|display/i.test(line))
    .map((line: string) => line.replace(/^[\da-f:.]+\s+\w.*?:\s*/i, "").trim());
  return { gpus };
}

async function probeVram(): Promise<Record<string, unknown>> {
  const { stdout } = await __hardwareIo.guardedExecFile(
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
  return {
    vramGb: vrams,
    totalVramGb: vrams.reduce((left: number, right: number) => left + right, 0),
  };
}

export async function detectHardware(): Promise<Record<string, unknown>> {
  if (hardwareCache) return hardwareCache;

  // Sequential, as before: three probes that each shell out with a 3s timeout,
  // and nothing here is on a hot path.
  const results = [
    await memoizedProbe("ram", probeRam),
    await memoizedProbe("gpus", probeGpus),
    await memoizedProbe("vram", probeVram),
  ];

  const hw: Record<string, unknown> = {};
  for (const fields of results) {
    if (fields !== null) Object.assign(hw, fields);
  }

  // Only a complete answer is frozen. A partial one used to be cached for the
  // life of the process, so a probe that was transiently missing at the first
  // call could never contribute again (§11.1).
  if (results.every((fields) => fields !== null)) hardwareCache = hw;
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

function isRateTable(value: unknown): value is ModelRates {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Load the per-model rate table from runtime/model-rates.json.
 * Returns { rates: {} } on failure so callers always get a valid shape.
 */
export async function loadModelRates(): Promise<ModelRatesFile> {
  const now = Date.now();
  if (modelRatesCache && now < modelRatesCache.expiresAt) return modelRatesCache.value;

  const candidates = repoFileCandidates(xxStackRepoRoot(), "model-rates.json");

  for (const path of candidates) {
    try {
      const raw = await readFile(path, "utf-8");
      const parsed = JSON.parse(raw) as ModelRatesFile;
      // `typeof null === "object"`, so the old check accepted `"rates": null`
      // and handed it to lookupModelCost, which then threw on property access —
      // the one thing the comment below promises never happens (MCP-6). An
      // array is rejected for the same reason: it indexes but carries no rates.
      if (isRateTable(parsed?.rates)) {
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
 * Compile a rate-table key into an anchored matcher. `*` is the only wildcard —
 * every other character is matched literally, so a model name containing `.`,
 * `+` or `(` cannot be turned into a regex metacharacter by the rate file.
 */
function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .split("*")
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`);
}

/**
 * Resolve a dispatch model name against the rate table's keys (MCP-6).
 *
 * The table is documented as `[modelPattern: string]` and the shipped file keys
 * local lanes as globs (`ollama/*`, `sglang/*`, `vllm/*`), while real dispatch
 * names are `"${provider}/${model}"`. An exact-key lookup therefore never
 * matched a single local lane, and every zero-cost local call reported
 * `costSource: "unknown-model"`.
 *
 * Resolution order, deterministic and independent of key insertion order:
 *   1. an exact key always wins over any wildcard;
 *   2. otherwise the most specific matching glob wins — most literal
 *      (non-wildcard) characters, then fewest wildcards, then lowest key.
 */
export function matchModelRateKey(rates: ModelRates, modelName: string): string | null {
  if (!isRateTable(rates)) return null;
  if (Object.prototype.hasOwnProperty.call(rates, modelName)) return modelName;

  let best: { key: string; literals: number; wildcards: number } | null = null;
  for (const key of Object.keys(rates)) {
    if (!key.includes("*")) continue;
    if (!globToRegExp(key).test(modelName)) continue;
    const wildcards = key.length - key.replace(/\*/g, "").length;
    const literals = key.length - wildcards;
    if (
      best === null ||
      literals > best.literals ||
      (literals === best.literals &&
        (wildcards < best.wildcards || (wildcards === best.wildcards && key < best.key)))
    ) {
      best = { key, literals, wildcards };
    }
  }
  return best?.key ?? null;
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
  const key = matchModelRateKey(rates, modelName);
  const entry = key === null ? undefined : rates[key];
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
