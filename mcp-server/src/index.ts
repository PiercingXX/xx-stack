#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { logEvent, initServerLog } from "./log_worker.js";

const execFileAsync = promisify(execFile);

// --- Registry loading ---

interface Host {
  id: string;
  label: string;
  provider: string;
  endpoint: string;
  capabilities?: {
    endpointFamily?: "catalog" | "compatible";
    supportsResidentModelInspection?: boolean;
  };
  primary?: boolean;
  networkScope?: string;
  enabled?: boolean;
  reachable?: boolean;
  hardware?: {
    summary?: string;
    cpu?: string;
    ram?: string;
    gpu?: string[];
    limits?: string[];
    detected?: {
      totalGpuVramGb?: number;
      gpuCount?: number;
    };
  };
  models?: Array<string | {
    name?: string;
    roles?: string[];
    size?: number;
    format?: string;
    quantization?: string;
    weightBits?: number;
    kernelFamily?: string;
    contextWindow?: number;
    estimatedVramGb?: number;
    supportsToolUse?: boolean;
    toolCallReliability?: "unknown" | "low" | "validated";
    jsonModeReliability?: "unknown" | "low" | "validated";
  }>;
  delegationPolicy?: {
    preferredTaskTypes?: string[];
    avoidTaskTypes?: string[];
  };
  executionPolicy?: {
    maxParallelSlices?: number;
    maxConcurrentModels?: number;
    contextReservePercent?: number;
    scheduling?: string;
  };
}

interface Tier {
  id: string;
  label: string;
  priority: number;
  usageGuidance?: string;
  hosts: Host[];
}

interface SelectionRule {
  name: string;
  when: string;
  preferTier: string;
}

interface Registry {
  version: number;
  selectionPolicy: {
    defaultOrder: string[];
    rules: SelectionRule[];
  };
  tiers: Tier[];
}

interface RouteRecommendation {
  recommendedTier: string;
  recommendedHost: string | null;
  recommendedModel: string | null;
  reasoning: string;
  availableModels: string[];
  fallback: string | null;
}

interface EndpointCompatibilityProbe {
  endpoint: string;
  provider: string;
  endpointFamily: "catalog" | "compatible";
  modelRequested: string | null;
  modelResolved: string | null;
  checks: {
    modelsEndpoint: { ok: boolean; status?: number; reason?: string };
    chatCompletion: { ok: boolean; status?: number; reason?: string };
    jsonMode: { ok: boolean; status?: number; reason?: string };
  };
}

interface ReliabilityConfig {
  watchdogEnabled: boolean;
  progressTimeoutMs: number;
  hardSessionTimeoutMs: number;
  staleSessionTtlMs: number;
  maxAttemptsPerSlice: number;
  maxConsecutiveFailures: number;
  backoffInitialMs: number;
  backoffMaxMs: number;
  failureResetWindowMs: number;
  banHostModelAfterFailures: number;
  retryDedupeWindowMs: number;
  abortWindowMs: number;
  completionValidationWindowMs: number;
}

interface SupervisorRoute {
  tier: string;
  host: string;
  endpoint: string;
  model: string | null;
}

interface SupervisorEvent {
  at: string;
  type: string;
  detail: string;
}

interface CompletionMemorySyncGuard {
  agentId: string;
  scope: AgentMemoryScope;
  cwd: string;
}

interface SupervisorSessionState {
  sessionId: string;
  description: string;
  status: "running" | "cooldown" | "blocked" | "completed" | "interrupted" | "exhausted";
  startedAt: number;
  lastProgressAt: number;
  lastOutputAt?: number;
  completionEvidenceAt?: number;
  completionEvidenceSummary?: string;
  completionJudgeAt?: number;
  completionJudgeVerdict?: "pass" | "fail";
  completionJudgeSummary?: string;
  completionMemorySync?: CompletionMemorySyncGuard;
  abortDetectedAt?: number;
  cooldownUntil?: number;
  pendingCompletionValidationAt?: number;
  attemptCount: number;
  failureCount: number;
  currentRoute: SupervisorRoute | null;
  fallbackRoutes: SupervisorRoute[];
  nextFallbackIndex: number;
  continuationCount: number;
  currentAttemptId?: string;
  recoveryInFlight?: boolean;
  lastRecoveryKey?: string;
  lastRecoveryAt?: number;
  lastContinuationFingerprint?: string;
  lastContinuationAt?: number;
  events: SupervisorEvent[];
}

interface HostModelFailure {
  count: number;
  lastFailureAt: number;
  cooldownUntil?: number;
}

interface SupervisorStore {
  version: number;
  sessions: Record<string, SupervisorSessionState>;
  hostModelFailures: Record<string, HostModelFailure>;
}

type TaskStatus = "todo" | "in_progress" | "suspended" | "blocked" | "done" | "canceled";

