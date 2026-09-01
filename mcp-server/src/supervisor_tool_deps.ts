import type {
  ReliabilityConfig,
  SupervisorEvent,
  SupervisorRoute,
  SupervisorSessionState,
  SupervisorStore,
  WatchdogRouteCandidates,
} from "./supervisor_runtime.js";
import type { Registry } from "./platform_types.js";

export interface SupervisorToolDeps {
  withSupervisorStoreLock: <T>(work: () => Promise<T>) => Promise<T>;
  loadRegistry: () => Promise<Registry>;
  loadReliabilityConfig: () => Promise<ReliabilityConfig>;
  readSupervisorStore: () => Promise<SupervisorStore>;
  writeSupervisorStore: (store: SupervisorStore) => Promise<void>;
  pruneSupervisorStore: (store: SupervisorStore, reliability: ReliabilityConfig) => SupervisorStore;
  buildWatchdogRouteCandidates: (
    registry: Registry,
    description: string,
    preferredHost: string | null,
    preferredModel: string | null,
    maxFallbacks: number,
    banned: Set<string>
  ) => Promise<WatchdogRouteCandidates>;
  applySupervisorEventTransition: (
    state: SupervisorSessionState,
    eventType: string,
    now: number,
    reliability: ReliabilityConfig,
    detail?: string
  ) => { stateChanged: boolean; reasonCode: string };
  sessionEvent: (type: string, detail: string) => SupervisorEvent;
  pushSessionEvent: (state: SupervisorSessionState, type: string, detail: string) => void;
  clearCompletionProof: (state: SupervisorSessionState) => void;
  makeAttemptId: (sessionId: string, attemptCount: number, route: SupervisorRoute | null) => string;
  makeRecoveryKey: (state: SupervisorSessionState) => string;
  shouldAutoReleaseLock: (
    recoveryInFlight: boolean | undefined,
    lastRecoveryAt: number | undefined,
    now: number,
    gracePeriodMs: number
  ) => boolean;
  shouldDedupeContinuation: (
    lastFingerprint: string | undefined,
    lastAt: number | undefined,
    nextFingerprint: string,
    now: number,
    dedupeWindowMs: number
  ) => boolean;
  isAbortWindowActive: (
    abortDetectedAt: number | undefined,
    now: number,
    abortWindowMs: number
  ) => boolean;
  evaluateCompletionReadiness: (
    state: SupervisorSessionState,
    now: number,
    reliability: ReliabilityConfig
  ) => { ok: boolean; reasonCode: string };
  parseCompletionValidationReason: (detail: string | undefined) => string;
  buildCompletionRepairChecklist: (reasonCode: string) => string[];
  computeBackoffMs: (reliability: ReliabilityConfig, failureCount: number) => number;
  failureKey: (host: string, model: string | null) => string;
  quickPingEndpoint: (endpoint: string) => Promise<boolean>;
}
