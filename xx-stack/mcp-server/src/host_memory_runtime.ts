/**
 * VRAM arithmetic for a single host: how much of the card is actually usable,
 * how much the resident models are holding, and whether the next request would
 * push past the reserve.
 *
 * This lived inside `monitor-memory.ts` — a standalone CLI — and nothing else
 * could see it. The watchdog lane ranking needs the same numbers, and MCP-DUP-3
 * records three prior cases where the second copy of a shared calculation
 * drifted from the first. So the arithmetic moved here *before* the second copy
 * existed rather than after: `monitor-memory.ts` imports these functions, and
 * so does the routing probe.
 *
 * Everything here is pure — no fetch, no fs, no clock. Callers supply the
 * numbers they read off `/api/ps` and the registry.
 */

/** Fraction of VRAM held back for KV cache and context, when a host is silent. */
export const DEFAULT_CONTEXT_RESERVE_PERCENT = 25;

/** Per-resident-model context allowance used by the headroom estimate. */
export const DEFAULT_CONTEXT_GB_PER_MODEL = 3;

/** Flat context allowance added on top of the per-model figure. */
export const DEFAULT_EXTRA_CONTEXT_GB = 2;

/** The size fields Ollama's `/api/ps` and `/api/tags` return, in bytes. */
export interface ResidentModelSizes {
  size?: number;
  size_vram?: number;
}

/** Bytes to GB, rounded to one decimal. Non-numeric and zero input give 0. */
export function bytesToGb(bytes: number | null | undefined): number {
  if (!bytes || Number.isNaN(bytes)) return 0;
  return Math.round((bytes / 1073741824) * 10) / 10;
}

/**
 * How much VRAM one resident model is holding. `size_vram` is the amount
 * actually on the card; `size` is the total including any CPU-offloaded layers
 * and is the only figure available for a catalog entry that is not loaded.
 */
export function residentModelVramGb(model: ResidentModelSizes): number {
  const raw =
    typeof model.size_vram === "number" && model.size_vram > 0 ? model.size_vram : model.size;
  return bytesToGb(raw);
}

/** Nameplate VRAM minus the configured context reserve. Zero total stays zero. */
export function usableVramGb(totalVramGb: number, reservePercent: number): number {
  return totalVramGb > 0 ? totalVramGb * (1 - reservePercent / 100) : 0;
}

/** Context allowance for the models currently resident. */
export function contextHeadroomGb(
  residentModelCount: number,
  contextGbPerModel: number = DEFAULT_CONTEXT_GB_PER_MODEL,
  extraContextGb: number = DEFAULT_EXTRA_CONTEXT_GB
): number {
  return residentModelCount * contextGbPerModel + extraContextGb;
}

/** What is left after weights and context, floored at zero. */
export function estimatedFreeGb(usableGb: number, usedGb: number, headroomGb: number): number {
  return Math.max(0, usableGb - usedGb - headroomGb);
}

/**
 * True when the resident weights plus their context allowance already exceed
 * what the reserve leaves usable. A host with no reported VRAM is never called
 * overloaded — that is an unknown, not a saturated card.
 */
export function isOverloaded(usableGb: number, usedGb: number, headroomGb: number): boolean {
  return usableGb > 0 && usedGb + headroomGb > usableGb;
}

export interface HostMemoryPressureInput {
  totalVramGb: number;
  reservePercent?: number;
  /** Per-model resident footprint in GB, one entry per resident model. */
  residentVramGb: number[];
  contextGbPerModel?: number;
  extraContextGb?: number;
}

export interface HostMemoryPressure {
  totalVramGb: number;
  reservePercent: number;
  usableVramGb: number;
  usedVramGb: number;
  contextHeadroomGb: number;
  estimatedFreeGb: number;
  residentModelCount: number;
  overload: boolean;
}

/**
 * The whole picture for one host in a single call. Values are unrounded so a
 * caller that formats to one decimal and a caller that compares numerically get
 * the same underlying figures.
 */
export function computeHostMemoryPressure(input: HostMemoryPressureInput): HostMemoryPressure {
  const reservePercent = input.reservePercent ?? DEFAULT_CONTEXT_RESERVE_PERCENT;
  const usable = usableVramGb(input.totalVramGb, reservePercent);
  const used = input.residentVramGb.reduce((sum, gb) => sum + gb, 0);
  const headroom = contextHeadroomGb(
    input.residentVramGb.length,
    input.contextGbPerModel,
    input.extraContextGb
  );
  return {
    totalVramGb: input.totalVramGb,
    reservePercent,
    usableVramGb: usable,
    usedVramGb: used,
    contextHeadroomGb: headroom,
    estimatedFreeGb: estimatedFreeGb(usable, used, headroom),
    residentModelCount: input.residentVramGb.length,
    overload: isOverloaded(usable, used, headroom),
  };
}
