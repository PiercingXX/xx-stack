import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolve } from "node:path";

import { CompletionMemorySyncGuard, getCompletionMemorySyncStatus } from "./memory_runtime.js";
import type { SupervisorToolDeps } from "./supervisor_tool_deps.js";

import { jsonContent } from "./agent_tool_helpers.js";
export function registerSupervisorCompletionTools(
  server: McpServer,
  deps: SupervisorToolDeps
): void {
  server.tool(
    "supervisor_record_completion_check",
    "Record deterministic completion evidence and independent judge verdict for a supervised session",
    {
      sessionId: z.string().describe("Supervisor session ID"),
      checkType: z.enum(["evidence", "judge"]).describe("Completion check type"),
      summary: z
        .string()
        .min(1)
        .max(8000)
        .describe("Human-readable summary for evidence or judge result"),
      verdict: z.enum(["pass", "fail"]).optional().describe("Required when checkType='judge'"),
    },
    async ({ sessionId, checkType, summary, verdict }) =>
      deps.withSupervisorStoreLock(async () => {
        const reliability = await deps.loadReliabilityConfig();
        const store = deps.pruneSupervisorStore(await deps.readSupervisorStore(), reliability);
        const state = store.sessions[sessionId];
        if (!state) {
          return jsonContent({ status: "missing", sessionId });
        }

        const now = Date.now();

        if (checkType === "evidence") {
          state.completionEvidenceAt = now;
          state.completionEvidenceSummary = summary;
          state.pendingCompletionValidationAt = undefined;
          deps.pushSessionEvent(state, "completion.evidence_recorded", summary);
        } else {
          if (!verdict) {
            return jsonContent({
              status: "invalid",
              reasonCode: "judge_verdict_required",
              sessionId,
            });
          }
          state.completionJudgeAt = now;
          state.completionJudgeVerdict = verdict;
          state.completionJudgeSummary = summary;
          state.pendingCompletionValidationAt = verdict === "pass" ? undefined : now;
          deps.pushSessionEvent(
            state,
            verdict === "pass" ? "completion.judge_pass" : "completion.judge_fail",
            summary
          );
        }

        await deps.writeSupervisorStore(store);

        return jsonContent({
          status: "recorded",
          reasonCode:
            checkType === "evidence" ? "completion_evidence_recorded" : "completion_judge_recorded",
          sessionId,
          checkType,
          completionEvidenceAt: state.completionEvidenceAt ?? null,
          completionJudgeAt: state.completionJudgeAt ?? null,
          completionJudgeVerdict: state.completionJudgeVerdict ?? null,
        });
      })
  );

  server.tool(
    "supervisor_complete_session",
    "Mark a supervised session with a final terminal outcome",
    {
      sessionId: z.string().describe("Supervisor session ID"),
      outcome: z
        .enum(["completed", "blocked", "interrupted", "exhausted"])
        .optional()
        .describe("Final outcome"),
      note: z.string().optional().describe("Optional completion note"),
      forceComplete: z
        .boolean()
        .optional()
        .describe("Override output validation gates and finalize immediately"),
      memorySync: z
        .object({
          agentId: z
            .string()
            .min(1)
            .describe("Agent identifier to enforce memory snapshot sync on completion"),
          scope: z
            .enum(["user", "project", "local"])
            .optional()
            .describe("Memory scope to enforce; defaults to project"),
          cwd: z
            .string()
            .optional()
            .describe("Project root used for project/local scope; defaults to current process cwd"),
        })
        .optional()
        .describe("Optional completion-time override for memory sync guard"),
    },
    async ({ sessionId, outcome, note, forceComplete, memorySync }) =>
      deps.withSupervisorStoreLock(async () => {
        const reliability = await deps.loadReliabilityConfig();
        const store = deps.pruneSupervisorStore(await deps.readSupervisorStore(), reliability);
        const state = store.sessions[sessionId];
        if (!state) {
          return jsonContent({ status: "missing", sessionId });
        }

        const now = Date.now();
        const requestedOutcome = outcome ?? "completed";
        if (requestedOutcome === "completed" && forceComplete !== true) {
          const memoryGuard: CompletionMemorySyncGuard | undefined = memorySync
            ? {
                agentId: memorySync.agentId.trim(),
                scope: memorySync.scope ?? "project",
                cwd: resolve(memorySync.cwd ?? process.cwd()),
              }
            : state.completionMemorySync;

          if (memoryGuard) {
            const memorySyncStatus = await getCompletionMemorySyncStatus(memoryGuard);
            if (memorySyncStatus.driftDetected) {
              const remediationChecklist = deps.buildCompletionRepairChecklist(
                "completion_memory_drift_detected"
              );
              state.pendingCompletionValidationAt = now;
              deps.pushSessionEvent(
                state,
                "completion.validation_failed",
                "completion_memory_drift_detected; refusing early completion"
              );
              await deps.writeSupervisorStore(store);
              return jsonContent({
                status: "running",
                reasonCode: "completion_memory_drift_detected",
                sessionId,
                completionValidationWindowMs: reliability.completionValidationWindowMs,
                memorySyncGuard: memoryGuard,
                memorySyncStatus,
                remediationChecklist,
                continuationDirective:
                  "Resync memory snapshot first, then continue repair loop and retry completion.",
              });
            }
          }

          const readiness = deps.evaluateCompletionReadiness(state, now, reliability);
          if (!readiness.ok) {
            const remediationChecklist = deps.buildCompletionRepairChecklist(readiness.reasonCode);
            state.pendingCompletionValidationAt = now;
            deps.pushSessionEvent(
              state,
              "completion.validation_failed",
              `${readiness.reasonCode}; refusing early completion`
            );
            await deps.writeSupervisorStore(store);
            return jsonContent({
              status: "running",
              reasonCode: readiness.reasonCode,
              sessionId,
              completionValidationWindowMs: reliability.completionValidationWindowMs,
              lastOutputAt: state.lastOutputAt ?? null,
              completionEvidenceAt: state.completionEvidenceAt ?? null,
              completionJudgeAt: state.completionJudgeAt ?? null,
              completionJudgeVerdict: state.completionJudgeVerdict ?? null,
              remediationChecklist,
              continuationDirective:
                "Continue repair loop: implement -> verify -> record evidence -> judge -> retry completion.",
            });
          }
        }

        state.status = requestedOutcome;
        state.lastProgressAt = now;
        state.pendingCompletionValidationAt = undefined;
        state.abortDetectedAt = undefined;
        state.recoveryInFlight = false;
        deps.pushSessionEvent(state, "session.completed", note ?? state.status);
        await deps.writeSupervisorStore(store);

        return jsonContent({
          status: state.status,
          reasonCode: "session_finalized",
          sessionId,
          currentAttemptId: state.currentAttemptId,
          state,
        });
      })
  );

  server.tool(
    "supervisor_emit_continuation_prompt",
    "Emit a bounded continuation prompt for stalled sessions and record continuation attempts",
    {
      sessionId: z.string().describe("Supervisor session ID"),
      remainingTasks: z.array(z.string()).optional().describe("Optional remaining task checklist"),
    },
    async ({ sessionId, remainingTasks }) =>
      deps.withSupervisorStoreLock(async () => {
        const reliability = await deps.loadReliabilityConfig();
        const store = deps.pruneSupervisorStore(await deps.readSupervisorStore(), reliability);
        const state = store.sessions[sessionId];
        if (!state) {
          return jsonContent({ status: "missing", sessionId });
        }

        const pendingTasks = remainingTasks ?? [];
        const now = Date.now();

        if (deps.isAbortWindowActive(state.abortDetectedAt, now, reliability.abortWindowMs)) {
          return jsonContent({
            status: "cooldown",
            reasonCode: "abort_window_active",
            sessionId,
            continuationCount: state.continuationCount,
            waitMs: reliability.abortWindowMs - (now - (state.abortDetectedAt ?? now)),
          });
        }

        if (state.recoveryInFlight) {
          return jsonContent({
            status: "recovering",
            reasonCode: "retry_in_flight",
            sessionId,
            continuationCount: state.continuationCount,
          });
        }

        const continuationFingerprint = JSON.stringify(pendingTasks);
        const dedupeWindowMs = Math.max(5_000, Math.floor(reliability.retryDedupeWindowMs));

        if (
          deps.shouldDedupeContinuation(
            state.lastContinuationFingerprint,
            state.lastContinuationAt,
            continuationFingerprint,
            now,
            dedupeWindowMs
          )
        ) {
          return jsonContent({
            status: "deduped",
            reasonCode: "continuation_deduped",
            sessionId,
            continuationCount: state.continuationCount,
            dedupeWindowMs,
          });
        }

        state.continuationCount += 1;
        state.lastContinuationFingerprint = continuationFingerprint;
        state.lastContinuationAt = now;
        deps.pushSessionEvent(state, "continuation.injected", `attempt ${state.continuationCount}`);
        await deps.writeSupervisorStore(store);

        const lastCompletionFailure = [...state.events]
          .reverse()
          .find((event) => event.type === "completion.validation_failed");
        let completionRecoveryReason = deps.parseCompletionValidationReason(
          lastCompletionFailure?.detail
        );
        let memorySyncStatus: Awaited<ReturnType<typeof getCompletionMemorySyncStatus>> | null =
          null;
        if (state.completionMemorySync) {
          memorySyncStatus = await getCompletionMemorySyncStatus(state.completionMemorySync);
          if (memorySyncStatus.driftDetected) {
            completionRecoveryReason = "completion_memory_drift_detected";
          }
        }
        const remediationChecklist = deps.buildCompletionRepairChecklist(completionRecoveryReason);

        const pending =
          pendingTasks.length > 0
            ? pendingTasks.map((task, index) => `${index + 1}. ${task}`).join("\n")
            : "1. Continue from the last verified artifact and produce deterministic output.\n2. Verify progress with a command, file diff, or explicit evidence.";

        const remediationText = remediationChecklist
          .map((item, index) => `${index + 1}. ${item}`)
          .join("\n");

        const prompt = [
          "Supervisor continuation directive:",
          `- session: ${sessionId}`,
          `- continuation-attempt: ${state.continuationCount}`,
          `- current-route: ${state.currentRoute?.host ?? "<none>"}/${state.currentRoute?.model ?? "<none>"}`,
          `- completion-recovery-reason: ${completionRecoveryReason}`,
          `- memory-sync-guard: ${state.completionMemorySync ? "enabled" : "disabled"}`,
          ...(state.completionMemorySync
            ? [
                `- memory-sync-agent: ${state.completionMemorySync.agentId}`,
                `- memory-sync-scope: ${state.completionMemorySync.scope}`,
                `- memory-sync-drift: ${memorySyncStatus?.driftDetected === true ? "detected" : "not-detected"}`,
              ]
            : []),
          "- requirements:",
          "  - do not restart from scratch",
          "  - produce deterministic evidence in this attempt",
          "  - if blocked, return explicit blocker and fallback recommendation",
          "  - follow strict loop: implement -> verify -> record evidence -> judge -> repair (if needed)",
          "- strict completion loop:",
          "  1) Update completion contract for current slice and unresolved criteria",
          "  2) Implement the smallest repair set",
          "  3) Run verification commands and capture concrete outputs",
          "  4) Call supervisor_record_completion_check with checkType='evidence'",
          "  5) Run completion-judge and call supervisor_record_completion_check with checkType='judge'",
          "  6) If judge fails, repair and repeat this loop",
          ...(memorySyncStatus?.driftDetected
            ? [
                "  7) Resolve memory drift before completion by following memory helper guidance",
                "- memory-sync helper:",
                memorySyncStatus.helperPrompt ??
                  "Run agent_memory_snapshot_status and resolve drift.",
              ]
            : []),
          "- remediation checklist:",
          remediationText,
          "- remaining tasks:",
          pending,
        ].join("\n");

        return jsonContent({
          status: "ready",
          reasonCode: "continuation_emitted",
          sessionId,
          continuationCount: state.continuationCount,
          completionRecoveryReason,
          remediationChecklist,
          memorySyncGuard: state.completionMemorySync ?? null,
          memorySyncStatus,
          prompt,
        });
      })
  );
}