interface PersistentTask {
  taskId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  resumable?: boolean;
  sessionId?: string;
  attemptCount?: number;
  resumeCount?: number;
  lastCheckpoint?: string;
  lastError?: string;
  worktreePath?: string;
  parentCwd?: string;
  priority?: "low" | "normal" | "high" | "urgent";
  tags: string[];
  owner?: string;
  blockedBy: string[];
  dueAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface TaskStore {
  version: number;
  tasks: Record<string, PersistentTask>;
}

type AgentMemoryScope = "user" | "project" | "local";

interface AgentMemoryConfig {
  enabled?: boolean;
  scope?: AgentMemoryScope;
}

interface AgentToolPolicy {
  allow?: string[];
  deny?: string[];
}

interface CoordinatorContractConfig {
  strictWorkerContract?: boolean;
  requireStructuredResults?: boolean;
}

interface AgentProfile {
  mode?: string;
  model?: string;
  requiredMcpServers?: string[];
  toolPolicy?: AgentToolPolicy;
  memory?: AgentMemoryConfig;
  coordinator?: CoordinatorContractConfig;
}

interface AgentConfigDocument {
  agent?: Record<string, AgentProfile>;
  mcp?: Record<string, unknown>;
}

interface ToolCatalogEntry {
  name: string;
  category: "routing" | "supervisor" | "observability" | "tasks" | "agents";
  description: string;
  keywords: string[];
}

const SUPERVISOR_STORE_VERSION = 1;
const TASK_STORE_VERSION = 1;

const TOOL_CATALOG: ToolCatalogEntry[] = [
  { name: "list_platforms", category: "routing", description: "List tiers, hosts, execution policy, and hardware metadata from the registry", keywords: ["inventory", "registry", "hosts", "tiers"] },
  { name: "check_health", category: "observability", description: "Ping configured model endpoints and report reachability and latency", keywords: ["latency", "health", "ping", "availability"] },
  { name: "list_models", category: "observability", description: "Fetch model catalogs from reachable model endpoints", keywords: ["models", "catalog", "tags"] },
  { name: "probe_endpoint_compatibility", category: "observability", description: "Validate compatible API behavior for models, chat completions, and JSON mode", keywords: ["compatibility", "chat", "json", "probe"] },
  { name: "route_task", category: "routing", description: "Recommend best tier, host, and model for a single task", keywords: ["route", "single", "placement"] },
  { name: "route_parallel_tasks", category: "routing", description: "Schedule many tasks across hosts with capacity-aware wave planning", keywords: ["parallel", "schedule", "waves", "capacity"] },
  { name: "route_task_with_watchdog", category: "routing", description: "Route task with liveness checks and failover candidates", keywords: ["watchdog", "failover", "fallback", "liveness"] },
  { name: "supervisor_start_session", category: "supervisor", description: "Start supervised execution state with fallback queue", keywords: ["session", "start", "recovery"] },
  { name: "supervisor_record_event", category: "supervisor", description: "Record canonical lifecycle events and update session state", keywords: ["event", "state", "transition"] },
  { name: "supervisor_tick", category: "supervisor", description: "Detect stalls and advance cooldown or fallback", keywords: ["tick", "stall", "backoff", "fallback"] },
  { name: "supervisor_abort_session", category: "supervisor", description: "Interrupt active supervised session", keywords: ["abort", "interrupt"] },
  { name: "supervisor_record_completion_check", category: "supervisor", description: "Record deterministic completion evidence and independent judge verdict", keywords: ["completion", "evidence", "judge", "qa"] },
  { name: "supervisor_complete_session", category: "supervisor", description: "Finalize supervised session outcome with validation gates", keywords: ["complete", "terminal", "outcome"] },
  { name: "supervisor_status", category: "supervisor", description: "Inspect sessions and circuit-breaker state", keywords: ["status", "breaker", "summary"] },
  { name: "supervisor_emit_continuation_prompt", category: "supervisor", description: "Generate bounded continuation prompt for stalled work", keywords: ["continuation", "prompt", "stalled"] },
  { name: "supervisor_run_self_test", category: "supervisor", description: "Run deterministic reliability self-checks", keywords: ["self-test", "reliability", "validation"] },
  { name: "get_hardware", category: "observability", description: "Detect local CPU/RAM/GPU hardware for routing decisions", keywords: ["hardware", "gpu", "vram", "ram"] },
  { name: "search_tools", category: "observability", description: "Search the MCP tool catalog by intent, name, and keywords", keywords: ["discover", "catalog", "search", "tooling"] },
  { name: "task_create", category: "tasks", description: "Create a persistent task record", keywords: ["task", "create", "todo", "queue"] },
  { name: "task_get", category: "tasks", description: "Fetch one persistent task by ID", keywords: ["task", "read", "lookup"] },
  { name: "task_update", category: "tasks", description: "Update task status and metadata", keywords: ["task", "update", "status", "blockers"] },
  { name: "task_list", category: "tasks", description: "List persistent tasks with filtering", keywords: ["task", "list", "filter", "backlog"] },
  { name: "task_suspend", category: "tasks", description: "Suspend a task with checkpoint metadata for resumption", keywords: ["task", "suspend", "checkpoint", "resume"] },
  { name: "task_resume", category: "tasks", description: "Resume a suspended or blocked task with a generated continuation directive", keywords: ["task", "resume", "continuation", "worktree"] },
  { name: "agent_list_profiles", category: "agents", description: "List effective agent policies merged from repo and user config", keywords: ["agent", "profile", "policy", "config"] },
  { name: "agent_preflight", category: "agents", description: "Validate required MCP servers and tool policy for an agent", keywords: ["agent", "mcp", "required", "preflight"] },
  { name: "agent_filter_tools", category: "agents", description: "Filter a candidate tool set through agent allow and deny rules", keywords: ["agent", "tools", "allow", "deny"] },
  { name: "agent_validate_profiles", category: "agents", description: "Validate merged agent profiles and report policy/configuration issues", keywords: ["agent", "validate", "lint", "config"] },
  { name: "agent_memory_get", category: "agents", description: "Read persistent memory for an agent by scope", keywords: ["agent", "memory", "scope", "read"] },
  { name: "agent_memory_append", category: "agents", description: "Append persistent memory notes for an agent by scope", keywords: ["agent", "memory", "append", "continuity"] },
  { name: "agent_memory_snapshot_status", category: "agents", description: "Check memory snapshot sync status and drift for an agent scope", keywords: ["agent", "memory", "snapshot", "drift"] },
  { name: "agent_memory_snapshot_sync", category: "agents", description: "Write or apply memory snapshots for an agent scope", keywords: ["agent", "memory", "snapshot", "sync"] },
  { name: "build_coordinator_contract", category: "agents", description: "Generate a hardened coordinator worker contract prompt", keywords: ["coordinator", "contract", "worker", "prompt"] },
];

const DEFAULT_RELIABILITY: ReliabilityConfig = {
  watchdogEnabled: true,
  progressTimeoutMs: 25_000,          // tuned down from 45s for faster recovery
  hardSessionTimeoutMs: 120_000,
  staleSessionTtlMs: 30 * 60_000,
  maxAttemptsPerSlice: 4,
  maxConsecutiveFailures: 5,
  backoffInitialMs: 2_000,
  backoffMaxMs: 60_000,
  failureResetWindowMs: 5 * 60_000,
  banHostModelAfterFailures: 2,
  retryDedupeWindowMs: 4_000,         // tuned down from 8s
  abortWindowMs: 6_000,               // tuned down from 10s
  completionValidationWindowMs: 90_000,
};

/**
 * Returns true when a stale recoveryInFlight lock should be auto-released.
 * This prevents a missed ack from permanently blocking recovery.
 */
export function shouldAutoReleaseLock(
  recoveryInFlight: boolean | undefined,
  lastRecoveryAt: number | undefined,
  now: number,
  gracePeriodMs: number
): boolean {
  return recoveryInFlight === true
    && typeof lastRecoveryAt === "number"
    && now - lastRecoveryAt > gracePeriodMs;
}

export const __testExports = {
  DEFAULT_RELIABILITY,
  pushSessionEvent,
  makeRecoveryKey,
  scoreTiers,
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

let supervisorStoreLock: Promise<void> = Promise.resolve();
let taskStoreLock: Promise<void> = Promise.resolve();

async function withSupervisorStoreLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = supervisorStoreLock;
  let release: () => void = () => {};
  supervisorStoreLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

async function withTaskStoreLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = taskStoreLock;
  let release: () => void = () => {};
  taskStoreLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

export function emptySupervisorStore(): SupervisorStore {
  return {
    version: SUPERVISOR_STORE_VERSION,
    sessions: {},
    hostModelFailures: {},
  };
}

function emptyTaskStore(): TaskStore {
  return {
    version: TASK_STORE_VERSION,
    tasks: {},
  };
}

function getSupervisorStatePath(): string {
  return resolve(homedir(), ".config/xx-stack/xx-stack-supervisor-state.json");
}

function getTaskStatePath(): string {
  return resolve(homedir(), ".config/xx-stack/xx-stack-task-state.json");
}

function getUserConfigPath(): string {
  return resolve(homedir(), ".config/xx-stack/config.json");
}

function getRepoConfigPath(): string {
  return resolve(
    process.env.XX_STACK_REPO || resolve(homedir(), ".config/xx-stack/skills/xx-stack"),
    ".xx-stack/config.json"
  );
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
}

function mergeAgentProfiles(base: AgentProfile, override: AgentProfile): AgentProfile {
  return {
    ...base,
    ...override,
    toolPolicy: {
      ...(base.toolPolicy ?? {}),
      ...(override.toolPolicy ?? {}),
    },
    memory: {
      ...(base.memory ?? {}),
      ...(override.memory ?? {}),
    },
    coordinator: {
      ...(base.coordinator ?? {}),
      ...(override.coordinator ?? {}),
    },
  };
}

function parseAgentProfile(raw: unknown): AgentProfile {
  const source = asRecord(raw);
  const toolPolicy = asRecord(source.toolPolicy);
  const memory = asRecord(source.memory);
  const coordinator = asRecord(source.coordinator);
  return {
    mode: typeof source.mode === "string" ? source.mode : undefined,
    model: typeof source.model === "string" ? source.model : undefined,
    requiredMcpServers: toStringArray(source.requiredMcpServers),
    toolPolicy: {
      allow: toStringArray(toolPolicy.allow),
      deny: toStringArray(toolPolicy.deny),
    },
    memory: {
      enabled: typeof memory.enabled === "boolean" ? memory.enabled : undefined,
      scope: memory.scope === "user" || memory.scope === "project" || memory.scope === "local"
        ? memory.scope
        : undefined,
    },
    coordinator: {
      strictWorkerContract: typeof coordinator.strictWorkerContract === "boolean"
        ? coordinator.strictWorkerContract
        : undefined,
      requireStructuredResults: typeof coordinator.requireStructuredResults === "boolean"
        ? coordinator.requireStructuredResults
        : undefined,
    },
  };
}

async function readAgentConfigDocument(path: string): Promise<AgentConfigDocument> {
  const parsed = await readJson(path);
  const root = asRecord(parsed);
  const agentRaw = asRecord(root.agent);
  const mcpRaw = asRecord(root.mcp);
  const agentProfiles: Record<string, AgentProfile> = {};

  for (const [agentId, agentValue] of Object.entries(agentRaw)) {
    if (!agentValue || typeof agentValue !== "object") continue;
    agentProfiles[agentId] = parseAgentProfile(agentValue);
  }

  return {
    agent: agentProfiles,
    mcp: mcpRaw,
  };
}

async function loadMergedAgentRuntimeConfig(): Promise<{
  agents: Record<string, AgentProfile>;
  configuredMcpServers: string[];
  sources: { repoPath: string; userPath: string };
}> {
  const repoPath = getRepoConfigPath();
  const userPath = getUserConfigPath();
  const [repoDoc, userDoc] = await Promise.all([
    readAgentConfigDocument(repoPath),
    readAgentConfigDocument(userPath),
  ]);

  const mergedAgents: Record<string, AgentProfile> = {};
  const repoAgents = repoDoc.agent ?? {};
  const userAgents = userDoc.agent ?? {};

  for (const [agentId, profile] of Object.entries(repoAgents)) {
    mergedAgents[agentId] = mergeAgentProfiles({}, profile);
  }
  for (const [agentId, profile] of Object.entries(userAgents)) {
    mergedAgents[agentId] = mergeAgentProfiles(mergedAgents[agentId] ?? {}, profile);
  }

  const mcpServerNames = [
    ...Object.keys(repoDoc.mcp ?? {}),
    ...Object.keys(userDoc.mcp ?? {}),
  ];
  const configuredMcpServers = [...new Set(mcpServerNames.map((name) => name.trim()).filter(Boolean))];

  return {
    agents: mergedAgents,
    configuredMcpServers,
    sources: { repoPath, userPath },
  };
}

function wildcardMatch(pattern: string, candidate: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const regex = new RegExp(`^${escaped}$`, "i");
  return regex.test(candidate);
}

function missingRequiredMcpServers(required: string[], available: string[]): string[] {
  if (required.length === 0) return [];
  return required.filter((pattern) => !available.some((name) => wildcardMatch(pattern, name)));
}

const ASYNC_AGENT_TOOL_BLOCKLIST = new Set<string>([
  "supervisor_abort_session",
  "task_suspend",
  "task_resume",
]);

function applyAsyncToolSafety(policy: {
  allowRules: string[];
  denyRules: string[];
  allowedTools: string[];
  deniedTools: string[];
}) {
  const allowedTools = policy.allowedTools.filter((tool) => !ASYNC_AGENT_TOOL_BLOCKLIST.has(tool));
  const removedForAsync = policy.allowedTools.filter((tool) => ASYNC_AGENT_TOOL_BLOCKLIST.has(tool));
  const deniedTools = [...new Set([...policy.deniedTools, ...removedForAsync])];
  return {
    ...policy,
    allowedTools,
    deniedTools,
    asyncRemovedTools: removedForAsync,
  };
}

function validateAgentProfiles(
  agents: Record<string, AgentProfile>,
  configuredMcpServers: string[]
): { errors: Array<Record<string, unknown>>; warnings: Array<Record<string, unknown>> } {
  const errors: Array<Record<string, unknown>> = [];
  const warnings: Array<Record<string, unknown>> = [];

  for (const [agentId, profile] of Object.entries(agents)) {
    if (!profile.model || profile.model.trim().length === 0) {
      errors.push({ agentId, code: "missing_model", message: "Agent model is not configured" });
    }

    const requiredServers = toStringArray(profile.requiredMcpServers);
    const missingServers = missingRequiredMcpServers(requiredServers, configuredMcpServers);
    if (missingServers.length > 0) {
      errors.push({
        agentId,
        code: "missing_required_mcp",
        message: "One or more required MCP servers are unavailable",
        missingServers,
      });
    }

    const allowRules = toStringArray(profile.toolPolicy?.allow);
    const denyRules = toStringArray(profile.toolPolicy?.deny);
    if (allowRules.length > 0 && denyRules.length > 0) {
      const overlap = allowRules.filter((allowRule) => denyRules.some((denyRule) => allowRule === denyRule));
      if (overlap.length > 0) {
        warnings.push({
          agentId,
          code: "overlapping_tool_rules",
          message: "Tool allow and deny lists overlap; deny will win",
          overlap,
        });
      }
    }

    if (profile.memory?.enabled === true && !profile.memory.scope) {
      warnings.push({
        agentId,
        code: "memory_scope_defaulted",
        message: "Memory enabled without explicit scope; defaulting to project",
      });
    }

    if (profile.mode !== "primary" && profile.mode !== "subagent") {
      warnings.push({
        agentId,
        code: "unexpected_mode",
        message: `Unexpected mode '${profile.mode ?? "<unset>"}'; expected primary or subagent`,
      });
    }
  }

  return { errors, warnings };
}

function applyToolPolicy(
  profile: AgentProfile,
  candidateTools: string[]
): {
  allowRules: string[];
  denyRules: string[];
  allowedTools: string[];
  deniedTools: string[];
} {
  const allowRules = toStringArray(profile.toolPolicy?.allow);
  const denyRules = toStringArray(profile.toolPolicy?.deny);
  const normalizedCandidates = [...new Set(candidateTools.map((tool) => tool.trim()).filter(Boolean))];
  const hasAllowAll = allowRules.length === 0 || allowRules.includes("*");

  const allowedTools = normalizedCandidates.filter((tool) => {
    const allowedByAllowRules = hasAllowAll || allowRules.some((rule) => wildcardMatch(rule, tool));
    if (!allowedByAllowRules) return false;
    const blocked = denyRules.some((rule) => wildcardMatch(rule, tool));
    return !blocked;
  });

  const deniedTools = normalizedCandidates.filter((tool) => !allowedTools.includes(tool));
  return { allowRules, denyRules, allowedTools, deniedTools };
}

function sanitizeNameForPath(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-");
}

function getScopedAgentMemoryDir(agentId: string, scope: AgentMemoryScope, cwd: string): string {
  const safeAgent = sanitizeNameForPath(agentId);
  const safeProject = sanitizeNameForPath(resolve(cwd));
  if (scope === "project") {
    return resolve(cwd, ".xx-stack/agent-memory", safeAgent);
  }
  if (scope === "local") {
    return resolve(homedir(), ".config/xx-stack/agent-memory-local", safeProject, safeAgent);
  }
  return resolve(homedir(), ".config/xx-stack/agent-memory", safeAgent);
}

function getAgentMemoryEntrypoint(agentId: string, scope: AgentMemoryScope, cwd: string): string {
  return resolve(getScopedAgentMemoryDir(agentId, scope, cwd), "MEMORY.md");
}

function getAgentMemorySnapshotPath(agentId: string, scope: AgentMemoryScope, cwd: string): string {
  return resolve(getScopedAgentMemoryDir(agentId, scope, cwd), "SNAPSHOT.md");
}

function getAgentMemorySnapshotMetaPath(agentId: string, scope: AgentMemoryScope, cwd: string): string {
  return resolve(getScopedAgentMemoryDir(agentId, scope, cwd), ".snapshot-meta.json");
}

function getAgentMemorySnapshotsDir(agentId: string, scope: AgentMemoryScope, cwd: string): string {
  return resolve(getScopedAgentMemoryDir(agentId, scope, cwd), ".snapshots");
}

async function readMemoryEntrypoint(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

async function ensureMemoryEntrypoint(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const current = await readMemoryEntrypoint(path);
  if (current.length === 0) {
    await atomicWriteTextFile(path, "# Agent Memory\n\n");
  }
}

function hashMemoryContent(content: string): string {
  let hash = 0;
  for (let index = 0; index < content.length; index += 1) {
    hash = (hash * 31 + content.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

async function readSnapshotMeta(path: string): Promise<Record<string, unknown> | null> {
  return readJson(path);
}

function lineDiffSummary(previousContent: string, nextContent: string): { added: number; removed: number; changed: number } {
  const previous = previousContent.split(/\r?\n/);
  const next = nextContent.split(/\r?\n/);
  const rows = previous.length;
  const cols = next.length;
  const dp: number[][] = Array.from({ length: rows + 1 }, () => Array<number>(cols + 1).fill(0));

  for (let i = 1; i <= rows; i += 1) {
    for (let j = 1; j <= cols; j += 1) {
      if (previous[i - 1] === next[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const lcs = dp[rows][cols];
  const added = Math.max(0, cols - lcs);
  const removed = Math.max(0, rows - lcs);
  return {
    added,
    removed,
    changed: Math.min(added, removed),
  };
}

function buildMemoryResyncHelperPrompt(
  agentId: string,
  scope: AgentMemoryScope,
  drift: { added: number; removed: number; changed: number }
): string {
  return [
    `Memory drift detected for agent ${agentId} (${scope}).`,
    `Diff summary: added=${drift.added}, removed=${drift.removed}, changed=${drift.changed}.`,
    "If current MEMORY.md is authoritative, run agent_memory_snapshot_sync with direction='capture'.",
    "If SNAPSHOT.md is authoritative, run agent_memory_snapshot_sync with direction='apply'.",
    "After syncing, run agent_memory_snapshot_status again to confirm driftDetected=false.",
  ].join(" ");
}

async function writeSnapshotHistoryEntry(
  snapshotsDir: string,
  direction: "capture" | "apply",
  memoryContent: string,
  snapshotContent: string,
  meta: Record<string, unknown>
): Promise<string> {
  await mkdir(snapshotsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `${timestamp}-${direction}`;
  const memoryHistoryPath = resolve(snapshotsDir, `${base}-MEMORY.md`);
  const snapshotHistoryPath = resolve(snapshotsDir, `${base}-SNAPSHOT.md`);
  const metaHistoryPath = resolve(snapshotsDir, `${base}-meta.json`);
  await atomicWriteTextFile(memoryHistoryPath, memoryContent.length > 0 ? memoryContent : "# Agent Memory\n\n");
  await atomicWriteTextFile(snapshotHistoryPath, snapshotContent.length > 0 ? snapshotContent : "# Agent Memory\n\n");
  await atomicWriteTextFile(metaHistoryPath, JSON.stringify(meta, null, 2) + "\n");
  return base;
}

async function getCompletionMemorySyncStatus(guard: CompletionMemorySyncGuard): Promise<{
  memoryPath: string;
  snapshotPath: string;
  metaPath: string;
  memoryHash: string;
  snapshotHash: string;
  driftDetected: boolean;
  diff: { added: number; removed: number; changed: number };
  helperPrompt: string | null;
}> {
  const memoryPath = getAgentMemoryEntrypoint(guard.agentId, guard.scope, guard.cwd);
  const snapshotPath = getAgentMemorySnapshotPath(guard.agentId, guard.scope, guard.cwd);
  const metaPath = getAgentMemorySnapshotMetaPath(guard.agentId, guard.scope, guard.cwd);

  await ensureMemoryEntrypoint(memoryPath);
  await ensureMemoryEntrypoint(snapshotPath);

  const memoryContent = await readMemoryEntrypoint(memoryPath);
  const snapshotContent = await readMemoryEntrypoint(snapshotPath);

  const memoryHash = hashMemoryContent(memoryContent);
  const snapshotHash = hashMemoryContent(snapshotContent);
  const driftDetected = memoryHash !== snapshotHash;
  const diff = lineDiffSummary(snapshotContent, memoryContent);
  const helperPrompt = driftDetected ? buildMemoryResyncHelperPrompt(guard.agentId, guard.scope, diff) : null;

  return {
    memoryPath,
    snapshotPath,
    metaPath,
    memoryHash,
    snapshotHash,
    driftDetected,
    diff,
    helperPrompt,
  };
}

function buildWorktreeResumeNotice(parentCwd: string | undefined, worktreePath: string | undefined): string {
  if (!worktreePath) {
    return "No isolated worktree path is recorded for this task. Re-open files from the current workspace before resuming.";
  }
  if (!parentCwd) {
    return `Task is linked to isolated worktree ${worktreePath}. Re-read all target files there before editing.`;
  }
  return [
    `Task context was originally gathered from parent workspace ${parentCwd}.`,
    `Resume inside isolated worktree ${worktreePath}.`,
    "Translate inherited file paths from parent workspace to this worktree root before editing.",
    "Re-open each file before patching in case parent and worktree diverged.",
  ].join(" ");
}

function buildResumeDirective(task: PersistentTask, linkedSession: SupervisorSessionState | undefined): string {
  const lines: string[] = [
    "Resume directive:",
    `- task-id: ${task.taskId}`,
    `- title: ${task.title}`,
    `- attempt: ${task.attemptCount ?? 0}`,
    `- resumes: ${task.resumeCount ?? 0}`,
  ];
  if (task.lastCheckpoint) lines.push(`- checkpoint: ${task.lastCheckpoint}`);
  if (task.lastError) lines.push(`- previous-error: ${task.lastError}`);
  if (task.sessionId) lines.push(`- supervisor-session: ${task.sessionId}`);
  if (linkedSession?.currentRoute) {
    lines.push(`- current-route: ${linkedSession.currentRoute.host}/${linkedSession.currentRoute.model ?? "<none>"}`);
  }
  lines.push(`- worktree-note: ${buildWorktreeResumeNotice(task.parentCwd, task.worktreePath)}`);
  lines.push("- requirements:");
  lines.push("  - continue from existing artifacts, do not restart from scratch");
  lines.push("  - produce deterministic evidence (diff, command output, or explicit blocker)");
  lines.push("  - if blocked, include next fallback action");
  return lines.join("\n");
}

function buildCoordinatorContract(agentId: string, strict: boolean, structuredResults: boolean): string {
  const lines: string[] = [
    `Coordinator contract for ${agentId}:`,
    "1. Treat worker notifications as internal signals, not user conversation turns.",
    "2. Never fabricate worker outcomes; only summarize received deterministic results.",
    "3. Worker prompts must be self-contained and include exact files, commands, and acceptance checks.",
    "4. Reuse the same worker for follow-up when context continuity matters.",
    "5. Stop or reroute workers immediately when requirements change.",
    "6. For parallel work, fan out independent research/verification slices in one batch.",
  ];

  if (strict) {
    lines.push("7. Strict mode: do not delegate trivial readback tasks that can be answered directly.");
    lines.push("8. Strict mode: require a concise synthesis step before issuing implementation follow-ups.");
  }
  if (structuredResults) {
    lines.push("9. Require worker outputs to include scope, result, changed files, and open issues.");
  }
  return lines.join("\n");
}

function toPositiveNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function quickPingEndpoint(endpoint: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);
  try {
    const url = new URL("/v1/models", endpoint);
    const res = await fetch(url.toString(), { method: "GET", signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadReliabilityConfig(): Promise<ReliabilityConfig> {
  const userConfigPath = getUserConfigPath();
  const repoConfigPath = getRepoConfigPath();

  const [userConfig, repoConfig] = await Promise.all([
    readJson(userConfigPath),
    readJson(repoConfigPath),
  ]);

  const fromConfig = (config: Record<string, unknown> | null): Record<string, unknown> | null => {
    if (!config) return null;
    const agent = config.agent;
    if (!agent || typeof agent !== "object") return null;
    const orchestrator = (agent as Record<string, unknown>)["execution-orchestrator"];
    if (!orchestrator || typeof orchestrator !== "object") return null;
    const reliability = (orchestrator as Record<string, unknown>).reliability;
    if (!reliability || typeof reliability !== "object") return null;
    return reliability as Record<string, unknown>;
  };

  const reliability = {
    ...(fromConfig(repoConfig) ?? {}),
    ...(fromConfig(userConfig) ?? {}),
  };

  return {
    watchdogEnabled: reliability.watchdogEnabled !== false,
    progressTimeoutMs: toPositiveNumber(reliability.progressTimeoutMs, DEFAULT_RELIABILITY.progressTimeoutMs),
    hardSessionTimeoutMs: toPositiveNumber(reliability.hardSessionTimeoutMs, DEFAULT_RELIABILITY.hardSessionTimeoutMs),
    staleSessionTtlMs: toPositiveNumber(reliability.staleSessionTtlMs, DEFAULT_RELIABILITY.staleSessionTtlMs),
    maxAttemptsPerSlice: Math.max(1, Math.floor(toPositiveNumber(reliability.maxAttemptsPerSlice, DEFAULT_RELIABILITY.maxAttemptsPerSlice))),
    maxConsecutiveFailures: Math.max(1, Math.floor(toPositiveNumber(reliability.maxConsecutiveFailures, DEFAULT_RELIABILITY.maxConsecutiveFailures))),
    backoffInitialMs: toPositiveNumber(reliability.backoffInitialMs, DEFAULT_RELIABILITY.backoffInitialMs),
    backoffMaxMs: toPositiveNumber(reliability.backoffMaxMs, DEFAULT_RELIABILITY.backoffMaxMs),
    failureResetWindowMs: toPositiveNumber(reliability.failureResetWindowMs, DEFAULT_RELIABILITY.failureResetWindowMs),
    banHostModelAfterFailures: Math.max(1, Math.floor(toPositiveNumber(reliability.banHostModelAfterFailures, DEFAULT_RELIABILITY.banHostModelAfterFailures))),
    retryDedupeWindowMs: toPositiveNumber(reliability.retryDedupeWindowMs, DEFAULT_RELIABILITY.retryDedupeWindowMs),
    abortWindowMs: toPositiveNumber(reliability.abortWindowMs, DEFAULT_RELIABILITY.abortWindowMs),
    completionValidationWindowMs: toPositiveNumber(
      reliability.completionValidationWindowMs,
      DEFAULT_RELIABILITY.completionValidationWindowMs
    ),
  };
}

async function readSupervisorStore(): Promise<SupervisorStore> {
  const path = getSupervisorStatePath();
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SupervisorStore>;
    return {
      version: SUPERVISOR_STORE_VERSION,
      sessions: parsed.sessions ?? {},
      hostModelFailures: parsed.hostModelFailures ?? {},
    };
  } catch {
    return emptySupervisorStore();
  }
}

async function readTaskStore(): Promise<TaskStore> {
  const path = getTaskStatePath();
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<TaskStore>;
    return {
      version: TASK_STORE_VERSION,
      tasks: parsed.tasks ?? {},
    };
  } catch {
    return emptyTaskStore();
  }
}

async function writeSupervisorStore(store: SupervisorStore): Promise<void> {
  const path = getSupervisorStatePath();
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteTextFile(path, JSON.stringify(store, null, 2) + "\n");
}

async function writeTaskStore(store: TaskStore): Promise<void> {
  const path = getTaskStatePath();
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteTextFile(path, JSON.stringify(store, null, 2) + "\n");
}

function generateTaskId(): string {
  return `tsk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeTags(tags: string[] | undefined): string[] {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))].slice(0, 32);
}

export async function atomicWriteTextFile(path: string, content: string): Promise<void> {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tempPath, content, "utf-8");
  await rename(tempPath, path);
}

function failureKey(host: string, model: string | null): string {
  return `${host}::${model ?? "<none>"}`;
}

function sessionEvent(type: string, detail: string): SupervisorEvent {
  return {
    at: new Date().toISOString(),
    type,
    detail,
  };
}

function pushSessionEvent(state: SupervisorSessionState, type: string, detail: string): void {
  state.events.push(sessionEvent(type, detail));
  if (state.events.length > 64) {
    state.events.splice(0, state.events.length - 64);
  }
}

function clearCompletionProof(state: SupervisorSessionState): void {
  state.completionEvidenceAt = undefined;
  state.completionEvidenceSummary = undefined;
  state.completionJudgeAt = undefined;
  state.completionJudgeVerdict = undefined;
  state.completionJudgeSummary = undefined;
}

function makeAttemptId(sessionId: string, attemptCount: number, route: SupervisorRoute | null): string {
  const host = route?.host ?? "no-host";
  const model = route?.model ?? "no-model";
  return `${sessionId}::${attemptCount}::${host}::${model}`;
}

function makeRecoveryKey(state: SupervisorSessionState): string {
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
  return lastFingerprint === nextFingerprint
    && typeof lastAt === "number"
    && now - lastAt < dedupeWindowMs;
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
  if (shouldRequireCompletionValidation(state.lastOutputAt, now, reliability.completionValidationWindowMs)) {
    return { ok: false, reasonCode: "completion_validation_failed" };
  }

  if (
    typeof state.completionEvidenceAt !== "number"
    || now - state.completionEvidenceAt > reliability.completionValidationWindowMs
  ) {
    return { ok: false, reasonCode: "completion_evidence_missing" };
  }

  if (typeof state.lastOutputAt === "number" && state.completionEvidenceAt < state.lastOutputAt) {
    return { ok: false, reasonCode: "completion_evidence_stale" };
  }

  if (
    state.completionJudgeVerdict !== "pass"
    || typeof state.completionJudgeAt !== "number"
    || now - state.completionJudgeAt > reliability.completionValidationWindowMs
  ) {
    return { ok: false, reasonCode: "completion_judge_missing_or_failed" };
  }

  if (state.completionJudgeAt < state.completionEvidenceAt) {
    return { ok: false, reasonCode: "completion_judge_before_evidence" };
  }

  return { ok: true, reasonCode: "completion_ready" };
}

function parseCompletionValidationReason(detail: string | undefined): string {
  if (!detail) return "completion_validation_failed";
  const [prefix] = detail.split(";");
  const normalized = prefix.trim();
  return normalized.length > 0 ? normalized : "completion_validation_failed";
}

function buildCompletionRepairChecklist(reasonCode: string): string[] {
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
    completion_memory_drift_detected: [
      "Run agent_memory_snapshot_status for the guarded agent/scope and inspect helperPrompt.",
      "Resolve drift with agent_memory_snapshot_sync (direction='capture' or direction='apply').",
      "Re-run agent_memory_snapshot_status and confirm driftDetected=false before retrying completion.",
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
      if (shouldRequireCompletionValidation(state.lastOutputAt, now, reliability.completionValidationWindowMs)) {
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

export function computeBackoffMs(reliability: ReliabilityConfig, failureCount: number): number {
  const backoff = reliability.backoffInitialMs * Math.pow(2, Math.max(0, failureCount - 1));
  return Math.min(reliability.backoffMaxMs, backoff);
}

async function loadRegistry(): Promise<Registry> {
  // Prefer live runtime registry, fall back to repo template
  const livePath = resolve(homedir(), ".config/xx-stack/xx-stack-platforms.json");
  const repoPath = resolve(
    process.env.XX_STACK_REPO || resolve(homedir(), ".config/xx-stack/skills/xx-stack"),
    ".xx-stack/platforms.json"
  );

  for (const path of [livePath, repoPath]) {
    try {
      const raw = await readFile(path, "utf-8");
      return JSON.parse(raw) as Registry;
    } catch {
      continue;
    }
  }
  throw new Error("No platform registry found. Run setup.sh first.");
}

// --- Endpoint family helpers ---

function endpointFamilyForProvider(provider: string): "catalog" | "compatible" {
  const normalized = provider.toLowerCase();
  if (normalized.includes("catalog")) {
    return "catalog";
  }
  if (normalized.includes("compatible") || normalized.includes("cloud") || normalized.includes("hosted")) {
    return "compatible";
  }
  return "compatible";
}

function endpointFamilyForHost(host: Host): "catalog" | "compatible" {
  return host.capabilities?.endpointFamily ?? endpointFamilyForProvider(host.provider);
}

async function fetchCatalogModels(endpoint: string): Promise<string[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const url = new URL("/api/tags", endpoint);
    const res = await fetch(url.toString(), { signal: controller.signal });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: { name: string }[] };
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchCompatibleModels(endpoint: string): Promise<string[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const url = new URL("/v1/models", endpoint);
    const res = await fetch(url.toString(), { signal: controller.signal });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    return (data.data ?? []).map((m) => m.id ?? "").filter((id) => id.length > 0);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function pingCatalogEndpoint(endpoint: string): Promise<{ ok: boolean; latencyMs: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const start = Date.now();
  try {
    const url = new URL("/api/tags", endpoint);
    const res = await fetch(url.toString(), { signal: controller.signal });
    return { ok: res.ok || res.status === 200, latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeCompatibleEndpoint(endpoint: string): string {
  return endpoint.replace(/\/v1\/?$/, "").replace(/\/$/, "");
}

async function pingCompatibleEndpoint(endpoint: string): Promise<{ ok: boolean; latencyMs: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const start = Date.now();
  try {
    const url = new URL("/v1/models", endpoint);
    const res = await fetch(url.toString(), { signal: controller.signal });
    return { ok: res.ok || res.status === 200, latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchHostModels(host: Host): Promise<string[]> {
  const family = endpointFamilyForHost(host);
  if (family === "catalog") {
    return fetchCatalogModels(host.endpoint);
  }
  return fetchCompatibleModels(host.endpoint);
}

async function postJsonWithStatus(url: string, payload: unknown): Promise<{ ok: boolean; status: number; json: unknown | null; reason?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    let json: unknown | null = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      json: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function probeHostEndpointCompatibility(host: Host, requestedModel: string | null = null): Promise<EndpointCompatibilityProbe> {
  const endpointFamily = endpointFamilyForHost(host);
  const endpoint = endpointFamily === "compatible"
    ? normalizeCompatibleEndpoint(host.endpoint)
    : host.endpoint.replace(/\/$/, "");
  const provider = host.provider;

  const models: string[] = await fetchHostModels(host);
  const resolvedModel = requestedModel ?? models[0] ?? modelNamesForHost(host)[0] ?? null;

  const modelsCheck = {
    ok: models.length > 0,
    status: models.length > 0 ? 200 : 0,
    reason: models.length > 0 ? undefined : "no models returned from live endpoint",
  };

  if (!resolvedModel) {
    return {
      endpoint,
      provider,
      endpointFamily,
      modelRequested: requestedModel,
      modelResolved: null,
      checks: {
        modelsEndpoint: modelsCheck,
        chatCompletion: {
          ok: false,
          status: 0,
          reason: "no model available for chat completion probe",
        },
        jsonMode: {
          ok: false,
          status: 0,
          reason: "no model available for JSON probe",
        },
      },
    };
  }

  const chatProbe = await postJsonWithStatus(`${endpoint}/v1/chat/completions`, {
    model: resolvedModel,
    max_tokens: 16,
    temperature: 0,
    messages: [
      { role: "system", content: "Respond briefly." },
      { role: "user", content: "Reply with the word ok." },
    ],
  });

  const jsonProbePayload = {
    model: resolvedModel,
    max_tokens: 64,
    temperature: 0,
    messages: [
      { role: "system", content: "Return valid JSON only." },
      { role: "user", content: "Return {\"status\":\"ok\",\"value\":1}." },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "probe_response",
        schema: {
          type: "object",
          properties: {
            status: { type: "string" },
            value: { type: "number" },
          },
          required: ["status", "value"],
          additionalProperties: false,
        },
      },
    },
  };

  const jsonProbe = await postJsonWithStatus(`${endpoint}/v1/chat/completions`, jsonProbePayload);

  return {
    endpoint,
    provider,
    endpointFamily,
    modelRequested: requestedModel,
    modelResolved: resolvedModel,
    checks: {
      modelsEndpoint: modelsCheck,
      chatCompletion: {
        ok: chatProbe.ok,
        status: chatProbe.status,
        reason: chatProbe.ok ? undefined : chatProbe.reason ?? "chat completion probe failed",
      },
      jsonMode: {
        ok: jsonProbe.ok,
        status: jsonProbe.status,
        reason: jsonProbe.ok ? undefined : jsonProbe.reason ?? "json mode probe failed",
      },
    },
  };
}

async function pingHostEndpoint(host: Host): Promise<{ ok: boolean; latencyMs: number }> {
  const family = endpointFamilyForHost(host);
  if (family === "catalog") {
    return pingCatalogEndpoint(host.endpoint);
  }
  return pingCompatibleEndpoint(host.endpoint);
}

// --- Hardware detection ---

async function detectHardware(): Promise<Record<string, unknown>> {
  const hw: Record<string, unknown> = {};

  // RAM
  try {
    const { stdout } = await execFileAsync("free", ["-b"], { timeout: 3000 });
    const match = stdout.match(/Mem:\s+(\d+)/);
    if (match) hw.ramGb = Math.round(Number(match[1]) / 1073741824 * 10) / 10;
  } catch { /* ignore */ }

  // GPUs via lspci
  try {
    const { stdout } = await execFileAsync("lspci", [], { timeout: 3000 });
    const gpus = stdout
      .split("\n")
      .filter((l: string) => /vga|3d|display/i.test(l))
      .map((l: string) => l.replace(/^[\da-f:.]+\s+\w.*?:\s*/i, "").trim());
    hw.gpus = gpus;
  } catch { /* ignore */ }

  // VRAM via sysfs
  try {
    const { stdout } = await execFileAsync("bash", ["-c",
      "cat /sys/class/drm/card*/device/mem_info_vram_total 2>/dev/null"
    ], { timeout: 3000 });
    const vrams = stdout.trim().split("\n")
      .filter(Boolean)
      .map((v: string) => Math.round(Number(v) / 1073741824));
    hw.vramGb = vrams;
    hw.totalVramGb = vrams.reduce((a: number, b: number) => a + b, 0);
  } catch { /* ignore */ }

  return hw;
}

// --- Task routing ---

const TASK_KEYWORDS: Record<string, string[]> = {
  "primary": [
    "implement", "code", "edit", "fix", "build", "test", "review",
    "deploy", "release", "plan", "planner", "planning", "orchestrate", "orchestrator"
  ],
  "reasoning": [
    "architecture", "architect", "research", "analyze", "investigate",
    "long-context", "long context", "deep-reasoning", "synthesis"
  ],
  "local": [
    "fast", "quick", "small", "obvious", "verify", "offline", "fallback", "local"
  ],
  "overflow": [
    "subagent", "delegate", "delegated", "parallel", "overflow", "offload",
    "backup", "fallback-reasoning"
  ],
  "compatibility": [
    "legacy", "bridge", "migration", "compatibility"
  ],
  "cloud": [
    "multimodal", "image", "vision", "provider-specific", "burst",
    "capability-gap", "unavailable-locally"
  ],
};

function modelEntries(host: Host): Array<{
  name: string;
  roles: string[];
  sizeGb: number | null;
  format: string | null;
  quantization: string | null;
  weightBits: number | null;
  kernelFamily: string | null;
  contextWindow: number | null;
  estimatedVramGb: number | null;
  supportsToolUse: boolean | null;
  toolCallReliability: "unknown" | "low" | "validated";
  jsonModeReliability: "unknown" | "low" | "validated";
}> {
  return (host.models ?? [])
    .map((model) => {
      if (typeof model === "string") {
        return {
          name: model,
          roles: [],
          sizeGb: null,
          format: null,
          quantization: null,
          weightBits: null,
          kernelFamily: null,
          contextWindow: null,
          estimatedVramGb: null,
          supportsToolUse: null,
          toolCallReliability: "unknown" as const,
          jsonModeReliability: "unknown" as const,
        };
      }
      const sizeBytes = typeof model?.size === "number" ? model.size : null;
      const inferredWeightBits = typeof model?.weightBits === "number"
        ? model.weightBits
        : (model?.quantization?.toLowerCase().includes("q1") || model?.quantization?.toLowerCase().includes("tq1")
          ? 1
          : null);
      const toolCallReliability: "unknown" | "low" | "validated" =
        model?.toolCallReliability === "low" || model?.toolCallReliability === "validated"
          ? model.toolCallReliability
          : "unknown";
      const jsonModeReliability: "unknown" | "low" | "validated" =
        model?.jsonModeReliability === "low" || model?.jsonModeReliability === "validated"
          ? model.jsonModeReliability
          : "unknown";
      return {
        name: model?.name ?? "",
        roles: Array.isArray(model?.roles) ? model.roles : [],
        sizeGb: sizeBytes ? Math.round((sizeBytes / 1073741824) * 10) / 10 : null,
        format: typeof model?.format === "string" ? model.format : null,
        quantization: typeof model?.quantization === "string" ? model.quantization : null,
        weightBits: inferredWeightBits,
        kernelFamily: typeof model?.kernelFamily === "string" ? model.kernelFamily : null,
        contextWindow: typeof model?.contextWindow === "number" ? model.contextWindow : null,
        estimatedVramGb: typeof model?.estimatedVramGb === "number" ? model.estimatedVramGb : null,
        supportsToolUse: typeof model?.supportsToolUse === "boolean" ? model.supportsToolUse : null,
        toolCallReliability,
        jsonModeReliability,
      };
    })
    .filter((entry) => Boolean(entry.name));
}

function maxParallelSlices(host: Host): number {
  const configured = Number(host.executionPolicy?.maxParallelSlices ?? 0);
  return configured > 0 ? Math.floor(configured) : 1;
}

function maxConcurrentModels(host: Host): number {
  const configured = Number(host.executionPolicy?.maxConcurrentModels ?? 0);
  return configured > 0 ? Math.floor(configured) : 1;
}

function effectiveParallelCapacity(host: Host): number {
  return Math.max(1, Math.min(maxParallelSlices(host), maxConcurrentModels(host)));
}

function hostCapacityScore(host: Host): number {
  const baseParallel = effectiveParallelCapacity(host);
  const detectedVram = Number(host.hardware?.detected?.totalGpuVramGb ?? 0);
  const modelCount = modelEntries(host).length;
  const primaryBoost = host.primary ? 0.25 : 0;
  return baseParallel * 10 + detectedVram * 0.2 + modelCount * 0.5 + primaryBoost;
}

function chooseModelForTask(host: Host, description: string): string | null {
  const entries = modelEntries(host);
  if (entries.length === 0) return null;

  const desc = description.toLowerCase();
  const wantsCode = /implement|code|fix|edit|build|review|test/.test(desc);
  const wantsReason = /plan|architect|reason|research|analy|investigate|synthes/.test(desc);
  const strictToolTask = /tool|function\s*call|structured\s*json|strict\s*json|json\s*schema/.test(desc);
  const longContextTask = /long-context|long context|large-context|synthesis/.test(desc);

  let candidates = [...entries];

  if (strictToolTask) {
    const validated = candidates.filter((entry) =>
      entry.supportsToolUse === true
      && entry.toolCallReliability === "validated"
      && entry.jsonModeReliability === "validated"
    );
    if (validated.length > 0) {
      candidates = validated;
    }
  }

  if (longContextTask) {
    const largeContext = candidates.filter((entry) => (entry.contextWindow ?? 0) >= 64000);
    if (largeContext.length > 0) {
      candidates = largeContext;
    }
  }

  if (wantsCode) {
    const coding = candidates.find((entry) => entry.roles.some((role) => /build|review|code/.test(role)));
    if (coding) return coding.name;
  }

  if (wantsReason) {
    const reasoning = candidates.find((entry) => entry.roles.some((role) => /plan|architect|reason|research|orchestrator/.test(role)));
    if (reasoning) return reasoning.name;
  }

  const safeGeneral = candidates.find((entry) =>
    !strictToolTask || (
      entry.supportsToolUse === true
      && entry.toolCallReliability !== "low"
      && entry.jsonModeReliability !== "low"
    )
  );

  return safeGeneral?.name ?? entries[0].name;
}

function modelNamesForHost(host: Host | null): string[] {
  return (host?.models ?? [])
    .map((model) => typeof model === "string" ? model : model?.name)
    .filter((modelName): modelName is string => Boolean(modelName));
}

function findHostById(registry: Registry, hostId: string): { tierId: string; host: Host } | null {
  for (const tier of registry.tiers) {
    const host = tier.hosts.find((candidate) => candidate.id === hostId);
    if (host) {
      return { tierId: tier.id, host };
    }
  }
  return null;
}

async function checkHostModelHealth(host: Host, modelName: string | null): Promise<{
  hostHealthy: boolean;
  modelAvailable: boolean;
  latencyMs: number | null;
  checkedModel: string | null;
  source: "live" | "registry" | "none";
  reason: string;
}> {
  const checkedModel = modelName ?? null;

  if (host.enabled === false || host.reachable === false) {
    return {
      hostHealthy: false,
      modelAvailable: false,
      latencyMs: null,
      checkedModel,
      source: "none",
      reason: "host disabled or marked unreachable",
    };
  }

  if (!host.endpoint.startsWith("http://") && !host.endpoint.startsWith("https://")) {
    return {
      hostHealthy: false,
      modelAvailable: false,
      latencyMs: null,
      checkedModel,
      source: "none",
      reason: "endpoint is not HTTP(S)",
    };
  }

  const ping = await pingHostEndpoint(host);
  if (!ping.ok) {
    return {
      hostHealthy: false,
      modelAvailable: false,
      latencyMs: ping.latencyMs,
      checkedModel,
      source: "live",
      reason: "endpoint unreachable",
    };
  }

  const liveModels = await fetchHostModels(host);
  const modelCatalog = liveModels.length > 0 ? liveModels : modelNamesForHost(host);
  const modelAvailable = checkedModel ? modelCatalog.includes(checkedModel) : modelCatalog.length > 0;

  return {
    hostHealthy: true,
    modelAvailable,
    latencyMs: ping.latencyMs,
    checkedModel,
    source: liveModels.length > 0 ? "live" : "registry",
    reason: modelAvailable
      ? "host reachable and model available"
      : `host reachable but model ${checkedModel ?? "<unset>"} missing`,
  };
}

function scoreTiers(description: string, registry: Registry): Record<string, number> {
  const desc = description.toLowerCase();
  const scores: Record<string, number> = {};

  for (const [tier, keywords] of Object.entries(TASK_KEYWORDS)) {
    scores[tier] = keywords.filter((keyword) => desc.includes(keyword)).length;
  }

  for (const rule of registry.selectionPolicy.rules) {
    const ruleWords = rule.when.toLowerCase().split(/[,\s]+/);
    const matches = ruleWords.filter((word) => word.length > 3 && desc.includes(word)).length;
    if (matches > 0 && rule.preferTier !== "next-available") {
      scores[rule.preferTier] = (scores[rule.preferTier] || 0) + matches * 2;
    }
  }

  return scores;
}

function isMultimodalTask(description: string): boolean {
  const desc = description.toLowerCase();
  return /multimodal|image|vision|audio|video|speech|transcribe|ocr/.test(desc);
}

function isSelfHostedCompatibleLane(host: Host): boolean {
  const provider = host.provider.toLowerCase();
  return provider.includes("self-hosted") || provider.includes("local-catalog") || provider.includes("compatibility");
}

function hostAllowedForTask(host: Host, description: string): boolean {
  if (isMultimodalTask(description) && isSelfHostedCompatibleLane(host)) {
    return false;
  }
  return true;
}

function routeTask(description: string, registry: Registry): RouteRecommendation {
  const isAvailableHost = (host: Host) =>
    host.enabled !== false
    && host.reachable !== false
    && hostAllowedForTask(host, description);
  const prioritizeHosts = (hosts: Host[]) => [...hosts].sort((left, right) => hostCapacityScore(right) - hostCapacityScore(left));

  const scores = scoreTiers(description, registry);

  // Pick highest scoring tier, default to first in defaultOrder
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const bestTier = sorted[0]?.[1] > 0
    ? sorted[0][0]
    : registry.selectionPolicy.defaultOrder[0];

  const orderedTierIds = registry.selectionPolicy.defaultOrder;
  const requestedTier = registry.tiers.find((t) => t.id === bestTier) ?? null;
  const requestedHosts = prioritizeHosts(requestedTier?.hosts.filter(isAvailableHost) ?? []);

  let resolvedTier = requestedTier;
  let resolvedTierId = bestTier;
  let resolvedHosts = requestedHosts;
  let usedFallback = false;

  if (resolvedHosts.length === 0) {
    for (const tierId of orderedTierIds) {
      if (tierId === bestTier) {
        continue;
      }
      const candidateTier = registry.tiers.find((tier) => tier.id === tierId);
      const candidateHosts = prioritizeHosts(candidateTier?.hosts.filter(isAvailableHost) ?? []);
      if (candidateTier && candidateHosts.length > 0) {
        resolvedTier = candidateTier;
        resolvedTierId = tierId;
        resolvedHosts = candidateHosts;
        usedFallback = true;
        break;
      }
    }
  }

  const host = resolvedHosts[0] ?? null;
  const models = modelNamesForHost(host);
  const fallbackId = orderedTierIds
    .filter((tierId) => tierId !== resolvedTierId)
    .find((tierId) => {
      const tier = registry.tiers.find((candidate) => candidate.id === tierId);
      return Boolean(tier?.hosts.some(isAvailableHost));
    }) ?? null;
  const requestedScore = sorted[0]?.[1] ?? 0;
  const selectedModel = chooseModelForTask(host, description);
  const baseReasoning = requestedScore > 0
    ? `Matched keywords for "${bestTier}" tier (score: ${requestedScore})${usedFallback ? `; fell back to "${resolvedTierId}" because no reachable hosts were available on "${bestTier}"` : ""}`
    : `No strong keyword match; defaulting to "${resolvedTierId}" per selection policy${usedFallback ? ` after "${bestTier}" had no reachable hosts` : ""}`;
  const reasoning = isMultimodalTask(description)
    ? `${baseReasoning}; denied self-hosted text-first multimodal routing by policy (text/chat/embeddings only)`
    : baseReasoning;

  return {
    recommendedTier: resolvedTierId,
    recommendedHost: host?.id ?? null,
    recommendedModel: selectedModel,
    reasoning: selectedModel ? `${reasoning}; selected model "${selectedModel}" using host roles and task intent` : reasoning,
    availableModels: models,
    fallback: fallbackId,
  };
}

function routeParallelTasks(descriptions: string[], registry: Registry): {
  assignments: Array<Record<string, unknown>>;
  hostUtilization: Array<Record<string, unknown>>;
} {
  const orderedTierIds = registry.selectionPolicy.defaultOrder;
  const allHostsByTier = new Map<string, Host[]>();

  for (const tier of registry.tiers) {
    allHostsByTier.set(
      tier.id,
      [...(tier.hosts ?? [])]
        .filter((host) => host.enabled !== false && host.reachable !== false)
        .sort((left, right) => hostCapacityScore(right) - hostCapacityScore(left))
    );
  }

  const hostLoad = new Map<string, number>();
  for (const hosts of allHostsByTier.values()) {
    for (const host of hosts) {
      hostLoad.set(host.id, 0);
    }
  }

  const assignments = descriptions.map((description, index) => {
    const scores = scoreTiers(description, registry);
    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const preferredTierId = sorted[0]?.[1] > 0 ? sorted[0][0] : orderedTierIds[0];
    const orderedTiers = [preferredTierId, ...orderedTierIds.filter((tierId) => tierId !== preferredTierId)];

    let selectedTierId = orderedTiers[0] ?? preferredTierId;
    let selectedHost: Host | null = null;

    for (const tierId of orderedTiers) {
      const candidates = (allHostsByTier.get(tierId) ?? []).filter((host) => hostAllowedForTask(host, description));
      if (candidates.length === 0) continue;

      const ranked = [...candidates].sort((left, right) => {
        const leftCapacity = effectiveParallelCapacity(left);
        const rightCapacity = effectiveParallelCapacity(right);
        const leftLoad = hostLoad.get(left.id) ?? 0;
        const rightLoad = hostLoad.get(right.id) ?? 0;
        const leftPressure = leftLoad / leftCapacity;
        const rightPressure = rightLoad / rightCapacity;
        if (leftPressure !== rightPressure) return leftPressure - rightPressure;
        return hostCapacityScore(right) - hostCapacityScore(left);
      });

      selectedHost = ranked[0] ?? null;
      selectedTierId = tierId;
      if (selectedHost) break;
    }

    if (!selectedHost) {
      return {
        taskIndex: index,
        description,
        status: "unassigned",
        reason: "No reachable host available across configured tiers",
      };
    }

    const currentLoad = hostLoad.get(selectedHost.id) ?? 0;
    const capacity = effectiveParallelCapacity(selectedHost);
    hostLoad.set(selectedHost.id, currentLoad + 1);

    const wave = Math.floor(currentLoad / capacity) + 1;
    const slot = (currentLoad % capacity) + 1;
    const selectedModel = chooseModelForTask(selectedHost, description);

    return {
      taskIndex: index,
      description,
      tier: selectedTierId,
      host: selectedHost.id,
      model: selectedModel,
      wave,
      slot,
      capacity,
      queueDepthOnHost: currentLoad,
      schedulingReason: `Assigned to lowest-pressure host with capacity-aware balancing (wave ${wave}, slot ${slot}/${capacity})`,
    };
  });

  const hostUtilization = Array.from(hostLoad.entries())
    .map(([hostId, assigned]) => {
      let host: Host | null = null;
      let tierId = "unknown";
      for (const tier of registry.tiers) {
        const match = tier.hosts.find((candidate) => candidate.id === hostId) ?? null;
        if (match) {
          host = match;
          tierId = tier.id;
          break;
        }
      }
        const capacity = host ? effectiveParallelCapacity(host) : 1;
      return {
        host: hostId,
        tier: tierId,
        assignedTasks: assigned,
        parallelCapacity: capacity,
        estimatedWaves: Math.max(1, Math.ceil(assigned / capacity)),
      };
    })
    .sort((left, right) => Number(right.assignedTasks) - Number(left.assignedTasks));

  return {
    assignments,
    hostUtilization,
  };
}

async function buildWatchdogRouteCandidates(
  registry: Registry,
  description: string,
  preferredHost: string | null,
  preferredModel: string | null,
  maxFallbacks: number,
  banned: Set<string>
): Promise<{
  primary: SupervisorRoute | null;
  healthyPrimary: boolean;
  candidates: SupervisorRoute[];
  health: Array<Record<string, unknown>>;
}> {
  const baseRoute = routeTask(description, registry);
  const primaryLookup = preferredHost || baseRoute.recommendedHost;
  const selectedPrimary = primaryLookup ? findHostById(registry, primaryLookup) : null;

  if (!selectedPrimary) {
    return {
      primary: null,
      healthyPrimary: false,
      candidates: [],
      health: [{ status: "unavailable", reason: "No reachable primary host" }],
    };
  }

  const primaryModel = preferredModel ?? baseRoute.recommendedModel ?? chooseModelForTask(selectedPrimary.host, description);
  const primaryHealth = await checkHostModelHealth(selectedPrimary.host, primaryModel);
  const primaryRoute: SupervisorRoute = {
    tier: selectedPrimary.tierId,
    host: selectedPrimary.host.id,
    endpoint: selectedPrimary.host.endpoint,
    model: primaryModel,
  };

  const allCandidates = registry.selectionPolicy.defaultOrder
    .flatMap((tierId) => {
      const tier = registry.tiers.find((candidate) => candidate.id === tierId);
      return (tier?.hosts ?? []).map((host) => ({ tierId, host }));
    })
    .filter(({ host }) => host.enabled !== false && host.reachable !== false)
    .filter(({ host }) => host.id !== selectedPrimary.host.id)
    .sort((left, right) => hostCapacityScore(right.host) - hostCapacityScore(left.host));

  const candidates: SupervisorRoute[] = [];
  const health: Array<Record<string, unknown>> = [
    {
      tier: selectedPrimary.tierId,
      host: selectedPrimary.host.id,
      endpoint: selectedPrimary.host.endpoint,
      model: primaryModel,
      health: primaryHealth,
      kind: "primary",
    },
  ];

  for (const candidate of allCandidates) {
    if (candidates.length >= maxFallbacks) break;
    const candidateModel = chooseModelForTask(candidate.host, description);
    const key = failureKey(candidate.host.id, candidateModel);
    if (banned.has(key)) {
      health.push({
        tier: candidate.tierId,
        host: candidate.host.id,
        endpoint: candidate.host.endpoint,
        model: candidateModel,
        health: { hostHealthy: false, modelAvailable: false, reason: "circuit breaker active" },
        kind: "fallback",
      });
      continue;
    }

    const candidateHealth = await checkHostModelHealth(candidate.host, candidateModel);
    const route: SupervisorRoute = {
      tier: candidate.tierId,
      host: candidate.host.id,
      endpoint: candidate.host.endpoint,
      model: candidateModel,
    };

    health.push({
      tier: candidate.tierId,
      host: candidate.host.id,
      endpoint: candidate.host.endpoint,
      model: candidateModel,
      health: candidateHealth,
      kind: "fallback",
    });

    if (candidateHealth.hostHealthy && candidateHealth.modelAvailable) {
      candidates.push(route);
    }
  }

  return {
    primary: primaryRoute,
    healthyPrimary: primaryHealth.hostHealthy && primaryHealth.modelAvailable,
    candidates,
    health,
  };
}

export function pruneSupervisorStore(store: SupervisorStore, reliability: ReliabilityConfig): SupervisorStore {
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
    if (failure.cooldownUntil && failure.cooldownUntil < now && now - failure.lastFailureAt > reliability.failureResetWindowMs) {
      continue;
    }
    if (now - failure.lastFailureAt > reliability.failureResetWindowMs * 2) {
      continue;
    }
    pruned.hostModelFailures[key] = failure;
  }

  return pruned;
}

// --- MCP Server ---

const server = new McpServer({
  name: "xx-stack-platform-routing",
  version: "1.0.0",
});

server.tool(
  "list_platforms",
  "List all platform tiers, hosts, and their configuration from the xx-stack registry",
  {},
  async () => {
    const registry = await loadRegistry();
    const summary = registry.tiers.map((tier) => ({
      id: tier.id,
      label: tier.label,
      priority: tier.priority,
      usageGuidance: tier.usageGuidance,
      hosts: tier.hosts.map((h) => ({
        id: h.id,
        label: h.label,
        provider: h.provider,
        endpoint: h.endpoint,
        enabled: h.enabled !== false,
        modelCount: (h.models ?? []).length,
        executionPolicy: h.executionPolicy ?? {},
        hardware: h.hardware ?? {},
        preferredTasks: h.delegationPolicy?.preferredTaskTypes ?? [],
      })),
    }));
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          selectionPolicy: registry.selectionPolicy,
          tiers: summary,
        }, null, 2),
      }],
    };
  }
);

server.tool(
  "check_health",
  "Check health and latency of all configured model endpoints in the platform registry",
  {},
  async () => {
    const registry = await loadRegistry();
    const results: Record<string, unknown>[] = [];

    for (const tier of registry.tiers) {
      for (const host of tier.hosts) {
        if (host.enabled === false) {
          results.push({ tier: tier.id, host: host.id, status: "disabled" });
          continue;
        }
        if (!host.endpoint.startsWith("http://") && !host.endpoint.startsWith("https://")) {
          results.push({ tier: tier.id, host: host.id, status: "skipped", reason: "not an HTTP endpoint" });
          continue;
        }
        const ping = await pingHostEndpoint(host);
        results.push({
          tier: tier.id,
          host: host.id,
          endpoint: host.endpoint,
          provider: host.provider,
          endpointFamily: endpointFamilyForHost(host),
          status: ping.ok ? "healthy" : "unreachable",
          latencyMs: ping.latencyMs,
        });
      }
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
    };
  }
);

server.tool(
  "list_models",
  "List models available on all reachable model endpoints (provider-aware live query)",
  {},
  async () => {
    const registry = await loadRegistry();
    const results: Record<string, unknown>[] = [];

    for (const tier of registry.tiers) {
      for (const host of tier.hosts) {
        if (host.enabled === false) continue;
        if (!host.endpoint.startsWith("http://") && !host.endpoint.startsWith("https://")) continue;

        const models = await fetchHostModels(host);
        results.push({
          tier: tier.id,
          host: host.id,
          endpoint: host.endpoint,
          provider: host.provider,
          endpointFamily: endpointFamilyForHost(host),
          models: models.length > 0 ? models : (host.models ?? []),
          source: models.length > 0 ? "live" : "registry-cache",
        });
      }
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
    };
  }
);

server.tool(
  "probe_endpoint_compatibility",
  "Probe endpoint compatibility for /v1/models, /v1/chat/completions, and JSON mode semantics",
  {
    hostId: z.string().optional().describe("Host ID from the platform registry"),
    endpoint: z.string().optional().describe("Optional endpoint override when hostId is not provided"),
    provider: z.string().optional().describe("Provider label for endpoint override (default: compatible-api)"),
    model: z.string().optional().describe("Optional model override for chat/json probes"),
  },
  async ({ hostId, endpoint, provider, model }) => {
    const registry = await loadRegistry();

    let host: Host | null = null;
    if (hostId) {
      const found = findHostById(registry, hostId);
      host = found?.host ?? null;
      if (!host) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `hostId not found: ${hostId}` }, null, 2) }],
        };
      }
    } else if (endpoint) {
      host = {
        id: "manual-endpoint",
        label: "Manual endpoint",
        provider: provider ?? "compatible-api",
        endpoint,
        models: model ? [{ name: model }] : [],
      };
    } else {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "provide hostId or endpoint" }, null, 2) }],
      };
    }

    const result = await probeHostEndpointCompatibility(host, model ?? null);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "route_task",
  "Given a task description, recommend which platform tier, host, and model to use",
  { description: z.string().describe("Description of the task to route") },
  async ({ description }) => {
    const registry = await loadRegistry();
    const recommendation = routeTask(description, registry);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(recommendation, null, 2),
      }],
    };
  }
);

server.tool(
  "route_parallel_tasks",
  "Given multiple task descriptions, produce a hardware-aware parallel delegation schedule across local and remote hosts",
  {
    tasks: z.array(z.string()).min(1).max(128).describe("Task descriptions to schedule in parallel"),
  },
  async ({ tasks }) => {
    const registry = await loadRegistry();
    const schedule = routeParallelTasks(tasks, registry);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(schedule, null, 2),
      }],
    };
  }
);

server.tool(
  "route_task_with_watchdog",
  "Route a task with host/model liveness checks and automatic failover recommendations",
  {
    description: z.string().describe("Description of the task to route"),
    preferredHost: z.string().optional().describe("Optional host ID override for the primary attempt"),
    preferredModel: z.string().optional().describe("Optional model override for the primary attempt"),
    maxFallbacks: z.number().int().min(1).max(8).optional().describe("Maximum fallback hosts to probe"),
  },
  async ({ description, preferredHost, preferredModel, maxFallbacks }) => {
    const registry = await loadRegistry();
    const baseRoute = routeTask(description, registry);
    const fallbackLimit = maxFallbacks ?? 3;

    const selectedPrimary = preferredHost
      ? findHostById(registry, preferredHost)
      : (baseRoute.recommendedHost ? findHostById(registry, baseRoute.recommendedHost) : null);

    if (!selectedPrimary) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "unavailable",
            reason: "No reachable primary host found for route",
            baseRoute,
            failoverCandidates: [],
          }, null, 2),
        }],
      };
    }

    const primaryModel = preferredModel ?? baseRoute.recommendedModel ?? chooseModelForTask(selectedPrimary.host, description);
    const primaryHealth = await checkHostModelHealth(selectedPrimary.host, primaryModel);

    const candidateHosts = registry.selectionPolicy.defaultOrder
      .flatMap((tierId) => {
        const tier = registry.tiers.find((candidate) => candidate.id === tierId);
        return (tier?.hosts ?? []).map((host) => ({ tierId, host }));
      })
      .filter(({ host }) => host.enabled !== false && host.reachable !== false)
      .filter(({ host }) => host.id !== selectedPrimary.host.id)
      .sort((left, right) => hostCapacityScore(right.host) - hostCapacityScore(left.host))
      .slice(0, fallbackLimit);

    const failoverCandidates: Array<Record<string, unknown>> = [];
    let selectedFailover: Record<string, unknown> | null = null;

    for (const candidate of candidateHosts) {
      const candidateModel = chooseModelForTask(candidate.host, description);
      const candidateHealth = await checkHostModelHealth(candidate.host, candidateModel);
      const entry = {
        tier: candidate.tierId,
        host: candidate.host.id,
        endpoint: candidate.host.endpoint,
        model: candidateModel,
        health: candidateHealth,
      };
      failoverCandidates.push(entry);
      if (!selectedFailover && candidateHealth.hostHealthy && candidateHealth.modelAvailable) {
        selectedFailover = entry;
      }
    }

    const primaryHealthy = primaryHealth.hostHealthy && primaryHealth.modelAvailable;
    const status = primaryHealthy ? "healthy" : (selectedFailover ? "degraded" : "unavailable");

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          status,
          reason: primaryHealthy
            ? "Primary route passed liveness checks"
            : (selectedFailover
              ? "Primary route failed liveness checks; failover candidate selected"
              : "Primary route failed and no healthy failover was found"),
          primary: {
            tier: selectedPrimary.tierId,
            host: selectedPrimary.host.id,
            endpoint: selectedPrimary.host.endpoint,
            model: primaryModel,
            health: primaryHealth,
          },
          selectedFailover,
          failoverCandidates,
          baseRoute,
        }, null, 2),
      }],
    };
  }
);

server.tool(
  "supervisor_start_session",
  "Start or restart a supervised orchestrator session with persisted fallback state",
  {
    sessionId: z.string().optional().describe("Optional supervisor session ID"),
    description: z.string().describe("Task description this session should supervise"),
    preferredHost: z.string().optional().describe("Preferred host ID for primary attempt"),
    preferredModel: z.string().optional().describe("Preferred model for primary attempt"),
    maxFallbacks: z.number().int().min(1).max(8).optional().describe("Maximum fallback routes to precompute"),
    forceRestart: z.boolean().optional().describe("Replace an existing session with the same ID"),
    memorySync: z.object({
      agentId: z.string().min(1).describe("Agent identifier to enforce memory snapshot sync on completion"),
      scope: z.enum(["user", "project", "local"]).optional().describe("Memory scope to enforce; defaults to project"),
      cwd: z.string().optional().describe("Project root used for project/local scope; defaults to current process cwd"),
    }).optional().describe("Optional memory sync guard for completion gating"),
  },
  async ({ sessionId, description, preferredHost, preferredModel, maxFallbacks, forceRestart, memorySync }) =>
    withSupervisorStoreLock(async () => {
      const registry = await loadRegistry();
      const reliability = await loadReliabilityConfig();
      let store = pruneSupervisorStore(await readSupervisorStore(), reliability);
      const id = sessionId?.trim() || `sx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

      if (store.sessions[id] && !forceRestart) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "exists",
              sessionId: id,
              session: store.sessions[id],
              message: "Session already exists. Use forceRestart=true to replace it.",
            }, null, 2),
          }],
        };
      }

      const now = Date.now();
      const banned = new Set<string>();
      for (const [key, failure] of Object.entries(store.hostModelFailures)) {
        if ((failure.cooldownUntil ?? 0) > now && failure.count >= reliability.banHostModelAfterFailures) {
          banned.add(key);
        }
      }

      const candidates = await buildWatchdogRouteCandidates(
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
        fallbackRoutes: candidates.healthyPrimary ? candidates.candidates : candidates.candidates.slice(1),
        nextFallbackIndex: 0,
        continuationCount: 0,
        currentAttemptId: selected ? makeAttemptId(id, 1, selected) : undefined,
        recoveryInFlight: false,
        events: [
          sessionEvent("session.started", selected
            ? `primary route: ${selected.host}/${selected.model ?? "<none>"}`
            : "no healthy route available at start"),
        ],
      };

      store.sessions[id] = state;
      await writeSupervisorStore(store);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: state.status,
            reasonCode: state.status === "blocked" ? "start_no_healthy_route" : "start_ok",
            sessionId: id,
            reliability,
            completionMemorySync: state.completionMemorySync ?? null,
            currentAttemptId: state.currentAttemptId,
            currentRoute: state.currentRoute,
            fallbackQueueDepth: state.fallbackRoutes.length,
            routeHealth: candidates.health,
          }, null, 2),
        }],
      };
    })
);

