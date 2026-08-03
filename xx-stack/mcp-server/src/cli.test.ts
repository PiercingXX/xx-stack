import test from "node:test";
import assert from "node:assert/strict";

import {
  CliUsageError,
  commandHelpText,
  diagnoseHosts,
  EXIT_OK,
  EXIT_SERVER,
  EXIT_USAGE,
  filterTasks,
  formatDiagnoseText,
  formatPlatformsText,
  formatRouteText,
  formatTasksText,
  helpText,
  parseCliArgs,
  summarizePlatforms,
} from "./cli.js";
import type { Registry, RouteRecommendation } from "./platform_types.js";
import type { PersistentTask, TaskStore } from "./task_runtime.js";

// --- Fixtures ---

function buildRegistry(): Registry {
  return {
    version: 1,
    selectionPolicy: {
      defaultOrder: ["local", "tailscale-ollama"],
      rules: [],
    },
    tiers: [
      {
        id: "local",
        label: "Local",
        priority: 1,
        usageGuidance: "prefer for code",
        hosts: [
          {
            id: "workstation",
            label: "Workstation",
            provider: "ollama",
            endpoint: "http://workstation:11434",
            enabled: true,
            models: ["qwen2.5-coder:14b", "qwen3-coder:30b"],
            executionPolicy: { maxParallelSlices: 2 },
            delegationPolicy: { preferredTaskTypes: ["code"] },
          },
          {
            id: "disabled-box",
            label: "Disabled box",
            provider: "ollama",
            endpoint: "http://disabled:11434",
            enabled: false,
            models: [],
          },
        ],
      },
      {
        id: "tailscale-ollama",
        label: "Tailscale Ollama",
        priority: 2,
        hosts: [
          {
            id: "cli-host",
            label: "CLI host",
            provider: "custom",
            endpoint: "ssh://not-http",
            enabled: true,
            models: [],
          },
        ],
      },
    ],
  } as Registry;
}

