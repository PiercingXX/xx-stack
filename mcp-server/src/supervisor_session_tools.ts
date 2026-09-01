import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolve } from "node:path";

import { emitLifecycleHooks } from "./execution_policy.js";
import { logEvent } from "./log_worker.js";
import type { SupervisorRoute, SupervisorSessionState } from "./supervisor_runtime.js";
import { shouldResetFailureStreak } from "./supervisor_runtime.js";
import { guardStoreAccess, SUPERVISOR_TERMINAL_STATUSES } from "./supervisor_store_runtime.js";
import type { SupervisorToolDeps } from "./supervisor_tool_deps.js";
import { revokeSessionTaskLeases } from "./task_runtime.js";

import { jsonContent } from "./agent_tool_helpers.js";
import { toolAnnotations } from "./observability_tools.js";

/**
 * Identifiers accepted at the tool boundary.
 *
 * Session and agent ids are not opaque: `log_worker` derives a per-session
 * `.jsonl` path from the session id and the memory runtime derives a memory
 * entrypoint path from the agent id. Both sanitize defensively (MCP-7), so a
 * traversal is already neutralized wherever a path is built — but neutralizing
 * a value is weaker than never accepting it. Constraining the id here makes
 * `../../../tmp/x` unrepresentable: it is rejected by the schema before any
 * handler, store key, or path builder sees it, and any future path builder
 * inherits the guarantee without having to remember the sanitizer.
 *
 * Deliberately narrow: letters, digits, `.`, `_`, `-`, 1-128 chars. Whitespace
 * padding and the empty string are rejected rather than trimmed away.
 */
const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * The pattern alone still admits `.`, `..`, and `...`, which are exactly the
 * traversal primitives — a path segment must carry real content, so at least
 * one alphanumeric character is required.
 */
function safeId(description: string): z.ZodType<string, string> {
  return z
    .string()
    .regex(SAFE_ID_PATTERN, "must be 1-128 characters of letters, digits, '.', '_' or '-'")
    .refine((value) => /[A-Za-z0-9]/.test(value), {
      message: "must contain at least one letter or digit; dot-only identifiers are rejected",
    })
    .describe(description);
}

