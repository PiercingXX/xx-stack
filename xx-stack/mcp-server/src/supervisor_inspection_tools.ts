import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { findMalformedSessions, pruningRemovedEntries } from "./supervisor_runtime.js";
import { guardStoreAccess, storeAccessErrorPayload } from "./supervisor_store_runtime.js";
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
      guardStoreAccess(() =>
        deps.withSupervisorStoreLock(async () => {
          const reliability = await deps.loadReliabilityConfig();
          const persisted = await deps.readSupervisorStore();
          const store = deps.pruneSupervisorStore(persisted, reliability);

          // MCP-1: this is an inspection tool. It writes only when pruning
          // actually dropped something, so a status poll can never rewrite —
          // and therefore never truncate — the store it is only reading.
          if (pruningRemovedEntries(persisted, store)) {
            await deps.writeSupervisorStore(store);
          }

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
      )
  );

  server.tool(
    "supervisor_run_self_test",
    "Run deterministic self-tests for timeout, fallback selection, and session persistence behavior",
    {},
    async () => {
      const reliability = await deps.loadReliabilityConfig();

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

      // MCP-DEAD-2: the old assertion was `sessionCount >= 0`, which passes for
      // every possible store — including one that could not be read at all.
      // The persistence check now actually exercises the read and the shape of
      // what came back, so it can fail.
      try {
        const store = deps.pruneSupervisorStore(await deps.readSupervisorStore(), reliability);
        const malformed = findMalformedSessions(store);
        checks.push({
          name: "store.sessions.readable",
          pass: true,
          value: Object.keys(store.sessions).length,
        });
        checks.push({
          name: "store.sessions.wellFormed",
          pass: malformed.length === 0,
          value: malformed.length === 0 ? "all session records usable" : malformed.join(", "),
        });
      } catch (error) {
        const payload = storeAccessErrorPayload(error);
        if (!payload) throw error;
        checks.push({
          name: "store.sessions.readable",
          pass: false,
          value: payload.detail,
        });
        checks.push({
          name: "store.sessions.wellFormed",
          pass: false,
          value: "not evaluated: the store could not be read",
        });
      }

      const allPass = checks.every((check) => check.pass === true);
      return jsonContent({
        status: allPass ? "pass" : "fail",
        checks,
      });
    }
  );
}
