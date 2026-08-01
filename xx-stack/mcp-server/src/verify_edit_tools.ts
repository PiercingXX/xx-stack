import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { guardedExecFile } from "./execution_policy.js";
import { jsonContent } from "./agent_tool_helpers.js";
import { compactOutput, type CompactOptions } from "./output_compaction.js";

const OUTPUT_CAP = 4096;

interface VerifyEditDeps {
  allowedCommands: string[];
}

interface CmdResult {
  ok: boolean;
  output: string;
}

function truncateFailingTail(full: string): string {
  if (full.length <= OUTPUT_CAP) return full;
  // Keep the last OUTPUT_CAP bytes — the failing tail is what a
  // continuation prompt needs to diagnose the failure.
  return "... [truncated " + (full.length - OUTPUT_CAP) + " bytes] ...\n" + full.slice(-OUTPUT_CAP);
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  allowedCommands: string[]
): Promise<CmdResult> {
  try {
    const { stdout, stderr } = await guardedExecFile(
      command,
      args,
      { cwd, timeout: 120_000 },
      { context: "hook", allowedHookCommands: allowedCommands }
    );
    const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
    return { ok: true, output: combined || "(no output)" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // guardedExecFile throws "execution_policy_denied:..." when the policy blocks it.
    if (message.startsWith("execution_policy_denied:")) {
      return { ok: false, output: message };
    }
    // execFile errors have stdout/stderr on the error object
    const execErr = err as { stdout?: string; stderr?: string };
    const combined = [execErr.stdout, execErr.stderr].filter(Boolean).join("\n").trim();
    const tail = combined || message;
    return { ok: false, output: truncateFailingTail(tail) };
  }
}

export function registerVerifyEditTools(server: McpServer, deps: VerifyEditDeps): void {
  server.tool(
    "verify_edit",
    "After an edit, run the project's linter and/or tests and return structured pass/fail with failure payload for a continuation prompt. Shells out through the execution-policy gate.",
    {
      cwd: z.string().describe("Working directory for the commands"),
      lintCmd: z.string().optional().describe("Lint command to run (e.g. 'npx eslint .')"),
      testCmd: z.string().optional().describe("Test command to run (e.g. 'npm test')"),
      compactOptions: z.object({
        cap: z.number().optional().describe("Maximum output length in characters"),
        stripAnsi: z.boolean().optional().describe("Strip ANSI escape sequences"),
        collapseRepeats: z.boolean().optional().describe("Collapse repeated consecutive lines"),
      }).optional().describe("If provided, compact command outputs using these options"),
    },
    async ({ cwd, lintCmd, testCmd, compactOptions }) => {
      const result: { lint: CmdResult | null; test: CmdResult | null; compacted?: string[] } = {
        lint: null,
        test: null,
      };

      const compactResults: string[] = [];

      const maybeCompact = (output: string): string => {
        if (!compactOptions) return output;
        const { output: compacted, dropped } = compactOutput(output, compactOptions);
        if (dropped.length > 0) {
          compactResults.push(...dropped);
        }
        return compacted;
      };

      if (lintCmd) {
        const parts = lintCmd.split(/\s+/);
        const command = parts[0]!;
        const args = parts.slice(1);
        result.lint = await runCommand(command, args, cwd, deps.allowedCommands);
        if (result.lint) {
          result.lint.output = maybeCompact(result.lint.output);
        }
      }

      if (testCmd) {
        const parts = testCmd.split(/\s+/);
        const command = parts[0]!;
        const args = parts.slice(1);
        result.test = await runCommand(command, args, cwd, deps.allowedCommands);
        if (result.test) {
          result.test.output = maybeCompact(result.test.output);
        }
      }

      if (compactResults.length > 0) {
        result.compacted = compactResults;
      }

      return jsonContent(result);
    }
  );
}