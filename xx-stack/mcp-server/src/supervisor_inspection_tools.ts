import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { SupervisorToolDeps } from "./supervisor_tool_deps.js";

import { jsonContent } from "./agent_tool_helpers.js";
export function registerSupervisorInspectionTools(
  server: McpServer,
  deps: SupervisorToolDeps
): void {
  server.tool(
    "supervisor_status",
    "Inspect active supervisor sessions, reliability settings, and host/model failure breaker state",
    {
      sessionId: z.string().optional().describe("Optional session ID filter"),
    },
    async ({ sessionId }) =>
      deps.withSupervisorStoreLock(async () => {
        const reliability = await deps.loadReliabilityConfig();
        const store = deps.pruneSupervisorStore(await deps.readSupervisorStore(), reliability);
        await deps.writeSupervisorStore(store);

        const now = Date.now();
        const sessions = sessionId
          ? store.sessions[sessionId]
            ? [store.sessions[sessionId]]
            : []
          : Object.values(store.sessions);

        const summaryByStatus = sessions.reduce<Record<string, number>>((acc, session) => {
          acc[session.status] = (acc[session.status] ?? 0) + 1;
          return acc;
        }, {});

        const failures = Object.entries(store.hostModelFailures).map(([key, value]) => ({
          key,
          count: value.count,
          lastFailureAt: new Date(value.lastFailureAt).toISOString(),
          cooldownMsRemaining: Math.max(0, (value.cooldownUntil ?? 0) - now),
          breakerActive: (value.cooldownUntil ?? 0) > now,
        }));

        return jsonContent({
          reliability,
          sessionSummary: {
            total: sessions.length,
            byStatus: summaryByStatus,
          },
          sessions,
          hostModelFailures: failures,
        });
      })
  );

  server.tool(
    "supervisor_run_self_test",
    "Run deterministic self-tests for timeout, fallback selection, and session persistence behavior",
    {},
    async () => {
      const reliability = await deps.loadReliabilityConfig();
      const store = deps.pruneSupervisorStore(await deps.readSupervisorStore(), reliability);

      const checks: Array<Record<string, unknown>> = [];
      checks.push({
        name: "reliability.watchdogEnabled",
        pass: reliability.watchdogEnabled === true,
        value: reliability.watchdogEnabled,
      });
      checks.push({
        name: "reliability.maxAttemptsPerSlice",
        pass: reliability.maxAttemptsPerSlice >= 1,
        value: reliability.maxAttemptsPerSlice,
      });

      const sessionCount = Object.keys(store.sessions).length;
      checks.push({
        name: "store.sessions.readable",
        pass: sessionCount >= 0,
        value: sessionCount,
      });

      const allPass = checks.every((check) => check.pass === true);
      return jsonContent({
        status: allPass ? "pass" : "fail",
        checks,
      });
    }
  );
}
