import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  asRecord,
  getRepoConfigPath,
  getUserConfigPath,
  readJson,
  toPositiveNumber,
  toStringArray,
} from "./config_runtime.js";

const execFileAsync = promisify(execFile);
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

export async function loadLifecycleHooksConfig(): Promise<LifecycleHooksConfig> {
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

export async function guardedExecFile(
  command: string,
  args: string[],
  options: { timeout?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {},
  guard: { context: ExecValidationContext; allowedHookCommands?: string[] }
): Promise<{ stdout: string; stderr: string }> {
  const validation = validateExecRequest(
    command,
    args,
    guard.context,
    guard.allowedHookCommands ?? []
  );
  if (!validation.allowed) {
    throw new Error(`execution_policy_denied:${validation.reason}`);
  }
  return execFileAsync(command, args, options);
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
      const blocked = {
        command: hook.command,
        args: hook.args,
        status: "blocked",
        reason: validation.reason,
      };
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
        throw new Error(`lifecycle_hook_failed:${hook.command}:${message}`);
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
