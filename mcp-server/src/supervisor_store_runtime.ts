import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { jsonContent, type JsonToolResult } from "./agent_tool_helpers.js";
import {
  getRepoConfigPath,
  getUserConfigPath,
  readJson,
  toPositiveNumber,
} from "./config_runtime.js";
import { atomicWriteTextFile } from "./io_runtime.js";
import type { CompletionMemorySyncGuard } from "./memory_runtime.js";

export interface ReliabilityConfig {
  watchdogEnabled: boolean;
  progressTimeoutMs: number;
  hardSessionTimeoutMs: number;
  staleSessionTtlMs: number;
  maxAttemptsPerSlice: number;
  maxConsecutiveFailures: number;
  backoffInitialMs: number;
  backoffMaxMs: number;
  failureResetWindowMs: number;
  banHostModelAfterFailures: number;
  retryDedupeWindowMs: number;
  abortWindowMs: number;
  completionValidationWindowMs: number;
}

export interface SupervisorRoute {
  tier: string;
  host: string;
  endpoint: string;
  model: string | null;
}

export interface SupervisorEvent {
  at: string;
  type: string;
  detail: string;
}

export interface SupervisorSessionState {
  sessionId: string;
  description: string;
  status:
    | "running"
    | "cooldown"
    | "blocked"
    | "completed"
    | "interrupted"
    | "exhausted"
    // Terminal state between success and failure: budget/step/stall threshold
    // tripped and the supervisor demanded a best-effort synthesis from the
    // evidence gathered so far. Never presented as a normal completion.
    | "force_synthesized";
  startedAt: number;
  /**
   * Last time the session was considered "moving". Bumped by genuine progress
   * AND by a failover (so the new lane gets a fresh stall window), which is why
   * it must never be used to decide whether a failure streak decayed — see
   * `lastObservedProgressAt` (MCP-11).
   */
  lastProgressAt: number;
  /**
   * Last time deterministic progress was actually observed (progress tick or a
   * status/output event). Never bumped by a fallback: applying a fallback is a
   * failure recovery, not progress.
   */
  lastObservedProgressAt?: number;
  /** Last time a stall was counted against `failureCount`. */
  lastFailureAt?: number;
  lastOutputAt?: number;
  completionEvidenceAt?: number;
  completionEvidenceSummary?: string;
  completionJudgeAt?: number;
  completionJudgeVerdict?: "pass" | "fail";
  completionJudgeSummary?: string;
  completionMemorySync?: CompletionMemorySyncGuard;
  abortDetectedAt?: number;
  cooldownUntil?: number;
  pendingCompletionValidationAt?: number;
  attemptCount: number;
  failureCount: number;
  currentRoute: SupervisorRoute | null;
  fallbackRoutes: SupervisorRoute[];
  nextFallbackIndex: number;
  continuationCount: number;
  currentAttemptId?: string;
  recoveryInFlight?: boolean;
  lastRecoveryKey?: string;
  lastRecoveryAt?: number;
  lastContinuationFingerprint?: string;
  lastContinuationAt?: number;
  forceSynthesisAt?: number;
  forceSynthesisTrigger?: string;
  events: SupervisorEvent[];
}

/**
 * Session statuses that are over. Terminal is terminal: a session in one of
 * these has a finished record, and a control-plane request to end it again is
 * a no-op rather than a rewrite. `blocked` and `cooldown` are deliberately
 * absent — both are live sessions that can still move.
 *
 * This lives beside the status union so the set cannot drift from it. It is
 * the single definition; `hook_tools.ts` and `supervisor_session_tools.ts`
 * import it rather than keeping parallel copies (MCP-DUP-3).
 */
export const SUPERVISOR_TERMINAL_STATUSES = new Set<SupervisorSessionState["status"]>([
  "completed",
  "interrupted",
  "exhausted",
  "force_synthesized",
]);

export interface HostModelFailure {
  count: number;
  lastFailureAt: number;
  cooldownUntil?: number;
}

export interface SupervisorStore {
  version: number;
  sessions: Record<string, SupervisorSessionState>;
  hostModelFailures: Record<string, HostModelFailure>;
}

