import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { diagnoseHosts, summarizePlatforms } from "./observability_runtime.js";
import {
  catalogForSurface,
  HIDDEN_TOOL_ANNOTATIONS,
  lookupToolAnnotations,
  registerObservabilityTools,
  TOOL_CATALOG,
  TOOL_CATEGORIES,
  type ToolHints,
} from "./observability_tools.js";
import { ROUTING_SURFACE_TOOLS } from "./tool_surface.js";
import type { Registry } from "./platform_types.js";

// --- fake server ----------------------------------------------------------

type ToolResult = { content: Array<{ type: string; text: string }> };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

/**
 * The registration config `registerTool` takes. `server.tool(...)` — every
 * overload of which the SDK marks `@deprecated` — could not express `title`,
 * `outputSchema`, or (in the shape this repo used) `annotations` at all, so the
 * recorders below read the config object rather than positional arguments.
 */
interface ToolConfig {
  description?: string;
  inputSchema?: Record<string, any>;
  annotations?: ToolHints;
}

function fakeServer(sink: (name: string, handler: Handler) => void): McpServer {
  return {
    registerTool: (...args: unknown[]) => {
      sink(args[0] as string, args[args.length - 1] as Handler);
    },
  } as unknown as McpServer;
}

/** Same recorder, but keeping the whole config so schema and hints are testable. */
function fakeServerWithConfig(sink: (name: string, config: ToolConfig) => void): McpServer {
  return {
    registerTool: (...args: unknown[]) => {
      sink(args[0] as string, args[1] as ToolConfig);
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
 * Registration is pure `server.registerTool(...)` — no dependency is touched
 * until a handler runs — so empty deps are safe here.
 */
async function driveEveryRegistrar(server: McpServer): Promise<void> {
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
}

async function registeredToolNames(): Promise<Set<string>> {
  const names = new Set<string>();
  await driveEveryRegistrar(fakeServer((name) => names.add(name)));
  return names;
}

/** Every registration's config object, keyed by tool name. */
async function registeredToolConfigs(): Promise<Map<string, ToolConfig>> {
  const configs = new Map<string, ToolConfig>();
  await driveEveryRegistrar(
    fakeServerWithConfig((name, config) => {
      configs.set(name, config);
    })
  );
  return configs;
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

// --- annotations: the same drift guard, extended to the safety hints -------
//
// MCP-13 happened because a second hand-maintained list sat beside the
// registrations with nothing comparing them. Annotations are declared on the
// TOOL_CATALOG entry for exactly that reason — one place per tool — and these
// tests are what stop that one place from rotting.

const HINT_KEYS = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
] as const satisfies ReadonlyArray<keyof ToolHints>;

test("annotations: every registered tool declares all four hints", async () => {
  const registered = await registeredToolNames();

  const undeclared = [...registered].filter((name) => lookupToolAnnotations(name) === null).sort();
  assert.deepEqual(
    undeclared,
    [],
    "registered with no declared annotations — a client cannot tell these apart from " +
      `verify_edit, so they fall back to destructive+openWorld: ${undeclared.join(", ")}`
  );

  for (const name of registered) {
    const hints = lookupToolAnnotations(name)!;
    for (const key of HINT_KEYS) {
      assert.equal(
        typeof hints[key],
        "boolean",
        `${name} must state ${key} explicitly — an omitted hint is not a neutral statement`
      );
    }
  }
});

test("annotations: no declaration names a tool nobody registers", async () => {
  const registered = await registeredToolNames();
  const declared = [
    ...TOOL_CATALOG.map((entry) => entry.name),
    ...Object.keys(HIDDEN_TOOL_ANNOTATIONS),
  ];
  const stale = declared.filter((name) => !registered.has(name)).sort();
  assert.deepEqual(stale, [], `annotations declared for unregistered tools: ${stale.join(", ")}`);
});

test("annotations: the hidden-hook exemption stays exactly the two lifecycle hooks", () => {
  assert.deepEqual(
    Object.keys(HIDDEN_TOOL_ANNOTATIONS).sort(),
    [...HIDDEN_FROM_CATALOG].sort(),
    "the annotation exemption and the catalog exemption must name the same tools — " +
      "a third entry here would be a tool hiding from search_tools with no reason recorded"
  );
});

test("annotations: what registration passes is what the catalog declares", async () => {
  const configs = await registeredToolConfigs();
  assert.ok(configs.size > 0, "expected registrations to be recorded");

  for (const [name, config] of configs) {
    assert.deepEqual(
      config.annotations,
      lookupToolAnnotations(name),
      `${name} registers annotations that differ from its declaration — the registration ` +
        "site must call toolAnnotations(name), never spell hints inline"
    );
  }
});

test("annotations: the read/write split is real, not uniform", async () => {
  const configs = await registeredToolConfigs();
  const readOnly = (name: string): boolean => configs.get(name)!.annotations!.readOnlyHint;

  // A pure registry read and a subprocess spawn must not look alike — that
  // indistinguishability is the whole reason these hints exist.
  assert.equal(readOnly("list_platforms"), true);
  assert.equal(readOnly("verify_edit"), false);
  assert.equal(configs.get("verify_edit")!.annotations!.idempotentHint, false);

  // openWorldHint tracks reaching beyond this machine: health probes dial
  // hosts, a store read does not.
  assert.equal(configs.get("check_health")!.annotations!.openWorldHint, true);
  assert.equal(configs.get("task_get")!.annotations!.openWorldHint, false);

  // The surface is genuinely mixed, so a future uniform sweep fails here.
  const values = [...configs.values()].map((config) => config.annotations!);
  for (const key of HINT_KEYS) {
    assert.ok(
      values.some((hints) => hints[key]) && values.some((hints) => !hints[key]),
      `every tool declares the same ${key} — the hints were filled in uniformly, not decided`
    );
  }
});

// --- the deprecated registration API is gone and must stay gone -----------

test("no registration site uses the @deprecated server.tool(...) API", async () => {
  // Every tool() overload in @modelcontextprotocol/sdk ^1.28 is marked
  // `@deprecated Use registerTool instead`, and it cannot express title,
  // outputSchema, or the annotations above. A grep over source is crude but it
  // is what catches the next copy-paste, which is how all 47 sites arrived.
  const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const files = (await readdir(srcDir)).filter((file) => file.endsWith(".ts")).sort();
  assert.ok(files.length > 0, `expected TypeScript sources in ${srcDir}`);

  const offenders: string[] = [];
  for (const file of files) {
    const text = await readFile(join(srcDir, file), "utf8");
    // `server.tool(` in prose is fine; a call is what matters, and every call
    // in this codebase is written against a parameter or local named `server`.
    for (const [index, line] of text.split("\n").entries()) {
      if (/^\s*server\.tool\(/.test(line)) offenders.push(`${file}:${index + 1}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `deprecated server.tool(...) call sites — use server.registerTool(name, config, cb): ${offenders.join(", ")}`
  );
});

// --- tools/list really carries the annotations over the wire --------------

test("tools/list returns the declared annotations for every tool", async () => {
  const server = new McpServer({ name: "annotation-probe", version: "0.0.0" });
  // driveEveryRegistrar calls the aggregators (registerAgentTools,
  // registerSupervisorTools) as well as the leaf registrars they delegate to,
  // which a real McpServer rejects as a duplicate name. index.ts only ever
  // calls the aggregators, so dropping the repeat here changes nothing about
  // what ships — it just lets one pass cover every group.
  const seen = new Set<string>();
  const dedupe = new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== "registerTool") return Reflect.get(target, prop, receiver);
      return (...args: unknown[]) => {
        const name = args[0] as string;
        if (seen.has(name)) return;
        seen.add(name);
        return (target.registerTool as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  await driveEveryRegistrar(dedupe);

  const client = new Client({ name: "annotation-probe-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const { tools } = await client.listTools();
    assert.ok(tools.length > 0, "expected tools/list to return the registered surface");

    for (const tool of tools) {
      const expected = lookupToolAnnotations(tool.name);
      assert.ok(expected, `tools/list advertises ${tool.name} with no declaration`);
      assert.ok(
        tool.annotations,
        `${tool.name} reached the wire with no annotations — the config was dropped`
      );
      for (const key of HINT_KEYS) {
        assert.equal(
          tool.annotations[key],
          expected[key],
          `${tool.name}.${key} did not survive to tools/list`
        );
      }
    }

    // The declarations are complete, so the wire and the declaration agree in
    // both directions.
    const listed = new Set(tools.map((tool) => tool.name));
    const missing = [...(await registeredToolNames())].filter((name) => !listed.has(name));
    assert.deepEqual(missing, [], `registered but absent from tools/list: ${missing.join(", ")}`);
  } finally {
    await client.close();
    await server.close();
  }
});

test("search_tools on the routing surface only advertises routing tools", async () => {
  const previous = process.env.XX_STACK_TOOL_SURFACE;
  process.env.XX_STACK_TOOL_SURFACE = "routing";
  try {
    const handlers: Record<string, Handler> = {};
    registerObservabilityTools(
      fakeServer((name, handler) => {
        handlers[name] = handler;
      }),
      {} as never
    );
    const found = await call(handlers.search_tools!, { query: "", limit: 50 });
    const names = (found.tools as Array<{ name: string }>).map((tool) => tool.name).sort();
    assert.deepEqual(names, [...ROUTING_SURFACE_TOOLS].sort());
    assert.deepEqual(
      catalogForSurface("routing")
        .map((entry) => entry.name)
        .sort(),
      [...ROUTING_SURFACE_TOOLS].sort()
    );
    const supervisor = await call(handlers.search_tools!, { query: "supervisor_status" });
    assert.equal(
      (supervisor.tools as Array<{ name: string }>).some(
        (tool) => tool.name === "supervisor_status"
      ),
      false,
      "routing surface must not advertise unregistered tools"
    );
  } finally {
    if (previous === undefined) delete process.env.XX_STACK_TOOL_SURFACE;
    else process.env.XX_STACK_TOOL_SURFACE = previous;
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
    "route_task",
    "supervisor_force_synthesis",
    "finding_record",
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

// --- §11.1: a telemetry failure never fails the caller, and is never hidden --

function telemetryWith(deps: Record<string, unknown>): Handler {
  const handlers: Record<string, Handler> = {};
  registerObservabilityTools(
    fakeServer((name, handler) => {
      handlers[name] = handler;
    }),
    { loadModelRates: async () => ({ comment: "test", rates: {} }), ...deps } as never
  );
  return handlers.record_telemetry!;
}

test("§11.1: a write the logger reports as failed is not passed off as best-effort", async () => {
  const handler = telemetryWith({
    logEvent: async () => ({
      ok: false,
      outcome: "failed",
      error: "EACCES: permission denied, open 'mcp-server.jsonl'",
    }),
  });

  const payload = JSON.parse((await handler(TELEMETRY_ARGS)).content[0]!.text);
  // The policy: telemetry is an observability sink, so the caller's operation
  // still succeeds...
  assert.equal(payload.status, "accepted");
  // ...but the durability claim tells the truth instead of always saying
  // "best-effort", which is what the bare `catch` used to force.
  assert.equal(payload.durability, "failed");
  assert.match(payload.error, /EACCES/);
});

test("§11.1: a rejected session log path is reported rather than silently dropped", async () => {
  const handler = telemetryWith({ logEvent: async () => ({ ok: false, outcome: "skipped" }) });

  const payload = JSON.parse(
    (await handler({ ...TELEMETRY_ARGS, sessionId: "sx-1" })).content[0]!.text
  );
  assert.equal(payload.status, "accepted");
  assert.equal(payload.durability, "failed");
  assert.match(payload.error, /skipped/);
});

test("§11.1: earlier fire-and-forget write failures surface through the writer counter", async () => {
  const healthy = telemetryWith({
    logEvent: async () => ({ ok: true, outcome: "written" }),
    telemetryHealth: () => ({ failures: 0, lastError: null, lastFailureAt: null }),
  });
  const clean = JSON.parse((await healthy(TELEMETRY_ARGS)).content[0]!.text);
  assert.equal(clean.durability, "best-effort");
  assert.equal(clean.writer, undefined, "a healthy writer adds nothing to the payload");

  const degraded = telemetryWith({
    logEvent: async () => ({ ok: true, outcome: "written" }),
    telemetryHealth: () => ({
      failures: 4,
      lastError: "ENOSPC: no space left on device",
      lastFailureAt: "2026-08-02T00:00:00.000Z",
    }),
  });
  const payload = JSON.parse((await degraded(TELEMETRY_ARGS)).content[0]!.text);
  // This write landed, but four events from `void logEvent(...)` call sites did
  // not, and this counter is the only place they are ever visible.
  assert.equal(payload.status, "accepted");
  assert.equal(payload.durability, "best-effort");
  assert.equal(payload.writer.failures, 4);
  assert.match(payload.writer.lastError, /ENOSPC/);
  assert.equal(payload.writer.lastFailureAt, "2026-08-02T00:00:00.000Z");
});

test("§11.1: a logger honoring the old void contract still reports best-effort", async () => {
  const handler = telemetryWith({ logEvent: async () => {} });
  const payload = JSON.parse((await handler(TELEMETRY_ARGS)).content[0]!.text);
  assert.equal(payload.status, "accepted");
  assert.equal(payload.durability, "best-effort");
  assert.equal(payload.error, undefined);
});

// --- §11.1: search_tools categories describe the tools they are filed under --

test("§11.1: build_repo_map and verify_edit are no longer filed under observability", () => {
  const category = (name: string): string =>
    TOOL_CATALOG.find((entry) => entry.name === name)!.category;

  assert.equal(category("build_repo_map"), "context");
  assert.equal(category("verify_edit"), "verification");
});

test("§11.1: search_tools accepts every category the catalog actually uses", () => {
  const schemas: Record<string, any> = {};
  registerObservabilityTools(
    fakeServerWithConfig((name, config) => {
      schemas[name] = config.inputSchema;
    }),
    {} as never
  );

  const filter = schemas.search_tools!.category;
  for (const value of TOOL_CATEGORIES) {
    assert.ok(
      filter.safeParse(value).success,
      `search_tools rejects its own category "${value}" — the enum and the catalog have drifted`
    );
  }
  for (const entry of TOOL_CATALOG) {
    assert.ok(
      filter.safeParse(entry.category).success,
      `${entry.name} is filed under "${entry.category}", which the filter rejects`
    );
  }
  assert.ok(!filter.safeParse("nonsense").success, "the filter is still a closed set");
});

test("§11.1: filtering by the new categories returns those tools and only those", async () => {
  const handlers: Record<string, Handler> = {};
  registerObservabilityTools(
    fakeServer((name, handler) => {
      handlers[name] = handler;
    }),
    {} as never
  );

  const context = await call(handlers.search_tools!, { category: "context" });
  assert.deepEqual(
    (context.tools as Array<{ name: string }>).map((tool) => tool.name),
    ["build_repo_map"]
  );

  const verification = await call(handlers.search_tools!, { category: "verification" });
  assert.deepEqual(
    (verification.tools as Array<{ name: string }>).map((tool) => tool.name),
    ["verify_edit"]
  );

  const observability = await call(handlers.search_tools!, { category: "observability" });
  const names = (observability.tools as Array<{ name: string }>).map((tool) => tool.name);
  assert.ok(!names.includes("build_repo_map"), "a repo map is not observability");
  assert.ok(!names.includes("verify_edit"), "a lint/test runner is not observability");
  assert.ok(names.includes("check_health"), "the genuine observability tools are still there");
});

// --- check_health reports what a host is actually holding -----------------

/**
 * The pressure numbers `monitor-memory` computes were invisible to every MCP
 * caller. `check_health` now surfaces them — but only for a host that can be
 * asked, and never as a guess: a host without
 * `capabilities.supportsResidentModelInspection` gets no `residentModels` key
 * at all, which is a different statement from "loaded nothing".
 *
 * Driven through the registered tool with no injection, against a stub Ollama
 * on loopback, so the real probe path is what runs.
 */
async function startStubOllama(): Promise<{ endpoint: string; close: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const body =
      req.url === "/api/ps"
        ? { models: [{ name: "qwen3:30b", size: 20 * 1073741824, size_vram: 8 * 1073741824 }] }
        : { models: [{ name: "qwen3:30b" }] };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("check_health reports resident models and memory pressure for an inspectable host", async () => {
  const stub = await startStubOllama();
  try {
    const registry = {
      version: 1,
      selectionPolicy: { defaultOrder: ["local"], rules: [] },
      tiers: [
        {
          id: "local",
          label: "Local",
          priority: 1,
          hosts: [
            {
              id: "gpu-box",
              label: "GPU box",
              provider: "ollama",
              endpoint: stub.endpoint,
              capabilities: { endpointFamily: "ollama", supportsResidentModelInspection: true },
              executionPolicy: { contextReservePercent: 25 },
              hardware: { detected: { totalGpuVramGb: 24 } },
              models: ["qwen3:30b"],
            },
            {
              // Same stub endpoint, so it pings healthy too — the only
              // difference is that nobody can ask it what it is holding.
              id: "opaque-box",
              label: "Opaque box",
              provider: "sglang-remote",
              endpoint: stub.endpoint,
              capabilities: {
                endpointFamily: "openai-compatible",
                supportsResidentModelInspection: false,
              },
              hardware: { detected: { totalGpuVramGb: 24 } },
              models: ["some-model"],
            },
          ],
        },
      ],
    } as unknown as Registry;

    const handlers: Record<string, Handler> = {};
    registerObservabilityTools(
      fakeServer((name, handler) => {
        handlers[name] = handler;
      }),
      { loadRegistry: async () => registry } as never
    );

    const results = (await call(handlers.check_health!)) as Array<Record<string, any>>;
    const byHost = new Map(results.map((entry) => [entry.host as string, entry]));

    const gpu = byHost.get("gpu-box")!;
    assert.equal(gpu.status, "healthy");
    assert.deepEqual(gpu.residentModels, ["qwen3:30b"]);
    // 24 GB card at a 25% reserve => 18 usable; 8 GB resident + 5 GB headroom.
    assert.equal(gpu.memoryPressure.usableVramGb, 18);
    assert.equal(gpu.memoryPressure.usedVramGb, 8);
    assert.equal(gpu.memoryPressure.contextHeadroomGb, 5);
    assert.equal(gpu.memoryPressure.estimatedFreeGb, 5);
    assert.equal(gpu.memoryPressure.overload, false);

    const opaque = byHost.get("opaque-box")!;
    assert.equal(opaque.status, "healthy");
    assert.ok(
      !("residentModels" in opaque),
      "an uninspectable host must not be described as holding nothing"
    );
    assert.ok(!("memoryPressure" in opaque));
  } finally {
    await stub.close();
  }
});