export function registerSupervisorSessionTools(server: McpServer, deps: SupervisorToolDeps): void {
  server.registerTool(
    "supervisor_start_session",
    {
      description:
        "Start or restart a supervised orchestrator session with persisted fallback state",
      inputSchema: {
        sessionId: safeId(
          "Optional supervisor session ID; letters/digits/._- only, generated when omitted"
        ).optional(),
        description: z.string().describe("Task description this session should supervise"),
        preferredHost: z.string().optional().describe("Preferred host ID for primary attempt"),
        preferredModel: z.string().optional().describe("Preferred model for primary attempt"),
        maxFallbacks: z
          .number()
          .int()
          .min(1)
          .max(8)
          .optional()
          .describe("Maximum fallback routes to precompute"),
        forceRestart: z
          .boolean()
          .optional()
          .describe("Replace an existing session with the same ID"),
        memorySync: z
          .object({
            agentId: safeId(
              "Agent identifier to enforce memory snapshot sync on completion; letters/digits/._- only"
            ),
            scope: z
              .enum(["user", "project", "local"])
              .optional()
              .describe("Memory scope to enforce; defaults to project"),
            cwd: z
              .string()
              .optional()
              .describe(
                "Project root used for project/local scope; defaults to current process cwd"
              ),
          })
          .optional()
          .describe("Optional memory sync guard for completion gating"),
      },
      annotations: toolAnnotations("supervisor_start_session"),
    },
    async ({
      sessionId,
      description,
      preferredHost,
      preferredModel,
      maxFallbacks,
      forceRestart,
      memorySync,
    }) =>
      guardStoreAccess(() =>
        deps.withSupervisorStoreLock(async () => {
          const registry = await deps.loadRegistry();
          const reliability = await deps.loadReliabilityConfig();
          const store = deps.pruneSupervisorStore(await deps.readSupervisorStore(), reliability);
          const id =
            sessionId?.trim() ||
            `sx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

          if (store.sessions[id] && !forceRestart) {
            return jsonContent({
              status: "exists",
              sessionId: id,
              session: store.sessions[id],
              message: "Session already exists. Use forceRestart=true to replace it.",
            });
          }

          const now = Date.now();
          const banned = new Set<string>();
          for (const [key, failure] of Object.entries(store.hostModelFailures)) {
            if (
              (failure.cooldownUntil ?? 0) > now &&
              failure.count >= reliability.banHostModelAfterFailures
            ) {
              banned.add(key);
            }
          }

          const candidates = await deps.buildWatchdogRouteCandidates(
            registry,
            description,
            preferredHost ?? null,
            preferredModel ?? null,
            maxFallbacks ?? 3,
            banned
          );

          const selected = candidates.healthyPrimary
            ? candidates.primary
            : (candidates.candidates[0] ?? null);

          void logEvent("server", "session.started", {
            sessionId: id,
            description,
            healthyPrimary: candidates.healthyPrimary,
            fallbackCount: candidates.candidates.length,
            selectedHost: selected?.host ?? null,
            selectedModel: selected?.model ?? null,
          });

          const state: SupervisorSessionState = {
            sessionId: id,
            description,
            status: selected ? "running" : "blocked",
            startedAt: now,
            lastProgressAt: now,
            lastOutputAt: undefined,
            completionEvidenceAt: undefined,
            completionEvidenceSummary: undefined,
            completionJudgeAt: undefined,
            completionJudgeVerdict: undefined,
            completionJudgeSummary: undefined,
            completionMemorySync: memorySync
              ? {
                  agentId: memorySync.agentId.trim(),
                  scope: memorySync.scope ?? "project",
                  cwd: resolve(memorySync.cwd ?? process.cwd()),
                }
              : undefined,
            attemptCount: selected ? 1 : 0,
            failureCount: 0,
            currentRoute: selected,
            fallbackRoutes: candidates.healthyPrimary
              ? candidates.candidates
              : candidates.candidates.slice(1),
            nextFallbackIndex: 0,
            continuationCount: 0,
            currentAttemptId: selected ? deps.makeAttemptId(id, 1, selected) : undefined,
            recoveryInFlight: false,
            events: [
              deps.sessionEvent(
                "session.started",
                selected
                  ? `primary route: ${selected.host}/${selected.model ?? "<none>"}`
                  : "no healthy route available at start"
              ),
            ],
          };

          store.sessions[id] = state;
          await deps.writeSupervisorStore(store);

          return jsonContent({
            status: state.status,
            reasonCode: state.status === "blocked" ? "start_no_healthy_route" : "start_ok",
            sessionId: id,
            reliability,
            completionMemorySync: state.completionMemorySync ?? null,
            currentAttemptId: state.currentAttemptId,
            currentRoute: state.currentRoute,
            fallbackQueueDepth: state.fallbackRoutes.length,
            routeHealth: candidates.health,
          });
        })
      )
  );

  server.registerTool(
    "supervisor_record_event",
    {
      description:
        "Record canonical session lifecycle events (status, error, stop, and output updates) and apply transition logic",
      inputSchema: {
        sessionId: safeId("Supervisor session ID"),
        eventType: z
          .enum([
            "session.status.busy",
            "session.status.retry",
            "session.status.idle",
            "session.error",
            "session.stop",
            "message.updated.assistant",
            "message.part.updated.assistant",
            "tool.execute.before",
            "tool.execute.after",
            "session.custom",
          ])
          .describe("Event type to apply"),
        detail: z.string().optional().describe("Optional event detail"),
      },
      annotations: toolAnnotations("supervisor_record_event"),
    },
    async ({ sessionId, eventType, detail }) =>
      guardStoreAccess(async () => {
        // Same hazard as MCP-12 on the task store: the supervisor store lock is
        // a non-reentrant promise-chain mutex, and a lifecycle hook is an
        // external subprocess that may call back into these tools. Everything
        // the hook and the response need is captured under the lock; the hook
        // is emitted after it is released.
        const recorded = await deps.withSupervisorStoreLock(async () => {
          const reliability = await deps.loadReliabilityConfig();
          const store = deps.pruneSupervisorStore(await deps.readSupervisorStore(), reliability);
          const state = store.sessions[sessionId];

          if (!state) {
            return null;
          }

          const now = Date.now();
          const transition = deps.applySupervisorEventTransition(
            state,
            eventType,
            now,
            reliability,
            detail
          );
          await deps.writeSupervisorStore(store);

          return {
            status: state.status,
            reasonCode: transition.reasonCode,
            stateChanged: transition.stateChanged,
            lastProgressAt: state.lastProgressAt,
            lastOutputAt: state.lastOutputAt,
            abortDetectedAt: state.abortDetectedAt,
            pendingCompletionValidationAt: state.pendingCompletionValidationAt,
            currentAttemptId: state.currentAttemptId,
          };
        });

        if (!recorded) {
          return jsonContent({ status: "missing", sessionId });
        }

        const hookSummary = await emitLifecycleHooks("supervisor.event_recorded", {
          sessionId,
          eventType,
          reasonCode: recorded.reasonCode,
          status: recorded.status,
        });

        return jsonContent({
          status: recorded.status,
          reasonCode: recorded.reasonCode,
          sessionId,
          eventType,
          stateChanged: recorded.stateChanged,
          hooks: hookSummary,
          lastProgressAt: recorded.lastProgressAt,
          lastOutputAt: recorded.lastOutputAt,
          abortDetectedAt: recorded.abortDetectedAt,
          pendingCompletionValidationAt: recorded.pendingCompletionValidationAt,
          currentAttemptId: recorded.currentAttemptId,
        });
      })
  );

  server.registerTool(
    "supervisor_tick",
    {
      description:
        "Tick a supervised session. Detect stalls, apply cooldown/backoff, and switch to fallback route when needed",
      inputSchema: {
        sessionId: safeId("Supervisor session ID to tick"),
        progressObserved: z
          .boolean()
          .optional()
          .describe("Whether deterministic progress was observed since last tick"),
        note: z.string().optional().describe("Optional operator note for this tick"),
        forceRecover: z.boolean().optional().describe("Force recovery regardless of timers"),
      },
      annotations: toolAnnotations("supervisor_tick"),
    },
    async ({ sessionId, progressObserved, note, forceRecover }) =>
      guardStoreAccess(() =>
        deps.withSupervisorStoreLock(async () => {
          const reliability = await deps.loadReliabilityConfig();
          const store = deps.pruneSupervisorStore(await deps.readSupervisorStore(), reliability);
          const state = store.sessions[sessionId];

          if (!state) {
            return jsonContent({ status: "missing", sessionId });
          }

          const now = Date.now();

          void logEvent({ session: sessionId }, "tick.start", {
            sessionId,
            status: state.status,
            sinceProgressMs: now - state.lastProgressAt,
            sinceStartMs: now - state.startedAt,
            failureCount: state.failureCount,
            attemptCount: state.attemptCount,
            recoveryInFlight: state.recoveryInFlight,
            abortDetectedAt: state.abortDetectedAt,
          });

          // MCP-11: the streak decays only when genuine progress was observed
          // after the last failure and the reset window has since elapsed. A
          // fallback bumps lastProgressAt without being progress, so anchoring
          // here on lastProgressAt let a slow poller zero the count every tick.
          if (shouldResetFailureStreak(state, now, reliability)) {
            state.failureCount = 0;
            deps.pushSessionEvent(
              state,
              "failure.reset",
              "progress observed since the last failure and the reset window elapsed; resetting consecutive failure count"
            );
          }

          if (
            deps.shouldAutoReleaseLock(
              state.recoveryInFlight,
              state.lastRecoveryAt,
              now,
              reliability.retryDedupeWindowMs * 3
            )
          ) {
            state.recoveryInFlight = false;
            deps.pushSessionEvent(
              state,
              "recovery.inflight.cleared",
              `auto-released stale lock after ${now - (state.lastRecoveryAt ?? 0)}ms`
            );
          }

          if (progressObserved) {
            state.lastProgressAt = now;
            state.lastObservedProgressAt = now;
            state.lastOutputAt = now;
            state.abortDetectedAt = undefined;
            state.pendingCompletionValidationAt = undefined;
            // MCP-11: observed progress ends the backoff window. Without this the
            // cooldown check ten lines below flipped the status straight back to
            // "cooldown" in the same tick, so after any fallback real progress
            // reported as cooldown for the whole backoff window.
            state.cooldownUntil = undefined;
            deps.clearCompletionProof(state);
            state.status = "running";
            state.recoveryInFlight = false;
            deps.pushSessionEvent(state, "progress.observed", note ?? "progress signal received");
          } else if (note) {
            deps.pushSessionEvent(state, "progress.note", note);
          }

          if (
            state.status === "completed" ||
            state.status === "blocked" ||
            state.status === "interrupted" ||
            state.status === "exhausted" ||
            state.status === "force_synthesized"
          ) {
            await deps.writeSupervisorStore(store);
            return jsonContent({
              status: state.status,
              reasonCode: "terminal_state",
              sessionId,
              currentAttemptId: state.currentAttemptId,
              currentRoute: state.currentRoute,
              attemptCount: state.attemptCount,
              failureCount: state.failureCount,
            });
          }

          if (state.cooldownUntil && now < state.cooldownUntil) {
            state.status = "cooldown";
            await deps.writeSupervisorStore(store);
            return jsonContent({
              status: "cooldown",
              reasonCode: "cooldown_active",
              sessionId,
              currentAttemptId: state.currentAttemptId,
              waitMs: state.cooldownUntil - now,
              currentRoute: state.currentRoute,
            });
          }

          if (
            deps.isAbortWindowActive(state.abortDetectedAt, now, reliability.abortWindowMs) &&
            forceRecover !== true
          ) {
            state.status = "cooldown";
            await deps.writeSupervisorStore(store);
            return jsonContent({
              status: "cooldown",
              reasonCode: "abort_window_active",
              sessionId,
              currentAttemptId: state.currentAttemptId,
              waitMs: reliability.abortWindowMs - (now - (state.abortDetectedAt ?? now)),
              currentRoute: state.currentRoute,
            });
          }

          const sinceProgress = now - state.lastProgressAt;
          const sinceStart = now - state.startedAt;
          const stalled =
            forceRecover === true ||
            sinceProgress >= reliability.progressTimeoutMs ||
            sinceStart >= reliability.hardSessionTimeoutMs;

          if (!stalled) {
            state.status = "running";
            await deps.writeSupervisorStore(store);
            return jsonContent({
              status: "running",
              reasonCode: "healthy_progress_window",
              sessionId,
              currentAttemptId: state.currentAttemptId,
              currentRoute: state.currentRoute,
              sinceProgressMs: sinceProgress,
              sinceStartMs: sinceStart,
              progressTimeoutMs: reliability.progressTimeoutMs,
              hardSessionTimeoutMs: reliability.hardSessionTimeoutMs,
            });
          }

          if (state.recoveryInFlight) {
            await deps.writeSupervisorStore(store);
            return jsonContent({
              status: "recovering",
              reasonCode: "retry_in_flight",
              sessionId,
              currentAttemptId: state.currentAttemptId,
              currentRoute: state.currentRoute,
            });
          }

          const recoveryKey = deps.makeRecoveryKey(state);
          if (
            deps.shouldDedupeContinuation(
              state.lastRecoveryKey,
              state.lastRecoveryAt,
              recoveryKey,
              now,
              reliability.retryDedupeWindowMs
            )
          ) {
            await deps.writeSupervisorStore(store);
            return jsonContent({
              status: "cooldown",
              reasonCode: "recovery_deduped",
              sessionId,
              currentAttemptId: state.currentAttemptId,
              dedupeWindowMs: reliability.retryDedupeWindowMs,
            });
          }

          state.lastRecoveryKey = recoveryKey;
          state.lastRecoveryAt = now;

          state.recoveryInFlight = true;
          await deps.writeSupervisorStore(store);

          state.failureCount += 1;
          // Anchor for the streak decay (MCP-11): the streak is measured from the
          // last failure, never from lastProgressAt (which failover bumps).
          state.lastFailureAt = now;
          const previousRoute = state.currentRoute;
          deps.pushSessionEvent(
            state,
            "session.stalled",
            `stalled after ${sinceProgress}ms since progress, ${sinceStart}ms since start`
          );

          if (previousRoute) {
            const key = deps.failureKey(previousRoute.host, previousRoute.model);
            const prev = store.hostModelFailures[key] ?? { count: 0, lastFailureAt: now };
            prev.count += 1;
            prev.lastFailureAt = now;
            if (prev.count >= reliability.banHostModelAfterFailures) {
              prev.cooldownUntil = now + reliability.failureResetWindowMs;
              deps.pushSessionEvent(
                state,
                "breaker.opened",
                `${key} banned until ${new Date(prev.cooldownUntil).toISOString()}`
              );
            }
            store.hostModelFailures[key] = prev;
          }

          if (
            state.failureCount >= reliability.maxConsecutiveFailures ||
            state.attemptCount >= reliability.maxAttemptsPerSlice
          ) {
            state.status = "exhausted";
            state.recoveryInFlight = false;
            deps.pushSessionEvent(state, "session.exhausted", "max failures or attempts reached");
            await deps.writeSupervisorStore(store);
            return jsonContent({
              status: "exhausted",
              reasonCode: "attempts_exhausted",
              reason: "max failures or attempts reached",
              sessionId,
              currentAttemptId: state.currentAttemptId,
              attemptCount: state.attemptCount,
              failureCount: state.failureCount,
              currentRoute: state.currentRoute,
              forceSynthesisAvailable: true,
              forceSynthesisDirective:
                "Budget exhausted. Call supervisor_force_synthesis to convert gathered evidence into an honestly-labeled best-effort answer instead of discarding partial work.",
            });
          }

          let nextRoute: SupervisorRoute | null =
            state.fallbackRoutes[state.nextFallbackIndex] ?? null;
          if (nextRoute) {
            state.nextFallbackIndex += 1;
          }

          if (!nextRoute) {
            const registry = await deps.loadRegistry();
            const banned = new Set<string>();
            for (const [key, failure] of Object.entries(store.hostModelFailures)) {
              if (
                (failure.cooldownUntil ?? 0) > now &&
                failure.count >= reliability.banHostModelAfterFailures
              ) {
                banned.add(key);
              }
            }

            const refreshed = await deps.buildWatchdogRouteCandidates(
              registry,
              state.description,
              previousRoute?.host ?? null,
              null,
              4,
              banned
            );

            const primaryKey = refreshed.primary
              ? deps.failureKey(refreshed.primary.host, refreshed.primary.model)
              : "";
            nextRoute =
              refreshed.candidates.find(
                (candidate) => deps.failureKey(candidate.host, candidate.model) !== primaryKey
              ) ?? null;

            if (nextRoute) {
              state.fallbackRoutes = refreshed.candidates.filter(
                (candidate) =>
                  candidate.host !== nextRoute?.host || candidate.model !== nextRoute?.model
              );
              state.nextFallbackIndex = 0;
            }
          }

          if (!nextRoute) {
            state.status = "blocked";
            state.recoveryInFlight = false;
            deps.pushSessionEvent(state, "session.blocked", "no healthy fallback routes available");
            await deps.writeSupervisorStore(store);
            return jsonContent({
              status: "blocked",
              reasonCode: "fallback_exhausted",
              reason: "no healthy fallback routes available",
              sessionId,
              currentAttemptId: state.currentAttemptId,
              attemptCount: state.attemptCount,
              failureCount: state.failureCount,
              forceSynthesisAvailable: true,
              forceSynthesisDirective:
                "Every lane is exhausted. Call supervisor_force_synthesis to convert gathered evidence into an honestly-labeled best-effort answer instead of discarding partial work.",
            });
          }

          if (nextRoute.endpoint.startsWith("http")) {
            const pingOk = await deps.quickPingEndpoint(nextRoute.endpoint);
            if (!pingOk) {
              void logEvent("server", "fallback.ping_failed", {
                sessionId,
                host: nextRoute.host,
                endpoint: nextRoute.endpoint,
                note: "skipping dead candidate; will re-try next fallback on next tick",
              });
              void logEvent({ session: sessionId }, "fallback.ping_failed", {
                host: nextRoute.host,
                endpoint: nextRoute.endpoint,
              });
              state.status = "cooldown";
              state.cooldownUntil = now + reliability.retryDedupeWindowMs;
              state.recoveryInFlight = false;
              await deps.writeSupervisorStore(store);
              return jsonContent({
                status: "cooldown",
                reasonCode: "fallback_ping_failed",
                sessionId,
                skippedHost: nextRoute.host,
                retryAfterMs: reliability.retryDedupeWindowMs,
              });
            }
          }

          state.currentRoute = nextRoute;
          state.attemptCount += 1;
          state.currentAttemptId = deps.makeAttemptId(sessionId, state.attemptCount, nextRoute);
          state.status = "cooldown";
          const backoffMs = deps.computeBackoffMs(reliability, state.failureCount);
          state.cooldownUntil = now + backoffMs;
          // Gives the new lane a fresh stall window. Deliberately does NOT touch
          // lastObservedProgressAt: a fallback is recovery, not progress (MCP-11).
          state.lastProgressAt = now;
          state.recoveryInFlight = false;
          deps.pushSessionEvent(
            state,
            "fallback.applied",
            `${nextRoute.host}/${nextRoute.model ?? "<none>"} (attempt ${state.attemptCount})`
          );

          void logEvent("server", "fallback.applied", {
            sessionId,
            host: nextRoute.host,
            model: nextRoute.model,
            attemptCount: state.attemptCount,
            failureCount: state.failureCount,
            backoffMs,
          });
          void logEvent({ session: sessionId }, "fallback.applied", {
            host: nextRoute.host,
            model: nextRoute.model,
            attemptCount: state.attemptCount,
            backoffMs,
            cooldownUntil: new Date(state.cooldownUntil).toISOString(),
          });

          await deps.writeSupervisorStore(store);

          // At-most-one-live-instance: the supervisor
          // has no kill channel to the stalled lane, so failover revokes its
          // claim instead. A returning lane's write-back is then rejected rather
          // than landing on top of the fallback lane's work. Tasks with no lease
          // take a pure no-op path — nothing is written.
          const revokedLeases = await revokeSessionTaskLeases(
            sessionId,
            new Date(now).toISOString()
          );

          return jsonContent({
            status: "recovering",
            reasonCode: "fallback_applied",
            sessionId,
            currentAttemptId: state.currentAttemptId,
            switchedTo: nextRoute,
            backoffMs,
            cooldownUntil: new Date(state.cooldownUntil).toISOString(),
            attemptCount: state.attemptCount,
            failureCount: state.failureCount,
            revokedLeases,
            handoffDirective:
              "Failover applied. Compose a failover handoff prompt (compose-supervisor-prompts skill) with goal, current state (DONE/PARTIAL/NOT STARTED), key decisions, traps & dead ends, relevant files, and open work so the fallback lane does not repeat the stalled lane's mistakes.",
          });
        })
      )
  );

  server.registerTool(
    "supervisor_abort_session",
    {
      description:
        "Abort a live supervised session and mark it as interrupted. Terminal is terminal: a " +
        "session that already ended (completed, interrupted, exhausted, force_synthesized) is a " +
        "no-op — nothing is written, no event is pushed, and the result reports " +
        "already_terminal with the status the session actually holds. A session ID that does not " +
        "exist still returns missing; the two outcomes are distinct",
      inputSchema: {
        sessionId: safeId("Supervisor session ID"),
        reason: z.string().optional().describe("Optional abort reason"),
      },
      annotations: toolAnnotations("supervisor_abort_session"),
    },
    async ({ sessionId, reason }) =>
      guardStoreAccess(() =>
        deps.withSupervisorStoreLock(async () => {
          const reliability = await deps.loadReliabilityConfig();
          const store = deps.pruneSupervisorStore(await deps.readSupervisorStore(), reliability);
          const state = store.sessions[sessionId];
          if (!state) {
            return jsonContent({ status: "missing", sessionId });
          }

          // Classify BEFORE mutating. This used to set status = "interrupted"
          // unconditionally, so aborting a session that finished ten minutes
          // ago rewrote its terminal record, pushed a session.interrupted
          // event, and reported "interrupted" as though it had stopped live
          // work. The three terminal states are "deliberately distinguished"
          // (MANUAL §5); a request to end something already ended erases that
          // distinction, so it answers with what actually happened instead of
          // echoing the transition that was asked for.
          //
          // Deliberately NOT ported: a running-vs-pending distinction. The
          // control plane holds no kill channel, so which of the two a live
          // session is in is unknowable from here, and guessing would be worse
          // than today's behavior. Lease revocation stays on the live path
          // below, where it is already idempotent.
          if (SUPERVISOR_TERMINAL_STATUSES.has(state.status)) {
            return jsonContent({
              status: "already_terminal",
              reasonCode: "session_terminal",
              sessionId,
              priorStatus: state.status,
              detail:
                `Session already ended as "${state.status}". Nothing was written, no event was ` +
                "pushed, and no lease was touched — its terminal record is unchanged.",
            });
          }

          const now = Date.now();
          state.status = "interrupted";
          state.lastProgressAt = now;
          state.cooldownUntil = undefined;
          state.recoveryInFlight = false;
          deps.pushSessionEvent(state, "session.interrupted", reason ?? "abort requested");
          await deps.writeSupervisorStore(store);

          // At-most-one-live-instance (MCP-4): abort is a terminal transition,
          // so no lane may keep a live claim on this session's tasks. Tasks
          // with no lease take the pure no-op path — nothing is written.
          const revokedLeases = await revokeSessionTaskLeases(
            sessionId,
            new Date(now).toISOString()
          );

          return jsonContent({
            status: "interrupted",
            reasonCode: "interrupt_requested",
            sessionId,
            currentAttemptId: state.currentAttemptId,
            currentRoute: state.currentRoute,
            reason: reason ?? "abort requested",
            revokedLeases,
          });
        })
      )
  );
}
