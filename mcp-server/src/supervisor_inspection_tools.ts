import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { pruningRemovedEntries } from "./supervisor_runtime.js";
import { guardStoreAccess } from "./supervisor_store_runtime.js";
import type { SupervisorToolDeps } from "./supervisor_tool_deps.js";

import { jsonContent } from "./agent_tool_helpers.js";
import { toolAnnotations } from "./observability_tools.js";
export function registerSupervisorInspectionTools(
  server: McpServer,
  deps: SupervisorToolDeps
): void {
  server.registerTool(
    "supervisor_status",
    {
      description:
        "Inspect active supervisor sessions, reliability settings, and host/model failure breaker state",
      inputSchema: {
        sessionId: z.string().optional().describe("Optional session ID filter"),
      },
      annotations: toolAnnotations("supervisor_status"),
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
}