server.tool(
  "supervisor_record_event",
  "Record canonical session lifecycle events (status, error, stop, and output updates) and apply transition logic",
  {
    sessionId: z.string().describe("Supervisor session ID"),
    eventType: z.enum([
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
    ]).describe("Event type to apply"),
    detail: z.string().optional().describe("Optional event detail"),
  },
  async ({ sessionId, eventType, detail }) =>
    withSupervisorStoreLock(async () => {
      const reliability = await loadReliabilityConfig();
      const store = pruneSupervisorStore(await readSupervisorStore(), reliability);
      const state = store.sessions[sessionId];

      if (!state) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ status: "missing", sessionId }, null, 2) }],
        };
      }

      const now = Date.now();
      const transition = applySupervisorEventTransition(state, eventType, now, reliability, detail);
      await writeSupervisorStore(store);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: state.status,
            reasonCode: transition.reasonCode,
            sessionId,
            eventType,
            stateChanged: transition.stateChanged,
            lastProgressAt: state.lastProgressAt,
            lastOutputAt: state.lastOutputAt,
            abortDetectedAt: state.abortDetectedAt,
            pendingCompletionValidationAt: state.pendingCompletionValidationAt,
            currentAttemptId: state.currentAttemptId,
          }, null, 2),
        }],
      };
    })
);

