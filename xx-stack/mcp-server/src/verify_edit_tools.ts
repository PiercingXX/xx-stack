import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { guardedExecFile } from "./execution_policy.js";
import { jsonContent } from "./agent_tool_helpers.js";

const MAX_OUTPUT_CHARS = 10_000;

interface VerifyEditResult {
  lint: { ok: boolean; output: string };
  test: { ok: boolean; output: string };
}

/**
 * Run a single command through the execution policy gate, capture output,
 * truncate to MAX_OUTPUT_CHARS, and return structured ok + output.
 * On failure the output includes the tail of stderr/stdout.
 */
async function runCaptured(
  commandStr: string,
  cwd: string,
  label: string
): Promise<{ ok: boolean; output: string }> {
  const trimmed = commandStr.trim();
  if (!trimmed) {
    return { ok: true, output: `${label}: no command configured` };
  }

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0]!;
  const args = parts.slice(1);

  try {
    const { stdout, stderr } = await guardedExecFile(
      cmd,
      args,
      { cwd, timeout: 120_000 },
      { context: "hook", allowedHookCommands: [cmd] }
    );

    const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
    const truncated =
      combined.length > MAX_OUTPUT_CHARS
        ? combined.slice(0, MAX_OUTPUT_CHARS) +
          `\n... [truncated at ${MAX_OUTPUT_CHARS} chars]`
        : combined;

    return { ok: true, output: truncated || `${label}: ok (no output)` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const output = message.length > MAX_OUTPUT_CHARS
      ? message.slice(0, MAX_OUTPUT_CHARS) +
        `\n... [truncated at ${MAX_OUTPUT_CHARS} chars]`
      : message;
    return { ok: false, output };
  }
}

export function registerVerifyEditTools(server: McpServer): void {
  server.tool(
    "verify_edit",
    "Run lint and/or test commands after an edit and return structured pass/fail with failing tail",
    {
      cwd: z.string().describe("Working directory to run commands in"),
      lintCmd: z.string().optional().describe("Lint command to run (e.g. 'npm run lint')"),
      testCmd: z.string().optional().describe("Test command to run (e.g. 'npm test')"),
    },
    async ({ cwd, lintCmd, testCmd }) => {
      const result: VerifyEditResult = {
        lint: lintCmd
          ? await runCaptured(lintCmd, cwd, "lint")
          : { ok: true, output: "lint: no command configured" },
        test: testCmd
          ? await runCaptured(testCmd, cwd, "test")
          : { ok: true, output: "test: no command configured" },
      };

      return jsonContent(result);
    }
  );
}