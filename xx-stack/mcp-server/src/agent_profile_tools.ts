import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  applyAsyncToolSafety,
  applyToolPolicy,
  loadMergedAgentRuntimeConfig,
  missingRequiredMcpServers,
  toStringArray,
  validateAgentProfiles,
} from "./config_runtime.js";
import { buildCoordinatorContract, jsonContent } from "./agent_tool_helpers.js";

export function registerAgentProfileTools(server: McpServer): void {
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

      return jsonContent({
        configuredMcpServers: runtime.configuredMcpServers,
        sources: runtime.sources,
        profiles,
      });
    }
  );

  server.tool(
    "agent_preflight",
    "Validate whether an agent can run under current MCP availability and tool policy. " +
      "Returns status 'config_invalid' with the offending paths when a config file exists but " +
      "could not be parsed, so an unusable config is never misreported as a missing agent or a " +
      "missing MCP server",
    {
      agentId: z.string().min(1).describe("Agent identifier"),
      requestedTools: z
        .array(z.string())
        .max(256)
        .optional()
        .describe("Optional tools requested for this run"),
      isAsync: z
        .boolean()
        .optional()
        .describe("Whether to apply background async safety restrictions"),
    },
    async ({ agentId, requestedTools, isAsync }) => {
      const runtime = await loadMergedAgentRuntimeConfig();

      // A config file that exists but does not parse contributes no agents and
      // no MCP server names, which used to surface as `missing_agent` or
      // `missing_required_mcp` — a diagnosis pointing at the wrong thing
      // entirely. `configErrors` is the distinguishing signal (a malformed user
      // config is now distinguishable from an absent one via
      // `sources.userConfigStatus`), so it takes precedence over both.
      const configErrors = runtime.configErrors;
      const configInvalid = configErrors.length > 0;

      const profile = runtime.agents[agentId];
      if (!profile) {
        return jsonContent({
          status: configInvalid ? "config_invalid" : "missing_agent",
          agentId,
          configErrors,
          sources: runtime.sources,
        });
      }

      const required = toStringArray(profile.requiredMcpServers);
      const missing = missingRequiredMcpServers(required, runtime.configuredMcpServers);
      const candidateTools = requestedTools ?? [];
      const basePolicy = applyToolPolicy(profile, candidateTools);
      const toolPolicy = isAsync === true ? applyAsyncToolSafety(basePolicy) : basePolicy;

      return jsonContent({
        status: configInvalid ? "config_invalid" : missing.length === 0 ? "ok" : "blocked",
        agentId,
        configErrors,
        sources: runtime.sources,
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
      });
    }
  );

  server.tool(
    "agent_filter_tools",
    "Filter candidate tool names through the selected agent allow/deny policy",
    {
      agentId: z.string().min(1).describe("Agent identifier"),
      candidateTools: z.array(z.string()).min(1).max(512).describe("Tool names to evaluate"),
      isAsync: z
        .boolean()
        .optional()
        .describe("Whether to apply background async safety restrictions"),
    },
    async ({ agentId, candidateTools, isAsync }) => {
      const runtime = await loadMergedAgentRuntimeConfig();
      const profile = runtime.agents[agentId];
      if (!profile) {
        return jsonContent({ status: "missing_agent", agentId });
      }

      const basePolicy = applyToolPolicy(profile, candidateTools);
      const filtered = isAsync === true ? applyAsyncToolSafety(basePolicy) : basePolicy;
      return jsonContent({
        status: "ok",
        agentId,
        isAsync: isAsync === true,
        ...filtered,
      });
    }
  );

  server.tool(
    "agent_validate_profiles",
    "Validate merged agent profile configuration and report errors/warnings",
    {},
    async () => {
      const runtime = await loadMergedAgentRuntimeConfig();
      const findings = validateAgentProfiles(runtime.agents, runtime.configuredMcpServers);
      return jsonContent({
        status: findings.errors.length === 0 ? "ok" : "fail",
        errorCount: findings.errors.length,
        warningCount: findings.warnings.length,
        errors: findings.errors,
        warnings: findings.warnings,
      });
    }
  );

  server.tool(
    "build_coordinator_contract",
    "Generate a hardened coordinator worker contract prompt from agent policy",
    {
      agentId: z
        .string()
        .optional()
        .describe("Agent identifier (defaults to execution-orchestrator)"),
    },
    async ({ agentId }) => {
      const resolvedAgentId = agentId?.trim() || "execution-orchestrator";
      const runtime = await loadMergedAgentRuntimeConfig();
      const profile = runtime.agents[resolvedAgentId];
      if (!profile) {
        return jsonContent({ status: "missing_agent", agentId: resolvedAgentId });
      }

      const strict = profile.coordinator?.strictWorkerContract !== false;
      const structured = profile.coordinator?.requireStructuredResults !== false;
      const contract = buildCoordinatorContract(resolvedAgentId, strict, structured);
      return jsonContent({
        status: "ok",
        agentId: resolvedAgentId,
        strictWorkerContract: strict,
        requireStructuredResults: structured,
        contract,
      });
    }
  );
}
