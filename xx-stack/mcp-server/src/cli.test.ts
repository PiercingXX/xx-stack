import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CliUsageError,
  CliWriteConflictError,
  commandHelpText,
  diagnoseHosts,
  EXIT_CONFLICT,
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
  runCli,
  summarizePlatforms,
} from "./cli.js";
import { getAgentMemoryEntrypoint, hashMemoryContent } from "./memory_runtime.js";
import {
  diagnoseHosts as runtimeDiagnoseHosts,
  summarizePlatforms as runtimeSummarizePlatforms,
} from "./observability_runtime.js";
import type { Registry, RouteRecommendation } from "./platform_types.js";
import { narrowTaskStoreToReady } from "./task_graph_runtime.js";
import { filterTasks as runtimeFilterTasks } from "./task_list_runtime.js";
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
    "--ready-only",
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
    readyOnly: true,
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
    readyOnly: false,
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
  for (const command of ["route", "platforms", "diagnose", "tasks list", "memory apply"]) {
    assert.ok(text.includes(command), `help must mention "${command}"`);
  }
  assert.ok(text.includes("--json"));
});

test("per-command help exists for each command and is distinct from the top level", () => {
  for (const topic of ["route", "platforms", "diagnose", "tasks", "memory"]) {
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

test("MCP-DUP-3: the CLI forwards the shared runtime rather than forking it", () => {
  // The CLI header promises "zero routing/task/memory logic is forked into this
  // file", but these three were copy-pasted from the tool handlers and only the
  // CLI copies had tests. Identity, not equivalence: there is one function, so
  // no behavior change can land on one side alone.
  assert.equal(summarizePlatforms, runtimeSummarizePlatforms);
  assert.equal(diagnoseHosts, runtimeDiagnoseHosts);
  assert.equal(filterTasks, runtimeFilterTasks);
});

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

test("exit code constants follow the 0/1/2 convention plus 5 for write conflicts", () => {
  assert.equal(EXIT_OK, 0);
  assert.equal(EXIT_USAGE, 1);
  assert.equal(EXIT_SERVER, 2);
  assert.equal(EXIT_CONFLICT, 5);
  assert.ok(helpText().includes("5 write conflict"), "the convention must be documented");
});

// --- memory: compare-and-swap writes and exit code 5 ---

test("parseCliArgs: memory subcommands, flags, and usage errors", () => {
  assert.deepEqual(parseCliArgs(["memory", "status", "--agent", "skippy"]), {
    kind: "memory-status",
    agentId: "skippy",
    scope: undefined,
    cwd: undefined,
    json: false,
  });
  assert.deepEqual(
    parseCliArgs([
      "memory",
      "apply",
      "--agent",
      "skippy",
      "--scope",
      "project",
      "--cwd",
      "/tmp/x",
      "--expect-hash",
      "abc123",
      "--json",
    ]),
    {
      kind: "memory-apply",
      agentId: "skippy",
      scope: "project",
      cwd: "/tmp/x",
      expectHash: "abc123",
      json: true,
    }
  );
  assert.deepEqual(parseCliArgs(["memory", "--help"]), { kind: "help", topic: "memory" });

  assert.throws(() => parseCliArgs(["memory"]), CliUsageError, "subcommand required");
  assert.throws(() => parseCliArgs(["memory", "wipe", "--agent", "a"]), CliUsageError);
  assert.throws(() => parseCliArgs(["memory", "status"]), CliUsageError, "--agent required");
  assert.throws(
    () => parseCliArgs(["memory", "apply", "--agent", "a", "--scope", "galaxy"]),
    CliUsageError
  );
  assert.throws(
    () => parseCliArgs(["memory", "status", "--agent", "a", "--expect-hash", "abc"]),
    CliUsageError,
    "--expect-hash is a write-command flag"
  );
});

interface CapturedRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCaptured(argv: string[]): Promise<CapturedRun> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(
    argv,
    { write: (text: string) => stdout.push(text) },
    { write: (text: string) => stderr.push(text) }
  );
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

test("xx memory apply: stale --expect-hash exits 5 with JSON on stderr and writes nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-cli-cas-"));
  try {
    const agent = "cli-cas-agent";
    const scoped = ["--agent", agent, "--scope", "project", "--cwd", dir];

    // Read first: status reports the live hashes (this is where a caller gets
    // the hash it later asserts).
    const status = await runCaptured(["memory", "status", ...scoped, "--json"]);
    assert.equal(status.code, EXIT_OK);
    const statusPayload = JSON.parse(status.stdout) as Record<string, string>;
    const memoryPath = getAgentMemoryEntrypoint(agent, "project", dir);
    assert.equal(statusPayload.memoryPath, memoryPath);
    assert.equal(statusPayload.memoryHash, hashMemoryContent(await readFile(memoryPath, "utf-8")));

    const before = await readFile(memoryPath, "utf-8");

    const conflict = await runCaptured([
      "memory",
      "apply",
      ...scoped,
      "--expect-hash",
      "0000000000000000",
    ]);
    assert.equal(conflict.code, EXIT_CONFLICT, "write conflict must exit 5");
    assert.equal(conflict.stdout, "", "stdout stays clean on conflict");

    const payload = JSON.parse(conflict.stderr) as Record<string, string>;
    assert.equal(payload.status, "write_conflict");
    assert.equal(payload.agentId, agent);
    assert.equal(payload.expectedHash, "0000000000000000");
    assert.equal(payload.currentHash, statusPayload.memoryHash);
    assert.equal(payload.hint, "re-read and retry");
    assert.equal(payload.targetPath, memoryPath);

    // Genuinely nothing written.
    assert.equal(await readFile(memoryPath, "utf-8"), before);

    // Re-read and retry with the current hash: the apply lands, exit 0.
    const ok = await runCaptured([
      "memory",
      "apply",
      ...scoped,
      "--expect-hash",
      payload.currentHash,
      "--json",
    ]);
    assert.equal(ok.code, EXIT_OK);
    const okPayload = JSON.parse(ok.stdout) as Record<string, unknown>;
    assert.equal(okPayload.status, "ok");
    assert.equal(okPayload.direction, "apply");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("xx tasks list: a corrupt task store exits 2 with a structured diagnostic, not a stack trace", async () => {
  // The store readers stopped treating an unreadable file as an empty store
  // (MCP-1) and now throw StoreAccessError. The MCP tools convert that into a
  // `store_unavailable` result via guardStoreAccess; the CLI inherited the raw
  // throw and had no equivalent, so `xx tasks list` reported it as an
  // undifferentiated server error.
  const originalHome = process.env.HOME;
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-cli-store-"));
  try {
    process.env.HOME = dir;
    const statePath = join(dir, ".config/opencode/xx-stack-task-state.json");
    await mkdir(join(dir, ".config/opencode"), { recursive: true });
    await writeFile(statePath, "{ this is not json", "utf-8");

    const run = await runCaptured(["tasks", "list", "--json"]);

    assert.equal(run.code, EXIT_SERVER, "an unreadable store is a server error, exit 2");
    assert.equal(run.stdout, "", "stdout stays clean so a pipeline never eats a diagnostic");

    const payload = JSON.parse(run.stderr) as Record<string, unknown>;
    assert.equal(payload.status, "error");
    assert.equal(payload.reasonCode, "store_unavailable");
    assert.equal(payload.store, "task");
    assert.equal(payload.path, statePath);
    assert.ok(
      typeof payload.remediation === "string" && payload.remediation.length > 0,
      "the diagnostic tells the operator what to do"
    );
    assert.ok(!run.stderr.includes("    at "), "no raw stack frames leak to stderr");

    // A genuinely absent store is still the empty-list case, not an error.
    await rm(statePath, { force: true });
    const empty = await runCaptured(["tasks", "list", "--json"]);
    assert.equal(empty.code, EXIT_OK);
    assert.deepEqual(JSON.parse(empty.stdout), { total: 0, returned: 0, tasks: [] });
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(dir, { recursive: true, force: true });
  }
});

test("CliWriteConflictError carries the conflict payload runCli emits", () => {
  const error = new CliWriteConflictError({ status: "write_conflict", currentHash: "abc" });
  assert.ok(error instanceof Error);
  assert.equal(error.name, "CliWriteConflictError");
  assert.deepEqual(error.conflict, { status: "write_conflict", currentHash: "abc" });
});

// ---------------------------------------------------------------------------
// BORROW A — `xx tasks list --ready-only`
// ---------------------------------------------------------------------------

test("xx tasks list --ready-only hides work whose blockers are still open", async () => {
  const originalHome = process.env.HOME;
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-cli-ready-"));
  try {
    process.env.HOME = dir;
    await mkdir(join(dir, ".config/opencode"), { recursive: true });

    const task = (
      taskId: string,
      status: PersistentTask["status"],
      blockedBy: string[] = []
    ): PersistentTask => ({
      taskId,
      title: taskId,
      status,
      tags: [],
      blockedBy,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });

    const store: TaskStore = {
      version: 1,
      tasks: {
        "blocker-open": task("blocker-open", "in_progress"),
        "blocker-done": task("blocker-done", "done"),
        waiting: task("waiting", "todo", ["blocker-open"]),
        startable: task("startable", "todo", ["blocker-done"]),
        orphan: task("orphan", "todo", ["typo-id"]),
      },
    };
    await writeFile(
      join(dir, ".config/opencode/xx-stack-task-state.json"),
      JSON.stringify(store),
      "utf-8"
    );

    const plain = await runCaptured(["tasks", "list", "--json"]);
    assert.equal(plain.code, EXIT_OK);
    assert.deepEqual(
      (JSON.parse(plain.stdout).tasks as PersistentTask[]).map((t) => t.taskId).sort(),
      ["blocker-open", "orphan", "startable", "waiting"]
    );

    const ready = await runCaptured(["tasks", "list", "--ready-only", "--json"]);
    assert.equal(ready.code, EXIT_OK);
    const payload = JSON.parse(ready.stdout) as { total: number; tasks: PersistentTask[] };
    assert.deepEqual(
      payload.tasks.map((t) => t.taskId).sort(),
      ["blocker-open", "startable"],
      "a blocked task, and a task blocked by an ID that does not exist, are not startable"
    );
    // total/returned describe the narrowed population, not the whole store.
    assert.equal(payload.total, 2);

    // MCP-DUP-3: the CLI must not carry its own readiness rule — it produces
    // exactly what the shared runtime pair produces.
    assert.deepEqual(
      JSON.parse(ready.stdout),
      JSON.parse(JSON.stringify(filterTasks(narrowTaskStoreToReady(store), {})))
    );

    // --ready-only composes with the other filters rather than replacing them.
    const combined = await runCaptured([
      "tasks",
      "list",
      "--ready-only",
      "--status",
      "todo",
      "--json",
    ]);
    assert.deepEqual(
      (JSON.parse(combined.stdout).tasks as PersistentTask[]).map((t) => t.taskId),
      ["startable"]
    );
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(dir, { recursive: true, force: true });
  }
});

test("xx tasks list --ready-only help states it is a view, not a runner", () => {
  // MANUAL §1: xx-stack computes and returns a schedule; it never executes
  // one. The CLI is the surface most likely to be mistaken for a runner.
  const help = commandHelpText("tasks");
  assert.ok(help.includes("--ready-only"), help);
  assert.ok(help.includes("never runs it"), help);
});
