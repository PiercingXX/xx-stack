import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { jsonContent } from "./agent_tool_helpers.js";
import { buildRepoMap } from "./repo_map_runtime.js";

export function registerRepoMapTools(server: McpServer, _deps: Record<string, never>): void {
  server.tool(
    "build_repo_map",
    "Given a repo root and token budget, return the most relevant slice of the codebase ranked by git recency, path proximity, and import/reference counts",
    {
      root: z.string().describe("Absolute path to the repository root"),
      tokenBudget: z
        .number()
        .int()
        .positive()
        .optional()
        .default(8000)
        .describe("Maximum estimated tokens for the returned file list"),
      focusPaths: z
        .array(z.string())
        .optional()
        .describe("Paths to prioritize when ranking (files under these paths score higher)"),
      includeSymbols: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, extract function/class/interface names from each file"),
    },
    async ({ root, tokenBudget, focusPaths, includeSymbols }) => {
      const result = await buildRepoMap({
        root,
        tokenBudget,
        focusPaths: focusPaths ?? [],
        includeSymbols: includeSymbols ?? false,
      });
      return jsonContent(result);
    }
  );
}