import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { PATH_CONSTANTS, resolveRepoFilePath, xxStackRepoRoot } from "./runtime_constants.js";

export type AgentMemoryScope = "user" | "project" | "local";

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

export interface AgentProfile {
  mode?: string;
  model?: string;
  requiredMcpServers?: string[];
  toolPolicy?: AgentToolPolicy;
  memory?: AgentMemoryConfig;
  coordinator?: CoordinatorContractConfig;
}

export interface AgentConfigDocument {
  agent?: Record<string, AgentProfile>;
  mcp?: Record<string, unknown>;
  /** Why this document contributed nothing, when it contributed nothing. */
  status: ConfigDocumentStatus;
}

/**
 * A config file that is absent and one that is present-but-unparseable are not
 * the same fact: the first is normal, the second silently drops every agent
 * profile and every configured MCP server, which downstream reads as
 * "missing_required_mcp" rather than "your config is invalid".
 */
export type ConfigDocumentStatus = "ok" | "missing" | "invalid";

export interface ConfigDocumentIssue {
  path: string;
  code: "invalid_config";
  message: string;
}

const ASYNC_AGENT_TOOL_BLOCKLIST = new Set<string>([
  "supervisor_abort_session",
  "task_suspend",
  "task_resume",
]);

export function getUserConfigPath(): string {
  return resolve(homedir(), ".config/opencode/config.json");
}

export function getRepoConfigPath(): string {
  return resolveRepoFilePath(xxStackRepoRoot(), PATH_CONSTANTS.configFile);
}

export interface ReadJsonResult {
  value: Record<string, unknown> | null;
  status: ConfigDocumentStatus;
  /** Present only when status is "invalid". */
  error?: string;
}

/**
 * Read a JSON document, distinguishing "not there" from "there but broken".
 *
 * A bare `catch { return null }` collapses ENOENT, EACCES, and a syntax error
 * into one indistinguishable answer, so a malformed config looks exactly like
 * an absent one to every caller.
 */
export async function readJsonResult(path: string): Promise<ReadJsonResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { value: null, status: "missing" };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { value: null, status: "invalid", error: message };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      return { value: parsed as Record<string, unknown>, status: "ok" };
    }
    return { value: null, status: "invalid", error: "top-level JSON value is not an object" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { value: null, status: "invalid", error: message };
  }
}

export async function readJson(path: string): Promise<Record<string, unknown> | null> {
  return (await readJsonResult(path)).value;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
}

/**
 * Copy `key` from override when the override actually carries it, else from
 * base. Object spread copies keys whose value is `undefined`, which is exactly
 * how a user config that merely *mentions* an agent used to erase that agent's
 * repo-configured model/mode — so nothing here goes through spread.
 */
function pickDefined<T, K extends keyof T>(target: T, key: K, base: T, override: T): void {
  const value = override[key] ?? base[key];
  if (value !== undefined) {
    target[key] = value;
  }
}

