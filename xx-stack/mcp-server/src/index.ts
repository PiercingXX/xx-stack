#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { logEvent, initServerLog, telemetryHealth } from "./log_worker.js";
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
  getAgentMemoryEntrypoint,
  getCompletionMemorySyncStatus,
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
  routeCompetitiveTask,
  routeParallelTasks,
  routeTask,
  scoreCandidates,
  scoreTiers,
} from "./routing_runtime.js";
import { registerAgentTools } from "./agent_tools.js";
import { registerObservabilityTools } from "./observability_tools.js";
import {
  detectHardware,
  loadModelRates,
  loadRegistry,
  lookupModelCost,
  quickPingEndpoint,
} from "./platform_runtime.js";
import { repoFileCandidates } from "./runtime_constants.js";
import { registerRoutingTools } from "./routing_tools.js";
import { registerSupervisorTools } from "./supervisor_tools.js";
import { registerTaskTools } from "./task_tools.js";
import { registerRepoMapTools } from "./repo_map_tools.js";
import { registerHookToolsIfEnabled } from "./hook_tools.js";
import { readTaskStore } from "./task_runtime.js";
import { registerReviewTools } from "./review_tools.js";
import { registerVerifyEditTools } from "./verify_edit_tools.js";
import { registerFindingTools } from "./finding_tools.js";
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
  scoreCandidates,
  scoreTiers,
  routeTask,
  routeArchitectEditor,
  routeCompetitiveTask,
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
  lookupModelCost,
  loadModelRates,
};

// --- MCP Server ---

// Sourced from package.json so the version reported over MCP cannot drift from
// the version actually published.
const SERVER_VERSION: string = ((): string => {
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
  logEvent,
  loadModelRates,
  telemetryHealth,
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

registerRepoMapTools(server, {});

// MCP lifecycle hook tools (_Stop / _PostCompact) are off by default: a harness
// that is not hook-aware would see them as ordinary callable tools. Opt in with
// XX_STACK_HOOK_TOOLS=1; without it they are absent from tools/list entirely.
const hookToolsRegistered = registerHookToolsIfEnabled(server, {
  readTaskStore,
  readSupervisorStore,
  loadReliabilityConfig,
  pruneSupervisorStore,
  evaluateCompletionReadiness,
  getCompletionMemorySyncStatus,
  getAgentMemoryEntrypoint,
});

registerVerifyEditTools(server, {
  allowedCommands: ["echo", "cat", "node", "npm", "npx", "ruff", "pytest"],
});

registerFindingTools(server);

registerReviewTools(server, {
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

// --- Start ---

async function main(): Promise<void> {
  await initServerLog();
  void logEvent("server", "server.start", {
    pid: process.pid,
    nodeVersion: process.version,
    hookToolsRegistered,
  });
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