export interface WatchdogRouteCandidates {
  primary: SupervisorRoute | null;
  healthyPrimary: boolean;
  candidates: SupervisorRoute[];
  health: Array<Record<string, unknown>>;
}

export const SUPERVISOR_STORE_VERSION = 1;

export const DEFAULT_RELIABILITY: ReliabilityConfig = {
  watchdogEnabled: true,
  progressTimeoutMs: 25_000,
  hardSessionTimeoutMs: 120_000,
  staleSessionTtlMs: 30 * 60_000,
  maxAttemptsPerSlice: 4,
  maxConsecutiveFailures: 5,
  backoffInitialMs: 2_000,
  backoffMaxMs: 60_000,
  failureResetWindowMs: 5 * 60_000,
  banHostModelAfterFailures: 2,
  retryDedupeWindowMs: 4_000,
  abortWindowMs: 6_000,
  completionValidationWindowMs: 90_000,
};

let supervisorStoreLock: Promise<void> = Promise.resolve();

export async function withSupervisorStoreLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = supervisorStoreLock;
  let release: () => void = () => {};
  supervisorStoreLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

export function emptySupervisorStore(): SupervisorStore {
  return {
    version: SUPERVISOR_STORE_VERSION,
    sessions: {},
    hostModelFailures: {},
  };
}

function getSupervisorStatePath(): string {
  return resolve(homedir(), ".config/opencode/xx-stack-supervisor-state.json");
}

export async function loadReliabilityConfig(): Promise<ReliabilityConfig> {
  const userConfigPath = getUserConfigPath();
  const repoConfigPath = getRepoConfigPath();

  const [userConfig, repoConfig] = await Promise.all([
    readJson(userConfigPath),
    readJson(repoConfigPath),
  ]);

  const fromConfig = (config: Record<string, unknown> | null): Record<string, unknown> | null => {
    if (!config) return null;
    const agent = config.agent;
    if (!agent || typeof agent !== "object") return null;
    const orchestrator = (agent as Record<string, unknown>)["execution-orchestrator"];
    if (!orchestrator || typeof orchestrator !== "object") return null;
    const reliability = (orchestrator as Record<string, unknown>).reliability;
    if (!reliability || typeof reliability !== "object") return null;
    return reliability as Record<string, unknown>;
  };

  const reliability = {
    ...(fromConfig(repoConfig) ?? {}),
    ...(fromConfig(userConfig) ?? {}),
  };

  return {
    watchdogEnabled: reliability.watchdogEnabled !== false,
    progressTimeoutMs: toPositiveNumber(
      reliability.progressTimeoutMs,
      DEFAULT_RELIABILITY.progressTimeoutMs
    ),
    hardSessionTimeoutMs: toPositiveNumber(
      reliability.hardSessionTimeoutMs,
      DEFAULT_RELIABILITY.hardSessionTimeoutMs
    ),
    staleSessionTtlMs: toPositiveNumber(
      reliability.staleSessionTtlMs,
      DEFAULT_RELIABILITY.staleSessionTtlMs
    ),
    maxAttemptsPerSlice: Math.max(
      1,
      Math.floor(
        toPositiveNumber(reliability.maxAttemptsPerSlice, DEFAULT_RELIABILITY.maxAttemptsPerSlice)
      )
    ),
    maxConsecutiveFailures: Math.max(
      1,
      Math.floor(
        toPositiveNumber(
          reliability.maxConsecutiveFailures,
          DEFAULT_RELIABILITY.maxConsecutiveFailures
        )
      )
    ),
    backoffInitialMs: toPositiveNumber(
      reliability.backoffInitialMs,
      DEFAULT_RELIABILITY.backoffInitialMs
    ),
    backoffMaxMs: toPositiveNumber(reliability.backoffMaxMs, DEFAULT_RELIABILITY.backoffMaxMs),
    failureResetWindowMs: toPositiveNumber(
      reliability.failureResetWindowMs,
      DEFAULT_RELIABILITY.failureResetWindowMs
    ),
    banHostModelAfterFailures: Math.max(
      1,
      Math.floor(
        toPositiveNumber(
          reliability.banHostModelAfterFailures,
          DEFAULT_RELIABILITY.banHostModelAfterFailures
        )
      )
    ),
    retryDedupeWindowMs: toPositiveNumber(
      reliability.retryDedupeWindowMs,
      DEFAULT_RELIABILITY.retryDedupeWindowMs
    ),
    abortWindowMs: toPositiveNumber(reliability.abortWindowMs, DEFAULT_RELIABILITY.abortWindowMs),
    completionValidationWindowMs: toPositiveNumber(
      reliability.completionValidationWindowMs,
      DEFAULT_RELIABILITY.completionValidationWindowMs
    ),
  };
}

