import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  asRecord,
  getRepoConfigPath,
  getUserConfigPath,
  readJson,
  toPositiveNumber,
  toStringArray,
} from "./config_runtime.js";

const MAX_EXEC_ARG_COUNT = 32;
const MAX_EXEC_ARG_LENGTH = 1024;
const SAFE_HOOK_ARG_PATTERN = /^[a-zA-Z0-9_./:@%+=,-]+$/;
export const INTERNAL_VRAM_PROBE =
  "cat /sys/class/drm/card*/device/mem_info_vram_total 2>/dev/null";

interface LifecycleHookSpec {
  command: string;
  args: string[];
  timeoutMs: number;
  cwd?: string;
  allowFailure: boolean;
}

interface LifecycleHooksConfig {
  enabled: boolean;
  allowedCommands: string[];
  events: Record<string, LifecycleHookSpec[]>;
  sources: { repoPath: string; userPath: string };
}

type ExecValidationContext = "internal" | "hook";

interface ExecValidationResult {
  allowed: boolean;
  reason: string;
  /** The denylist pattern that matched, when reason is "dangerous_command_blocked". */
  pattern?: string;
}

// --- Catastrophic-command denylist -----------------------------------------
//
// Canonical source: runtime/dangerous-patterns.txt — one POSIX-ERE
// per line, '#' comments. Evaluated AHEAD of the allowlist so a listed
// pattern is rejected even for an otherwise-allowlisted command.
//
// This is a seatbelt against accidents, not a sandbox against a malicious
// agent: it only stops the common catastrophic slips (rm -rf /, dd onto a
// disk, fork bombs, curl|sh, git push --force, repo deletion).
//
// Fail-open contract: a missing or partially unparseable pattern file must
// never brick the server. Unreadable file -> empty denylist; broken lines ->
// skipped. Both are flagged via parseErrors/loaded and logged to stderr.

export interface DangerousPattern {
  source: string;
  regex: RegExp;
}

export interface DangerousPatternsLoadResult {
  patterns: DangerousPattern[];
  parseErrors: string[];
  sourcePath: string | null;
  loaded: boolean;
}

// Resolved relative to this module (dist/ at runtime), mirroring the
// runtime-constants.json candidate chain in runtime_constants.ts.
const DANGEROUS_PATTERNS_CANDIDATES = [
  "../dangerous-patterns.txt",
  "../../runtime/dangerous-patterns.txt",
  "../../opencode/dangerous-patterns.txt",
] as const;

