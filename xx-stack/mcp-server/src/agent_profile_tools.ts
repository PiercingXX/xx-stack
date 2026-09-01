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
import { jsonContent } from "./agent_tool_helpers.js";
import { toolAnnotations } from "./observability_tools.js";

export function registerAgentProfileTools(server: McpServer): void {
  server.registerTool(
    "agent_list_profiles",
    {
      description:
        "List merged agent profiles including required MCP servers, tool policy, memory scope, and coordinator contract flags",
      inputSchema: {},
      annotations: toolAnnotations("agent_list_profiles"),
    },
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

      const findings = validateAgentProfiles(runtime.agents, runtime.configuredMcpServers);
      return jsonContent({
        configuredMcpServers: runtime.configuredMcpServers,
        sources: runtime.sources,
        profiles,
        validation: {
          status: findings.errors.length === 0 ? "ok" : "fail",
          errorCount: findings.errors.length,
          warningCount: findings.warnings.length,
          errors: findings.errors,
          warnings: findings.warnings,
        },
      });
    }
  );

  server.registerTool(
    "agent_preflight",
    {
      description:
        "Validate whether an agent can run under current MCP availability and tool policy. " +
        "Returns status 'config_invalid' with the offending paths when a config file exists but " +
        "could not be parsed, so an unusable config is never misreported as a missing agent or a " +
        "missing MCP server",
      inputSchema: {
        agentId: z.string().min(1).describe("Agent identifier"),
        requestedTools: z
          .array(z.string())
          .max(256)
          .optional()
          .describe(
            "Optional tools requested for this run; when set, the response includes the filtered allow/deny set"
          ),
        isAsync: z
          .boolean()
          .optional()
          .describe("Whether to apply background async safety restrictions"),
      },
      annotations: toolAnnotations("agent_preflight"),
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
}