server.tool(
  "supervisor_tick",
  "Tick a supervised session. Detect stalls, apply cooldown/backoff, and switch to fallback route when needed",
  {
    sessionId: z.string().describe("Supervisor session ID to tick"),
    progressObserved: z.boolean().optional().describe("Whether deterministic progress was observed since last tick"),
    note: z.string().optional().describe("Optional operator note for this tick"),
    forceRecover: z.boolean().optional().describe("Force recovery regardless of timers"),
  },
  async ({ sessionId, progressObserved, note, forceRecover }) =>
    withSupervisorStoreLock(async () => {
      const reliability = await loadReliabilityConfig();
      let store = pruneSupervisorStore(await readSupervisorStore(), reliability);
      const state = store.sessions[sessionId];

      if (!state) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ status: "missing", sessionId }, null, 2) }],
        };
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

    if (state.failureCount > 0 && now - state.lastProgressAt >= reliability.failureResetWindowMs) {
      state.failureCount = 0;
      pushSessionEvent(state, "failure.reset", "failure window expired; resetting consecutive failure count");
    }

    // Auto-release a stale recoveryInFlight lock so recovery can retry after a missed ack.
    if (shouldAutoReleaseLock(state.recoveryInFlight, state.lastRecoveryAt, now, reliability.retryDedupeWindowMs * 3)) {
      state.recoveryInFlight = false;
      pushSessionEvent(state, "recovery.inflight.cleared",
        `auto-released stale lock after ${now - (state.lastRecoveryAt ?? 0)}ms`);
    }

    if (progressObserved) {
      state.lastProgressAt = now;
      state.lastOutputAt = now;
      state.abortDetectedAt = undefined;
      state.pendingCompletionValidationAt = undefined;
      clearCompletionProof(state);
      state.status = "running";
      state.recoveryInFlight = false;
      pushSessionEvent(state, "progress.observed", note ?? "progress signal received");
    } else if (note) {
      pushSessionEvent(state, "progress.note", note);
    }

    if (
      state.status === "completed"
      || state.status === "blocked"
      || state.status === "interrupted"
      || state.status === "exhausted"
    ) {
      await writeSupervisorStore(store);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: state.status,
            reasonCode: "terminal_state",
            sessionId,
            currentAttemptId: state.currentAttemptId,
            currentRoute: state.currentRoute,
            attemptCount: state.attemptCount,
            failureCount: state.failureCount,
          }, null, 2),
        }],
      };
    }

    if (state.cooldownUntil && now < state.cooldownUntil) {
      state.status = "cooldown";
      await writeSupervisorStore(store);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "cooldown",
            reasonCode: "cooldown_active",
            sessionId,
            currentAttemptId: state.currentAttemptId,
            waitMs: state.cooldownUntil - now,
            currentRoute: state.currentRoute,
          }, null, 2),
        }],
      };
    }

    if (isAbortWindowActive(state.abortDetectedAt, now, reliability.abortWindowMs) && forceRecover !== true) {
      state.status = "cooldown";
      await writeSupervisorStore(store);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "cooldown",
            reasonCode: "abort_window_active",
            sessionId,
            currentAttemptId: state.currentAttemptId,
            waitMs: reliability.abortWindowMs - (now - (state.abortDetectedAt ?? now)),
            currentRoute: state.currentRoute,
          }, null, 2),
        }],
      };
    }

    const sinceProgress = now - state.lastProgressAt;
    const sinceStart = now - state.startedAt;
    const stalled = forceRecover === true
      || sinceProgress >= reliability.progressTimeoutMs
      || sinceStart >= reliability.hardSessionTimeoutMs;

    if (!stalled) {
      state.status = "running";
      await writeSupervisorStore(store);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "running",
            reasonCode: "healthy_progress_window",
            sessionId,
            currentAttemptId: state.currentAttemptId,
            currentRoute: state.currentRoute,
            sinceProgressMs: sinceProgress,
            sinceStartMs: sinceStart,
            progressTimeoutMs: reliability.progressTimeoutMs,
            hardSessionTimeoutMs: reliability.hardSessionTimeoutMs,
          }, null, 2),
        }],
      };
    }

    if (state.recoveryInFlight) {
      await writeSupervisorStore(store);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "recovering",
            reasonCode: "retry_in_flight",
            sessionId,
            currentAttemptId: state.currentAttemptId,
            currentRoute: state.currentRoute,
          }, null, 2),
        }],
      };
    }

    const recoveryKey = makeRecoveryKey(state);
    if (
      shouldDedupeContinuation(
        state.lastRecoveryKey,
        state.lastRecoveryAt,
        recoveryKey,
        now,
        reliability.retryDedupeWindowMs
      )
    ) {
      await writeSupervisorStore(store);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "cooldown",
            reasonCode: "recovery_deduped",
            sessionId,
            currentAttemptId: state.currentAttemptId,
            dedupeWindowMs: reliability.retryDedupeWindowMs,
          }, null, 2),
        }],
      };
    }

    state.lastRecoveryKey = recoveryKey;
    state.lastRecoveryAt = now;

    state.recoveryInFlight = true;
    await writeSupervisorStore(store);

    state.failureCount += 1;
    const previousRoute = state.currentRoute;
    pushSessionEvent(state,
      "session.stalled",
      `stalled after ${sinceProgress}ms since progress, ${sinceStart}ms since start`
    );

    if (previousRoute) {
      const key = failureKey(previousRoute.host, previousRoute.model);
      const prev = store.hostModelFailures[key] ?? { count: 0, lastFailureAt: now };
      prev.count += 1;
      prev.lastFailureAt = now;
      if (prev.count >= reliability.banHostModelAfterFailures) {
        prev.cooldownUntil = now + reliability.failureResetWindowMs;
        pushSessionEvent(state, "breaker.opened", `${key} banned until ${new Date(prev.cooldownUntil).toISOString()}`);
      }
      store.hostModelFailures[key] = prev;
    }

    if (state.failureCount >= reliability.maxConsecutiveFailures || state.attemptCount >= reliability.maxAttemptsPerSlice) {
      state.status = "exhausted";
      state.recoveryInFlight = false;
      pushSessionEvent(state, "session.exhausted", "max failures or attempts reached");
      await writeSupervisorStore(store);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "exhausted",
            reasonCode: "attempts_exhausted",
            reason: "max failures or attempts reached",
            sessionId,
            currentAttemptId: state.currentAttemptId,
            attemptCount: state.attemptCount,
            failureCount: state.failureCount,
            currentRoute: state.currentRoute,
          }, null, 2),
        }],
      };
    }

    let nextRoute: SupervisorRoute | null = state.fallbackRoutes[state.nextFallbackIndex] ?? null;
    if (nextRoute) {
      state.nextFallbackIndex += 1;
    }

    if (!nextRoute) {
      const registry = await loadRegistry();
      const banned = new Set<string>();
      for (const [key, failure] of Object.entries(store.hostModelFailures)) {
        if ((failure.cooldownUntil ?? 0) > now && failure.count >= reliability.banHostModelAfterFailures) {
          banned.add(key);
        }
      }

      const refreshed = await buildWatchdogRouteCandidates(
        registry,
        state.description,
        previousRoute?.host ?? null,
        null,
        4,
        banned
      );

      const primaryKey = refreshed.primary ? failureKey(refreshed.primary.host, refreshed.primary.model) : "";
      nextRoute = refreshed.candidates.find((candidate) => failureKey(candidate.host, candidate.model) !== primaryKey) ?? null;

      if (nextRoute) {
        state.fallbackRoutes = refreshed.candidates.filter((candidate) => candidate.host !== nextRoute?.host || candidate.model !== nextRoute?.model);
        state.nextFallbackIndex = 0;
      }
    }

    if (!nextRoute) {
      state.status = "blocked";
      state.recoveryInFlight = false;
      pushSessionEvent(state, "session.blocked", "no healthy fallback routes available");
      await writeSupervisorStore(store);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "blocked",
            reasonCode: "fallback_exhausted",
            reason: "no healthy fallback routes available",
            sessionId,
            currentAttemptId: state.currentAttemptId,
            attemptCount: state.attemptCount,
            failureCount: state.failureCount,
          }, null, 2),
        }],
      };
    }

    // Quick live ping before committing to this fallback — avoids burning a failureCount
    // against a host that is already down.
    if (nextRoute.endpoint.startsWith("http")) {
      const pingOk = await quickPingEndpoint(nextRoute.endpoint);
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
        // Return to cooldown without incrementing failureCount so the next tick retries.
        state.status = "cooldown";
        state.cooldownUntil = now + reliability.retryDedupeWindowMs;
        state.recoveryInFlight = false;
        await writeSupervisorStore(store);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "cooldown",
              reasonCode: "fallback_ping_failed",
              sessionId,
              skippedHost: nextRoute.host,
              retryAfterMs: reliability.retryDedupeWindowMs,
            }, null, 2),
          }],
        };
      }
    }

    state.currentRoute = nextRoute;
    state.attemptCount += 1;
    state.currentAttemptId = makeAttemptId(sessionId, state.attemptCount, nextRoute);
    state.status = "cooldown";
    const backoffMs = computeBackoffMs(reliability, state.failureCount);
    state.cooldownUntil = now + backoffMs;
    state.lastProgressAt = now;
    state.recoveryInFlight = false;
    pushSessionEvent(state, "fallback.applied", `${nextRoute.host}/${nextRoute.model ?? "<none>"} (attempt ${state.attemptCount})`);

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

    await writeSupervisorStore(store);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "recovering",
              reasonCode: "fallback_applied",
            sessionId,
              currentAttemptId: state.currentAttemptId,
            switchedTo: nextRoute,
            backoffMs,
            cooldownUntil: new Date(state.cooldownUntil).toISOString(),
            attemptCount: state.attemptCount,
            failureCount: state.failureCount,
          }, null, 2),
        }],
      };
    })
);