function mergeNested<T extends object>(
  base: T | undefined,
  override: T | undefined
): T | undefined {
  if (base === undefined && override === undefined) return undefined;
  const merged = { ...(base ?? {}) } as T;
  for (const [key, value] of Object.entries(override ?? {})) {
    // Skip undefined-valued override keys: absent in the override document is
    // not the same as "explicitly cleared".
    if (value === undefined) continue;
    (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}

export function mergeAgentProfiles(base: AgentProfile, override: AgentProfile): AgentProfile {
  const merged: AgentProfile = {};
  pickDefined(merged, "mode", base, override);
  pickDefined(merged, "model", base, override);
  pickDefined(merged, "requiredMcpServers", base, override);

  const toolPolicy = mergeNested(base.toolPolicy, override.toolPolicy);
  if (toolPolicy !== undefined) merged.toolPolicy = toolPolicy;
  const memory = mergeNested(base.memory, override.memory);
  if (memory !== undefined) merged.memory = memory;
  const coordinator = mergeNested(base.coordinator, override.coordinator);
  if (coordinator !== undefined) merged.coordinator = coordinator;

  return merged;
}

/**
 * Parse one agent profile, emitting ONLY the keys the document actually sets.
 *
 * Emitting every key with an `undefined`/empty value makes an override document
 * indistinguishable from a document that deliberately clears a field. Combined
 * with the merge below, an always-present `toolPolicy: { allow: [], deny: [] }`
 * would overwrite a repo `deny` list with `[]` — and `applyToolPolicy` treats an
 * empty allow-list as allow-all, so a restricted agent would silently become
 * unrestricted.
 */
function parseAgentProfile(raw: unknown): AgentProfile {
  const source = asRecord(raw);
  const profile: AgentProfile = {};

  if (typeof source.mode === "string") profile.mode = source.mode;
  if (typeof source.model === "string") profile.model = source.model;
  if (source.requiredMcpServers !== undefined) {
    profile.requiredMcpServers = toStringArray(source.requiredMcpServers);
  }

  if (source.toolPolicy !== undefined) {
    const toolPolicy = asRecord(source.toolPolicy);
    const parsed: AgentToolPolicy = {};
    if (toolPolicy.allow !== undefined) parsed.allow = toStringArray(toolPolicy.allow);
    if (toolPolicy.deny !== undefined) parsed.deny = toStringArray(toolPolicy.deny);
    profile.toolPolicy = parsed;
  }

  if (source.memory !== undefined) {
    const memory = asRecord(source.memory);
    const parsed: AgentMemoryConfig = {};
    if (typeof memory.enabled === "boolean") parsed.enabled = memory.enabled;
    if (memory.scope === "user" || memory.scope === "project" || memory.scope === "local") {
      parsed.scope = memory.scope;
    }
    profile.memory = parsed;
  }

  if (source.coordinator !== undefined) {
    const coordinator = asRecord(source.coordinator);
    const parsed: CoordinatorContractConfig = {};
    if (typeof coordinator.strictWorkerContract === "boolean") {
      parsed.strictWorkerContract = coordinator.strictWorkerContract;
    }
    if (typeof coordinator.requireStructuredResults === "boolean") {
      parsed.requireStructuredResults = coordinator.requireStructuredResults;
    }
    profile.coordinator = parsed;
  }

  return profile;
}

function buildAgentConfigDocument(read: ReadJsonResult): AgentConfigDocument {
  const root = asRecord(read.value);
  const agentRaw = asRecord(root.agent);
  const agentProfiles: Record<string, AgentProfile> = {};
  for (const [agentId, agentValue] of Object.entries(agentRaw)) {
    if (!agentValue || typeof agentValue !== "object") continue;
    agentProfiles[agentId] = parseAgentProfile(agentValue);
  }
  return {
    agent: agentProfiles,
    mcp: asRecord(root.mcp),
    status: read.status,
  };
}

export async function readAgentConfigDocument(path: string): Promise<AgentConfigDocument> {
  return buildAgentConfigDocument(await readJsonResult(path));
}

export async function loadMergedAgentRuntimeConfig(): Promise<{
  agents: Record<string, AgentProfile>;
  configuredMcpServers: string[];
  /** Non-empty when a config file exists but could not be used. */
  configErrors: ConfigDocumentIssue[];
  sources: {
    repoPath: string;
    userPath: string;
    repoConfigStatus: ConfigDocumentStatus;
    userConfigStatus: ConfigDocumentStatus;
  };
}> {
  const repoPath = getRepoConfigPath();
  const userPath = getUserConfigPath();
  const [repoRead, userRead] = await Promise.all([
    readJsonResult(repoPath),
    readJsonResult(userPath),
  ]);
  const [repoDoc, userDoc] = [
    buildAgentConfigDocument(repoRead),
    buildAgentConfigDocument(userRead),
  ];

  const mergedAgents: Record<string, AgentProfile> = {};
  const repoAgents = repoDoc.agent ?? {};
  const userAgents = userDoc.agent ?? {};

  for (const [agentId, profile] of Object.entries(repoAgents)) {
    mergedAgents[agentId] = mergeAgentProfiles({}, profile);
  }
  for (const [agentId, profile] of Object.entries(userAgents)) {
    mergedAgents[agentId] = mergeAgentProfiles(mergedAgents[agentId] ?? {}, profile);
  }

  const mcpServerNames = [...Object.keys(repoDoc.mcp ?? {}), ...Object.keys(userDoc.mcp ?? {})];
  const configuredMcpServers = [
    ...new Set(mcpServerNames.map((name) => name.trim()).filter(Boolean)),
  ];

  const configErrors: ConfigDocumentIssue[] = [];
  for (const [path, read] of [
    [repoPath, repoRead],
    [userPath, userRead],
  ] as const) {
    if (read.status === "invalid") {
      configErrors.push({
        path,
        code: "invalid_config",
        message: `config file exists but could not be read as JSON: ${read.error ?? "unknown error"}`,
      });
    }
  }

  return {
    agents: mergedAgents,
    configuredMcpServers,
    configErrors,
    sources: {
      repoPath,
      userPath,
      repoConfigStatus: repoDoc.status,
      userConfigStatus: userDoc.status,
    },
  };
}

export function wildcardMatch(pattern: string, candidate: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const regex = new RegExp(`^${escaped}$`, "i");
  return regex.test(candidate);
}

export function missingRequiredMcpServers(required: string[], available: string[]): string[] {
  if (required.length === 0) return [];
  return required.filter((pattern) => !available.some((name) => wildcardMatch(pattern, name)));
}

export type ToolPolicyResult = {
  allowRules: string[];
  denyRules: string[];
  allowedTools: string[];
  deniedTools: string[];
};

export function applyAsyncToolSafety(policy: ToolPolicyResult): ToolPolicyResult & {
  asyncRemovedTools: string[];
} {
  const allowedTools = policy.allowedTools.filter((tool) => !ASYNC_AGENT_TOOL_BLOCKLIST.has(tool));
  const removedForAsync = policy.allowedTools.filter((tool) =>
    ASYNC_AGENT_TOOL_BLOCKLIST.has(tool)
  );
  const deniedTools = [...new Set([...policy.deniedTools, ...removedForAsync])];
  return {
    ...policy,
    allowedTools,
    deniedTools,
    asyncRemovedTools: removedForAsync,
  };
}

export function validateAgentProfiles(
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
      const overlap = allowRules.filter((allowRule) =>
        denyRules.some((denyRule) => allowRule === denyRule)
      );
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

export function applyToolPolicy(
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
  const normalizedCandidates = [
    ...new Set(candidateTools.map((tool) => tool.trim()).filter(Boolean)),
  ];
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

export function toPositiveNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
