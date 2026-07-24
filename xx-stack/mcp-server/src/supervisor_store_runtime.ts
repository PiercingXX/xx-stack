import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

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
  status: "running" | "cooldown" | "blocked" | "completed" | "interrupted" | "exhausted";
  startedAt: number;
  lastProgressAt: number;
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
  events: SupervisorEvent[];
}

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

export async function readSupervisorStore(): Promise<SupervisorStore> {
  const path = getSupervisorStatePath();
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SupervisorStore>;
    return {
      version: SUPERVISOR_STORE_VERSION,
      sessions: parsed.sessions ?? {},
      hostModelFailures: parsed.hostModelFailures ?? {},
    };
  } catch {
    return emptySupervisorStore();
  }
}

export async function writeSupervisorStore(store: SupervisorStore): Promise<void> {
  const path = getSupervisorStatePath();
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteTextFile(path, JSON.stringify(store, null, 2) + "\n");
}
