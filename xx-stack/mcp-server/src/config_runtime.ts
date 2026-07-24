import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { PATH_CONSTANTS, resolveRepoFilePath } from "./runtime_constants.js";

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

interface AgentConfigDocument {
  agent?: Record<string, AgentProfile>;
  mcp?: Record<string, unknown>;
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
  return resolveRepoFilePath(
    process.env.XX_STACK_REPO || resolve(homedir(), ".config/opencode/skills/xx-stack"),
    PATH_CONSTANTS.configFile
  );
}

export async function readJson(path: string): Promise<Record<string, unknown> | null> {
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

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function toStringArray(value: unknown): string[] {
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
      scope:
        memory.scope === "user" || memory.scope === "project" || memory.scope === "local"
          ? memory.scope
          : undefined,
    },
    coordinator: {
      strictWorkerContract:
        typeof coordinator.strictWorkerContract === "boolean"
          ? coordinator.strictWorkerContract
          : undefined,
      requireStructuredResults:
        typeof coordinator.requireStructuredResults === "boolean"
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

export async function loadMergedAgentRuntimeConfig(): Promise<{
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

  const mcpServerNames = [...Object.keys(repoDoc.mcp ?? {}), ...Object.keys(userDoc.mcp ?? {})];
  const configuredMcpServers = [
    ...new Set(mcpServerNames.map((name) => name.trim()).filter(Boolean)),
  ];

  return {
    agents: mergedAgents,
    configuredMcpServers,
    sources: { repoPath, userPath },
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