export function parseDangerousPatterns(text: string): {
  patterns: DangerousPattern[];
  parseErrors: string[];
} {
  const patterns: DangerousPattern[] = [];
  const parseErrors: string[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    try {
      patterns.push({ source: line, regex: new RegExp(line) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      parseErrors.push(`line ${index + 1}: ${message}`);
    }
  }
  return { patterns, parseErrors };
}

export function loadDangerousPatternsFromFile(filePath: string): DangerousPatternsLoadResult {
  try {
    const text = readFileSync(filePath, "utf8");
    const { patterns, parseErrors } = parseDangerousPatterns(text);
    return { patterns, parseErrors, sourcePath: filePath, loaded: true };
  } catch (error) {
    // Fail-open: an unreadable pattern file yields an empty denylist, flagged.
    const message = error instanceof Error ? error.message : String(error);
    return { patterns: [], parseErrors: [message], sourcePath: filePath, loaded: false };
  }
}

let cachedDenylist: DangerousPatternsLoadResult | null = null;

/**
 * Resolve the first existing candidate pattern file to a real filesystem path.
 *
 * `fileURLToPath`, never `url.pathname`: pathname is percent-encoded, so an
 * install path containing a space, `#`, or any non-ASCII byte would hand
 * `readFileSync` a literal `%20`/`%23` that does not exist — and
 * `loadDangerousPatternsFromFile` fails open to an EMPTY denylist, killing the
 * catastrophic-command layer on exactly the hosts where the file is present.
 * It also strips the leading slash a Windows drive letter carries
 * (`/C:/...` -> `C:\...`).
 *
 * @param baseUrl module URL the candidates resolve against; injectable for tests.
 */
export function resolveDangerousPatternsFile(baseUrl: string = import.meta.url): string | null {
  for (const candidate of DANGEROUS_PATTERNS_CANDIDATES) {
    const url = new URL(candidate, baseUrl);
    if (existsSync(url)) {
      return fileURLToPath(url);
    }
  }
  return null;
}

function loadDenylist(): DangerousPatternsLoadResult {
  const override = process.env.XX_STACK_DANGEROUS_PATTERNS_FILE;
  if (override && override.trim().length > 0) {
    return loadDangerousPatternsFromFile(override.trim());
  }
  const resolved = resolveDangerousPatternsFile();
  if (resolved !== null) {
    return loadDangerousPatternsFromFile(resolved);
  }
  // Fail-open: no pattern file found — deny layer inert, flagged as not loaded.
  return {
    patterns: [],
    parseErrors: ["dangerous-patterns.txt not found next to runtime/ or opencode/"],
    sourcePath: null,
    loaded: false,
  };
}

export function getDangerousPatternsStatus(): DangerousPatternsLoadResult {
  if (cachedDenylist === null) {
    cachedDenylist = loadDenylist();
    if (!cachedDenylist.loaded || cachedDenylist.parseErrors.length > 0) {
      // stderr only — stdout carries the MCP protocol.
      console.error(
        `xx-stack execution_policy: dangerous-pattern denylist degraded (fail-open). ` +
          `loaded=${cachedDenylist.loaded} source=${cachedDenylist.sourcePath ?? "none"} ` +
          `errors=${JSON.stringify(cachedDenylist.parseErrors)}`
      );
    }
  }
  return cachedDenylist;
}

/** Test-only: force the denylist to be re-read on next use. */
export function resetDangerousPatternsCache(): void {
  cachedDenylist = null;
}

export function findDangerousPattern(
  commandLine: string,
  patterns: DangerousPattern[] = getDangerousPatternsStatus().patterns
): string | null {
  for (const pattern of patterns) {
    if (pattern.regex.test(commandLine)) {
      return pattern.source;
    }
  }
  return null;
}

function parseLifecycleHookSpecs(rawHooks: unknown): Record<string, LifecycleHookSpec[]> {
  const source = asRecord(rawHooks);
  const parsed: Record<string, LifecycleHookSpec[]> = {};

  for (const [eventName, eventHooks] of Object.entries(source)) {
    if (!Array.isArray(eventHooks)) continue;
    const specs: LifecycleHookSpec[] = [];

    for (const rawSpec of eventHooks) {
      const specRecord = asRecord(rawSpec);
      const command = typeof specRecord.command === "string" ? specRecord.command.trim() : "";
      if (!command) continue;
      const args = toStringArray(specRecord.args).slice(0, MAX_EXEC_ARG_COUNT);
      const timeoutMs = Math.min(
        120_000,
        Math.max(500, Math.floor(toPositiveNumber(specRecord.timeoutMs, 5_000)))
      );
      const cwd = typeof specRecord.cwd === "string" ? specRecord.cwd.trim() : "";
      const allowFailure =
        typeof specRecord.allowFailure === "boolean" ? specRecord.allowFailure : true;
      specs.push({
        command,
        args,
        timeoutMs,
        cwd: cwd.length > 0 ? cwd : undefined,
        allowFailure,
      });
    }

    if (specs.length > 0) {
      parsed[eventName] = specs;
    }
  }

  return parsed;
}

function parseLifecycleHooksConfigFromRoot(root: Record<string, unknown> | null): {
  enabled: boolean | undefined;
  allowedCommands: string[];
  events: Record<string, LifecycleHookSpec[]>;
} {
  if (!root) {
    return { enabled: undefined, allowedCommands: [], events: {} };
  }
  const lifecycleHooks = asRecord(root.lifecycleHooks);
  return {
    enabled: typeof lifecycleHooks.enabled === "boolean" ? lifecycleHooks.enabled : undefined,
    allowedCommands: toStringArray(lifecycleHooks.allowedCommands),
    events: parseLifecycleHookSpecs(lifecycleHooks.events),
  };
}

async function loadLifecycleHooksConfig(): Promise<LifecycleHooksConfig> {
  const repoPath = getRepoConfigPath();
  const userPath = getUserConfigPath();
  const [repoRoot, userRoot] = await Promise.all([readJson(repoPath), readJson(userPath)]);
  const repoConfig = parseLifecycleHooksConfigFromRoot(repoRoot);
  const userConfig = parseLifecycleHooksConfigFromRoot(userRoot);
  const enabled = userConfig.enabled ?? repoConfig.enabled ?? false;
  const allowedCommands = [
    ...new Set([
      ...repoConfig.allowedCommands.map((value) => value.trim()).filter(Boolean),
      ...userConfig.allowedCommands.map((value) => value.trim()).filter(Boolean),
    ]),
  ];

  const events: Record<string, LifecycleHookSpec[]> = {};
  const eventNames = new Set([
    ...Object.keys(repoConfig.events),
    ...Object.keys(userConfig.events),
  ]);
  for (const eventName of eventNames) {
    events[eventName] = [
      ...(repoConfig.events[eventName] ?? []),
      ...(userConfig.events[eventName] ?? []),
    ];
  }

  return {
    enabled,
    allowedCommands,
    events,
    sources: { repoPath, userPath },
  };
}

export function validateExecRequest(
  command: string,
  args: string[],
  context: ExecValidationContext,
  allowedHookCommands: string[] = []
): ExecValidationResult {
  const normalizedCommand = command.trim();
  if (!normalizedCommand) {
    return { allowed: false, reason: "empty_command" };
  }

  // Deny layer runs AHEAD of the allowlist: a catastrophic pattern is
  // rejected even for an otherwise-allowlisted command.
  const commandLine = [normalizedCommand, ...args].join(" ");
  const dangerousPattern = findDangerousPattern(commandLine);
  if (dangerousPattern !== null) {
    return {
      allowed: false,
      reason: "dangerous_command_blocked",
      pattern: dangerousPattern,
    };
  }

  if (args.length > MAX_EXEC_ARG_COUNT) {
    return { allowed: false, reason: "too_many_args" };
  }

  if (args.some((arg) => arg.length > MAX_EXEC_ARG_LENGTH)) {
    return { allowed: false, reason: "arg_too_long" };
  }

  if (context === "internal") {
    if (normalizedCommand === "free") {
      return args.length === 1 && args[0] === "-b"
        ? { allowed: true, reason: "ok" }
        : { allowed: false, reason: "internal_free_args_invalid" };
    }
    if (normalizedCommand === "lspci") {
      return args.length === 0
        ? { allowed: true, reason: "ok" }
        : { allowed: false, reason: "internal_lspci_args_invalid" };
    }
    if (normalizedCommand === "bash") {
      return args.length === 2 && args[0] === "-c" && args[1] === INTERNAL_VRAM_PROBE
        ? { allowed: true, reason: "ok" }
        : { allowed: false, reason: "internal_bash_args_invalid" };
    }
    return { allowed: false, reason: "internal_command_not_allowlisted" };
  }

  const allowlist = new Set(allowedHookCommands.map((entry) => entry.trim()).filter(Boolean));
  if (!allowlist.has(normalizedCommand)) {
    return { allowed: false, reason: "hook_command_not_allowlisted" };
  }

  if (args.some((arg) => !SAFE_HOOK_ARG_PATTERN.test(arg))) {
    return { allowed: false, reason: "hook_arg_pattern_blocked" };
  }

  return { allowed: true, reason: "ok" };
}

// --- Guarded subprocess execution ------------------------------------------
//
// Doctrine (borrowed from buzz-dev-mcp): ephemeral processes, process-group
// kill on EVERY exit path, bounded capture.
//
// Node's execFile() timeout signals only the direct child, so a command that
// forks workers (any real test runner) strands grandchildren that keep eating
// a lane after the gate has given up. We therefore spawn detached on POSIX —
// which makes the child a process-group leader with pgid === pid — and tear
// the whole group down with kill(-pid) using a SIGTERM-then-SIGKILL grace
// period on timeout, spawn error, abort, AND normal completion (a command can
// exit 0 while leaving background children behind).
//
// Windows has no process groups: detached there would pop a console window,
// so we degrade cleanly to signalling the direct child, i.e. today's behavior.

/** Hard cap on captured stdout+stderr per guarded exec. Beyond this the
 *  streams are still drained (so the child never blocks) but not retained. */
export const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;

/** Grace between SIGTERM and SIGKILL when tearing a process group down. */
const KILL_GRACE_MS = 2_000;

/** POSIX gets real process groups; Windows does not. */
const SUPPORTS_PROCESS_GROUPS = process.platform !== "win32";

export interface GuardedExecOptions {
  timeout?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Optional cancellation. Aborting tears the process group down too. */
  signal?: AbortSignal;
}

/** Error shape mirrors what promisify(execFile) rejected with, so callers that
 *  read err.stdout / err.stderr / err.code keep working unchanged. */
interface GuardedExecError extends Error {
  code?: number | string | null;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
  cmd?: string;
}

function captureCapMarker(): string {
  return `\n... [capture cap reached: output beyond ${MAX_CAPTURE_BYTES} bytes dropped] ...\n`;
}

function runGuardedProcess(
  command: string,
  args: string[],
  options: GuardedExecOptions
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const detached = SUPPORTS_PROCESS_GROUPS;
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        detached,
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let capturedBytes = 0;
    let cappedStream: "stdout" | "stderr" | null = null;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceSettleTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const collect = (which: "stdout" | "stderr", chunks: Buffer[], chunk: Buffer): void => {
      if (cappedStream !== null) return;
      const remaining = MAX_CAPTURE_BYTES - capturedBytes;
      if (chunk.length >= remaining) {
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        capturedBytes = MAX_CAPTURE_BYTES;
        cappedStream = which;
        return;
      }
      chunks.push(chunk);
      capturedBytes += chunk.length;
    };

    /** Signal the whole group on POSIX, the direct child elsewhere.
     *  Returns true when something was actually signalled. */
    const signalGroup = (signal: NodeJS.Signals): boolean => {
      const pid = child.pid;
      if (pid === undefined) return false;
      if (detached) {
        try {
          process.kill(-pid, signal);
          return true;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          // ESRCH: the group is already empty — nothing left to reap.
          if (code === "ESRCH") return false;
          // Anything else (EPERM): fall through to the direct-child kill.
        }
      }
      try {
        return child.kill(signal);
      } catch {
        return false;
      }
    };

    const terminateGroup = (): void => {
      if (!signalGroup("SIGTERM")) return;
      if (killTimer) return;
      killTimer = setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };

    const onAbort = (): void => {
      aborted = true;
      terminateGroup();
      scheduleForceSettle();
    };

    const detachAbort = (): void => {
      options.signal?.removeEventListener("abort", onAbort);
    };

    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      detachAbort();
      // Every exit path sweeps the group; killTimer intentionally survives so
      // the SIGKILL escalation still lands on stragglers.
      terminateGroup();
      action();
    };

    const buildOutput = (): { stdout: string; stderr: string } => {
      const marker = cappedStream === null ? "" : captureCapMarker();
      return {
        stdout:
          Buffer.concat(stdoutChunks).toString("utf8") + (cappedStream === "stdout" ? marker : ""),
        stderr:
          Buffer.concat(stderrChunks).toString("utf8") + (cappedStream === "stderr" ? marker : ""),
      };
    };

    const failure = (
      message: string,
      code: number | string | null | undefined,
      signal: NodeJS.Signals | null,
      killed: boolean
    ): GuardedExecError => {
      const { stdout, stderr } = buildOutput();
      const error: GuardedExecError = new Error(message);
      error.code = code;
      error.signal = signal;
      error.killed = killed;
      error.stdout = stdout;
      error.stderr = stderr;
      error.cmd = [command, ...args].join(" ");
      return error;
    };

    /** If the group refuses to die, do not hang the lane waiting for stdio. */
    const scheduleForceSettle = (): void => {
      if (forceSettleTimer) return;
      forceSettleTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(() =>
          reject(
            failure(
              aborted
                ? `guarded_exec_aborted: ${command}`
                : `Command failed: ${[command, ...args].join(" ")}`,
              null,
              "SIGKILL",
              true
            )
          )
        );
      }, KILL_GRACE_MS * 2);
      forceSettleTimer.unref();
    };

    child.stdout?.on("data", (chunk: Buffer) => collect("stdout", stdoutChunks, chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect("stderr", stderrChunks, chunk));
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});

    if (options.timeout && options.timeout > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminateGroup();
        scheduleForceSettle();
      }, options.timeout);
      timeoutTimer.unref();
    }

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.on("error", (error) => {
      settle(() => reject(error));
    });

    child.on("close", (code, signal) => {
      settle(() => {
        const commandLine = [command, ...args].join(" ");
        if (aborted) {
          reject(failure(`guarded_exec_aborted: ${commandLine}`, code ?? null, signal, true));
          return;
        }
        // A clean exit always wins, even when the timeout fired moments
        // earlier: the child finished its work before the teardown mattered,
        // and reporting a timeout here would discard good output. Only an
        // actually-signalled close is classified as a timeout.
        if (code === 0 && signal === null) {
          resolve(buildOutput());
          return;
        }
        if (timedOut) {
          reject(
            failure(`Command failed: ${commandLine}`, code ?? null, signal ?? "SIGTERM", true)
          );
          return;
        }
        const { stderr } = buildOutput();
        reject(
          failure(
            `Command failed: ${commandLine}\n${stderr}`,
            code ?? signal ?? null,
            signal,
            signal !== null
          )
        );
      });
    });
  });
}

