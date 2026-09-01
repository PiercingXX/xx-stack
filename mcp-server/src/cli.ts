#!/usr/bin/env node

/**
 * xx — pipeable CLI surface over the xx-stack routing runtime.
 *
 * PRESENTATION LAYER ONLY. Every command calls the exact same runtime
 * functions the MCP tools call (routing_runtime.js, platform_runtime.js,
 * task_runtime.js, memory_runtime.js, observability_runtime.js,
 * task_list_runtime.js) — zero routing/task/memory logic is forked into this
 * file, so the CLI can never drift from MCP tool behavior. The claim was
 * briefly untrue: `summarizePlatforms`, `diagnoseHosts`, and `filterTasks` were
 * copy-pasted from the tool handlers (MCP-DUP-3) and are now shared modules.
 *
 * Conventions (unix-composable, agent-friendly):
 *   - stdout carries data; stderr carries diagnostics
 *   - exit codes: 0 ok / 1 user error / 2 server error / 5 write conflict
 *   - --json on every command (e.g. `xx platforms --json | jq`)
 *   - layered --help: top-level under 40 lines, per-command help beneath
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type { AgentMemoryScope } from "./config_runtime.js";
import { loadMergedAgentRuntimeConfig } from "./config_runtime.js";
import { resolveAgentContext } from "./agent_tool_helpers.js";
import {
  getCompletionMemorySyncStatus,
  syncAgentMemorySnapshot,
  type CompletionMemorySyncStatus,
} from "./memory_runtime.js";
import { diagnoseHosts, summarizePlatforms, type DiagnoseResult } from "./observability_runtime.js";
import type { RouteRecommendation } from "./platform_types.js";
import { loadRegistry } from "./platform_runtime.js";
import { routeTask } from "./routing_runtime.js";
import { StoreAccessError } from "./supervisor_store_runtime.js";
import { narrowTaskStoreToReady } from "./task_graph_runtime.js";
import { filterTasks, type TaskListFilters, type TaskListResult } from "./task_list_runtime.js";
import {
  readTaskStore,
  TASK_STATUS_VALUES,
  withTaskStoreLock,
  type TaskStatus,
} from "./task_runtime.js";

/**
 * Re-exported, not re-implemented. `xx platforms`, `xx diagnose`, and
 * `xx tasks list` used to carry their own copies of the list_platforms /
 * check_health / task_list shaping (MCP-DUP-3); the implementations now live in
 * the runtime modules the MCP tools import, and the CLI keeps a single public
 * surface by forwarding them.
 */
export { diagnoseHosts, filterTasks, summarizePlatforms };
export type { DiagnoseResult, TaskListFilters, TaskListResult };

// --- Exit codes (per convention) ---

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_SERVER = 2;
/**
 * Optimistic-concurrency precondition failed: the target changed under us and
 * nothing was written. Distinct from a server error because the caller's
 * remedy is mechanical (re-read, merge, retry), not diagnostic. Borrowed from
 * buzz-cli, where 5 is the write-conflict code.
 */
export const EXIT_CONFLICT = 5;

/** Thrown for user/usage errors — mapped to exit code 1. */
export class CliUsageError extends Error {}

/**
 * Thrown by any write command whose compare-and-swap precondition failed.
 * runCli emits `conflict` as JSON on stderr and exits EXIT_CONFLICT, so every
 * future write command inherits the convention for free.
 */
export class CliWriteConflictError extends Error {
  readonly conflict: Record<string, unknown>;

  constructor(conflict: Record<string, unknown>) {
    super("write conflict");
    this.name = "CliWriteConflictError";
    this.conflict = conflict;
  }
}

const MEMORY_SCOPES: readonly AgentMemoryScope[] = ["user", "project", "local"];

// --- Parsed command shapes ---

export type ParsedCommand =
  | { kind: "help"; topic?: string }
  | { kind: "route"; description: string; json: boolean }
  | { kind: "platforms"; json: boolean }
  | { kind: "diagnose"; json: boolean }
  | {
      kind: "tasks-list";
      json: boolean;
      status?: TaskStatus;
      tag?: string;
      owner?: string;
      includeCompleted: boolean;
      readyOnly: boolean;
      limit?: number;
    }
  | {
      kind: "memory-status";
      agentId: string;
      scope?: AgentMemoryScope;
      cwd?: string;
      json: boolean;
    }
  | {
      kind: "memory-apply";
      agentId: string;
      scope?: AgentMemoryScope;
      cwd?: string;
      expectHash?: string;
      json: boolean;
    };

