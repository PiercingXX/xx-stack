#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { logEvent, initServerLog } from "./log_worker.js";
import {
  applyAsyncToolSafety,
  applyToolPolicy,
  missingRequiredMcpServers,
  validateAgentProfiles,
} from "./config_runtime.js";
import { validateExecRequest } from "./execution_policy.js";
import { atomicWriteTextFile } from "./io_runtime.js";
import {
  buildMemoryResyncHelperPrompt,
  hashMemoryContent,
  lineDiffSummary,
  readSnapshotMeta,
} from "./memory_runtime.js";
import {
  buildWatchdogRouteCandidates,
  chooseModelForTask,
  effectiveParallelCapacity,
  endpointFamilyForProvider,
  routeParallelTasks,
  routeTask,
  scoreTiers,
} from "./routing_runtime.js";
import { registerAgentTools } from "./agent_tools.js";
import { registerObservabilityTools } from "./observability_tools.js";
import { loadRegistry, detectHardware, quickPingEndpoint } from "./platform_runtime.js";
import { repoFileCandidates } from "./runtime_constants.js";
import { registerRoutingTools } from "./routing_tools.js";
import { registerSupervisorTools } from "./supervisor_tools.js";
import { registerTaskTools } from "./task_tools.js";
import {
  applySupervisorEventTransition,
  buildCompletionRepairChecklist,
  clearCompletionProof,
  computeBackoffMs,
  DEFAULT_RELIABILITY,
  emptySupervisorStore,
  evaluateCompletionReadiness,
  failureKey,
  isAbortWindowActive,
  loadReliabilityConfig,
  makeAttemptId,
  makeRecoveryKey,
  parseCompletionValidationReason,
  pruneSupervisorStore,
  pushSessionEvent,
  readSupervisorStore,
  sessionEvent,
  shouldAutoReleaseLock,
  shouldDedupeContinuation,
  shouldRequireCompletionValidation,
  withSupervisorStoreLock,
  writeSupervisorStore,
} from "./supervisor_runtime.js";

export {
  applySupervisorEventTransition,
  atomicWriteTextFile,
  computeBackoffMs,
  emptySupervisorStore,
  isAbortWindowActive,
  pruneSupervisorStore,
  shouldAutoReleaseLock,
  shouldDedupeContinuation,
  shouldRequireCompletionValidation,
};

export const __testExports = {
  DEFAULT_RELIABILITY,
  pushSessionEvent,
  makeRecoveryKey,
  scoreTiers,
  routeTask,
  routeParallelTasks,
  routeParallelTasksRaw: routeParallelTasks,
  buildWatchdogRouteCandidates,
  chooseModelForTask,
  effectiveParallelCapacity,
  repoFileCandidates,
  endpointFamilyForProvider,
  validateExecRequest,
  loadReliabilityConfig,
  validateAgentProfiles,
  applyToolPolicy,
  applyAsyncToolSafety,
  missingRequiredMcpServers,
  hashMemoryContent,
  readSnapshotMeta,
  lineDiffSummary,
  buildMemoryResyncHelperPrompt,
  evaluateCompletionReadiness,
  parseCompletionValidationReason,
  buildCompletionRepairChecklist,
};

// --- MCP Server ---

const server = new McpServer({
  name: "xx-stack-platform-routing",
  version: "1.0.0",
});

registerObservabilityTools(server, {
  loadRegistry,
  detectHardware,
});

registerRoutingTools(server, {
  loadRegistry,
});

registerSupervisorTools(server, {
  withSupervisorStoreLock,
  loadRegistry,
  loadReliabilityConfig,
  readSupervisorStore,
  writeSupervisorStore,
  pruneSupervisorStore,
  buildWatchdogRouteCandidates,
  applySupervisorEventTransition,
  sessionEvent,
  pushSessionEvent,
  clearCompletionProof,
  makeAttemptId,
  makeRecoveryKey,
  shouldAutoReleaseLock,
  shouldDedupeContinuation,
  isAbortWindowActive,
  evaluateCompletionReadiness,
  parseCompletionValidationReason,
  buildCompletionRepairChecklist,
  computeBackoffMs,
  failureKey,
  quickPingEndpoint,
});

registerAgentTools(server);
registerTaskTools(server, {
  loadReliabilityConfig,
  readSupervisorStore,
  pruneSupervisorStore,
});

// --- Start ---

async function main(): Promise<void> {
  await initServerLog();
  void logEvent("server", "server.start", { pid: process.pid, nodeVersion: process.version });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isDirectExecution = ((): boolean => {
  const modulePath = fileURLToPath(import.meta.url);
  return Boolean(process.argv[1]) && resolve(process.argv[1]) === modulePath;
})();

if (isDirectExecution) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