server.tool(
  "supervisor_abort_session",
  "Abort a supervised session and mark it as interrupted",
  {
    sessionId: z.string().describe("Supervisor session ID"),
    reason: z.string().optional().describe("Optional abort reason"),
  },
  async ({ sessionId, reason }) =>
    withSupervisorStoreLock(async () => {
      const reliability = await loadReliabilityConfig();
      const store = pruneSupervisorStore(await readSupervisorStore(), reliability);
      const state = store.sessions[sessionId];
      if (!state) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ status: "missing", sessionId }, null, 2) }],
        };
      }

      state.status = "interrupted";
      state.lastProgressAt = Date.now();
      state.cooldownUntil = undefined;
      state.recoveryInFlight = false;
      pushSessionEvent(state, "session.interrupted", reason ?? "abort requested");
      await writeSupervisorStore(store);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "interrupted",
            reasonCode: "interrupt_requested",
            sessionId,
            currentAttemptId: state.currentAttemptId,
            currentRoute: state.currentRoute,
            reason: reason ?? "abort requested",
          }, null, 2),
        }],
      };
    })
);

server.tool(
  "supervisor_record_completion_check",
  "Record deterministic completion evidence and independent judge verdict for a supervised session",
  {
    sessionId: z.string().describe("Supervisor session ID"),
    checkType: z.enum(["evidence", "judge"]).describe("Completion check type"),
    summary: z.string().min(1).max(8000).describe("Human-readable summary for evidence or judge result"),
    verdict: z.enum(["pass", "fail"]).optional().describe("Required when checkType='judge'"),
  },
  async ({ sessionId, checkType, summary, verdict }) =>
    withSupervisorStoreLock(async () => {
      const reliability = await loadReliabilityConfig();
      const store = pruneSupervisorStore(await readSupervisorStore(), reliability);
      const state = store.sessions[sessionId];
      if (!state) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ status: "missing", sessionId }, null, 2) }],
        };
      }

      const now = Date.now();

      if (checkType === "evidence") {
        state.completionEvidenceAt = now;
        state.completionEvidenceSummary = summary;
        state.pendingCompletionValidationAt = undefined;
        pushSessionEvent(state, "completion.evidence_recorded", summary);
      } else {
        if (!verdict) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "invalid",
                reasonCode: "judge_verdict_required",
                sessionId,
              }, null, 2),
            }],
          };
        }
        state.completionJudgeAt = now;
        state.completionJudgeVerdict = verdict;
        state.completionJudgeSummary = summary;
        state.pendingCompletionValidationAt = verdict === "pass" ? undefined : now;
        pushSessionEvent(state, verdict === "pass" ? "completion.judge_pass" : "completion.judge_fail", summary);
      }

      await writeSupervisorStore(store);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "recorded",
            reasonCode: checkType === "evidence" ? "completion_evidence_recorded" : "completion_judge_recorded",
            sessionId,
            checkType,
            completionEvidenceAt: state.completionEvidenceAt ?? null,
            completionJudgeAt: state.completionJudgeAt ?? null,
            completionJudgeVerdict: state.completionJudgeVerdict ?? null,
          }, null, 2),
        }],
      };
    })
);