/**
 * A store file that exists but cannot be read or parsed (MCP-1).
 *
 * The stores are read-modify-write-whole-document, so treating an unreadable
 * file as "empty" makes the very next write truncate every session/task. Only a
 * genuinely missing file is an empty store; everything else — parse error,
 * EACCES, EIO, a truncated document — raises this and the caller decides.
 */
export class StoreAccessError extends Error {
  readonly store: "supervisor" | "task" | "finding";
  readonly path: string;
  readonly code: string | null;

  constructor(store: "supervisor" | "task" | "finding", path: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`${store} store at ${path} exists but could not be read: ${detail}`, { cause });
    this.name = "StoreAccessError";
    this.store = store;
    this.path = path;
    const code = (cause as NodeJS.ErrnoException | null)?.code;
    this.code = typeof code === "string" ? code : null;
  }

  /** Structured tool payload: a failed read is reported, never silently healed. */
  toToolPayload(): Record<string, unknown> {
    return {
      status: "error",
      reasonCode: "store_unavailable",
      store: this.store,
      path: this.path,
      errorCode: this.code,
      detail: this.message,
      remediation:
        "The state file exists but is unreadable or corrupt. Nothing was written — inspect or restore the file before retrying; the request was not applied.",
    };
  }
}

/** True only for a genuinely missing file — the one case that means "empty store". */
export function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** The structured payload for a store-access failure, or null for other errors. */
export function storeAccessErrorPayload(error: unknown): Record<string, unknown> | null {
  return error instanceof StoreAccessError ? error.toToolPayload() : null;
}

/**
 * Turn a store-access failure into a structured tool result instead of letting
 * it escape the handler and crash the server (MCP-1). Any other error still
 * propagates — this guard exists to report unreadable state, not to swallow bugs.
 */
export async function guardStoreAccess(
  work: () => Promise<JsonToolResult>
): Promise<JsonToolResult> {
  try {
    return await work();
  } catch (error) {
    const payload = storeAccessErrorPayload(error);
    if (!payload) throw error;
    return jsonContent(payload);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readSupervisorStore(): Promise<SupervisorStore> {
  const path = getSupervisorStatePath();
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    // A missing file is the only "empty store" case. Anything else (EACCES,
    // EIO, EISDIR, ...) must fail loudly: the next write would truncate the
    // whole document.
    if (isMissingFileError(error)) return emptySupervisorStore();
    throw new StoreAccessError("supervisor", path, error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new StoreAccessError("supervisor", path, error);
  }

  if (!isPlainRecord(parsed)) {
    throw new StoreAccessError("supervisor", path, new Error("store root is not a JSON object"));
  }
  const sessions = parsed.sessions;
  const hostModelFailures = parsed.hostModelFailures;
  if (sessions !== undefined && !isPlainRecord(sessions)) {
    throw new StoreAccessError("supervisor", path, new Error("sessions is not a JSON object"));
  }
  if (hostModelFailures !== undefined && !isPlainRecord(hostModelFailures)) {
    throw new StoreAccessError(
      "supervisor",
      path,
      new Error("hostModelFailures is not a JSON object")
    );
  }

  return {
    version: SUPERVISOR_STORE_VERSION,
    sessions: (sessions as SupervisorStore["sessions"]) ?? {},
    hostModelFailures: (hostModelFailures as SupervisorStore["hostModelFailures"]) ?? {},
  };
}

export async function writeSupervisorStore(store: SupervisorStore): Promise<void> {
  const path = getSupervisorStatePath();
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteTextFile(path, JSON.stringify(store, null, 2) + "\n");
}
