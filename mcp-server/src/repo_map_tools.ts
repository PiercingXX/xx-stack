import { resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { envFlagEnabled, isPathWithinRoot, jsonContent } from "./agent_tool_helpers.js";
import { buildRepoMap } from "./repo_map_runtime.js";
import { toolAnnotations } from "./observability_tools.js";

/** Env flag that lifts the root confinement on `build_repo_map`. */
export const ALLOW_ANY_ROOT_ENV = "XX_STACK_ALLOW_ANY_ROOT";

/**
 * Seams for the tool's path policy. Production registration passes nothing and
 * the launch directory is the only admitted root; tests (and golden tasks)
 * inject their fixture roots here instead of weakening the runtime itself.
 */
export interface RepoMapToolDeps {
  /** Extra absolute roots whose subtrees are acceptable repo roots. */
  allowedRoots?: readonly string[];
}

export function registerRepoMapTools(server: McpServer, deps: RepoMapToolDeps = {}): void {
  server.registerTool(
    "build_repo_map",
    {
      description:
        "Given a repo root and token budget, return the most relevant slice of the codebase ranked by git recency, path proximity, and import/reference counts. " +
        "The root must lie under the server launch directory unless XX_STACK_ALLOW_ANY_ROOT=1. " +
        "Omit `tokenBudget` and pass `model` (optionally with `host`) or `contextWindow` to size the map against the lane the task is actually routed to: the budget becomes a fraction of that model's context window, minus `reservedTokens` for the rest of the prompt. An explicit `tokenBudget` always wins; an unknown model or absent context window falls back to 8000. The applied budget and where it came from are returned as `budget`. " +
        "Also returns `omissions`: `considered` (paths discovery produced) plus a count and up to 10 example paths for each exclusion class — ignored, unreadable, oversized (over 2 MiB), binary (NUL byte in the first 8000 bytes), empty, droppedForScale (ranked below the candidate cap, so never offered to selection), droppedForBudget, and truncated (included as a head only). " +
        "Nothing is dropped in silence, but the absence of an omission is not a completeness guarantee: `omissions` reports the exclusions this tool makes, not files that never reached discovery at all.",
      inputSchema: {
        root: z
          .string()
          .describe(
            "Absolute path to the repository root; must stay under the server launch directory unless XX_STACK_ALLOW_ANY_ROOT=1"
          ),
        tokenBudget: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Maximum estimated tokens for the returned file list. Wins over model/contextWindow; 8000 when nothing else resolves"
          ),
        focusPaths: z
          .array(z.string())
          .optional()
          .describe("Paths to prioritize when ranking (files under these paths score higher)"),
        includeSymbols: z
          .boolean()
          .optional()
          .default(false)
          .describe("If true, extract function/class/interface names from each file"),
        model: z
          .string()
          .optional()
          .describe(
            "Model the context is being built for; its registry context window sizes the budget when tokenBudget is omitted"
          ),
        host: z
          .string()
          .optional()
          .describe("Host id, when one model name is served by more than one host"),
        contextWindow: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Nominal context window in tokens; skips the registry lookup"),
        reservedTokens: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "Tokens held back from a derived budget for the prompt itself (ignored when tokenBudget is explicit)"
          ),
      },
      annotations: toolAnnotations("build_repo_map"),
    },
    async ({
      root,
      tokenBudget,
      focusPaths,
      includeSymbols,
      model,
      host,
      contextWindow,
      reservedTokens,
    }) => {
      // Confinement lives here, at the tool boundary — not in the runtime, so
      // direct buildRepoMap callers (tests, golden tasks) keep their contract.
      // An unconstrained root turns this tool into machine-wide enumeration.
      const resolvedRoot = resolve(root.trim());
      const allowedRoots = deps.allowedRoots ?? [process.cwd()];
      if (
        !envFlagEnabled(ALLOW_ANY_ROOT_ENV) &&
        !allowedRoots.some((r) => isPathWithinRoot(resolvedRoot, r))
      ) {
        return jsonContent({
          status: "error",
          reasonCode: "root_out_of_bounds",
          root: resolvedRoot,
          boundaryRoots: allowedRoots,
          hint: `root escapes the server launch directory (${allowedRoots.join(", ")}); pass a repo under it or set ${ALLOW_ANY_ROOT_ENV}=1`,
        });
      }

      const result = await buildRepoMap({
        root: resolvedRoot,
        tokenBudget,
        focusPaths: focusPaths ?? [],
        includeSymbols: includeSymbols ?? false,
        model,
        host,
        contextWindow,
        reservedTokens,
      });
      return jsonContent(result);
    }
  );
}