server.tool(
  "supervisor_complete_session",
  "Mark a supervised session with a final terminal outcome",
  {
    sessionId: z.string().describe("Supervisor session ID"),
    outcome: z.enum(["completed", "blocked", "interrupted", "exhausted"]).optional().describe("Final outcome"),
    note: z.string().optional().describe("Optional completion note"),
    forceComplete: z.boolean().optional().describe("Override output validation gates and finalize immediately"),
    memorySync: z.object({
      agentId: z.string().min(1).describe("Agent identifier to enforce memory snapshot sync on completion"),
      scope: z.enum(["user", "project", "local"]).optional().describe("Memory scope to enforce; defaults to project"),
      cwd: z.string().optional().describe("Project root used for project/local scope; defaults to current process cwd"),
    }).optional().describe("Optional completion-time override for memory sync guard"),
  },
  async ({ sessionId, outcome, note, forceComplete, memorySync }) =>
    withSupervisorStoreLock(async () => {
      const reliability = await loadReliabilityConfig();
      const store = pruneSupervisorStore(await readSupervisorStore(), reliability);
      const state = store.sessions[sessionId];
      if (!state) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ status: "missing", sessionId }, null, 2) }],
        };
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
            const remediationChecklist = buildCompletionRepairChecklist("completion_memory_drift_detected");
            state.pendingCompletionValidationAt = now;
            pushSessionEvent(state, "completion.validation_failed", "completion_memory_drift_detected; refusing early completion");
            await writeSupervisorStore(store);
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  status: "running",
                  reasonCode: "completion_memory_drift_detected",
                  sessionId,
                  completionValidationWindowMs: reliability.completionValidationWindowMs,
                  memorySyncGuard: memoryGuard,
                  memorySyncStatus,
                  remediationChecklist,
                  continuationDirective: "Resync memory snapshot first, then continue repair loop and retry completion.",
                }, null, 2),
              }],
            };
          }
        }

        const readiness = evaluateCompletionReadiness(state, now, reliability);
        if (!readiness.ok) {
          const remediationChecklist = buildCompletionRepairChecklist(readiness.reasonCode);
          state.pendingCompletionValidationAt = now;
          pushSessionEvent(state, "completion.validation_failed", `${readiness.reasonCode}; refusing early completion`);
          await writeSupervisorStore(store);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "running",
                reasonCode: readiness.reasonCode,
                sessionId,
                completionValidationWindowMs: reliability.completionValidationWindowMs,
                lastOutputAt: state.lastOutputAt ?? null,
                completionEvidenceAt: state.completionEvidenceAt ?? null,
                completionJudgeAt: state.completionJudgeAt ?? null,
                completionJudgeVerdict: state.completionJudgeVerdict ?? null,
                remediationChecklist,
                continuationDirective: "Continue repair loop: implement -> verify -> record evidence -> judge -> retry completion.",
              }, null, 2),
            }],
          };
        }
      }

      state.status = requestedOutcome;
      state.lastProgressAt = now;
      state.pendingCompletionValidationAt = undefined;
      state.abortDetectedAt = undefined;
      state.recoveryInFlight = false;
      pushSessionEvent(state, "session.completed", note ?? state.status);
      await writeSupervisorStore(store);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: state.status,
            reasonCode: "session_finalized",
            sessionId,
            currentAttemptId: state.currentAttemptId,
            state,
          }, null, 2),
        }],
      };
    })
);

