import test from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { diagnoseHosts, summarizePlatforms } from "./observability_runtime.js";
import { registerObservabilityTools, TOOL_CATALOG } from "./observability_tools.js";
import type { Registry } from "./platform_types.js";

// --- fake server ----------------------------------------------------------

type ToolResult = { content: Array<{ type: string; text: string }> };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function fakeServer(sink: (name: string, handler: Handler) => void): McpServer {
  return {
    tool: (...args: unknown[]) => {
      sink(args[0] as string, args[args.length - 1] as Handler);
    },
  } as unknown as McpServer;
}

async function call(handler: Handler, args: Record<string, unknown> = {}): Promise<any> {
  const result = await handler(args);
  assert.equal(result.content.length, 1);
  return JSON.parse(result.content[0]!.text);
}

// --- MCP-13: the catalog cannot drift behind registration -----------------

/**
 * Deliberately hidden lifecycle hooks. They are called by a hook-aware harness
 * via the `_`-prefixed protocol names, never discovered by an agent through
 * search_tools, and they only register at all behind XX_STACK_HOOK_TOOLS=1.
 * Every other registered tool must be discoverable.
 */
const HIDDEN_FROM_CATALOG = new Set(["_Stop", "_PostCompact"]);

/**
 * Derive the registered tool names by driving the real registration functions
 * against a recording server — never by hand-listing them, which is exactly the
 * mistake that let TOOL_CATALOG fall 11 tools behind (MCP-13).
 *
 * The registrar set itself is derived too: every `register*` export of every
 * `*_tools.js` module is invoked. A new tool group therefore enters this test
 * the moment its file lands, with no second list to remember to update.
 * Registration is pure `server.tool(...)` — no dependency is touched until a
 * handler runs — so empty deps are safe here.
 */
async function registeredToolNames(): Promise<Set<string>> {
  const names = new Set<string>();
  const server = fakeServer((name) => names.add(name));

  const here = dirname(fileURLToPath(import.meta.url));
  const toolModules = (await readdir(here)).filter((file) => file.endsWith("_tools.js")).sort();
  assert.ok(toolModules.length > 0, "expected to find compiled *_tools.js modules beside the test");

  for (const file of toolModules) {
    const mod = (await import(`./${file}`)) as Record<string, unknown>;
    for (const [exportName, value] of Object.entries(mod)) {
      if (!exportName.startsWith("register") || typeof value !== "function") continue;
      // Every registrar is (server, deps?) and ignores deps until a handler
      // runs. `registerHookToolsIfEnabled` reads process.env and no-ops without
      // the flag; `registerHookTools` is exported too, so the hooks still land.
      (value as (server: McpServer, deps: never) => void)(server, {} as never);
    }
  }
  return names;
}

test("MCP-13: every registered tool has a search_tools catalog entry", async () => {
  const registered = await registeredToolNames();
  const cataloged = new Set(TOOL_CATALOG.map((entry) => entry.name));

  const missing = [...registered]
    .filter((name) => !HIDDEN_FROM_CATALOG.has(name))
    .filter((name) => !cataloged.has(name))
    .sort();

  assert.deepEqual(
    missing,
    [],
    `registered but undiscoverable via search_tools — add a TOOL_CATALOG entry: ${missing.join(", ")}`
  );
});

test("MCP-13: no catalog entry names a tool nobody registers", async () => {
  const registered = await registeredToolNames();
  const stale = TOOL_CATALOG.map((entry) => entry.name)
    .filter((name) => !registered.has(name))
    .sort();

  assert.deepEqual(stale, [], `TOOL_CATALOG advertises unregistered tools: ${stale.join(", ")}`);
});

test("MCP-13: the hidden lifecycle hooks really are registered and really are omitted", async () => {
  const registered = await registeredToolNames();
  const cataloged = new Set(TOOL_CATALOG.map((entry) => entry.name));
  for (const hook of HIDDEN_FROM_CATALOG) {
    assert.ok(registered.has(hook), `${hook} should still be a registered tool`);
    assert.ok(!cataloged.has(hook), `${hook} is a hidden hook and must stay out of the catalog`);
  }
});

test("MCP-13: catalog entries are unique and carry searchable keywords", () => {
  const seen = new Set<string>();
  for (const entry of TOOL_CATALOG) {
    assert.ok(!seen.has(entry.name), `duplicate catalog entry for ${entry.name}`);
    seen.add(entry.name);
    assert.ok(entry.description.length > 0, `${entry.name} needs a description`);
    assert.ok(entry.keywords.length > 0, `${entry.name} needs at least one keyword`);
  }
});

test("MCP-13: search_tools can find the tools that used to be missing", async () => {
  const handlers: Record<string, Handler> = {};
  registerObservabilityTools(
    fakeServer((name, handler) => {
      handlers[name] = handler;
    }),
    {} as never
  );

  for (const name of [
    "build_repo_map",
    "verify_edit",
    "score_candidates",
    "route_review",
    "supervisor_force_synthesis",
    "agent_memory_compaction_prompt",
  ]) {
    const found = await call(handlers.search_tools!, { query: name });
    assert.ok(
      (found.tools as Array<{ name: string }>).some((tool) => tool.name === name),
      `search_tools query "${name}" should surface ${name}`
    );
  }
});

// --- MCP-DUP-3: the tool and the CLI share one implementation -------------