function makeTask(overrides: Partial<PersistentTask>): PersistentTask {
  return {
    taskId: "task-x",
    title: "untitled",
    status: "todo",
    tags: [],
    blockedBy: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function buildTaskStore(): TaskStore {
  return {
    version: 1,
    tasks: {
      "task-a": makeTask({
        taskId: "task-a",
        title: "Fix the tests",
        status: "in_progress",
        tags: ["ci"],
        owner: "skippy",
        priority: "high",
        updatedAt: "2026-02-01T00:00:00.000Z",
      }),
      "task-b": makeTask({
        taskId: "task-b",
        title: "Old finished work",
        status: "done",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
      "task-c": makeTask({
        taskId: "task-c",
        title: "Write docs",
        status: "todo",
        tags: ["docs"],
        updatedAt: "2026-01-15T00:00:00.000Z",
      }),
    },
  };
}

// --- parseCliArgs: commands and flags ---

test("parseCliArgs: no args yields top-level help", () => {
  assert.deepEqual(parseCliArgs([]), { kind: "help" });
});

test("parseCliArgs: --help and help command yield help", () => {
  assert.equal(parseCliArgs(["--help"]).kind, "help");
  assert.equal(parseCliArgs(["-h"]).kind, "help");
  assert.equal(parseCliArgs(["help"]).kind, "help");
});

test("parseCliArgs: help with a topic carries the topic", () => {
  const parsed = parseCliArgs(["help", "route"]);
  assert.deepEqual(parsed, { kind: "help", topic: "route" });
});

test("parseCliArgs: help with an unknown topic is a usage error", () => {
  assert.throws(() => parseCliArgs(["help", "bogus"]), CliUsageError);
});

test("parseCliArgs: route joins positionals into a description", () => {
  const parsed = parseCliArgs(["route", "fix", "the", "tests"]);
  assert.deepEqual(parsed, { kind: "route", description: "fix the tests", json: false });
});

test("parseCliArgs: route accepts a single quoted description with --json", () => {
  const parsed = parseCliArgs(["route", "--json", "fix the tests"]);
  assert.deepEqual(parsed, { kind: "route", description: "fix the tests", json: true });
});

test("parseCliArgs: route without a description is a usage error", () => {
  assert.throws(() => parseCliArgs(["route"]), CliUsageError);
  assert.throws(() => parseCliArgs(["route", "--json"]), CliUsageError);
});

test("parseCliArgs: route --help yields command help", () => {
  assert.deepEqual(parseCliArgs(["route", "--help"]), { kind: "help", topic: "route" });
});

test("parseCliArgs: platforms and diagnose parse with and without --json", () => {
  assert.deepEqual(parseCliArgs(["platforms"]), { kind: "platforms", json: false });
  assert.deepEqual(parseCliArgs(["platforms", "--json"]), { kind: "platforms", json: true });
  assert.deepEqual(parseCliArgs(["diagnose"]), { kind: "diagnose", json: false });
  assert.deepEqual(parseCliArgs(["diagnose", "--json"]), { kind: "diagnose", json: true });
});

test("parseCliArgs: platforms rejects stray positionals", () => {
  assert.throws(() => parseCliArgs(["platforms", "extra"]), CliUsageError);
});

test("parseCliArgs: unknown command is a usage error", () => {
  assert.throws(() => parseCliArgs(["frobnicate"]), CliUsageError);
});

test("parseCliArgs: unknown option is a usage error", () => {
  assert.throws(() => parseCliArgs(["platforms", "--bogus"]), CliUsageError);
});

test("parseCliArgs: tasks requires the list subcommand", () => {
  assert.throws(() => parseCliArgs(["tasks"]), CliUsageError);
  assert.throws(() => parseCliArgs(["tasks", "purge"]), CliUsageError);
});

test("parseCliArgs: tasks list parses all filters", () => {
  const parsed = parseCliArgs([
    "tasks",
    "list",
    "--status",
    "in_progress",
    "--tag",
    "ci",
    "--owner",
    "skippy",
    "--include-completed",
    "--limit",
    "25",
    "--json",
  ]);
  assert.deepEqual(parsed, {
    kind: "tasks-list",
    json: true,
    status: "in_progress",
    tag: "ci",
    owner: "skippy",
    includeCompleted: true,
    limit: 25,
  });
});

test("parseCliArgs: tasks list defaults", () => {
  const parsed = parseCliArgs(["tasks", "list"]);
  assert.deepEqual(parsed, {
    kind: "tasks-list",
    json: false,
    status: undefined,
    tag: undefined,
    owner: undefined,
    includeCompleted: false,
    limit: undefined,
  });
});

test("parseCliArgs: tasks list rejects invalid status and limit", () => {
  assert.throws(() => parseCliArgs(["tasks", "list", "--status", "bogus"]), CliUsageError);
  assert.throws(() => parseCliArgs(["tasks", "list", "--limit", "0"]), CliUsageError);
  assert.throws(() => parseCliArgs(["tasks", "list", "--limit", "501"]), CliUsageError);
  assert.throws(() => parseCliArgs(["tasks", "list", "--limit", "ten"]), CliUsageError);
  assert.throws(() => parseCliArgs(["tasks", "list", "--limit", "1.5"]), CliUsageError);
});

// --- Help layering ---

test("top-level help stays under 40 lines and names every command", () => {
  const text = helpText();
  assert.ok(text.split("\n").length < 40, "top-level help must stay under 40 lines");
  for (const command of ["route", "platforms", "diagnose", "tasks list"]) {
    assert.ok(text.includes(command), `help must mention "${command}"`);
  }
  assert.ok(text.includes("--json"));
});

test("per-command help exists for each command and is distinct from the top level", () => {
  for (const topic of ["route", "platforms", "diagnose", "tasks"]) {
    const text = commandHelpText(topic);
    assert.ok(text.length > 0);
    assert.notEqual(text, helpText());
    assert.ok(text.includes("--json"), `${topic} help must document --json`);
  }
});

test("commandHelpText falls back to top-level help for unknown topics", () => {
  assert.equal(commandHelpText("nope"), helpText());
});

// --- Output shaping ---

test("summarizePlatforms mirrors the list_platforms tool shape", () => {
  const summary = summarizePlatforms(buildRegistry());
  assert.deepEqual(Object.keys(summary), ["selectionPolicy", "tiers"]);
  assert.equal(summary.tiers.length, 2);

  const local = summary.tiers[0] as {
    id: string;
    hosts: Array<Record<string, unknown>>;
  };
  assert.equal(local.id, "local");
  assert.equal(local.hosts.length, 2);
  assert.deepEqual(local.hosts[0], {
    id: "workstation",
    label: "Workstation",
    provider: "ollama",
    endpoint: "http://workstation:11434",
    enabled: true,
    modelCount: 2,
    executionPolicy: { maxParallelSlices: 2 },
    hardware: {},
    preferredTasks: ["code"],
  });
  assert.equal(local.hosts[1].enabled, false);
});

test("diagnoseHosts marks disabled, non-HTTP, healthy, and unreachable hosts", async () => {
  const registry = buildRegistry();
  const pinged: string[] = [];
  const results = await diagnoseHosts(registry, async (host) => {
    pinged.push(host.id);
    return { ok: host.id === "workstation", latencyMs: 12 };
  });

  assert.deepEqual(pinged, ["workstation"], "only enabled HTTP hosts get pinged");
  assert.equal(results.length, 3);

  const byHost = new Map(results.map((r) => [r.host, r]));
  assert.equal(byHost.get("workstation")?.status, "healthy");
  assert.equal(byHost.get("workstation")?.latencyMs, 12);
  assert.equal(byHost.get("workstation")?.endpointFamily, "ollama");
  assert.equal(byHost.get("disabled-box")?.status, "disabled");
  assert.equal(byHost.get("cli-host")?.status, "skipped");
  assert.equal(byHost.get("cli-host")?.reason, "not an HTTP endpoint");
});

test("filterTasks hides terminal tasks by default and sorts newest first", () => {
  const result = filterTasks(buildTaskStore(), {});
  assert.equal(result.total, 2);
  assert.equal(result.returned, 2);
  assert.deepEqual(
    result.tasks.map((t) => t.taskId),
    ["task-a", "task-c"]
  );
});

test("filterTasks includeCompleted surfaces done tasks", () => {
  const result = filterTasks(buildTaskStore(), { includeCompleted: true });
  assert.equal(result.total, 3);
  assert.deepEqual(
    result.tasks.map((t) => t.taskId),
    ["task-b", "task-a", "task-c"]
  );
});

test("filterTasks applies status, tag, owner, and limit filters", () => {
  const store = buildTaskStore();

  const byStatus = filterTasks(store, { status: "todo" });
  assert.deepEqual(
    byStatus.tasks.map((t) => t.taskId),
    ["task-c"]
  );

  const byTag = filterTasks(store, { tag: "CI" });
  assert.deepEqual(
    byTag.tasks.map((t) => t.taskId),
    ["task-a"],
    "tag filter is case-insensitive"
  );

  const byOwner = filterTasks(store, { owner: "SKIPPY" });
  assert.deepEqual(
    byOwner.tasks.map((t) => t.taskId),
    ["task-a"]
  );

  const limited = filterTasks(store, { limit: 1 });
  assert.equal(limited.total, 2);
  assert.equal(limited.returned, 1);
  assert.deepEqual(
    limited.tasks.map((t) => t.taskId),
    ["task-a"]
  );
});

// --- Text formatters ---

test("formatRouteText renders every recommendation field", () => {
  const route: RouteRecommendation = {
    recommendedTier: "local",
    recommendedHost: "workstation",
    recommendedModel: "qwen2.5-coder:14b",
    reasoning: "matched code keywords",
    availableModels: ["qwen2.5-coder:14b"],
    fallback: "tailscale-ollama",
  };
  const text = formatRouteText(route);
  assert.ok(text.includes("local"));
  assert.ok(text.includes("workstation"));
  assert.ok(text.includes("qwen2.5-coder:14b"));
  assert.ok(text.includes("matched code keywords"));
  assert.ok(text.includes("fallback: tailscale-ollama"));
});

test("formatRouteText handles null host/model and omits absent fallback", () => {
  const route: RouteRecommendation = {
    recommendedTier: "local",
    recommendedHost: null,
    recommendedModel: null,
    reasoning: "nothing available",
    availableModels: [],
    fallback: null,
  };
  const text = formatRouteText(route);
  assert.ok(text.includes("(none)"));
  assert.ok(!text.includes("fallback:"));
});

test("formatPlatformsText lists tiers and hosts line-oriented", () => {
  const text = formatPlatformsText(summarizePlatforms(buildRegistry()));
  const lines = text.split("\n");
  assert.ok(lines[0].startsWith("local (priority 1)"));
  assert.ok(lines.some((line) => line.includes("workstation") && line.includes("2 models")));
  assert.ok(lines.some((line) => line.includes("disabled-box") && line.includes("disabled")));
});

test("formatDiagnoseText renders one line per host", () => {
  const text = formatDiagnoseText([
    { tier: "local", host: "workstation", status: "healthy", latencyMs: 12 },
    { tier: "local", host: "cli-host", status: "skipped", reason: "not an HTTP endpoint" },
  ]);
  const lines = text.split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes("local/workstation"));
  assert.ok(lines[0].includes("healthy"));
  assert.ok(lines[0].includes("12ms"));
  assert.ok(lines[1].includes("not an HTTP endpoint"));
});

test("formatTasksText renders id, status, priority, and title per line", () => {
  const result = filterTasks(buildTaskStore(), {});
  const text = formatTasksText(result);
  const lines = text.split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes("task-a"));
  assert.ok(lines[0].includes("in_progress"));
  assert.ok(lines[0].includes("[high]"));
  assert.ok(lines[0].includes("Fix the tests"));
});

// --- Exit code constants (part of the public contract) ---

test("exit code constants follow the 0/1/2 convention", () => {
  assert.equal(EXIT_OK, 0);
  assert.equal(EXIT_USAGE, 1);
  assert.equal(EXIT_SERVER, 2);
});
