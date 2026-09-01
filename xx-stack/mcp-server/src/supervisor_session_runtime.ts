import type {
  ReliabilityConfig,
  SupervisorEvent,
  SupervisorRoute,
  SupervisorSessionState,
  SupervisorStore,
} from "./supervisor_store_runtime.js";
import { SUPERVISOR_STORE_VERSION } from "./supervisor_store_runtime.js";

export function shouldAutoReleaseLock(
  recoveryInFlight: boolean | undefined,
  lastRecoveryAt: number | undefined,
  now: number,
  gracePeriodMs: number
): boolean {
  return (
    recoveryInFlight === true &&
    typeof lastRecoveryAt === "number" &&
    now - lastRecoveryAt > gracePeriodMs
  );
}

export function failureKey(host: string, model: string | null): string {
  return `${host}::${model ?? "<none>"}`;
}

export function sessionEvent(type: string, detail: string): SupervisorEvent {
  return {
    at: new Date().toISOString(),
    type,
    detail,
  };
}

export function pushSessionEvent(
  state: SupervisorSessionState,
  type: string,
  detail: string
): void {
  state.events.push(sessionEvent(type, detail));
  if (state.events.length > 64) {
    state.events.splice(0, state.events.length - 64);
  }
}

export function clearCompletionProof(state: SupervisorSessionState): void {
  state.completionEvidenceAt = undefined;
  state.completionEvidenceSummary = undefined;
  state.completionJudgeAt = undefined;
  state.completionJudgeVerdict = undefined;
  state.completionJudgeSummary = undefined;
}

export function makeAttemptId(
  sessionId: string,
  attemptCount: number,
  route: SupervisorRoute | null
): string {
  const host = route?.host ?? "no-host";
  const model = route?.model ?? "no-model";
  return `${sessionId}::${attemptCount}::${host}::${model}`;
}

export function makeRecoveryKey(state: SupervisorSessionState): string {
  const route = state.currentRoute;
  return `${state.sessionId}::${state.attemptCount}::${route?.host ?? "no-host"}::${route?.model ?? "no-model"}::${state.failureCount}`;
}

export function shouldDedupeContinuation(
  lastFingerprint: string | undefined,
  lastAt: number | undefined,
  nextFingerprint: string,
  now: number,
  dedupeWindowMs: number
): boolean {
  return (
    lastFingerprint === nextFingerprint &&
    typeof lastAt === "number" &&
    now - lastAt < dedupeWindowMs
  );
}

export function isAbortWindowActive(
  abortDetectedAt: number | undefined,
  now: number,
  abortWindowMs: number
): boolean {
  return typeof abortDetectedAt === "number" && now - abortDetectedAt < abortWindowMs;
}

export function shouldRequireCompletionValidation(
  lastOutputAt: number | undefined,
  now: number,
  completionValidationWindowMs: number
): boolean {
  return typeof lastOutputAt !== "number" || now - lastOutputAt > completionValidationWindowMs;
}

export function evaluateCompletionReadiness(
  state: SupervisorSessionState,
  now: number,
  reliability: ReliabilityConfig
): { ok: boolean; reasonCode: string } {
  if (
    shouldRequireCompletionValidation(
      state.lastOutputAt,
      now,
      reliability.completionValidationWindowMs
    )
  ) {
    return { ok: false, reasonCode: "completion_validation_failed" };
  }

  if (
    typeof state.completionEvidenceAt !== "number" ||
    now - state.completionEvidenceAt > reliability.completionValidationWindowMs
  ) {
    return { ok: false, reasonCode: "completion_evidence_missing" };
  }

  if (typeof state.lastOutputAt === "number" && state.completionEvidenceAt < state.lastOutputAt) {
    return { ok: false, reasonCode: "completion_evidence_stale" };
  }

  if (
    state.completionJudgeVerdict !== "pass" ||
    typeof state.completionJudgeAt !== "number" ||
    now - state.completionJudgeAt > reliability.completionValidationWindowMs
  ) {
    return { ok: false, reasonCode: "completion_judge_missing_or_failed" };
  }

  if (state.completionJudgeAt < state.completionEvidenceAt) {
    return { ok: false, reasonCode: "completion_judge_before_evidence" };
  }

  return { ok: true, reasonCode: "completion_ready" };
}

export interface ForceSynthesisTrigger {
  triggered: boolean;
  reasonCode:
    | "session_exhausted"
    | "session_blocked"
    | "failure_budget_exhausted"
    | "attempt_budget_exhausted"
    | "hard_session_timeout"
    | "stall_threshold_tripped"
    | "force_synthesis_not_triggered";
}

