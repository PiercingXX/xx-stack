import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { jsonContent } from "./agent_tool_helpers.js";
import { guardedExecFile } from "./execution_policy.js";

const MAX_OUTPUT_BYTES = 4096;

interface VerifyEditDeps {
  /** Paths the policy allowlists for "hook" context */
  allowedHookCommands: string[];
}

/**
 * Run a shell command via the execution-policy gate, capture stdout+stderr,
 * and return { ok, output } where output is the failing tail (last N bytes)
 * when the command fails, or the full output when it succeeds.
 */
async function runCaptured(
  command: string,
  args: string[],
  cwd: string | undefined,
  deps: VerifyEditDeps
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await guardedExecFile(
      command,
      args,
      { cwd, timeout: 60_000 },
      { context: "hook", allowedHookCommands: deps.allowedHookCommands }
    );
    const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
    return { ok: true, output: combined };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Take the failing tail — last MAX_OUTPUT_BYTES bytes
    const tail = message.slice(-MAX_OUTPUT_BYTES);
    return { ok: false, output: tail };
  }
}

export function registerVerifyEditTools(
  server: McpServer,
  deps: VerifyEditDeps
): void {
  server.tool(
    "verify_edit",
    "Run lint and/or test commands after an edit, returning structured pass/fail results through the execution-policy gate",
    {
      cwd: z
        .string()
        .optional()
        .describe("Working directory for the commands"),
      lintCmd: z
        .string()
        .optional()
        .describe("Lint command to run (e.g. 'npx eslint src/')"),
      testCmd: z
        .string()
        .optional()
        .describe("Test command to run (e.g. 'npm test')"),
    },
    async ({ cwd, lintCmd, testCmd }) => {
      const result: {
        lint?: { ok: boolean; output: string };
        test?: { ok: boolean; output: string };
      } = {};

      if (lintCmd) {
        result.lint = await runCaptured(
          "bash",
          ["-c", lintCmd],
          cwd,
          deps
        );
      }

      if (testCmd) {
        result.test = await runCaptured(
          "bash",
          ["-c", testCmd],
          cwd,
          deps
        );
      }

      return jsonContent(result);
    }
  );
}