server.tool(
  "supervisor_status",
  "Inspect active supervisor sessions, reliability settings, and host/model failure breaker state",
  {
    sessionId: z.string().optional().describe("Optional session ID filter"),
  },
  async ({ sessionId }) => withSupervisorStoreLock(async () => {
    const reliability = await loadReliabilityConfig();
    const store = pruneSupervisorStore(await readSupervisorStore(), reliability);
    await writeSupervisorStore(store);

    const now = Date.now();
    const sessions = sessionId
      ? (store.sessions[sessionId] ? [store.sessions[sessionId]] : [])
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

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          reliability,
          sessionSummary: {
            total: sessions.length,
            byStatus: summaryByStatus,
          },
          sessions,
          hostModelFailures: failures,
        }, null, 2),
      }],
    };
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
    withSupervisorStoreLock(async () => {
      const reliability = await loadReliabilityConfig();
      const store = pruneSupervisorStore(await readSupervisorStore(), reliability);
      const state = store.sessions[sessionId];
      if (!state) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ status: "missing", sessionId }, null, 2) }],
        };
      }

      const pendingTasks = remainingTasks ?? [];
      const now = Date.now();

      if (isAbortWindowActive(state.abortDetectedAt, now, reliability.abortWindowMs)) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "cooldown",
              reasonCode: "abort_window_active",
              sessionId,
              continuationCount: state.continuationCount,
              waitMs: reliability.abortWindowMs - (now - (state.abortDetectedAt ?? now)),
            }, null, 2),
          }],
        };
      }

      if (state.recoveryInFlight) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "recovering",
              reasonCode: "retry_in_flight",
              sessionId,
              continuationCount: state.continuationCount,
            }, null, 2),
          }],
        };
      }

      const continuationFingerprint = JSON.stringify(pendingTasks);
      const dedupeWindowMs = Math.max(5_000, Math.floor(reliability.retryDedupeWindowMs));

      if (shouldDedupeContinuation(
        state.lastContinuationFingerprint,
        state.lastContinuationAt,
        continuationFingerprint,
        now,
        dedupeWindowMs
      )) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "deduped",
              reasonCode: "continuation_deduped",
              sessionId,
              continuationCount: state.continuationCount,
              dedupeWindowMs,
            }, null, 2),
          }],
        };
      }

      state.continuationCount += 1;
      state.lastContinuationFingerprint = continuationFingerprint;
      state.lastContinuationAt = now;
      pushSessionEvent(state, "continuation.injected", `attempt ${state.continuationCount}`);
      await writeSupervisorStore(store);

      const lastCompletionFailure = [...state.events]
        .reverse()
        .find((event) => event.type === "completion.validation_failed");
      let completionRecoveryReason = parseCompletionValidationReason(lastCompletionFailure?.detail);
      let memorySyncStatus: Awaited<ReturnType<typeof getCompletionMemorySyncStatus>> | null = null;
      if (state.completionMemorySync) {
        memorySyncStatus = await getCompletionMemorySyncStatus(state.completionMemorySync);
        if (memorySyncStatus.driftDetected) {
          completionRecoveryReason = "completion_memory_drift_detected";
        }
      }
      const remediationChecklist = buildCompletionRepairChecklist(completionRecoveryReason);

      const pending = pendingTasks.length > 0
        ? pendingTasks.map((task, index) => `${index + 1}. ${task}`).join("\n")
        : "1. Continue from the last verified artifact and produce deterministic output.\n2. Verify progress with a command, file diff, or explicit evidence.";

      const remediationText = remediationChecklist.map((item, index) => `${index + 1}. ${item}`).join("\n");

      const prompt = [
        "Supervisor continuation directive:",
        `- session: ${sessionId}`,
        `- continuation-attempt: ${state.continuationCount}`,
        `- current-route: ${state.currentRoute?.host ?? "<none>"}/${state.currentRoute?.model ?? "<none>"}`,
        `- completion-recovery-reason: ${completionRecoveryReason}`,
        `- memory-sync-guard: ${state.completionMemorySync ? "enabled" : "disabled"}`,
        ...(state.completionMemorySync ? [
          `- memory-sync-agent: ${state.completionMemorySync.agentId}`,
          `- memory-sync-scope: ${state.completionMemorySync.scope}`,
          `- memory-sync-drift: ${memorySyncStatus?.driftDetected === true ? "detected" : "not-detected"}`,
        ] : []),
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
        ...(memorySyncStatus?.driftDetected ? [
          "  7) Resolve memory drift before completion by following memory helper guidance",
          "- memory-sync helper:",
          memorySyncStatus.helperPrompt ?? "Run agent_memory_snapshot_status and resolve drift.",
        ] : []),
        "- remediation checklist:",
        remediationText,
        "- remaining tasks:",
        pending,
      ].join("\n");

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "ready",
            reasonCode: "continuation_emitted",
            sessionId,
            continuationCount: state.continuationCount,
            completionRecoveryReason,
            remediationChecklist,
            memorySyncGuard: state.completionMemorySync ?? null,
            memorySyncStatus,
            prompt,
          }, null, 2),
        }],
      };
    })
);

server.tool(
  "supervisor_run_self_test",
  "Run deterministic self-tests for timeout, fallback selection, and session persistence behavior",
  {},
  async () => {
    const reliability = await loadReliabilityConfig();
    const store = pruneSupervisorStore(await readSupervisorStore(), reliability);

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
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          status: allPass ? "pass" : "fail",
          checks,
        }, null, 2),
      }],
    };
  }
);

server.tool(
  "get_hardware",
  "Detect local hardware (GPUs, VRAM, RAM) for routing decisions",
  {},
  async () => {
    const hw = await detectHardware();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(hw, null, 2) }],
    };
  }
);

server.tool(
  "search_tools",
  "Search xx-stack MCP tools by name, category, description, and keywords",
  {
    query: z.string().optional().describe("Optional natural language query"),
    category: z.enum(["routing", "supervisor", "observability", "tasks", "agents"]).optional().describe("Optional category filter"),
    limit: z.number().int().min(1).max(50).optional().describe("Maximum results to return"),
  },
  async ({ query, category, limit }) => {
    const tokens = (query ?? "")
      .toLowerCase()
      .split(/[^a-z0-9_\-]+/)
      .map((token) => token.trim())
      .filter(Boolean);

    const filtered = TOOL_CATALOG
      .filter((entry) => !category || entry.category === category)
      .map((entry) => {
        const haystack = [entry.name, entry.description, ...entry.keywords].join(" ").toLowerCase();
        const score = tokens.length === 0
          ? 1
          : tokens.reduce((sum, token) => {
            if (entry.name === token) return sum + 8;
            if (entry.name.includes(token)) return sum + 5;
            if (entry.keywords.some((keyword) => keyword.includes(token))) return sum + 3;
            if (haystack.includes(token)) return sum + 1;
            return sum;
          }, 0);
        return { ...entry, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));

    const capped = filtered.slice(0, limit ?? 15).map(({ score, ...entry }) => ({ ...entry, matchScore: score }));

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          query: query ?? "",
          category: category ?? "all",
          totalMatches: filtered.length,
          returned: capped.length,
          tools: capped,
        }, null, 2),
      }],
    };
  }
);

server.tool(
  "agent_list_profiles",
  "List merged agent profiles including required MCP servers, tool policy, memory scope, and coordinator contract flags",
  {},
  async () => {
    const runtime = await loadMergedAgentRuntimeConfig();
    const profiles = Object.entries(runtime.agents)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([agentId, profile]) => ({
        agentId,
        mode: profile.mode ?? "<unset>",
        model: profile.model ?? "<unset>",
        requiredMcpServers: profile.requiredMcpServers ?? [],
        toolPolicy: {
          allow: profile.toolPolicy?.allow ?? ["*"],
          deny: profile.toolPolicy?.deny ?? [],
        },
        memory: {
          enabled: profile.memory?.enabled === true,
          scope: profile.memory?.scope ?? "project",
        },
        coordinator: {
          strictWorkerContract: profile.coordinator?.strictWorkerContract === true,
          requireStructuredResults: profile.coordinator?.requireStructuredResults === true,
        },
      }));

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          configuredMcpServers: runtime.configuredMcpServers,
          sources: runtime.sources,
          profiles,
        }, null, 2),
      }],
    };
  }
);

server.tool(
  "agent_preflight",
  "Validate whether an agent can run under current MCP availability and tool policy",
  {
    agentId: z.string().min(1).describe("Agent identifier"),
    requestedTools: z.array(z.string()).max(256).optional().describe("Optional tools requested for this run"),
    isAsync: z.boolean().optional().describe("Whether to apply background async safety restrictions"),
  },
  async ({ agentId, requestedTools, isAsync }) => {
    const runtime = await loadMergedAgentRuntimeConfig();
    const profile = runtime.agents[agentId];
    if (!profile) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ status: "missing_agent", agentId }, null, 2) }],
      };
    }

    const required = toStringArray(profile.requiredMcpServers);
    const missing = missingRequiredMcpServers(required, runtime.configuredMcpServers);
    const candidateTools = requestedTools ?? [];
    const basePolicy = applyToolPolicy(profile, candidateTools);
    const toolPolicy = isAsync === true ? applyAsyncToolSafety(basePolicy) : basePolicy;

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          status: missing.length === 0 ? "ok" : "blocked",
          agentId,
          configuredMcpServers: runtime.configuredMcpServers,
          requiredMcpServers: required,
          missingRequiredMcpServers: missing,
          isAsync: isAsync === true,
          toolPolicy,
          memory: {
            enabled: profile.memory?.enabled === true,
            scope: profile.memory?.scope ?? "project",
          },
          coordinator: {
            strictWorkerContract: profile.coordinator?.strictWorkerContract === true,
            requireStructuredResults: profile.coordinator?.requireStructuredResults === true,
          },
        }, null, 2),
      }],
    };
  }
);

server.tool(
  "agent_filter_tools",
  "Filter candidate tool names through the selected agent allow/deny policy",
  {
    agentId: z.string().min(1).describe("Agent identifier"),
    candidateTools: z.array(z.string()).min(1).max(512).describe("Tool names to evaluate"),
    isAsync: z.boolean().optional().describe("Whether to apply background async safety restrictions"),
  },
  async ({ agentId, candidateTools, isAsync }) => {
    const runtime = await loadMergedAgentRuntimeConfig();
    const profile = runtime.agents[agentId];
    if (!profile) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ status: "missing_agent", agentId }, null, 2) }],
      };
    }
    const basePolicy = applyToolPolicy(profile, candidateTools);
    const filtered = isAsync === true ? applyAsyncToolSafety(basePolicy) : basePolicy;
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          status: "ok",
          agentId,
          isAsync: isAsync === true,
          ...filtered,
        }, null, 2),
      }],
    };
  }
);

server.tool(
  "agent_validate_profiles",
  "Validate merged agent profile configuration and report errors/warnings",
  {},
  async () => {
    const runtime = await loadMergedAgentRuntimeConfig();
    const findings = validateAgentProfiles(runtime.agents, runtime.configuredMcpServers);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          status: findings.errors.length === 0 ? "ok" : "fail",
          errorCount: findings.errors.length,
          warningCount: findings.warnings.length,
          errors: findings.errors,
          warnings: findings.warnings,
        }, null, 2),
      }],
    };
  }
);

server.tool(
  "agent_memory_get",
  "Read persistent memory entrypoint for an agent and scope",
  {
    agentId: z.string().min(1).describe("Agent identifier"),
    scope: z.enum(["user", "project", "local"]).optional().describe("Memory scope override"),
    cwd: z.string().optional().describe("Optional project root for project/local scope"),
  },
  async ({ agentId, scope, cwd }) => {
    const runtime = await loadMergedAgentRuntimeConfig();
    const profile = runtime.agents[agentId];
    const resolvedScope = scope ?? profile?.memory?.scope ?? "project";
    const resolvedCwd = cwd?.trim() || process.cwd();
    const path = getAgentMemoryEntrypoint(agentId, resolvedScope, resolvedCwd);
    await ensureMemoryEntrypoint(path);
    const content = await readMemoryEntrypoint(path);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          status: "ok",
          agentId,
          scope: resolvedScope,
          path,
          content,
        }, null, 2),
      }],
    };
  }
);

server.tool(
  "agent_memory_append",
  "Append a timestamped memory note for an agent and scope",
  {
    agentId: z.string().min(1).describe("Agent identifier"),
    note: z.string().min(1).max(8000).describe("Memory note content"),
    scope: z.enum(["user", "project", "local"]).optional().describe("Memory scope override"),
    cwd: z.string().optional().describe("Optional project root for project/local scope"),
  },
  async ({ agentId, note, scope, cwd }) => {
    const runtime = await loadMergedAgentRuntimeConfig();
    const profile = runtime.agents[agentId];
    const resolvedScope = scope ?? profile?.memory?.scope ?? "project";
    const resolvedCwd = cwd?.trim() || process.cwd();
    const path = getAgentMemoryEntrypoint(agentId, resolvedScope, resolvedCwd);
    await ensureMemoryEntrypoint(path);
    const current = await readMemoryEntrypoint(path);
    const entry = `- ${new Date().toISOString()} ${note.trim()}\n`;
    await atomicWriteTextFile(path, `${current}${entry}`);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          status: "ok",
          agentId,
          scope: resolvedScope,
          path,
          appended: entry.trim(),
        }, null, 2),
      }],
    };
  }
);

server.tool(
  "agent_memory_snapshot_status",
  "Check whether agent memory and snapshot are in sync and report drift",
  {
    agentId: z.string().min(1).describe("Agent identifier"),
    scope: z.enum(["user", "project", "local"]).optional().describe("Memory scope override"),
    cwd: z.string().optional().describe("Optional project root for project/local scope"),
  },
  async ({ agentId, scope, cwd }) => {
    const runtime = await loadMergedAgentRuntimeConfig();
    const profile = runtime.agents[agentId];
    const resolvedScope = scope ?? profile?.memory?.scope ?? "project";
    const resolvedCwd = cwd?.trim() || process.cwd();
    const memoryPath = getAgentMemoryEntrypoint(agentId, resolvedScope, resolvedCwd);
    const snapshotPath = getAgentMemorySnapshotPath(agentId, resolvedScope, resolvedCwd);
    const metaPath = getAgentMemorySnapshotMetaPath(agentId, resolvedScope, resolvedCwd);

    await ensureMemoryEntrypoint(memoryPath);
    const memoryContent = await readMemoryEntrypoint(memoryPath);
    const snapshotContent = await readMemoryEntrypoint(snapshotPath);
    const meta = await readSnapshotMeta(metaPath);

    const memoryHash = hashMemoryContent(memoryContent);
    const snapshotHash = hashMemoryContent(snapshotContent);
    const diff = lineDiffSummary(snapshotContent, memoryContent);
    const lastSyncedMemoryHash = typeof meta?.lastSyncedMemoryHash === "string" ? meta.lastSyncedMemoryHash : null;
    const driftDetected = memoryHash !== snapshotHash;
    const helperPrompt = driftDetected ? buildMemoryResyncHelperPrompt(agentId, resolvedScope, diff) : null;

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          status: driftDetected ? "drifted" : "synced",
          agentId,
          scope: resolvedScope,
          memoryPath,
          snapshotPath,
          metaPath,
          memoryHash,
          snapshotHash,
          lastSyncedMemoryHash,
          driftDetected,
          diff,
          helperPrompt,
        }, null, 2),
      }],
    };
  }
);