const COMMANDS = ["route", "platforms", "diagnose", "tasks", "memory", "help"] as const;

const BASE_OPTIONS = {
  json: { type: "boolean" as const, default: false },
  help: { type: "boolean" as const, short: "h", default: false },
};

const TASKS_LIST_OPTIONS = {
  ...BASE_OPTIONS,
  status: { type: "string" as const },
  tag: { type: "string" as const },
  owner: { type: "string" as const },
  "include-completed": { type: "boolean" as const, default: false },
  "ready-only": { type: "boolean" as const, default: false },
  limit: { type: "string" as const },
};

const MEMORY_OPTIONS = {
  ...BASE_OPTIONS,
  agent: { type: "string" as const },
  scope: { type: "string" as const },
  cwd: { type: "string" as const },
  "expect-hash": { type: "string" as const },
};

function parseWith<T extends Record<string, unknown>>(
  args: string[],
  options: T
): { values: Record<string, string | boolean | undefined>; positionals: string[] } {
  try {
    // parseArgs throws TypeError on unknown/malformed options in strict mode.
    return parseArgs({
      args,
      // parseArgs's option typing is stricter than we need here.
      options: options as never,
      strict: true,
      allowPositionals: true,
    }) as { values: Record<string, string | boolean | undefined>; positionals: string[] };
  } catch (err) {
    throw new CliUsageError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Parse CLI argv (already stripped of node + script path) into a command.
 * Pure function — throws CliUsageError on user error.
 */
export function parseCliArgs(argv: string[]): ParsedCommand {
  if (argv.length === 0) return { kind: "help" };

  const command = argv[0];
  const rest = argv.slice(1);

  if (command === "-h" || command === "--help" || command === "help") {
    const topic = rest.find((a) => !a.startsWith("-"));
    if (topic !== undefined && !COMMANDS.includes(topic as (typeof COMMANDS)[number])) {
      throw new CliUsageError(`unknown help topic: "${topic}" (commands: ${COMMANDS.join(", ")})`);
    }
    return { kind: "help", topic };
  }

  switch (command) {
    case "route": {
      const { values, positionals } = parseWith(rest, BASE_OPTIONS);
      if (values.help === true) return { kind: "help", topic: "route" };
      const description = positionals.join(" ").trim();
      if (description.length === 0) {
        throw new CliUsageError(
          'route requires a task description (e.g. xx route "fix the tests")'
        );
      }
      return { kind: "route", description, json: values.json === true };
    }

    case "platforms": {
      const { values, positionals } = parseWith(rest, BASE_OPTIONS);
      if (values.help === true) return { kind: "help", topic: "platforms" };
      if (positionals.length > 0) {
        throw new CliUsageError(`platforms takes no arguments (got: ${positionals.join(" ")})`);
      }
      return { kind: "platforms", json: values.json === true };
    }

    case "diagnose": {
      const { values, positionals } = parseWith(rest, BASE_OPTIONS);
      if (values.help === true) return { kind: "help", topic: "diagnose" };
      if (positionals.length > 0) {
        throw new CliUsageError(`diagnose takes no arguments (got: ${positionals.join(" ")})`);
      }
      return { kind: "diagnose", json: values.json === true };
    }

    case "tasks": {
      const { values, positionals } = parseWith(rest, TASKS_LIST_OPTIONS);
      if (values.help === true) return { kind: "help", topic: "tasks" };
      const sub = positionals[0];
      if (sub === undefined) {
        throw new CliUsageError("tasks requires a subcommand (available: list)");
      }
      if (sub !== "list") {
        throw new CliUsageError(`unknown tasks subcommand: "${sub}" (available: list)`);
      }
      if (positionals.length > 1) {
        throw new CliUsageError(
          `tasks list takes no positional arguments (got: ${positionals.slice(1).join(" ")})`
        );
      }

      let status: TaskStatus | undefined;
      if (typeof values.status === "string") {
        if (!(TASK_STATUS_VALUES as readonly string[]).includes(values.status)) {
          throw new CliUsageError(
            `invalid --status "${values.status}" (valid: ${TASK_STATUS_VALUES.join(", ")})`
          );
        }
        status = values.status as TaskStatus;
      }

      let limit: number | undefined;
      if (typeof values.limit === "string") {
        const parsed = Number.parseInt(values.limit, 10);
        if (
          !Number.isInteger(parsed) ||
          parsed < 1 ||
          parsed > 500 ||
          String(parsed) !== values.limit
        ) {
          throw new CliUsageError(`invalid --limit "${values.limit}" (must be an integer 1-500)`);
        }
        limit = parsed;
      }

      return {
        kind: "tasks-list",
        json: values.json === true,
        status,
        tag: typeof values.tag === "string" ? values.tag : undefined,
        owner: typeof values.owner === "string" ? values.owner : undefined,
        includeCompleted: values["include-completed"] === true,
        readyOnly: values["ready-only"] === true,
        limit,
      };
    }

    case "memory": {
      const { values, positionals } = parseWith(rest, MEMORY_OPTIONS);
      if (values.help === true) return { kind: "help", topic: "memory" };
      const sub = positionals[0];
      if (sub === undefined) {
        throw new CliUsageError("memory requires a subcommand (available: status, apply)");
      }
      if (sub !== "status" && sub !== "apply") {
        throw new CliUsageError(`unknown memory subcommand: "${sub}" (available: status, apply)`);
      }
      if (positionals.length > 1) {
        throw new CliUsageError(
          `memory ${sub} takes no positional arguments (got: ${positionals.slice(1).join(" ")})`
        );
      }

      const agentId = typeof values.agent === "string" ? values.agent.trim() : "";
      if (agentId.length === 0) {
        throw new CliUsageError(`memory ${sub} requires --agent <id>`);
      }

      let scope: AgentMemoryScope | undefined;
      if (typeof values.scope === "string") {
        if (!(MEMORY_SCOPES as readonly string[]).includes(values.scope)) {
          throw new CliUsageError(
            `invalid --scope "${values.scope}" (valid: ${MEMORY_SCOPES.join(", ")})`
          );
        }
        scope = values.scope as AgentMemoryScope;
      }

      const cwd = typeof values.cwd === "string" ? values.cwd : undefined;
      const json = values.json === true;

      if (sub === "status") {
        if (typeof values["expect-hash"] === "string") {
          throw new CliUsageError("--expect-hash applies to write commands (try: memory apply)");
        }
        return { kind: "memory-status", agentId, scope, cwd, json };
      }

      const expectHash =
        typeof values["expect-hash"] === "string" ? values["expect-hash"].trim() : undefined;
      if (expectHash !== undefined && expectHash.length === 0) {
        throw new CliUsageError("--expect-hash requires a non-empty hash");
      }
      return { kind: "memory-apply", agentId, scope, cwd, expectHash, json };
    }

    default:
      throw new CliUsageError(`unknown command: "${command}" (commands: ${COMMANDS.join(", ")})`);
  }
}

// --- Help (layered: top-level short, per-command beneath) ---

export function helpText(): string {
  return [
    "xx — pipeable command surface over the xx-stack routing runtime",
    "",
    "Usage:",
    "  xx <command> [options]",
    "",
    "Commands:",
    "  route <description>   Recommend tier, host, and model for a task",
    "  platforms             List tiers, hosts, and selection policy from the registry",
    "  diagnose              Ping configured model endpoints and report health",
    "  tasks list            List persistent tasks (filters: --status --tag --owner)",
    "  memory status         Show agent memory/snapshot hashes and drift",
    "  memory apply          Apply SNAPSHOT.md over MEMORY.md (--expect-hash for CAS)",
    "",
    "Global options:",
    "  --json                Emit JSON on stdout (pipe-friendly: xx platforms --json | jq)",
    "  -h, --help            Show help; per-command detail via xx <command> --help",
    "",
    "Conventions:",
    "  stdout carries data; stderr carries diagnostics",
    "  exit codes: 0 ok / 1 user error / 2 server error / 5 write conflict",
    "  write conflicts print the conflict as JSON on stderr and write nothing",
  ].join("\n");
}

const COMMAND_HELP: Record<string, string> = {
  route: [
    "xx route <description> [--json]",
    "",
    "Recommend which platform tier, host, and model to use for a task.",
    "Calls the same routeTask() the route_task MCP tool calls.",
    "",
    "Options:",
    "  --json    Emit the full RouteRecommendation as JSON",
    "",
    "Examples:",
    '  xx route "fix the tests"',
    '  xx route --json "deep architectural analysis" | jq .recommendedHost',
  ].join("\n"),
  platforms: [
    "xx platforms [--json]",
    "",
    "List all platform tiers, hosts, and their configuration from the",
    "xx-stack registry (same data as the list_platforms MCP tool).",
    "",
    "Options:",
    "  --json    Emit { selectionPolicy, tiers } as JSON",
    "",
    "Example:",
    "  xx platforms --json | jq '.tiers[].hosts[].id'",
  ].join("\n"),
  diagnose: [
    "xx diagnose [--json]",
    "",
    "Ping every enabled HTTP endpoint in the registry and report",
    "reachability and latency (same checks as the check_health MCP tool).",
    "",
    "Options:",
    "  --json    Emit per-host results as a JSON array",
    "",
    "Example:",
    "  xx diagnose --json | jq '.[] | select(.status == \"unreachable\")'",
  ].join("\n"),
  tasks: [
    "xx tasks list [options]",
    "",
    "List persistent tasks from the task store (same store the task_list",
    "MCP tool reads). Terminal tasks (done/canceled) hidden by default.",
    "",
    "Options:",
    `  --status <s>           Filter by status (${TASK_STATUS_VALUES.join("|")})`,
    "  --tag <tag>            Filter by tag (case-insensitive)",
    "  --owner <owner>        Filter by owner (case-insensitive)",
    "  --include-completed    Include done and canceled tasks",
    "  --ready-only           Only tasks that can start now: every blockedBy",
    "                         entry is already terminal. A view, not a runner —",
    "                         xx-stack returns the schedule, it never runs it.",
    "  --limit <n>            Maximum tasks to return (1-500, default 100)",
    "  --json                 Emit { total, returned, tasks } as JSON",
  ].join("\n"),
  memory: [
    "xx memory status --agent <id> [options]",
    "xx memory apply  --agent <id> [--expect-hash <hash>] [options]",
    "",
    "status: report MEMORY.md / SNAPSHOT.md hashes and drift (same",
    "getCompletionMemorySyncStatus() the supervisor completion gate uses).",
    "",
    "apply: overwrite live MEMORY.md with SNAPSHOT.md via the same",
    "syncAgentMemorySnapshot() the agent_memory_snapshot_sync MCP tool calls.",
    "",
    "Options:",
    "  --agent <id>           Agent identifier (required)",
    `  --scope <s>            Memory scope (${MEMORY_SCOPES.join("|")}; default from agent config)`,
    "  --cwd <path>           Project root for project/local scope",
    "  --expect-hash <hash>   apply only: compare-and-swap on memoryHash from",
    "                         `xx memory status`. If MEMORY.md changed since,",
    "                         nothing is written, the conflict is printed as",
    "                         JSON on stderr, and xx exits 5.",
    "  --json                 Emit the runtime result as JSON",
    "",
    "Example (read, then conditionally write):",
    "  h=$(xx memory status --agent skippy --json | jq -r .memoryHash)",
    '  xx memory apply --agent skippy --expect-hash "$h" || test $? -eq 5',
  ].join("\n"),
  help: helpText(),
};

export function commandHelpText(topic: string): string {
  return COMMAND_HELP[topic] ?? helpText();
}

// --- Text formatters (human-readable; --json bypasses these) ---

export function formatRouteText(result: RouteRecommendation): string {
  const lines = [
    `tier:   ${result.recommendedTier}`,
    `host:   ${result.recommendedHost ?? "(none)"}`,
    `model:  ${result.recommendedModel ?? "(none)"}`,
    `reason: ${result.reasoning}`,
  ];
  if (result.fallback) lines.push(`fallback: ${result.fallback}`);
  return lines.join("\n");
}

export function formatPlatformsText(summary: ReturnType<typeof summarizePlatforms>): string {
  const lines: string[] = [];
  for (const tier of summary.tiers) {
    const t = tier as {
      id: string;
      label: string;
      priority: number;
      hosts: Array<{
        id: string;
        provider: string;
        endpoint: string;
        enabled: boolean;
        modelCount: number;
      }>;
    };
    lines.push(`${t.id} (priority ${t.priority}) — ${t.label}`);
    for (const host of t.hosts) {
      const state = host.enabled ? "enabled" : "disabled";
      lines.push(
        `  ${host.id}\t${host.provider}\t${host.endpoint}\t${state}\t${host.modelCount} models`
      );
    }
  }
  return lines.join("\n");
}

export function formatDiagnoseText(results: DiagnoseResult[]): string {
  return results
    .map((r) => {
      const latency = r.latencyMs !== undefined ? `\t${r.latencyMs}ms` : "";
      const reason = r.reason ? `\t(${r.reason})` : "";
      return `${r.tier}/${r.host}\t${r.status}${latency}${reason}`;
    })
    .join("\n");
}

export function formatMemoryStatusText(status: CompletionMemorySyncStatus): string {
  return [
    `memory:   ${status.memoryPath}`,
    `snapshot: ${status.snapshotPath}`,
    `memoryHash:   ${status.memoryHash}`,
    `snapshotHash: ${status.snapshotHash}`,
    `drift:    ${status.driftDetected ? "yes" : "no"}`,
    `diff:     +${status.diff.added} -${status.diff.removed} ~${status.diff.changed}`,
  ].join("\n");
}

export function formatTasksText(result: TaskListResult): string {
  return result.tasks
    .map((task) => {
      const priority = task.priority ? `\t[${task.priority}]` : "";
      return `${task.taskId}\t${task.status}${priority}\t${task.title}`;
    })
    .join("\n");
}

// --- Runner ---

interface Writer {
  write(text: string): unknown;
}

function emitJson(out: Writer, data: unknown): void {
  out.write(JSON.stringify(data, null, 2) + "\n");
}

/**
 * Execute a parsed CLI command against the runtime. Returns the exit code.
 * `out`/`err` are injectable for tests; defaults are process streams.
 */
export async function runCli(
  argv: string[],
  out: Writer = process.stdout,
  err: Writer = process.stderr
): Promise<number> {
  let parsed: ParsedCommand;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      err.write(`xx: ${error.message}\n`);
      err.write(`Run "xx --help" for usage.\n`);
      return EXIT_USAGE;
    }
    throw error;
  }

  try {
    switch (parsed.kind) {
      case "help": {
        out.write((parsed.topic ? commandHelpText(parsed.topic) : helpText()) + "\n");
        return EXIT_OK;
      }

      case "route": {
        const registry = await loadRegistry();
        const result = routeTask(parsed.description, registry);
        if (parsed.json) emitJson(out, result);
        else out.write(formatRouteText(result) + "\n");
        return EXIT_OK;
      }

      case "platforms": {
        const registry = await loadRegistry();
        const summary = summarizePlatforms(registry);
        if (parsed.json) emitJson(out, summary);
        else out.write(formatPlatformsText(summary) + "\n");
        return EXIT_OK;
      }

      case "diagnose": {
        const registry = await loadRegistry();
        const hostCount = registry.tiers.reduce((sum, tier) => sum + tier.hosts.length, 0);
        err.write(`xx: pinging ${hostCount} host(s)...\n`);
        const results = await diagnoseHosts(registry);
        if (parsed.json) emitJson(out, results);
        else out.write(formatDiagnoseText(results) + "\n");
        return EXIT_OK;
      }

      case "tasks-list": {
        // Bind now: `parsed` is a `let`, so narrowing would not survive
        // into the async closure below.
        const filters: TaskListFilters = {
          status: parsed.status,
          tag: parsed.tag,
          owner: parsed.owner,
          includeCompleted: parsed.includeCompleted,
          limit: parsed.limit,
        };
        const readyOnly = parsed.readyOnly;
        // Same lock + read path the task_list MCP tool uses, and the same two
        // shared runtime functions in the same order — narrowTaskStoreToReady
        // then filterTasks. MCP-DUP-3: the readiness rule is imported, never
        // re-expressed here.
        const result = await withTaskStoreLock(async () => {
          const store = await readTaskStore();
          return filterTasks(readyOnly ? narrowTaskStoreToReady(store) : store, filters);
        });
        if (parsed.json) emitJson(out, result);
        else {
          err.write(`xx: ${result.total} task(s), showing ${result.returned}\n`);
          out.write(formatTasksText(result) + "\n");
        }
        return EXIT_OK;
      }

      case "memory-status": {
        const runtime = await loadMergedAgentRuntimeConfig();
        const { resolvedScope, resolvedCwd } = resolveAgentContext(
          parsed.agentId,
          parsed.scope,
          parsed.cwd,
          runtime
        );
        // Same status helper the supervisor completion gate calls.
        const status = await getCompletionMemorySyncStatus({
          agentId: parsed.agentId,
          scope: resolvedScope,
          cwd: resolvedCwd,
        });
        if (parsed.json)
          emitJson(out, { agentId: parsed.agentId, scope: resolvedScope, ...status });
        else out.write(formatMemoryStatusText(status) + "\n");
        return EXIT_OK;
      }

      case "memory-apply": {
        const runtime = await loadMergedAgentRuntimeConfig();
        const { resolvedScope, resolvedCwd } = resolveAgentContext(
          parsed.agentId,
          parsed.scope,
          parsed.cwd,
          runtime
        );
        // Same runtime call the agent_memory_snapshot_sync MCP tool makes.
        const outcome = await syncAgentMemorySnapshot({
          agentId: parsed.agentId,
          scope: resolvedScope,
          cwd: resolvedCwd,
          direction: "apply",
          expectedHash: parsed.expectHash,
        });
        if (outcome.status === "write_conflict") {
          throw new CliWriteConflictError({
            agentId: parsed.agentId,
            scope: resolvedScope,
            ...outcome,
          });
        }
        if (parsed.json)
          emitJson(out, { agentId: parsed.agentId, scope: resolvedScope, ...outcome });
        else err.write(`xx: applied snapshot over ${outcome.memoryPath}\n`);
        return EXIT_OK;
      }
    }
  } catch (error) {
    // Compare-and-swap precondition failed: nothing was written. The conflict
    // goes to stderr as JSON (stdout stays clean for the caller's pipeline)
    // and the distinct exit code lets scripts branch on "re-read and retry".
    if (error instanceof CliWriteConflictError) {
      err.write(JSON.stringify(error.conflict, null, 2) + "\n");
      return EXIT_CONFLICT;
    }
    // A state file that exists but cannot be read or parsed (MCP-1). The store
    // readers throw rather than presenting themselves as empty, so without this
    // branch `xx tasks list` dumped a raw error through the generic handler
    // instead of the structured diagnostic the MCP tools return. Same payload
    // as the tools' `store_unavailable` result, on stderr so stdout stays clean
    // for the caller's pipeline, at the server-error exit code.
    if (error instanceof StoreAccessError) {
      err.write(JSON.stringify(error.toToolPayload(), null, 2) + "\n");
      return EXIT_SERVER;
    }
    const message = error instanceof Error ? error.message : String(error);
    err.write(`xx: server error: ${message}\n`);
    return EXIT_SERVER;
  }
}

// --- Direct execution guard (same realpath pattern as index.ts) ---

const isDirectExecution = ((): boolean => {
  if (!process.argv[1]) return false;
  const realOrSelf = (candidate: string): string => {
    try {
      return realpathSync(candidate);
    } catch {
      return resolve(candidate);
    }
  };
  return realOrSelf(process.argv[1]) === realOrSelf(fileURLToPath(import.meta.url));
})();

if (isDirectExecution) {
  runCli(process.argv.slice(2))
    .then((code) => {
      // exitCode (not process.exit) so pending stdout pipe writes flush.
      process.exitCode = code;
    })
    .catch((error) => {
      console.error("Fatal:", error);
      process.exitCode = EXIT_SERVER;
    });
}