/**
 * Decide whether a session qualifies for budget-exhausted forced synthesis
 *. Triggered when the budget (attempts/failures),
 * the hard session timeout, or the stall threshold has tripped — the cases
 * where failing over again would discard accumulated partial work.
 */
export function evaluateForceSynthesisTrigger(
  state: SupervisorSessionState,
  now: number,
  reliability: ReliabilityConfig
): ForceSynthesisTrigger {
  if (state.status === "exhausted") {
    return { triggered: true, reasonCode: "session_exhausted" };
  }
  if (state.status === "blocked") {
    return { triggered: true, reasonCode: "session_blocked" };
  }
  if (state.failureCount >= reliability.maxConsecutiveFailures) {
    return { triggered: true, reasonCode: "failure_budget_exhausted" };
  }
  if (state.attemptCount >= reliability.maxAttemptsPerSlice) {
    return { triggered: true, reasonCode: "attempt_budget_exhausted" };
  }
  if (now - state.startedAt >= reliability.hardSessionTimeoutMs) {
    return { triggered: true, reasonCode: "hard_session_timeout" };
  }
  if (now - state.lastProgressAt >= reliability.progressTimeoutMs) {
    return { triggered: true, reasonCode: "stall_threshold_tripped" };
  }
  return { triggered: false, reasonCode: "force_synthesis_not_triggered" };
}

export function parseCompletionValidationReason(detail: string | undefined): string {
  if (!detail) return "completion_validation_failed";
  const [prefix] = detail.split(";");
  const normalized = prefix.trim();
  return normalized.length > 0 ? normalized : "completion_validation_failed";
}

export function buildCompletionRepairChecklist(reasonCode: string): string[] {
  const common = [
    "Refresh the active completion contract and explicitly mark unmet criteria.",
    "Implement the smallest repair set that addresses unmet criteria.",
    "Run deterministic verification commands and capture outputs.",
    "Record evidence with supervisor_record_completion_check (checkType='evidence').",
    "Run completion-judge and record verdict with supervisor_record_completion_check (checkType='judge').",
    "Only call supervisor_complete_session after evidence is fresh and judge verdict is pass.",
  ];

  const specific: Record<string, string[]> = {
    completion_validation_failed: [
      "Generate fresh assistant/tool output before attempting completion.",
    ],
    completion_evidence_missing: [
      "Capture at least one deterministic artifact (test output, command output, or diff proof).",
    ],
    completion_evidence_stale: [
      "Re-run verification after latest output; stale evidence cannot be reused.",
    ],
    completion_judge_missing_or_failed: [
      "Treat judge feedback as blocking; repair all failed criteria before retry.",
    ],
    completion_judge_before_evidence: [
      "Re-record evidence first, then re-run judge so verdict is newer than evidence.",
    ],
    goal_contract_validation_evidence_missing: [
      "Run the goal contract's validationCmd through verify_edit and record its result as completion evidence.",
      "Cite the contract's stopCondition in the evidence summary; do not delete, skip, weaken, or narrow tests to make the goal pass.",
    ],
    completion_memory_drift_detected: [
      "Run agent_memory_get for the guarded agent/scope and inspect snapshot.helperPrompt.",
      "Resolve drift with agent_memory_snapshot_sync (direction='capture' or direction='apply').",
      "Re-run agent_memory_get and confirm snapshot.driftDetected=false before retrying completion.",
    ],
  };

  return [...(specific[reasonCode] ?? []), ...common];
}

export function applySupervisorEventTransition(
  state: SupervisorSessionState,
  eventType: string,
  now: number,
  reliability: ReliabilityConfig,
  detail?: string
): { stateChanged: boolean; reasonCode: string } {
  let stateChanged = false;
  const note = detail ?? "event transition";

  const markProgress = (): void => {
    state.lastProgressAt = now;
    // Genuine progress, so it also anchors the failure-streak decay (MCP-11).
    state.lastObservedProgressAt = now;
    // Progress supersedes a backoff window: a session that is demonstrably
    // moving must not be reported as cooling down (MCP-11).
    state.cooldownUntil = undefined;
    state.status = "running";
    state.recoveryInFlight = false;
    stateChanged = true;
  };

  const markOutput = (): void => {
    state.lastOutputAt = now;
    state.abortDetectedAt = undefined;
    state.pendingCompletionValidationAt = undefined;
    clearCompletionProof(state);
    markProgress();
  };

  switch (eventType) {
    case "session.status.busy":
    case "session.status.retry":
      markProgress();
      pushSessionEvent(state, eventType, note);
      return { stateChanged, reasonCode: "status_progress" };
    case "session.status.idle":
      pushSessionEvent(state, eventType, note);
      if (
        shouldRequireCompletionValidation(
          state.lastOutputAt,
          now,
          reliability.completionValidationWindowMs
        )
      ) {
        state.pendingCompletionValidationAt = now;
        stateChanged = true;
        return { stateChanged, reasonCode: "idle_without_recent_output" };
      }
      return { stateChanged, reasonCode: "idle_with_recent_output" };
    case "session.error":
    case "session.stop":
      state.abortDetectedAt = now;
      state.pendingCompletionValidationAt = now;
      state.recoveryInFlight = false;
      state.status = "cooldown";
      stateChanged = true;
      pushSessionEvent(state, eventType, note);
      return { stateChanged, reasonCode: "abort_window_started" };
    case "message.updated.assistant":
    case "message.part.updated.assistant":
    case "tool.execute.before":
    case "tool.execute.after":
      markOutput();
      pushSessionEvent(state, eventType, note);
      return { stateChanged, reasonCode: "output_progress" };
    default:
      pushSessionEvent(state, eventType, note);
      return { stateChanged, reasonCode: "event_recorded" };
  }
}

