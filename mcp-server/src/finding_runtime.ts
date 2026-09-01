import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { atomicWriteTextFile } from "./io_runtime.js";
import { isMissingFileError, StoreAccessError } from "./supervisor_store_runtime.js";
import {
  canaryCommandFor,
  type BaselineRef,
  type GoalContract,
  type MetricRef,
} from "./task_runtime.js";

/**
 * Evidence lanes. Score is not parenthood: a high number in diagnostic is
 * still a diagnostic, and a force-synthesized salvage never becomes confirmed.
 *
 * - confirmed: durable, parent-eligible, mergeable
 * - incubator: works or looks promising, not confirmed; may become a parent
 *   later if policy allows
 * - diagnostic: controls, failures, traps, canaries — visible, never a parent
 */
export const FINDING_LANE_VALUES = ["confirmed", "incubator", "diagnostic"] as const;
export type FindingLane = (typeof FINDING_LANE_VALUES)[number];

/**
 * Artifact roles. Leaderboards and markdown reports are derived views;
 * they never override canonical state. Partial output is ignored by readers
 * that ask for current truth.
 */
export const ARTIFACT_ROLE_VALUES = [
  "canonical_state",
  "validation_signal",
  "derived_view",
  "audit_snapshot",
  "partial_output",
] as const;
export type ArtifactRole = (typeof ARTIFACT_ROLE_VALUES)[number];

export const FINDING_KIND_VALUES = ["result", "finding", "canary", "mechanism_contract"] as const;
export type FindingKind = (typeof FINDING_KIND_VALUES)[number];

export const CANARY_OUTCOME_VALUES = ["pass", "fail", "could_not_run", "denied"] as const;
export type CanaryOutcome = (typeof CANARY_OUTCOME_VALUES)[number];

/**
 * Surfaces a mechanism contract must not change. Tests, the evaluator, the
 * validation command, CI, and metric calculation are the verifier — editing
 * them to make a goal pass is the reward-hacking the stack already forbids.
 */
export const MECHANISM_FORBIDDEN_SURFACES = [
  "tests",
  "eval",
  "validationCmd",
  "ci",
  "metric-calculation",
] as const;
export type MechanismForbiddenSurface = (typeof MECHANISM_FORBIDDEN_SURFACES)[number];

const FORBIDDEN_SURFACE_SET = new Set<string>(MECHANISM_FORBIDDEN_SURFACES);

export function isForbiddenMechanismSurface(surface: string): boolean {
  return FORBIDDEN_SURFACE_SET.has(surface.trim());
}

/** Statuses that mean the attempt did not finish as a normal completion. */
const FAILED_SOURCE_STATUSES = new Set([
  "blocked",
  "interrupted",
  "exhausted",
  "canceled",
  "failed",
]);

const FORCE_SYNTHESIZED_STATUS = "force_synthesized";

export interface DiversityCell {
  mechanismFamily: string;
  surface: string;
  intent: string;
}

export function diversityCellKey(cell: DiversityCell): string {
  return [
    cell.mechanismFamily.trim().toLowerCase(),
    cell.surface.trim().toLowerCase(),
    cell.intent.trim().toLowerCase(),
  ].join("|");
}

