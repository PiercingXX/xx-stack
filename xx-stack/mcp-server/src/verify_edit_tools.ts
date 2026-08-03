import { chmodSync, existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { guardedExecFile } from "./execution_policy.js";
import { jsonContent } from "./agent_tool_helpers.js";
import { compactOutput } from "./output_compaction.js";
import { redactSecrets } from "./supervisor_completion_tools.js";
import { toolAnnotations } from "./observability_tools.js";

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

/** Wall-clock budget for a single verify command. */
const RUN_TIMEOUT_MS = 120_000;

interface VerifyEditDeps {
  allowedCommands: string[];
}

// --- Could-not-run is not a failure ----------------------------------------
//
// xx-stack dispatches to heterogeneous machines, so the lane that got the task
// is exactly the one most likely to be missing the toolchain. Collapsing every
// non-zero path into `ok: false` made four different facts indistinguishable:
// the suite reported real failures; the policy refused to run the command at
// all; the binary is not on this machine's PATH; `node_modules` was never
// installed here. Only the first is evidence about the code. The other three
// are evidence about the LANE, and telling an agent to fix code that is fine
// burns the failure budget on a misdiagnosis.
//
// `ok` is kept exactly as it was for wire compatibility — `ok === (outcome ===
// "pass")` — and `outcome` is additive.

/**
 * What actually happened to the command.
 * - `pass` — exit 0.
 * - `fail` — it ran, it exited non-zero: evidence about the code.
 * - `could_not_run` — it never really executed here: evidence about the lane.
 * - `denied` — the execution policy refused it before any process was spawned.
 */
export type CmdOutcome = "pass" | "fail" | "could_not_run" | "denied";

export interface CmdResult {
  ok: boolean;
  /**
   * Additive classification. `ok` stays true iff this is `"pass"`, so existing
   * callers are unaffected; new callers can distinguish "your code is broken"
   * from "this machine cannot run the check".
   */
  outcome: CmdOutcome;
  /**
   * Machine-readable cause, so a caller never has to substring-match `output`:
   * the policy's denial reason for `denied`; `command_not_found`, `timeout`,
   * `bad_cwd`, `deps_not_installed` for `could_not_run`.
   */
  reasonCode?: string;
  /**
   * One sentence naming the fix. Present for every `could_not_run`, and for a
   * `denied` whose cause is a caller-side limitation rather than a policy
   * judgement — today that is `hook_arg_pattern_blocked`, where the usual
   * cause is a quoted argument this tool cannot express (D5).
   */
  remediation?: string;
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
//
// D3: the capture on disk stays RAW (see the redaction note on `toResult`),
// which makes the path itself the exposure. `os.tmpdir()` is world-readable
// and this path is predictable — `<tmp>/xx-stack-scratch/verify-edit-<pid>` —
// so on a shared machine every other user could read the last 8 full captures.
// The directory is created 0700 and each artifact written 0600: same trust
// level as the working tree, and nothing wider.

/** Directory mode for the session scratch dir — owner only. */
const SCRATCH_DIR_MODE = 0o700;

/** File mode for a full-capture artifact — owner read/write only. */
const ARTIFACT_FILE_MODE = 0o600;

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
    mkdirSync(dir, { recursive: true, mode: SCRATCH_DIR_MODE });
    // mkdir's mode is masked by umask and ignored entirely for a directory
    // that already exists, so the mode is asserted rather than requested.
    chmodSync(dir, SCRATCH_DIR_MODE);
    writeFileSync(path, content, { encoding: "utf8", mode: ARTIFACT_FILE_MODE });
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
  outcome: CmdOutcome;
  reasonCode?: string;
  remediation?: string;
}

/** Package managers whose failure is worth one cheap precondition check. */
const NPM_ECOSYSTEM_COMMANDS = new Set(["npm", "npx", "pnpm", "yarn"]);

/** The execution policy's reason code for an argument that fails its charset. */
const ARG_PATTERN_DENIAL = "hook_arg_pattern_blocked";

// --- D5: a quoted argument cannot be expressed, and now says so -------------
//
// `lintCmd`/`testCmd` are split on whitespace and handed to execFile as argv.
// That is a deliberate design property, NOT an oversight: there is no shell in
// the path, so there is no shell grammar to defeat, which is why several
// upstream shell-quoting mitigations were correctly declined. Adding a shell
// parser here would create the attack surface those mitigations exist to
// manage.
//
// The cost is real though: `npx jest -t "my test"` splits into `-t`, `"my`,
// `test"`, and the leading quote fails SAFE_HOOK_ARG_PATTERN (quotes are not
// in its charset). The denial was correct and loud but anonymous — the caller
// got `hook_arg_pattern_blocked` and no hint that quoting was the cause. Since
// `goalContract.validationCmd` flows through this tool, that costs a whole
// verify cycle to diagnose.

/** Arguments carrying a quote character — the usual cause of the denial. */
function quotedArgs(args: string[]): string[] {
  return args.filter((arg) => arg.includes('"') || arg.includes("'"));
}

/** One sentence naming the limitation behind an argv-charset denial. */
function argPatternRemediation(args: string[]): string {
  const quoted = quotedArgs(args);
  const base =
    "verify_edit splits the command on whitespace and runs it as argv with no shell, so a quoted argument cannot be expressed — the quote characters become part of the argument and fail the allowed-argument pattern. Use a form that needs no quoting (a config file, an npm script, or a pattern without spaces).";
  return quoted.length > 0
    ? `${base} The rejected argument(s) contained quotes: ${quoted.join(" ")}.`
    : `${base} Allowed argument characters are letters, digits, and _./:@%+=,- — no spaces, quotes, or shell metacharacters.`;
}

/** The shape a spawn error arrives in — read structurally, never re-parsed. */
interface SpawnFailure {
  code?: unknown;
  syscall?: unknown;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
}

/**
 * One cheap npm-ecosystem precondition, deliberately not a general framework
 * detector: `npm test` in a project whose `node_modules` was never installed on
 * this lane cannot report anything about the code, and its output is otherwise
 * byte-indistinguishable from a red suite.
 */
function missingNodeModules(command: string, cwd: string): boolean {
  if (!NPM_ECOSYSTEM_COMMANDS.has(command)) return false;
  return existsSync(join(cwd, "package.json")) && !existsSync(join(cwd, "node_modules"));
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  allowedCommands: string[]
): Promise<RawRun> {
  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await guardedExecFile(
      command,
      args,
      { cwd, timeout: RUN_TIMEOUT_MS },
      { context: "hook", allowedHookCommands: allowedCommands }
    );
    const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
    return { ok: true, full: combined || "(no output)", outcome: "pass" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Classification happens HERE, where the information still exists as
    // structured error properties. Once this collapses into a display string
    // the distinctions are gone and only substring-matching can recover them —
    // which is exactly the bug.

    // guardedExecFile throws "execution_policy_denied:<reason>[:<pattern>]"
    // when the policy blocks it, before any process is spawned.
    if (message.startsWith("execution_policy_denied:")) {
      const reason = message.slice("execution_policy_denied:".length).split(":")[0]!.trim();
      const reasonCode = reason.length > 0 ? reason : "execution_policy_denied";
      return {
        ok: false,
        full: message,
        outcome: "denied",
        reasonCode,
        ...(reasonCode === ARG_PATTERN_DENIAL ? { remediation: argPatternRemediation(args) } : {}),
      };
    }

    const execErr = err as SpawnFailure;
    const spawnCode = typeof execErr.code === "string" ? execErr.code : undefined;
    const isSpawnError = typeof execErr.syscall === "string" && execErr.syscall.startsWith("spawn");

    // A spawn-level ENOENT/EACCES means no process ever ran. A missing cwd
    // presents identically, so it is disambiguated before blaming the binary.
    if (isSpawnError && (spawnCode === "ENOENT" || spawnCode === "EACCES")) {
      if (!existsSync(cwd)) {
        return {
          ok: false,
          full: message,
          outcome: "could_not_run",
          reasonCode: "bad_cwd",
          remediation: `The working directory ${cwd} does not exist on this lane — check the repo out there, or route this task to the machine that holds it.`,
        };
      }
      return {
        ok: false,
        full: message,
        outcome: "could_not_run",
        reasonCode: "command_not_found",
        remediation:
          spawnCode === "EACCES"
            ? `${command} exists on this lane but is not executable — fix its permissions, or route this task to a machine that can run it.`
            : `${command} is not installed on this lane — install it, or route this task to a machine that has it.`,
      };
    }

    // The timeout path kills the process group, so the error arrives killed
    // with a signal and no exit code. Pairing that with the elapsed budget
    // keeps a genuinely crash-signalled test suite classified as a failure.
    const killedBySignal = execErr.killed === true && execErr.signal != null;
    if (killedBySignal && Date.now() - startedAt >= RUN_TIMEOUT_MS) {
      return {
        ok: false,
        full: message,
        outcome: "could_not_run",
        reasonCode: "timeout",
        remediation: `${command} exceeded the ${RUN_TIMEOUT_MS / 1000}s verify budget on this lane — narrow the command's scope, or run it on a faster lane.`,
      };
    }

    // Guarded exec failures carry the captured stdout/stderr on the error.
    const combined = [execErr.stdout, execErr.stderr].filter(Boolean).join("\n").trim();

    if (missingNodeModules(command, cwd)) {
      return {
        ok: false,
        full: combined || message,
        outcome: "could_not_run",
        reasonCode: "deps_not_installed",
        remediation: `${cwd} has a package.json but no node_modules — run the project's install step on this lane before validating.`,
      };
    }

    // It ran and exited non-zero: this is evidence about the code.
    return { ok: false, full: combined || message, outcome: "fail" };
  }
}

export function registerVerifyEditTools(server: McpServer, deps: VerifyEditDeps): void {
  server.registerTool(
    "verify_edit",
    {
      description:
        "After an edit, run the project's linter and/or tests and return structured pass/fail with failure payload for a continuation prompt. Each result carries an `outcome` of pass | fail | could_not_run | denied with a machine-readable `reasonCode`: 'could_not_run' means this lane could not execute the command (missing binary, missing node_modules, bad cwd, timeout) and is NOT evidence about the code, and carries a one-sentence `remediation`. Commands are split on whitespace and run as argv with no shell, so quoted arguments cannot be expressed (a denial with reasonCode 'hook_arg_pattern_blocked' says so in `remediation`). Output is captured in full, returned as a bounded head+tail view with secrets redacted, and the complete unredacted capture is kept at fullOutputPath when truncated. Shells out through the execution-policy gate.",
      inputSchema: {
        cwd: z.string().describe("Working directory for the commands"),
        lintCmd: z
          .string()
          .optional()
          .describe(
            "Lint command to run (e.g. 'npx eslint .'). Split on whitespace and run as argv — no shell, so quoted arguments are not supported."
          ),
        testCmd: z
          .string()
          .optional()
          .describe(
            "Test command to run (e.g. 'npm test'). Split on whitespace and run as argv — no shell, so quoted arguments are not supported."
          ),
        compactOptions: z
          .object({
            cap: z.number().optional().describe("Maximum output length in characters"),
            stripAnsi: z.boolean().optional().describe("Strip ANSI escape sequences"),
            collapseRepeats: z.boolean().optional().describe("Collapse repeated consecutive lines"),
          })
          .optional()
          .describe("If provided, compact command outputs using these options"),
      },
      annotations: toolAnnotations("verify_edit"),
    },
    async ({ cwd, lintCmd, testCmd, compactOptions }) => {
      const result: { lint: CmdResult | null; test: CmdResult | null; compacted?: string[] } = {
        lint: null,
        test: null,
      };

      const compactResults: string[] = [];

      /** Full capture -> caller compaction -> view cap -> artifact on overflow. */
      const toResult = (label: string, raw: RawRun): CmdResult => {
        // The classification travels with every result; `ok` is derived from it
        // so the two can never disagree.
        const classification = {
          ok: raw.outcome === "pass",
          outcome: raw.outcome,
          ...(raw.reasonCode !== undefined ? { reasonCode: raw.reasonCode } : {}),
          ...(raw.remediation !== undefined ? { remediation: raw.remediation } : {}),
        };

        if (raw.outcome === "denied") {
          return { ...classification, output: redactSecrets(raw.full), truncated: false };
        }

        // --- D3: the travelling copy is redacted, the local capture is not ---
        //
        // MANUAL §5: secrets are redacted from rendered lines, credential
        // LOCATIONS survive, values never do. That was enforced on supervisor
        // prompts and on the review diff but not here — even though lint and
        // test-runner stdout is the highest-variance untrusted text in the
        // system, and a failing DB test printing its DSN is the ordinary case,
        // not the exotic one. This `output` is embedded in continuation
        // prompts that travel to other lanes, so it is redacted.
        //
        // The tension is real and was adjudicated rather than split: redacting
        // a test failure can destroy the very diff the agent needs to repair
        // it. So the RAW capture stays on disk at `fullOutputPath` — local,
        // same trust level as the working tree, greppable for the assertion
        // diff — and only the copy that leaves this machine's process is
        // redacted. The path is 0700/0600 so "local" means local.
        //
        // Redaction runs BEFORE compaction on purpose: a secret that the view
        // cap cuts in half would otherwise pass a value-pattern matcher and
        // leak its first half. `redactSecrets` is called with no path — this
        // is command output, not a dotenv file, so the structural
        // redact-every-value pass must not fire.
        let text = redactSecrets(raw.full);
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
          return { ...classification, output: text, truncated: false };
        }

        // Keep the pre-compaction capture — the point of the artifact is that
        // the agent can grep what the view dropped.
        const fullOutputPath = writeFullOutputArtifact(label, raw.full);
        return fullOutputPath
          ? { ...classification, output: text, truncated: true, fullOutputPath }
          : { ...classification, output: text, truncated: true };
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