function buildRegistry(): Registry {
  return {
    version: 1,
    selectionPolicy: { defaultOrder: ["local"], rules: [] },
    tiers: [
      {
        id: "local",
        label: "Local",
        priority: 1,
        usageGuidance: "prefer for code",
        hosts: [
          {
            id: "offline-box",
            label: "Offline box",
            provider: "ollama",
            endpoint: "http://offline:11434",
            enabled: false,
            models: ["qwen3"],
            executionPolicy: { maxParallelSlices: 2 },
            delegationPolicy: { preferredTaskTypes: ["code"] },
          },
          {
            id: "cli-host",
            label: "CLI host",
            provider: "custom",
            // Not an HTTP endpoint, so check_health skips it and no test
            // touches the network.
            endpoint: "ssh://not-http",
            enabled: true,
            models: [],
          },
        ],
      },
    ],
  } as unknown as Registry;
}

test("MCP-DUP-3: list_platforms returns exactly summarizePlatforms output", async () => {
  const registry = buildRegistry();
  const handlers: Record<string, Handler> = {};
  registerObservabilityTools(
    fakeServer((name, handler) => {
      handlers[name] = handler;
    }),
    { loadRegistry: async () => registry } as never
  );

  assert.deepEqual(
    await call(handlers.list_platforms!),
    JSON.parse(JSON.stringify(summarizePlatforms(registry)))
  );
});

test("MCP-DUP-3: check_health returns exactly diagnoseHosts output", async () => {
  const registry = buildRegistry();
  const handlers: Record<string, Handler> = {};
  registerObservabilityTools(
    fakeServer((name, handler) => {
      handlers[name] = handler;
    }),
    { loadRegistry: async () => registry } as never
  );

  assert.deepEqual(
    await call(handlers.check_health!),
    JSON.parse(JSON.stringify(await diagnoseHosts(registry)))
  );
});

// --- MCP-16: record_telemetry orders its write and reports honestly -------

interface TelemetryProbe {
  handler: Handler;
  release: () => void;
  writes: number;
}

function telemetryWithGatedWrite(reject = false): TelemetryProbe {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const probe = { writes: 0 } as TelemetryProbe;

  const handlers: Record<string, Handler> = {};
  registerObservabilityTools(
    fakeServer((name, handler) => {
      handlers[name] = handler;
    }),
    {
      loadModelRates: async () => ({ comment: "test", rates: {} }),
      logEvent: async () => {
        await gate;
        probe.writes += 1;
        if (reject) throw new Error("ENOSPC: no space left on device");
      },
    } as never
  );

  probe.handler = handlers.record_telemetry!;
  probe.release = release;
  return probe;
}

const TELEMETRY_ARGS = { skill: "demo", outcome: "success", durationMs: 12 };

test("MCP-16: record_telemetry does not return before the telemetry write settles", async () => {
  const probe = telemetryWithGatedWrite();

  let returned = false;
  const pending = probe.handler(TELEMETRY_ARGS).then((result) => {
    returned = true;
    return result;
  });

  // Drain the microtask queue and a macrotask turn: nothing should have
  // resolved while the write is still parked.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(returned, false, "the handler must await the telemetry append, not fire-and-forget");
  assert.equal(probe.writes, 0, "the write has not completed yet");

  probe.release();
  const payload = JSON.parse((await pending).content[0]!.text);
  assert.equal(probe.writes, 1, "the write completed before the tool returned");
  assert.equal(payload.status, "accepted");
  assert.equal(payload.durability, "best-effort");
});

test("MCP-16: a rejected telemetry write is reported, not swallowed as success", async () => {
  const probe = telemetryWithGatedWrite(true);
  const pending = probe.handler(TELEMETRY_ARGS);
  probe.release();

  const payload = JSON.parse((await pending).content[0]!.text);
  assert.equal(payload.status, "error");
  assert.equal(payload.durability, "none");
  assert.match(payload.error, /ENOSPC/);
});

test("MCP-16: cost estimation still reports its source alongside the honest status", async () => {
  const handlers: Record<string, Handler> = {};
  registerObservabilityTools(
    fakeServer((name, handler) => {
      handlers[name] = handler;
    }),
    {
      loadModelRates: async () => ({
        comment: "test",
        rates: { "ollama/*": { costPer1kInputTokens: 0, costPer1kOutputTokens: 0, lane: "local" } },
      }),
      logEvent: async () => {},
    } as never
  );

  const local = await call(handlers.record_telemetry!, {
    ...TELEMETRY_ARGS,
    model: "ollama/qwen3-coder:30b",
    tokensIn: 4000,
    tokensOut: 1000,
  });
  assert.equal(local.status, "accepted");
  assert.equal(local.costUsd, 0);
  assert.equal(local.costSource, "estimated", "a glob-keyed local lane is no longer unknown-model");

  const unknown = await call(handlers.record_telemetry!, {
    ...TELEMETRY_ARGS,
    model: "some-cloud-model",
    tokensIn: 10,
    tokensOut: 10,
  });
  assert.equal(unknown.costUsd, null);
  assert.equal(unknown.costSource, "unknown-model");

  const explicit = await call(handlers.record_telemetry!, {
    ...TELEMETRY_ARGS,
    costUsd: 1.5,
    tokensIn: 10,
  });
  assert.equal(explicit.costUsd, 1.5);
  assert.equal(explicit.costSource, "explicit");
});
