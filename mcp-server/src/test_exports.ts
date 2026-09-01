/**
 * Test-only barrel. Compiled into dist-test/, never into dist/.
 *
 * Production modules import these symbols from their owning files. Tests that
 * historically reached them through index.ts __testExports keep that shape here
 * so a production import of the server entry cannot pull the test surface.
 */
import {
  applyAsyncToolSafety,
  applyToolPolicy,
  missingRequiredMcpServers,
  validateAgentProfiles,
} from "./config_runtime.js";
import { validateExecRequest } from "./execution_policy.js";
import {
  buildMemoryResyncHelperPrompt,
  hashMemoryContent,
  lineDiffSummary,
  readSnapshotMeta,
} from "./memory_runtime.js";
import { lookupModelCost, loadModelRates } from "./platform_runtime.js";
import { repoFileCandidates } from "./runtime_constants.js";
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
import {
  buildCompletionRepairChecklist,
  DEFAULT_RELIABILITY,
  evaluateCompletionReadiness,
  loadReliabilityConfig,
  makeRecoveryKey,
  parseCompletionValidationReason,
  pushSessionEvent,
} from "./supervisor_runtime.js";

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