export interface Finding {
  findingId: string;
  kind: FindingKind;
  lane: FindingLane;
  role: ArtifactRole;
  title: string;
  summary: string;
  parentEligible: boolean;
  requestedLane?: FindingLane;
  laneReasonCode: string;
  taskId?: string;
  sessionId?: string;
  generationId?: string;
  sourceStatus?: string;
  metric?: MetricRef;
  /** Measured value for this result. Missing is unknown — never stored as 0. */
  metricValue?: number | "unknown";
  baseline?: BaselineRef;
  diversityCell?: DiversityCell;
  plannedDimensions?: DiversityCell;
  designDimensions?: DiversityCell;
  canaryOutcome?: CanaryOutcome;
  validationCmd?: string;
  caveats: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Generation {
  generationId: string;
  index: number;
  status: "open" | "closed";
  openedAt: string;
  closedAt?: string;
  evidenceCutoffAt?: string;
  cohortTaskIds: string[];
  findingIds: string[];
  lateFindingIds: string[];
  agenda?: string;
  canaryFindingId?: string;
}

export interface FindingStore {
  version: number;
  findings: Record<string, Finding>;
  generations: Record<string, Generation>;
}

const FINDING_STORE_VERSION = 1;

let findingStoreLock: Promise<void> = Promise.resolve();

export async function withFindingStoreLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = findingStoreLock;
  let release: () => void = () => {};
  findingStoreLock = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

export function emptyFindingStore(): FindingStore {
  return { version: FINDING_STORE_VERSION, findings: {}, generations: {} };
}

export function getFindingStatePath(): string {
  return resolve(homedir(), ".config/opencode/xx-stack-finding-state.json");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readFindingStore(): Promise<FindingStore> {
  const path = getFindingStatePath();
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    if (isMissingFileError(error)) return emptyFindingStore();
    throw new StoreAccessError("finding", path, error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new StoreAccessError("finding", path, error);
  }

  if (!isPlainRecord(parsed)) {
    throw new StoreAccessError("finding", path, new Error("store root is not a JSON object"));
  }
  const findings = parsed.findings;
  const generations = parsed.generations;
  if (findings !== undefined && !isPlainRecord(findings)) {
    throw new StoreAccessError("finding", path, new Error("findings is not a JSON object"));
  }
  if (generations !== undefined && !isPlainRecord(generations)) {
    throw new StoreAccessError("finding", path, new Error("generations is not a JSON object"));
  }

  return {
    version: FINDING_STORE_VERSION,
    findings: (findings as FindingStore["findings"]) ?? {},
    generations: (generations as FindingStore["generations"]) ?? {},
  };
}

export async function writeFindingStore(store: FindingStore): Promise<void> {
  const path = getFindingStatePath();
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteTextFile(path, JSON.stringify(store, null, 2) + "\n");
}

export function generateFindingId(): string {
  return `fnd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function generateGenerationId(): string {
  return `gen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface LaneAssignment {
  lane: FindingLane;
  role: ArtifactRole;
  parentEligible: boolean;
  reasonCode: string;
}

export interface AssignLaneInput {
  kind: FindingKind;
  requestedLane?: FindingLane;
  sourceStatus?: string;
  metric?: MetricRef;
  metricValue?: number | "unknown";
  baseline?: BaselineRef;
  parentEligible?: boolean;
  canaryOutcome?: CanaryOutcome;
  late?: boolean;
}

/**
 * The load-bearing policy. Requested lane is a hint; this function is what
 * actually decides membership. A caller cannot promote a salvage, a canary,
 * a mechanism contract, an unknown-direction metric, or a placeholder
 * baseline into confirmed.
 */
export function assignLane(input: AssignLaneInput): LaneAssignment {
  if (input.kind === "canary") {
    return {
      lane: "diagnostic",
      role: "validation_signal",
      parentEligible: false,
      reasonCode: "canary_not_parent",
    };
  }
  if (input.kind === "mechanism_contract") {
    return {
      lane: "diagnostic",
      role: "audit_snapshot",
      parentEligible: false,
      reasonCode: "mechanism_not_parent",
    };
  }

  const source = (input.sourceStatus ?? "").trim();
  if (source === FORCE_SYNTHESIZED_STATUS) {
    return {
      lane: "incubator",
      role: "partial_output",
      parentEligible: false,
      reasonCode: "forced_to_incubator",
    };
  }
  if (FAILED_SOURCE_STATUSES.has(source)) {
    return {
      lane: "diagnostic",
      role: "validation_signal",
      parentEligible: false,
      reasonCode: "forced_to_diagnostic",
    };
  }

  if (input.late) {
    return {
      lane: input.requestedLane === "diagnostic" ? "diagnostic" : "incubator",
      role: "validation_signal",
      parentEligible: false,
      reasonCode: "late_after_generation_boundary",
    };
  }

  if (input.metric && input.metric.direction === "unknown") {
    return {
      lane: "incubator",
      role: "canonical_state",
      parentEligible: false,
      reasonCode: "metric_direction_unknown",
    };
  }
  if (input.metricValue === "unknown") {
    return {
      lane: "incubator",
      role: "canonical_state",
      parentEligible: false,
      reasonCode: "metric_value_unknown",
    };
  }
  if (input.baseline && input.baseline.provenance === "placeholder") {
    return {
      lane: "incubator",
      role: "canonical_state",
      parentEligible: false,
      reasonCode: "baseline_placeholder",
    };
  }

  const requested = input.requestedLane ?? "incubator";
  if (requested === "confirmed") {
    const parentEligible = input.parentEligible !== false;
    return {
      lane: "confirmed",
      role: "canonical_state",
      parentEligible,
      reasonCode: "lane_confirmed",
    };
  }
  if (requested === "diagnostic") {
    return {
      lane: "diagnostic",
      role: "validation_signal",
      parentEligible: false,
      reasonCode: "lane_diagnostic",
    };
  }
  return {
    lane: "incubator",
    role: "canonical_state",
    parentEligible: input.parentEligible === true,
    reasonCode: "lane_incubator",
  };
}

export interface FindingDraft {
  kind: FindingKind;
  title: string;
  summary: string;
  requestedLane?: FindingLane;
  taskId?: string;
  sessionId?: string;
  generationId?: string;
  sourceStatus?: string;
  metric?: MetricRef;
  metricValue?: number | "unknown";
  baseline?: BaselineRef;
  diversityCell?: DiversityCell;
  plannedDimensions?: DiversityCell;
  designDimensions?: DiversityCell;
  canaryOutcome?: CanaryOutcome;
  validationCmd?: string;
  parentEligible?: boolean;
  caveats?: string[];
  findingId?: string;
  createdAt?: string;
}

/**
 * Build a finding. Does not write. Lane policy is applied here so a store
 * write cannot persist a requested confirmed salvage.
 */
export function materializeFinding(draft: FindingDraft, nowIso: string): Finding {
  const assignment = assignLane({
    kind: draft.kind,
    requestedLane: draft.requestedLane,
    sourceStatus: draft.sourceStatus,
    metric: draft.metric,
    metricValue: draft.metricValue,
    baseline: draft.baseline,
    parentEligible: draft.parentEligible,
    canaryOutcome: draft.canaryOutcome,
  });
  const finding: Finding = {
    findingId: draft.findingId ?? generateFindingId(),
    kind: draft.kind,
    lane: assignment.lane,
    role: assignment.role,
    title: draft.title.trim(),
    summary: draft.summary.trim(),
    parentEligible: assignment.parentEligible,
    laneReasonCode: assignment.reasonCode,
    caveats: (draft.caveats ?? [])
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 32),
    createdAt: draft.createdAt ?? nowIso,
    updatedAt: nowIso,
  };
  if (draft.requestedLane) finding.requestedLane = draft.requestedLane;
  if (draft.taskId) finding.taskId = draft.taskId;
  if (draft.sessionId) finding.sessionId = draft.sessionId;
  if (draft.generationId) finding.generationId = draft.generationId;
  if (draft.sourceStatus) finding.sourceStatus = draft.sourceStatus;
  if (draft.metric) finding.metric = draft.metric;
  if (draft.metricValue !== undefined) finding.metricValue = draft.metricValue;
  if (draft.baseline) finding.baseline = draft.baseline;
  if (draft.diversityCell) finding.diversityCell = draft.diversityCell;
  if (draft.plannedDimensions) finding.plannedDimensions = draft.plannedDimensions;
  if (draft.designDimensions) finding.designDimensions = draft.designDimensions;
  if (draft.canaryOutcome) finding.canaryOutcome = draft.canaryOutcome;
  if (draft.validationCmd) finding.validationCmd = draft.validationCmd;
  return finding;
}

export interface IngestResult {
  finding: Finding;
  late: boolean;
  generation?: Generation;
}

/**
 * Insert a finding into the store. If its generation is already closed, the
 * finding remains visible as a late signal and cannot enter that generation's
 * committed findingIds or become a parent.
 */
export function ingestFinding(
  store: FindingStore,
  draft: FindingDraft,
  nowIso: string
): IngestResult {
  const generation = draft.generationId ? store.generations[draft.generationId] : undefined;
  const late = generation?.status === "closed";
  const finding = materializeFinding(draft, nowIso);
  if (late) {
    const lateAssignment = assignLane({
      kind: finding.kind,
      requestedLane: finding.requestedLane,
      sourceStatus: finding.sourceStatus,
      metric: finding.metric,
      metricValue: finding.metricValue,
      baseline: finding.baseline,
      parentEligible: false,
      canaryOutcome: finding.canaryOutcome,
      late: true,
    });
    finding.lane = lateAssignment.lane;
    finding.role = lateAssignment.role;
    finding.parentEligible = false;
    finding.laneReasonCode = lateAssignment.reasonCode;
  }
  store.findings[finding.findingId] = finding;
  if (generation) {
    if (late) {
      if (!generation.lateFindingIds.includes(finding.findingId)) {
        generation.lateFindingIds.push(finding.findingId);
      }
    } else if (!generation.findingIds.includes(finding.findingId)) {
      generation.findingIds.push(finding.findingId);
    }
  }
  return { finding, late, generation };
}

export interface GenerationCanaryCheck {
  ok: boolean;
  required: boolean;
  reasonCode: "canary_not_required" | "canary_ready" | "canary_required" | "canary_could_not_run";
  missingTaskIds: string[];
  blockedTaskIds: string[];
}

/**
 * A canary must run on the unchanged tree before fan-out. Fail (tests already
 * red) is a measured baseline and does not block opening. could_not_run /
 * denied means the harness is broken and fan-out must not start.
 */
export function evaluateGenerationCanary(
  contracts: Array<{ taskId: string; contract: GoalContract }>,
  canaries: Finding[]
): GenerationCanaryCheck {
  const required = contracts.filter((entry) => canaryCommandFor(entry.contract) !== undefined);
  if (required.length === 0) {
    return {
      ok: true,
      required: false,
      reasonCode: "canary_not_required",
      missingTaskIds: [],
      blockedTaskIds: [],
    };
  }

  const byTask = new Map<string, Finding>();
  for (const canary of canaries) {
    if (canary.kind !== "canary" || !canary.taskId) continue;
    byTask.set(canary.taskId, canary);
  }

  const missingTaskIds: string[] = [];
  const blockedTaskIds: string[] = [];
  for (const entry of required) {
    const canary = byTask.get(entry.taskId);
    if (!canary) {
      missingTaskIds.push(entry.taskId);
      continue;
    }
    if (canary.canaryOutcome === "could_not_run" || canary.canaryOutcome === "denied") {
      blockedTaskIds.push(entry.taskId);
    }
  }

  if (blockedTaskIds.length > 0) {
    return {
      ok: false,
      required: true,
      reasonCode: "canary_could_not_run",
      missingTaskIds,
      blockedTaskIds,
    };
  }
  if (missingTaskIds.length > 0) {
    return {
      ok: false,
      required: true,
      reasonCode: "canary_required",
      missingTaskIds,
      blockedTaskIds,
    };
  }
  return {
    ok: true,
    required: true,
    reasonCode: "canary_ready",
    missingTaskIds: [],
    blockedTaskIds: [],
  };
}

export interface OpenGenerationInput {
  index: number;
  cohortTaskIds: string[];
  canaryFindingId?: string;
  openedAt: string;
  generationId?: string;
}

export function openGeneration(store: FindingStore, input: OpenGenerationInput): Generation {
  const generation: Generation = {
    generationId: input.generationId ?? generateGenerationId(),
    index: input.index,
    status: "open",
    openedAt: input.openedAt,
    cohortTaskIds: [...input.cohortTaskIds],
    findingIds: [],
    lateFindingIds: [],
  };
  if (input.canaryFindingId) {
    generation.canaryFindingId = input.canaryFindingId;
    if (!generation.findingIds.includes(input.canaryFindingId)) {
      generation.findingIds.push(input.canaryFindingId);
    }
  }
  store.generations[generation.generationId] = generation;
  return generation;
}

export interface CloseGenerationResult {
  ok: boolean;
  reasonCode: "generation_closed" | "generation_missing" | "generation_already_closed";
  generation?: Generation;
}

/**
 * Commit a generation. After this, new findings that name the same
 * generationId land in lateFindingIds and cannot rewrite committed membership.
 */
export function closeGeneration(
  store: FindingStore,
  generationId: string,
  nowIso: string,
  agenda?: string
): CloseGenerationResult {
  const generation = store.generations[generationId];
  if (!generation) {
    return { ok: false, reasonCode: "generation_missing" };
  }
  if (generation.status === "closed") {
    return { ok: false, reasonCode: "generation_already_closed", generation };
  }
  generation.status = "closed";
  generation.closedAt = nowIso;
  generation.evidenceCutoffAt = nowIso;
  if (agenda !== undefined && agenda.trim()) generation.agenda = agenda.trim();
  return { ok: true, reasonCode: "generation_closed", generation };
}

export interface HypothesisSlice {
  id: string;
  cell: DiversityCell;
}

export interface QdCaps {
  maxSameCell: number;
  maxSameFamilyFraction: number;
}

export const DEFAULT_QD_CAPS: QdCaps = {
  maxSameCell: 1,
  maxSameFamilyFraction: 0.34,
};

export interface QdCollision {
  id: string;
  reasonCode: "duplicate_cell" | "family_cap";
  cellKey: string;
  mechanismFamily: string;
}

export interface QdAllocation {
  ok: boolean;
  assigned: string[];
  collisions: QdCollision[];
  cellCounts: Record<string, number>;
  familyCounts: Record<string, number>;
  caps: { maxSameCell: number; maxSameFamily: number };
}

/**
 * Quality-diversity on *plans*, not hosts. First occupant of a cell/family
 * wins input order. Never assigns peer A's candidate to peer B — it only
 * flags extras so the caller can restack the cohort.
 */
export function allocateHypothesisCohort(
  slices: HypothesisSlice[],
  caps: Partial<QdCaps> = {}
): QdAllocation {
  const maxSameCell = caps.maxSameCell ?? DEFAULT_QD_CAPS.maxSameCell;
  const fraction = caps.maxSameFamilyFraction ?? DEFAULT_QD_CAPS.maxSameFamilyFraction;
  const maxSameFamily = Math.max(1, Math.ceil(slices.length * fraction));
  const cellCounts: Record<string, number> = {};
  const familyCounts: Record<string, number> = {};
  const assigned: string[] = [];
  const collisions: QdCollision[] = [];

  for (const slice of slices) {
    const cellKey = diversityCellKey(slice.cell);
    const family = slice.cell.mechanismFamily.trim().toLowerCase() || "unspecified";
    const cellCount = cellCounts[cellKey] ?? 0;
    const familyCount = familyCounts[family] ?? 0;
    if (cellCount >= maxSameCell) {
      collisions.push({
        id: slice.id,
        reasonCode: "duplicate_cell",
        cellKey,
        mechanismFamily: family,
      });
      continue;
    }
    if (familyCount >= maxSameFamily) {
      collisions.push({
        id: slice.id,
        reasonCode: "family_cap",
        cellKey,
        mechanismFamily: family,
      });
      continue;
    }
    cellCounts[cellKey] = cellCount + 1;
    familyCounts[family] = familyCount + 1;
    assigned.push(slice.id);
  }

  return {
    ok: collisions.length === 0,
    assigned,
    collisions,
    cellCounts,
    familyCounts,
    caps: { maxSameCell, maxSameFamily },
  };
}

export function draftForceSynthesisFinding(input: {
  sessionId: string;
  taskId?: string;
  trigger: string;
  nowIso: string;
}): FindingDraft {
  const title = input.taskId
    ? `Forced synthesis for ${input.taskId}`
    : `Forced synthesis for session ${input.sessionId}`;
  return {
    kind: "finding",
    title,
    summary:
      `Budget, step, or stall threshold tripped (${input.trigger}). ` +
      "Best-effort salvage from partial evidence — not a normal completion.",
    requestedLane: "confirmed",
    taskId: input.taskId,
    sessionId: input.sessionId,
    sourceStatus: FORCE_SYNTHESIZED_STATUS,
    caveats: ["force_synthesized", "partial_output", "not_a_normal_completion"],
    createdAt: input.nowIso,
  };
}

/**
 * Persist incubator findings for a force-synthesized session. Failures to
 * write are returned, never thrown through to the salvage path — losing the
 * salvage prompt because the finding store was unreadable would drop the
 * more important result.
 */
export async function persistForceSynthesisFindings(input: {
  sessionId: string;
  taskIds: string[];
  trigger: string;
  nowIso: string;
}): Promise<{ status: "recorded" | "failed"; findingIds: string[]; detail?: string }> {
  try {
    return await withFindingStoreLock(async () => {
      const store = await readFindingStore();
      const findingIds: string[] = [];
      const targets = input.taskIds.length > 0 ? input.taskIds : [undefined];
      for (const taskId of targets) {
        const ingested = ingestFinding(
          store,
          draftForceSynthesisFinding({
            sessionId: input.sessionId,
            taskId,
            trigger: input.trigger,
            nowIso: input.nowIso,
          }),
          input.nowIso
        );
        findingIds.push(ingested.finding.findingId);
      }
      await writeFindingStore(store);
      return { status: "recorded" as const, findingIds };
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { status: "failed", findingIds: [], detail };
  }
}

export function listFindings(
  store: FindingStore,
  filters: {
    lane?: FindingLane;
    kind?: FindingKind;
    generationId?: string;
    taskId?: string;
    sessionId?: string;
    parentEligible?: boolean;
  } = {}
): Finding[] {
  return Object.values(store.findings)
    .filter((finding) => {
      if (filters.lane && finding.lane !== filters.lane) return false;
      if (filters.kind && finding.kind !== filters.kind) return false;
      if (filters.generationId && finding.generationId !== filters.generationId) return false;
      if (filters.taskId && finding.taskId !== filters.taskId) return false;
      if (filters.sessionId && finding.sessionId !== filters.sessionId) return false;
      if (
        filters.parentEligible !== undefined &&
        finding.parentEligible !== filters.parentEligible
      ) {
        return false;
      }
      return true;
    })
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}
