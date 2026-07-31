#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, readFileSync, realpathSync } from "node:fs";
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
  routeArchitectEditor,
  routeParallelTasks,
  routeTask,
  scoreTiers,
} from "./routing_runtime.js";
import { registerAgentTools } from "./agent_tools.js";
import { registerObservabilityTools } from "./observability_tools.js";
import { registerReviewToContinuationTool } from "./review_to_continuation.js";
import { loadRegistry, detectHardware, quickPingEndpoint } from "./platform_runtime.js";
import { repoFileCandidates } from "./runtime_constants.js";
import { registerRoutingTools } from "./routing_tools.js";
import { registerSupervisorTools } from "./supervisor_tools.js";
import { registerTaskTools } from "./task_tools.js";
import { registerVerifyEditTools } from "./verify_edit_tools.js";
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
  routeArchitectEditor,
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

// Sourced from package.json so the version reported over MCP cannot drift from
// the version actually published.
const SERVER_VERSION: string = (() => {
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const url = new URL(rel, import.meta.url);
      if (existsSync(url)) {
        const pkg = JSON.parse(readFileSync(url, "utf8")) as { version?: string };
        if (pkg.version) return pkg.version;
      }
    } catch {
      /* fall through to the next candidate */
    }
  }
  return "0.0.0";
})();

const server = new McpServer({
  name: "xx-stack-platform-routing",
  version: SERVER_VERSION,
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

registerVerifyEditTools(server, {
  allowedCommands: ["echo", "cat", "node", "npm", "npx", "ruff", "pytest"],
});

// registerReviewToContinuationTool follows the registerXxxTools pattern
registerReviewToContinuationTool(server);

// --- Start ---

async function main(): Promise<void> {
  await initServerLog();
  void logEvent("server", "server.start", { pid: process.pid, nodeVersion: process.version });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isDirectExecution = ((): boolean => {
  if (!process.argv[1]) return false;
  // Compare real paths, not lexical ones. Components reach this server through
  // a symlinked mcp-server/ directory, so the invoked path and import.meta.url
  // legitimately differ; a lexical comparison made the server exit 0 without
  // ever starting, which reads as "crashed silently" to every caller.
  const realOrSelf = (candidate: string): string => {
    try {
      return realpathSync(candidate);
    } catch {
      return resolve(candidate);
    }
  };
  return realOrSelf(process.argv[1]) === realOrSelf(fileURLToPath(import.meta.url));
})();

if (isDirectExecution) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