export async function guardedExecFile(
  command: string,
  args: string[],
  options: GuardedExecOptions = {},
  guard: { context: ExecValidationContext; allowedHookCommands?: string[] }
): Promise<{ stdout: string; stderr: string }> {
  const validation = validateExecRequest(
    command,
    args,
    guard.context,
    guard.allowedHookCommands ?? []
  );
  if (!validation.allowed) {
    const detail = validation.pattern ? `:${validation.pattern}` : "";
    throw new Error(`execution_policy_denied:${validation.reason}${detail}`);
  }
  // Policy gate above is unchanged; everything below is the hardened runner.
  return runGuardedProcess(command, args, options);
}

export async function emitLifecycleHooks(
  eventName: string,
  payload: Record<string, unknown>
): Promise<{
  enabled: boolean;
  eventName: string;
  configuredHookCount: number;
  executedHookCount: number;
  blockedHookCount: number;
  failedHookCount: number;
  results: Array<Record<string, unknown>>;
}> {
  const config = await loadLifecycleHooksConfig();
  const hooks = config.events[eventName] ?? [];

  if (!config.enabled || hooks.length === 0) {
    return {
      enabled: config.enabled,
      eventName,
      configuredHookCount: hooks.length,
      executedHookCount: 0,
      blockedHookCount: 0,
      failedHookCount: 0,
      results: [],
    };
  }

  const results: Array<Record<string, unknown>> = [];
  let executedHookCount = 0;
  let blockedHookCount = 0;
  let failedHookCount = 0;

  for (const hook of hooks) {
    const validation = validateExecRequest(hook.command, hook.args, "hook", config.allowedCommands);
    if (!validation.allowed) {
      blockedHookCount += 1;
      const blocked: Record<string, unknown> = {
        command: hook.command,
        args: hook.args,
        status: "blocked",
        reason: validation.reason,
      };
      if (validation.pattern) {
        blocked.pattern = validation.pattern;
      }
      results.push(blocked);
      if (!hook.allowFailure) {
        throw new Error(`lifecycle_hook_blocked:${hook.command}:${validation.reason}`);
      }
      continue;
    }

    try {
      const startedAt = Date.now();
      const hookEnv: NodeJS.ProcessEnv = {
        ...process.env,
        XX_STACK_HOOK_EVENT: eventName,
        XX_STACK_HOOK_SESSION_ID: String(payload.sessionId ?? ""),
        XX_STACK_HOOK_TASK_ID: String(payload.taskId ?? ""),
      };
      const { stdout, stderr } = await guardedExecFile(
        hook.command,
        hook.args,
        { timeout: hook.timeoutMs, cwd: hook.cwd, env: hookEnv },
        { context: "hook", allowedHookCommands: config.allowedCommands }
      );
      executedHookCount += 1;
      results.push({
        command: hook.command,
        args: hook.args,
        status: "ok",
        durationMs: Date.now() - startedAt,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    } catch (error) {
      failedHookCount += 1;
      const message = error instanceof Error ? error.message : String(error);
      const failed = {
        command: hook.command,
        args: hook.args,
        status: "failed",
        error: message,
      };
      results.push(failed);
      if (!hook.allowFailure) {
        throw new Error(`lifecycle_hook_failed:${hook.command}:${message}`, { cause: error });
      }
    }
  }

  return {
    enabled: true,
    eventName,
    configuredHookCount: hooks.length,
    executedHookCount,
    blockedHookCount,
    failedHookCount,
    results,
  };
}
