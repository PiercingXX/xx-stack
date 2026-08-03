import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { guardedExecFile } from "./execution_policy.js";
import { jsonContent } from "./agent_tool_helpers.js";
import { compactOutput } from "./output_compaction.js";

// --- Capture-then-truncate -------------------------------------------------
//
// The exec gate captures the command's full output (bounded by
// MAX_CAPTURE_BYTES in execution_policy.ts), returns a bounded head+tail VIEW
// for the model, and keeps the full capture on disk so the agent can grep the
// complete log without re-running the suite.
//
// The view cap stays at this codebase's existing 4096 chars: verify_edit
// output is fed straight into continuation prompts for small local models,
// where the context window — not the disk — is the scarce resource. (Upstream
// buzz uses a 50KB view because it feeds a frontier-model chat window.) The
// head/tail split is compactOutput's, not a second truncation implementation.

/** Characters of command output returned inline to the model. */
const VIEW_CAP = 4096;

/** Number of full-capture artifacts kept per session; oldest evicted. */
const ARTIFACT_RING_SIZE = 8;

interface VerifyEditDeps {
  allowedCommands: string[];
}

interface CmdResult {
  ok: boolean;
  /** Bounded head+tail view of the output. */
  output: string;
  /** True when `output` is a truncated view of a larger capture. */
  truncated: boolean;
  /** Path to the full capture on disk, present only when truncated. */
  fullOutputPath?: string;
}

// --- Scratch artifact ring -------------------------------------------------
//
// Artifacts live in a per-session scratch dir under the OS temp dir — NEVER in
// the repo. XX_STACK_SCRATCH_DIR overrides the base for tests and for hosts
// that put scratch space elsewhere.

const SESSION_ID = `${process.pid}`;
const ringPaths: string[] = [];
let artifactSeq = 0;

/** Per-session scratch dir for verify_edit full-output artifacts. */
export function getVerifyEditScratchDir(): string {
  const override = process.env.XX_STACK_SCRATCH_DIR?.trim();
  const base = override && override.length > 0 ? override : join(tmpdir(), "xx-stack-scratch");
  return join(base, `verify-edit-${SESSION_ID}`);
}

/**
 * Persist a full capture into the session scratch ring, evicting the oldest
 * entry once the ring is full. Best-effort: a failed write never fails the
 * command, it just means no fullOutputPath in the result.
 */
export function writeFullOutputArtifact(label: string, content: string): string | undefined {
  const dir = getVerifyEditScratchDir();
  artifactSeq += 1;
  const path = join(dir, `${label}-${String(artifactSeq).padStart(4, "0")}.log`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, content, "utf8");
  } catch {
    return undefined;
  }
  ringPaths.push(path);
  while (ringPaths.length > ARTIFACT_RING_SIZE) {
    const evicted = ringPaths.shift();
    if (!evicted) break;
    try {
      unlinkSync(evicted);
    } catch {
      /* already gone — eviction is best-effort */
    }
  }
  return path;
}

/** Paths currently held by the artifact ring, oldest first. */
export function listFullOutputArtifacts(): string[] {
  return [...ringPaths];
}

/** Test-only: drop the ring and remove the session scratch dir. */
export function resetFullOutputArtifacts(): void {
  ringPaths.length = 0;
  artifactSeq = 0;
  try {
    rmSync(getVerifyEditScratchDir(), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

interface RawRun {
  ok: boolean;
  /** Full capture (or the denial reason when denied). */
  full: string;
  /** True when the execution policy refused to run the command at all. */
  denied: boolean;
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  allowedCommands: string[]
): Promise<RawRun> {
  try {
    const { stdout, stderr } = await guardedExecFile(
      command,
      args,
      { cwd, timeout: 120_000 },
      { context: "hook", allowedHookCommands: allowedCommands }
    );
    const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
    return { ok: true, full: combined || "(no output)", denied: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // guardedExecFile throws "execution_policy_denied:..." when the policy
    // blocks it — before any process is spawned. Surface it verbatim.
    if (message.startsWith("execution_policy_denied:")) {
      return { ok: false, full: message, denied: true };
    }
    // Guarded exec failures carry the captured stdout/stderr on the error.
    const execErr = err as { stdout?: string; stderr?: string };
    const combined = [execErr.stdout, execErr.stderr].filter(Boolean).join("\n").trim();
    return { ok: false, full: combined || message, denied: false };
  }
}

export function registerVerifyEditTools(server: McpServer, deps: VerifyEditDeps): void {
  server.tool(
    "verify_edit",
    "After an edit, run the project's linter and/or tests and return structured pass/fail with failure payload for a continuation prompt. Output is captured in full, returned as a bounded head+tail view, and the complete capture is kept at fullOutputPath when truncated. Shells out through the execution-policy gate.",
    {
      cwd: z.string().describe("Working directory for the commands"),
      lintCmd: z.string().optional().describe("Lint command to run (e.g. 'npx eslint .')"),
      testCmd: z.string().optional().describe("Test command to run (e.g. 'npm test')"),
      compactOptions: z
        .object({
          cap: z.number().optional().describe("Maximum output length in characters"),
          stripAnsi: z.boolean().optional().describe("Strip ANSI escape sequences"),
          collapseRepeats: z.boolean().optional().describe("Collapse repeated consecutive lines"),
        })
        .optional()
        .describe("If provided, compact command outputs using these options"),
    },
    async ({ cwd, lintCmd, testCmd, compactOptions }) => {
      const result: { lint: CmdResult | null; test: CmdResult | null; compacted?: string[] } = {
        lint: null,
        test: null,
      };

      const compactResults: string[] = [];

      /** Full capture -> caller compaction -> view cap -> artifact on overflow. */
      const toResult = (label: string, raw: RawRun): CmdResult => {
        if (raw.denied) {
          return { ok: false, output: raw.full, truncated: false };
        }

        let text = raw.full;
        let truncated = false;

        if (compactOptions) {
          const { output, dropped } = compactOutput(text, compactOptions);
          text = output;
          if (dropped.length > 0) {
            compactResults.push(...dropped);
            truncated ||= dropped.some((entry) => entry.startsWith("truncated "));
          }
        }

        const view = compactOutput(text, { cap: VIEW_CAP });
        if (view.dropped.length > 0) {
          truncated = true;
          text = view.output;
        }

        if (!truncated) {
          return { ok: raw.ok, output: text, truncated: false };
        }

        // Keep the pre-compaction capture — the point of the artifact is that
        // the agent can grep what the view dropped.
        const fullOutputPath = writeFullOutputArtifact(label, raw.full);
        return fullOutputPath
          ? { ok: raw.ok, output: text, truncated: true, fullOutputPath }
          : { ok: raw.ok, output: text, truncated: true };
      };

      if (lintCmd) {
        const parts = lintCmd.split(/\s+/);
        const command = parts[0]!;
        const args = parts.slice(1);
        result.lint = toResult("lint", await runCommand(command, args, cwd, deps.allowedCommands));
      }

      if (testCmd) {
        const parts = testCmd.split(/\s+/);
        const command = parts[0]!;
        const args = parts.slice(1);
        result.test = toResult("test", await runCommand(command, args, cwd, deps.allowedCommands));
      }

      if (compactResults.length > 0) {
        result.compacted = compactResults;
      }

      return jsonContent(result);
    }
  );
}