/**
 * Should the consecutive-failure streak decay this tick? (MCP-11)
 *
 * The streak is "consecutive failures with no progress in between", so it may
 * only decay when deterministic progress was observed *after* the most recent
 * failure and the configured reset window has elapsed since that failure.
 *
 * The historical condition anchored on `lastProgressAt`, which a fallback bumps
 * even though no progress happened — so a poller slower than the reset window
 * zeroed `failureCount` every tick and `maxConsecutiveFailures` could never
 * trip. Applying a fallback is failure recovery, not progress.
 */
export function shouldResetFailureStreak(
  state: SupervisorSessionState,
  now: number,
  reliability: ReliabilityConfig
): boolean {
  if (state.failureCount <= 0) return false;
  const lastFailureAt = state.lastFailureAt;
  if (typeof lastFailureAt !== "number") return false;
  const progressAt = state.lastObservedProgressAt;
  if (typeof progressAt !== "number" || progressAt <= lastFailureAt) return false;
  return now - lastFailureAt >= reliability.failureResetWindowMs;
}

/**
 * Did pruning actually drop anything? Pruning only ever removes entries, so
 * comparing counts is exact. Inspection paths use this to avoid rewriting the
 * whole store on a read-only poll (MCP-1).
 */
export function pruningRemovedEntries(before: SupervisorStore, after: SupervisorStore): boolean {
  return (
    Object.keys(after.sessions).length !== Object.keys(before.sessions).length ||
    Object.keys(after.hostModelFailures).length !== Object.keys(before.hostModelFailures).length
  );
}

/**
 * Session records that are not usable state (MCP-DEAD-2). Persistence is only
 * proven if what came back off disk is what the supervisor can actually run on:
 * keyed by its own id, with the numeric clocks and the event log every
 * transition mutates.
 */
export function findMalformedSessions(store: SupervisorStore): string[] {
  const malformed: string[] = [];
  for (const [key, session] of Object.entries(store.sessions)) {
    const record = session as Partial<SupervisorSessionState> | null;
    const ok =
      typeof record === "object" &&
      record !== null &&
      record.sessionId === key &&
      typeof record.startedAt === "number" &&
      Number.isFinite(record.startedAt) &&
      typeof record.lastProgressAt === "number" &&
      Number.isFinite(record.lastProgressAt) &&
      typeof record.status === "string" &&
      Array.isArray(record.events);
    if (!ok) malformed.push(key);
  }
  return malformed.sort();
}

export function computeBackoffMs(reliability: ReliabilityConfig, failureCount: number): number {
  const backoff = reliability.backoffInitialMs * Math.pow(2, Math.max(0, failureCount - 1));
  return Math.min(reliability.backoffMaxMs, backoff);
}

export function pruneSupervisorStore(
  store: SupervisorStore,
  reliability: ReliabilityConfig
): SupervisorStore {
  const now = Date.now();
  const pruned: SupervisorStore = {
    version: SUPERVISOR_STORE_VERSION,
    sessions: {},
    hostModelFailures: {},
  };

  for (const [sessionId, state] of Object.entries(store.sessions)) {
    const stale = now - state.lastProgressAt > reliability.staleSessionTtlMs;
    if (!stale) {
      pruned.sessions[sessionId] = state;
    }
  }

  for (const [key, failure] of Object.entries(store.hostModelFailures)) {
    if (
      failure.cooldownUntil &&
      failure.cooldownUntil < now &&
      now - failure.lastFailureAt > reliability.failureResetWindowMs
    ) {
      continue;
    }
    if (now - failure.lastFailureAt > reliability.failureResetWindowMs * 2) {
      continue;
    }
    pruned.hostModelFailures[key] = failure;
  }

  return pruned;
}