server.tool(
  "agent_memory_snapshot_sync",
  "Sync memory snapshots by capturing current memory or applying snapshot back to live memory",
  {
    agentId: z.string().min(1).describe("Agent identifier"),
    scope: z.enum(["user", "project", "local"]).optional().describe("Memory scope override"),
    cwd: z.string().optional().describe("Optional project root for project/local scope"),
    direction: z.enum(["capture", "apply"]).optional().describe("capture: memory -> snapshot; apply: snapshot -> memory"),
    retainHistory: z.boolean().optional().describe("When true, store timestamped copies under .snapshots/"),
  },
  async ({ agentId, scope, cwd, direction, retainHistory }) => {
    const runtime = await loadMergedAgentRuntimeConfig();
    const profile = runtime.agents[agentId];
    const resolvedScope = scope ?? profile?.memory?.scope ?? "project";
    const resolvedDirection = direction ?? "capture";
    const shouldRetainHistory = retainHistory === true;
    const resolvedCwd = cwd?.trim() || process.cwd();
    const memoryPath = getAgentMemoryEntrypoint(agentId, resolvedScope, resolvedCwd);
    const snapshotPath = getAgentMemorySnapshotPath(agentId, resolvedScope, resolvedCwd);
    const metaPath = getAgentMemorySnapshotMetaPath(agentId, resolvedScope, resolvedCwd);
    const snapshotsDir = getAgentMemorySnapshotsDir(agentId, resolvedScope, resolvedCwd);

    await ensureMemoryEntrypoint(memoryPath);
    await mkdir(dirname(snapshotPath), { recursive: true });

    const memoryContent = await readMemoryEntrypoint(memoryPath);
    const snapshotContent = await readMemoryEntrypoint(snapshotPath);
    const sourceContent = resolvedDirection === "capture" ? memoryContent : snapshotContent;
    const targetPath = resolvedDirection === "capture" ? snapshotPath : memoryPath;
    await atomicWriteTextFile(targetPath, sourceContent.length > 0 ? sourceContent : "# Agent Memory\n\n");

    const updatedMemory = await readMemoryEntrypoint(memoryPath);
    const updatedSnapshot = await readMemoryEntrypoint(snapshotPath);
    const meta = {
      agentId,
      scope: resolvedScope,
      direction: resolvedDirection,
      syncedAt: new Date().toISOString(),
      lastSyncedMemoryHash: hashMemoryContent(updatedMemory),
      lastSyncedSnapshotHash: hashMemoryContent(updatedSnapshot),
      historyRetentionEnabled: shouldRetainHistory,
    };
    await atomicWriteTextFile(metaPath, JSON.stringify(meta, null, 2) + "\n");

    let historyEntryId: string | null = null;
    if (shouldRetainHistory) {
      historyEntryId = await writeSnapshotHistoryEntry(snapshotsDir, resolvedDirection, updatedMemory, updatedSnapshot, meta);
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          status: "ok",
          agentId,
          scope: resolvedScope,
          direction: resolvedDirection,
          memoryPath,
          snapshotPath,
          metaPath,
          snapshotsDir: shouldRetainHistory ? snapshotsDir : null,
          historyEntryId,
          meta,
        }, null, 2),
      }],
    };
  }
);

server.tool(
  "build_coordinator_contract",
  "Generate a hardened coordinator worker contract prompt from agent policy",
  {
    agentId: z.string().optional().describe("Agent identifier (defaults to execution-orchestrator)"),
  },
  async ({ agentId }) => {
    const resolvedAgentId = agentId?.trim() || "execution-orchestrator";
    const runtime = await loadMergedAgentRuntimeConfig();
    const profile = runtime.agents[resolvedAgentId];
    if (!profile) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ status: "missing_agent", agentId: resolvedAgentId }, null, 2) }],
      };
    }

    const strict = profile.coordinator?.strictWorkerContract !== false;
    const structured = profile.coordinator?.requireStructuredResults !== false;
    const contract = buildCoordinatorContract(resolvedAgentId, strict, structured);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          status: "ok",
          agentId: resolvedAgentId,
          strictWorkerContract: strict,
          requireStructuredResults: structured,
          contract,
        }, null, 2),
      }],
    };
  }
);

server.tool(
  "task_suspend",
  "Suspend an active task with checkpoint/error metadata for later resume",
  {
    taskId: z.string().min(1).describe("Task ID"),
    checkpoint: z.string().max(4000).optional().describe("Checkpoint summary before suspension"),
    error: z.string().max(4000).optional().describe("Optional error or blocker summary"),
    worktreePath: z.string().max(4096).optional().describe("Optional isolated worktree path"),
    parentCwd: z.string().max(4096).optional().describe("Optional parent workspace path"),
  },
  async ({ taskId, checkpoint, error, worktreePath, parentCwd }) =>
    withTaskStoreLock(async () => {
      const store = await readTaskStore();
      const task = store.tasks[taskId];
      if (!task) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ status: "missing", taskId }, null, 2) }],
        };
      }

      task.status = "suspended";
      task.lastCheckpoint = checkpoint?.trim() || task.lastCheckpoint;
      task.lastError = error?.trim() || task.lastError;
      task.worktreePath = worktreePath?.trim() || task.worktreePath;
      task.parentCwd = parentCwd?.trim() || task.parentCwd;
      task.resumable = task.resumable !== false;
      task.updatedAt = new Date().toISOString();
      store.tasks[taskId] = task;
      await writeTaskStore(store);

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ status: "suspended", task }, null, 2) }],
      };
    })
);

server.tool(
  "task_resume",
  "Resume a suspended or blocked task and emit a continuation directive with worktree context",
  {
    taskId: z.string().min(1).describe("Task ID"),
    checkpoint: z.string().max(4000).optional().describe("Optional refreshed checkpoint before resume"),
    clearError: z.boolean().optional().describe("Clear stored lastError on resume"),
  },
  async ({ taskId, checkpoint, clearError }) =>
    withTaskStoreLock(async () => {
      const store = await readTaskStore();
      const task = store.tasks[taskId];
      if (!task) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ status: "missing", taskId }, null, 2) }],
        };
      }

      if (task.resumable === false) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ status: "blocked", reason: "task marked non-resumable", taskId }, null, 2) }],
        };
      }

      task.status = "in_progress";
      task.attemptCount = (task.attemptCount ?? 0) + 1;
      task.resumeCount = (task.resumeCount ?? 0) + 1;
      if (typeof checkpoint === "string") task.lastCheckpoint = checkpoint.trim() || task.lastCheckpoint;
      if (clearError === true) task.lastError = undefined;
      task.updatedAt = new Date().toISOString();

      let linkedSession: SupervisorSessionState | undefined;
      if (task.sessionId) {
        const reliability = await loadReliabilityConfig();
        const supervisorStore = pruneSupervisorStore(await readSupervisorStore(), reliability);
        linkedSession = supervisorStore.sessions[task.sessionId];
      }

      const directive = buildResumeDirective(task, linkedSession);
      store.tasks[taskId] = task;
      await writeTaskStore(store);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "resumed",
            task,
            linkedSupervisorRoute: linkedSession?.currentRoute ?? null,
            directive,
          }, null, 2),
        }],
      };
    })
);

server.tool(
  "task_create",
  "Create a persistent task item for long-running orchestrated work",
  {
    title: z.string().min(1).max(200).describe("Task title"),
    description: z.string().max(4000).optional().describe("Optional task description"),
    status: z.enum(["todo", "in_progress", "suspended", "blocked", "done", "canceled"]).optional().describe("Initial status"),
    resumable: z.boolean().optional().describe("Whether this task supports structured resume directives"),
    sessionId: z.string().max(120).optional().describe("Optional linked supervisor session ID"),
    worktreePath: z.string().max(4096).optional().describe("Optional worktree path where task edits are isolated"),
    parentCwd: z.string().max(4096).optional().describe("Optional parent working directory for inherited context"),
    lastCheckpoint: z.string().max(4000).optional().describe("Optional initial checkpoint summary"),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional().describe("Optional priority"),
    tags: z.array(z.string().min(1).max(64)).max(32).optional().describe("Optional tags"),
    owner: z.string().max(120).optional().describe("Optional owner hint"),
    blockedBy: z.array(z.string().min(1).max(64)).max(32).optional().describe("Optional blocker IDs"),
    dueAt: z.string().optional().describe("Optional due date as ISO-8601"),
  },
  async ({ title, description, status, resumable, sessionId, worktreePath, parentCwd, lastCheckpoint, priority, tags, owner, blockedBy, dueAt }) =>
    withTaskStoreLock(async () => {
      const store = await readTaskStore();
      const now = new Date().toISOString();
      const taskId = generateTaskId();

      const task: PersistentTask = {
        taskId,
        title: title.trim(),
        description: description?.trim() || undefined,
        status: status ?? "todo",
        resumable: resumable ?? true,
        sessionId: sessionId?.trim() || undefined,
        attemptCount: status === "in_progress" ? 1 : 0,
        resumeCount: 0,
        worktreePath: worktreePath?.trim() || undefined,
        parentCwd: parentCwd?.trim() || undefined,
        lastCheckpoint: lastCheckpoint?.trim() || undefined,
        priority,
        tags: sanitizeTags(tags),
        owner: owner?.trim() || undefined,
        blockedBy: (blockedBy ?? []).map((value) => value.trim()).filter(Boolean),
        dueAt: dueAt?.trim() || undefined,
        createdAt: now,
        updatedAt: now,
      };

      store.tasks[taskId] = task;
      await writeTaskStore(store);

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ status: "created", task }, null, 2) }],
      };
    })
);

server.tool(
  "task_get",
  "Get one persistent task by ID",
  {
    taskId: z.string().min(1).describe("Task ID"),
  },
  async ({ taskId }) =>
    withTaskStoreLock(async () => {
      const store = await readTaskStore();
      const task = store.tasks[taskId];
      if (!task) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ status: "missing", taskId }, null, 2) }],
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ status: "ok", task }, null, 2) }],
      };
    })
);

server.tool(
  "task_update",
  "Update persistent task fields including status and blockers",
  {
    taskId: z.string().min(1).describe("Task ID"),
    title: z.string().min(1).max(200).optional().describe("Updated title"),
    description: z.string().max(4000).optional().describe("Updated description"),
    status: z.enum(["todo", "in_progress", "suspended", "blocked", "done", "canceled"]).optional().describe("Updated status"),
    resumable: z.boolean().optional().describe("Whether this task supports structured resume directives"),
    sessionId: z.string().max(120).optional().describe("Updated supervisor session ID"),
    worktreePath: z.string().max(4096).optional().describe("Updated worktree path"),
    parentCwd: z.string().max(4096).optional().describe("Updated parent working directory"),
    lastCheckpoint: z.string().max(4000).optional().describe("Updated checkpoint summary"),
    lastError: z.string().max(4000).optional().describe("Updated error summary"),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional().describe("Updated priority"),
    tags: z.array(z.string().min(1).max(64)).max(32).optional().describe("Updated tags"),
    owner: z.string().max(120).optional().describe("Updated owner"),
    blockedBy: z.array(z.string().min(1).max(64)).max(32).optional().describe("Updated blocker IDs"),
    dueAt: z.string().optional().describe("Updated due date as ISO-8601"),
  },
  async ({ taskId, title, description, status, resumable, sessionId, worktreePath, parentCwd, lastCheckpoint, lastError, priority, tags, owner, blockedBy, dueAt }) =>
    withTaskStoreLock(async () => {
      const store = await readTaskStore();
      const task = store.tasks[taskId];
      if (!task) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ status: "missing", taskId }, null, 2) }],
        };
      }

      if (typeof title === "string") task.title = title.trim();
      if (typeof description === "string") task.description = description.trim() || undefined;
      if (status) task.status = status;
      if (typeof resumable === "boolean") task.resumable = resumable;
      if (typeof sessionId === "string") task.sessionId = sessionId.trim() || undefined;
      if (typeof worktreePath === "string") task.worktreePath = worktreePath.trim() || undefined;
      if (typeof parentCwd === "string") task.parentCwd = parentCwd.trim() || undefined;
      if (typeof lastCheckpoint === "string") task.lastCheckpoint = lastCheckpoint.trim() || undefined;
      if (typeof lastError === "string") task.lastError = lastError.trim() || undefined;
      if (priority) task.priority = priority;
      if (Array.isArray(tags)) task.tags = sanitizeTags(tags);
      if (typeof owner === "string") task.owner = owner.trim() || undefined;
      if (Array.isArray(blockedBy)) task.blockedBy = blockedBy.map((value) => value.trim()).filter(Boolean);
      if (typeof dueAt === "string") task.dueAt = dueAt.trim() || undefined;
      task.updatedAt = new Date().toISOString();

      store.tasks[taskId] = task;
      await writeTaskStore(store);

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ status: "updated", task }, null, 2) }],
      };
    })
);

server.tool(
  "task_list",
  "List persistent tasks with optional status, tag, and owner filters",
  {
    status: z.enum(["todo", "in_progress", "suspended", "blocked", "done", "canceled"]).optional().describe("Optional status filter"),
    tag: z.string().optional().describe("Optional tag filter"),
    owner: z.string().optional().describe("Optional owner filter"),
    includeCompleted: z.boolean().optional().describe("Include done and canceled tasks"),
    limit: z.number().int().min(1).max(500).optional().describe("Maximum tasks to return"),
  },
  async ({ status, tag, owner, includeCompleted, limit }) =>
    withTaskStoreLock(async () => {
      const store = await readTaskStore();
      const tagFilter = tag?.trim().toLowerCase();
      const ownerFilter = owner?.trim().toLowerCase();

      const tasks = Object.values(store.tasks)
        .filter((task) => !status || task.status === status)
        .filter((task) => includeCompleted === true || (task.status !== "done" && task.status !== "canceled"))
        .filter((task) => !tagFilter || task.tags.some((taskTag) => taskTag.toLowerCase() === tagFilter))
        .filter((task) => !ownerFilter || (task.owner ?? "").toLowerCase() === ownerFilter)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

      const capped = tasks.slice(0, limit ?? 100);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            total: tasks.length,
            returned: capped.length,
            tasks: capped,
          }, null, 2),
        }],
      };
    })
);

// --- Start ---

async function main() {
  await initServerLog();
  void logEvent("server", "server.start", { pid: process.pid, nodeVersion: process.version });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isDirectExecution = (() => {
  const modulePath = fileURLToPath(import.meta.url);
  return Boolean(process.argv[1]) && resolve(process.argv[1]) === modulePath;
})();

if (isDirectExecution) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
