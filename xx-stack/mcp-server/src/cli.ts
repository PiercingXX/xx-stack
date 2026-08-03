#!/usr/bin/env node

/**
 * xx — pipeable CLI surface over the xx-stack routing runtime.
 *
 * PRESENTATION LAYER ONLY. Every command calls the exact same runtime
 * functions the MCP tools call (routing_runtime.js, platform_runtime.js,
 * task_runtime.js) — zero routing/task logic is forked into this file,
 * so the CLI can never drift from MCP tool behavior.
 *
 * Conventions (unix-composable, agent-friendly):
 *   - stdout carries data; stderr carries diagnostics
 *   - exit codes: 0 ok / 1 user error / 2 server error
 *   - --json on every command (e.g. `xx platforms --json | jq`)
 *   - layered --help: top-level under 40 lines, per-command help beneath
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type { Host, Registry, RouteRecommendation } from "./platform_types.js";
import { loadRegistry } from "./platform_runtime.js";
import { endpointFamilyForHost, pingHostEndpoint, routeTask } from "./routing_runtime.js";
import {
  readTaskStore,
  TASK_STATUS_VALUES,
  TASK_TERMINAL_STATUSES,
  withTaskStoreLock,
  type PersistentTask,
  type TaskStatus,
  type TaskStore,
} from "./task_runtime.js";

// --- Exit codes (per convention) ---

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_SERVER = 2;

/** Thrown for user/usage errors — mapped to exit code 1. */
export class CliUsageError extends Error {}

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
      limit?: number;
    };

const COMMANDS = ["route", "platforms", "diagnose", "tasks", "help"] as const;

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
  limit: { type: "string" as const },
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
        limit,
      };
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
    "",
    "Global options:",
    "  --json                Emit JSON on stdout (pipe-friendly: xx platforms --json | jq)",
    "  -h, --help            Show help; per-command detail via xx <command> --help",
    "",
    "Conventions:",
    "  stdout carries data; stderr carries diagnostics",
    "  exit codes: 0 ok / 1 user error / 2 server error",
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
    "  --limit <n>            Maximum tasks to return (1-500, default 100)",
    "  --json                 Emit { total, returned, tasks } as JSON",
  ].join("\n"),
  help: helpText(),
};

export function commandHelpText(topic: string): string {
  return COMMAND_HELP[topic] ?? helpText();
}

// --- Output shaping (presentation only) ---

/**
 * Shape the registry into the exact summary the list_platforms MCP tool
 * returns, so `xx platforms --json` and the tool stay interchangeable.
 */
export function summarizePlatforms(registry: Registry): {
  selectionPolicy: Registry["selectionPolicy"];
  tiers: Array<Record<string, unknown>>;
} {
  const tiers = registry.tiers.map((tier) => ({
    id: tier.id,
    label: tier.label,
    priority: tier.priority,
    usageGuidance: tier.usageGuidance,
    hosts: tier.hosts.map((host) => ({
      id: host.id,
      label: host.label,
      provider: host.provider,
      endpoint: host.endpoint,
      enabled: host.enabled !== false,
      modelCount: (host.models ?? []).length,
      executionPolicy: host.executionPolicy ?? {},
      hardware: host.hardware ?? {},
      preferredTasks: host.delegationPolicy?.preferredTaskTypes ?? [],
    })),
  }));
  return { selectionPolicy: registry.selectionPolicy, tiers };
}

export interface DiagnoseResult {
  tier: string;
  host: string;
  status: "disabled" | "skipped" | "healthy" | "unreachable";
  endpoint?: string;
  provider?: string;
  endpointFamily?: string;
  latencyMs?: number;
  reason?: string;
}

/**
 * Ping every host in the registry — same disabled/non-HTTP/ping shaping
 * as the check_health MCP tool. `ping` is injectable for tests; the CLI
 * passes the real pingHostEndpoint from routing_runtime.
 */
export async function diagnoseHosts(
  registry: Registry,
  ping: (host: Host) => Promise<{ ok: boolean; latencyMs: number }> = pingHostEndpoint
): Promise<DiagnoseResult[]> {
  const allHosts = registry.tiers.flatMap((tier) => tier.hosts.map((host) => ({ tier, host })));
  return Promise.all(
    allHosts.map(async ({ tier, host }): Promise<DiagnoseResult> => {
      if (host.enabled === false) {
        return { tier: tier.id, host: host.id, status: "disabled" };
      }
      if (!host.endpoint.startsWith("http://") && !host.endpoint.startsWith("https://")) {
        return { tier: tier.id, host: host.id, status: "skipped", reason: "not an HTTP endpoint" };
      }
      const result = await ping(host);
      return {
        tier: tier.id,
        host: host.id,
        endpoint: host.endpoint,
        provider: host.provider,
        endpointFamily: endpointFamilyForHost(host),
        status: result.ok ? "healthy" : "unreachable",
        latencyMs: result.latencyMs,
      };
    })
  );
}

export interface TaskListFilters {
  status?: TaskStatus;
  tag?: string;
  owner?: string;
  includeCompleted?: boolean;
  limit?: number;
}

export interface TaskListResult {
  total: number;
  returned: number;
  tasks: PersistentTask[];
}

/**
 * Filter/sort the task store — exact mirror of the task_list MCP tool's
 * shaping (status/tag/owner filters, terminal statuses hidden by default,
 * newest-updated first, default cap 100).
 */
export function filterTasks(store: TaskStore, filters: TaskListFilters): TaskListResult {
  const tagFilter = filters.tag?.trim().toLowerCase();
  const ownerFilter = filters.owner?.trim().toLowerCase();

  const tasks = Object.values(store.tasks)
    .filter((task) => !filters.status || task.status === filters.status)
    .filter((task) => filters.includeCompleted === true || !TASK_TERMINAL_STATUSES.has(task.status))
    .filter(
      (task) => !tagFilter || task.tags.some((taskTag) => taskTag.toLowerCase() === tagFilter)
    )
    .filter((task) => !ownerFilter || (task.owner ?? "").toLowerCase() === ownerFilter)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  const capped = tasks.slice(0, filters.limit ?? 100);
  return { total: tasks.length, returned: capped.length, tasks: capped };
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
        // Same lock + read path the task_list MCP tool uses.
        const result = await withTaskStoreLock(async () =>
          filterTasks(await readTaskStore(), filters)
        );
        if (parsed.json) emitJson(out, result);
        else {
          err.write(`xx: ${result.total} task(s), showing ${result.returned}\n`);
          out.write(formatTasksText(result) + "\n");
        }
        return EXIT_OK;
      }
    }
  } catch (error) {
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
