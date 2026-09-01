import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { LogEventResult, TelemetryHealth } from "./log_worker.js";
import { diagnoseHosts, summarizePlatforms } from "./observability_runtime.js";
import type { Host, Registry } from "./platform_types.js";
import type { ModelRatesFile } from "./platform_runtime.js";
import { lookupModelCost } from "./platform_runtime.js";
import {
  endpointFamilyForHost,
  fetchHostModels,
  probeHostEndpointCompatibility,
} from "./routing_runtime.js";

import { jsonContent } from "./agent_tool_helpers.js";
import { resolveToolSurface, toolAllowedOnSurface } from "./tool_surface.js";

interface ObservabilityToolDeps {
  loadRegistry: () => Promise<Registry>;
  detectHardware: () => Promise<Record<string, unknown>>;
  logEvent: (
    stream: "server" | { session: string },
    type: string,
    payload: Record<string, unknown>
  ) => Promise<LogEventResult | void>;
  loadModelRates: () => Promise<ModelRatesFile>;
  /**
   * Process-lifetime telemetry write health. Optional because it is the only
   * dep a host can legitimately not provide; without it `record_telemetry`
   * reports this call's outcome and nothing about earlier ones.
   */
  telemetryHealth?: () => TelemetryHealth;
}

/**
 * Every category `search_tools` will filter on.
 *
 * `context` and `verification` were added after `build_repo_map` and
 * `verify_edit` had been parked under `observability` purely to avoid touching
 * this list (§11.1). Neither is observability — one returns a budgeted slice of
 * a codebase, the other runs the linter and tests — and a wrong taxonomy on a
 * *discovery* surface is worse than a schema edit. The edit is additive: the
 * five original values still validate, the filter is optional, and every caller
 * that passes no `category` is unaffected. It is a search facet, not a data
 * contract, so nothing persisted anywhere carries these strings.
 */
export const TOOL_CATEGORIES = [
  "routing",
  "supervisor",
  "observability",
  "tasks",
  "agents",
  "context",
  "verification",
  "evidence",
] as const;

export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

/**
 * The four MCP tool hints, all four required rather than optional.
 *
 * `ToolAnnotations` makes every hint optional, and an omitted hint is not a
 * neutral statement — a client that sees no `readOnlyHint` has to assume the
 * tool writes, and one that sees no `destructiveHint` on a writer has to assume
 * the worst. Requiring all four forces the author to decide, which is the whole
 * point: `list_platforms` and `verify_edit` are not equally dangerous, and a
 * client can only auto-approve the first if we say so.
 */
export type ToolHints = Required<
  Pick<ToolAnnotations, "readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint">
>;

/**
 * What a tool gets when nobody declared anything for it.
 *
 * Fail closed, exactly like `cloudRoutingAllowed()`: an unannotated tool is
 * treated as a destructive one that reaches the network, so forgetting to
 * annotate costs an approval prompt rather than silently granting a write path
 * the auto-approve treatment. The drift test in `observability_tools.test.ts`
 * makes reaching this default a test failure, so it is a backstop and not a
 * shipping state.
 */
export const FAIL_SAFE_TOOL_HINTS: ToolHints = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

/**
 * Hints for the tools that are deliberately absent from `TOOL_CATALOG`.
 *
 * `_Stop` and `_PostCompact` are hook-protocol surfaces, never discovered by an
 * agent through `search_tools`, so they must stay out of the catalog (the drift
 * test asserts that). They still register, so they still need honest hints.
 * This is the one exemption, it is two entries long, and the same drift test
 * that keeps the catalog honest fails if a third tool tries to hide here.
 */
export const HIDDEN_TOOL_ANNOTATIONS: Record<string, ToolHints> = {
  // Both hooks read the task and supervisor stores and nothing else — the
  // memory-drift check passes `ensureFiles: false` precisely so a read path
  // never scaffolds files (§5: "two file reads, no walks", MCP-9).
  _Stop: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  _PostCompact: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export interface ToolCatalogEntry {
  name: string;
  category: ToolCategory;
  description: string;
  keywords: string[];
  /**
   * The client-facing safety hints for this tool. Declared here, next to the
   * category and keywords, so there is exactly one place per tool — adding a
   * parallel annotation map is how MCP-13 happened the first time.
   */
  annotations: ToolHints;
}

/**
 * The `search_tools` catalog — the discovery surface for every registered tool.
 *
 * This is a hand-maintained mirror of what `index.ts` registers, and it drifted
 * 11 tools behind (MCP-13): an agent searching for `build_repo_map`,
 * `verify_edit`, or any of the review/competitive routing tools was told they
 * did not exist. `observability_tools.test.ts` now derives the registered set by
 * driving the real `register*` functions and fails on any tool missing here or
 * any entry here naming a tool nobody registers, so it cannot drift again.
 *
 * The only permitted omissions are the deliberately hidden lifecycle hooks
 * (`_Stop`, `_PostCompact`), which are named as an explicit exemption in that
 * test — they are called by a hook-aware harness, never discovered by an agent.
 * Prompt formatters (continuation, handoff, review, memory compaction) are
 * skills, not tools, so they are neither registered nor cataloged.
 *
 * ## Why this stays curated instead of being derived from the registrations
 *
 * The obvious next step is to delete this list and read name + description
 * straight off the registrations, since the drift test already drives every
 * `register*` export against a recording server. It was measured against the
 * real registrations and rejected on three
 * counts:
 *
 * 1. **Keywords do not exist there.** 55 of the 183 catalog keywords (30%)
 *    appear nowhere in the corresponding registration description — they are
 *    the synonyms an agent actually searches with: `fanout`, `diversity`,
 *    `second-opinion`, `backlog`, `todo`, `queue`, `lookup`, `compare`,
 *    `takeover`, `availability`. Keyword hits score 3 against 1 for a body
 *    match, so derivation would both lose the hit and demote what remains.
 * 2. **Category does not exist there either.** Nothing in a registration names
 *    one, and the fallback — infer it from the module — does not survive
 *    contact: `agent_tools.ts` re-exports `agent_profile_tools` and
 *    `agent_memory_tools`, `supervisor_tools.ts` aggregates three modules, and
 *    several tools are therefore registered from two files at once.
 * 3. **Registration prose is the wrong shape for a result list.** It is written
 *    for a model about to *call* the tool: 2.64x the bytes of this catalog
 *    (8,095 vs 3,070 across the same 45 tools), median 95 chars, and up to 762
 *    for `route_competitive_task` — a paragraph of usage doctrine per search
 *    hit, which is exactly what a discovery surface must not return.
 *
 * So the parallel list stays, and the MCP-13 drift tests are the guard that
 * makes it safe. Do not re-litigate without new numbers.
 */
export const TOOL_CATALOG: ToolCatalogEntry[] = [
  {
    name: "list_platforms",
    category: "routing",
    description: "List tiers, hosts, execution policy, and hardware metadata from the registry",
    keywords: ["inventory", "registry", "hosts", "tiers"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "check_health",
    category: "observability",
    description:
      "Ping configured model endpoints and report reachability, latency, and — where the host can be asked — the models it currently has loaded and its VRAM pressure. Optional include flags also return live model catalogs, local hardware detection, and OpenAI-compat probes.",
    keywords: [
      "latency",
      "health",
      "ping",
      "availability",
      "resident",
      "loaded",
      "vram",
      "memory",
      "models",
      "catalog",
      "hardware",
      "probe",
      "compatibility",
    ],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "route_task",
    category: "routing",
    description:
      "Recommend best tier, host, and model. Optional mode: default, watchdog, architect-editor, competitive, review",
    keywords: [
      "route",
      "single",
      "placement",
      "watchdog",
      "failover",
      "architect",
      "editor",
      "competitive",
      "fanout",
      "review",
      "reviewer",
      "diversity",
    ],
    // Reads a live registry. Watchdog mode also probes hosts, so this is open-world.
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "route_parallel_tasks",
    category: "routing",
    description: "Schedule many tasks across hosts with capacity-aware wave planning",
    keywords: ["parallel", "schedule", "waves", "capacity"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "supervisor_start_session",
    category: "supervisor",
    description: "Start supervised execution state with fallback queue",
    keywords: ["session", "start", "recovery"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "supervisor_record_event",
    category: "supervisor",
    description: "Record canonical lifecycle events and update session state",
    keywords: ["event", "state", "transition"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "supervisor_tick",
    category: "supervisor",
    description: "Detect stalls and advance cooldown or fallback",
    keywords: ["tick", "stall", "backoff", "fallback"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "supervisor_abort_session",
    category: "supervisor",
    description: "Interrupt active supervised session",
    keywords: ["abort", "interrupt"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "supervisor_record_completion_check",
    category: "supervisor",
    description: "Record deterministic completion evidence and independent judge verdict",
    keywords: ["completion", "evidence", "judge", "qa"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "supervisor_complete_session",
    category: "supervisor",
    description: "Finalize supervised session outcome with validation gates",
    keywords: ["complete", "terminal", "outcome"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "supervisor_status",
    category: "supervisor",
    description: "Inspect sessions and circuit-breaker state",
    keywords: ["status", "breaker", "summary"],
    // Judgment call. This is a status poll, but it does write in one case: when
    // pruning actually expired something it persists the pruned store (MCP-1
    // narrowed it to exactly that case, so a poll can no longer truncate). The
    // write is TTL garbage collection of records already past their deadline,
    // never a caller-visible mutation, and any other supervisor call would have
    // done the same collection. So it is annotated as the read it is.
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "search_tools",
    category: "observability",
    description: "Search the MCP tool catalog by intent, name, and keywords",
    keywords: ["discover", "catalog", "search", "tooling"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "task_create",
    category: "tasks",
    description: "Create a persistent task record",
    keywords: ["task", "create", "todo", "queue"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "task_get",
    category: "tasks",
    description: "Fetch one persistent task by ID",
    keywords: ["task", "read", "lookup"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "task_update",
    category: "tasks",
    description: "Update task status and metadata",
    keywords: ["task", "update", "status", "blockers"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "task_list",
    category: "tasks",
    description: "List persistent tasks with filtering",
    keywords: ["task", "list", "filter", "backlog"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "task_suspend",
    category: "tasks",
    description: "Suspend a task with checkpoint metadata for resumption",
    keywords: ["task", "suspend", "checkpoint", "resume"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "task_resume",
    category: "tasks",
    description: "Resume a suspended or blocked task with a generated continuation directive",
    keywords: ["task", "resume", "continuation", "worktree"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "agent_list_profiles",
    category: "agents",
    description:
      "List effective agent policies merged from repo and user config, including validation findings",
    keywords: ["agent", "profile", "policy", "config", "validate", "lint"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "agent_preflight",
    category: "agents",
    description:
      "Validate required MCP servers and tool policy for an agent; pass candidateTools to filter a tool set",
    keywords: ["agent", "mcp", "required", "preflight", "tools", "allow", "deny"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "agent_memory_get",
    category: "agents",
    description:
      "Read persistent memory for an agent by scope, including snapshot sync status and drift",
    keywords: ["agent", "memory", "scope", "read", "snapshot", "drift"],
    // Judgment call, shared with the former snapshot-status and compaction
    // prompt tools: agent_memory_get calls ensureMemoryEntrypoint,
    // which creates an empty MEMORY.md when one is absent. That is scaffolding
    // a first read cannot avoid, not a change to anything the caller can
    // observe, and it converges after one call — so these stay reads. `_Stop`
    // takes the stricter line for the same check (ensureFiles: false) because
    // it runs under a hard latency budget, not because the write is unsafe.
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "agent_memory_append",
    category: "agents",
    description: "Append persistent memory notes for an agent by scope",
    keywords: ["agent", "memory", "append", "continuity"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "agent_memory_snapshot_sync",
    category: "agents",
    description: "Write or apply memory snapshots for an agent scope",
    keywords: ["agent", "memory", "snapshot", "sync"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "record_telemetry",
    category: "observability",
    description: "Record a telemetry event with lane, tokensIn, tokensOut, and costUsd",
    keywords: ["telemetry", "cost", "tokens", "lane", "usage"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "supervisor_force_synthesis",
    category: "supervisor",
    description:
      "Mark a session force_synthesized and demand a best-effort answer from existing evidence with explicit gaps and confidence",
    keywords: ["synthesis", "forced", "budget", "terminal", "partial"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "agent_memory_mark_superseded",
    category: "agents",
    description:
      "Mark memory entries as superseded by abstracted rules, annotated in place and never deleted (compare-and-swap on expectedHash)",
    keywords: ["agent", "memory", "superseded", "compaction", "rules"],
    // The one writer that is both non-destructive and idempotent, and both for
    // the same reason: entries are annotated in place and never deleted, so
    // re-marking the same ids reports them as alreadySuperseded and changes no
    // content. Contrast agent_memory_snapshot_sync, which overwrites a whole
    // file and is destructive.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "build_repo_map",
    category: "context",
    description:
      "Return the most relevant slice of a codebase for a token budget, ranked by git recency, path proximity, and reference counts, with an `omissions` report naming every excluded class (ignored, unreadable, oversized, binary, empty, dropped-for-budget, truncated) — though the absence of an omission is not a completeness guarantee",
    keywords: ["repo", "map", "context", "budget", "files", "codebase", "omissions"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "verify_edit",
    category: "verification",
    description:
      "Run the project's linter and/or tests after an edit and return structured pass/fail with a bounded failure payload",
    keywords: ["verify", "lint", "test", "check", "edit", "gate"],
    // The only tool here that spawns a process, and the command is
    // caller-supplied. `destructive` and `openWorld` are the honest reading
    // rather than the cautious one: the allowlist includes `node` and `npx`,
    // which is arbitrary execution (MCP-15), and a test suite routinely touches
    // the working tree and the network. Not idempotent — it also writes a
    // capture into the scratch ring on every truncated run.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "finding_record",
    category: "evidence",
    description:
      "Record a result or finding; lane policy decides confirmed vs incubator vs diagnostic",
    keywords: ["finding", "evidence", "lane", "incubator", "confirmed", "diagnostic", "canary"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "finding_list",
    category: "evidence",
    description: "List recorded findings by lane, generation, task, or parent-eligibility",
    keywords: ["finding", "evidence", "list", "lane", "frontier"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "generation_open",
    category: "evidence",
    description:
      "Open a research generation for a task cohort after an unchanged-tree canary when required",
    keywords: ["generation", "cohort", "canary", "open", "research"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "generation_close",
    category: "evidence",
    description: "Commit a generation boundary so late evidence cannot rewrite membership",
    keywords: ["generation", "close", "boundary", "cutoff", "agenda"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "generation_status",
    category: "evidence",
    description: "Inspect a generation's committed findings, late signals, and agenda",
    keywords: ["generation", "status", "frontier", "late"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

/** name -> hints, built once from the two declaration sites above. */
const TOOL_HINTS_BY_NAME: ReadonlyMap<string, ToolHints> = new Map<string, ToolHints>([
  ...TOOL_CATALOG.map((entry) => [entry.name, entry.annotations] as const),
  ...Object.entries(HIDDEN_TOOL_ANNOTATIONS),
]);

/**
 * The declared hints for `name`, or `null` when nobody declared any.
 *
 * The null is what the drift test asserts against — `toolAnnotations` can never
 * return it, so this is the only way to tell "declared as a writer" apart from
 * "never declared and silently defaulted to a writer".
 */
export function lookupToolAnnotations(name: string): ToolHints | null {
  return TOOL_HINTS_BY_NAME.get(name) ?? null;
}

/** Catalog entries `search_tools` may advertise on the current surface. */
export function catalogForSurface(
  surface: ReturnType<typeof resolveToolSurface> = resolveToolSurface()
): ToolCatalogEntry[] {
  if (surface === "full") return TOOL_CATALOG;
  return TOOL_CATALOG.filter((entry) => toolAllowedOnSurface(entry.name, surface));
}

/**
 * The hints to hand `server.registerTool`. Every registration site calls this
 * rather than spelling its own object inline, so the catalog is the only place
 * a hint is ever written and the drift test only has one list to check.
 */
export function toolAnnotations(name: string): ToolHints {
  return lookupToolAnnotations(name) ?? FAIL_SAFE_TOOL_HINTS;
}

export function registerObservabilityTools(server: McpServer, deps: ObservabilityToolDeps): void {
  server.registerTool(
    "list_platforms",
    {
      description:
        "List all platform tiers, hosts, and their configuration from the xx-stack registry",
      inputSchema: {},
      annotations: toolAnnotations("list_platforms"),
    },
    // MCP-DUP-3: the same shaping `xx platforms` renders, from one module.
    async () => jsonContent(summarizePlatforms(await deps.loadRegistry()))
  );

  server.registerTool(
    "check_health",
    {
      description:
        "Check health and latency of all configured model endpoints in the platform registry. " +
        "Hosts that support resident-model inspection (Ollama runtimes in the current registry) " +
        "also report residentModels and memoryPressure; the absence of those fields means the " +
        "host cannot be asked, not that it is idle. Pass include to also fetch live model catalogs, " +
        "local hardware, or an OpenAI-compat probe.",
      inputSchema: {
        include: z
          .array(z.enum(["models", "hardware", "probe"]))
          .optional()
          .describe("Optional extra reports: live model catalogs, local hardware, compat probe"),
        hostId: z.string().optional().describe("probe: host ID from the platform registry"),
        endpoint: z.string().optional().describe("probe: endpoint override when hostId is omitted"),
        provider: z.string().optional().describe("probe: provider label for an endpoint override"),
        model: z.string().optional().describe("probe: model override for chat/json probes"),
      },
      annotations: toolAnnotations("check_health"),
    },
    async ({ include, hostId, endpoint, provider, model }) => {
      const registry = await deps.loadRegistry();
      const extras = new Set(include ?? []);
      const payload: Record<string, unknown> = {
        health: await diagnoseHosts(registry),
      };

      if (extras.has("models")) {
        const allHosts = registry.tiers.flatMap((tier) =>
          tier.hosts
            .filter(
              (host) =>
                host.enabled !== false &&
                (host.endpoint.startsWith("http://") || host.endpoint.startsWith("https://"))
            )
            .map((host) => ({ tier, host }))
        );
        payload.models = await Promise.all(
          allHosts.map(async ({ tier, host }) => {
            const models = await fetchHostModels(host);
            return {
              tier: tier.id,
              host: host.id,
              endpoint: host.endpoint,
              provider: host.provider,
              endpointFamily: endpointFamilyForHost(host),
              models: models.length > 0 ? models : (host.models ?? []),
              source: models.length > 0 ? "live" : "registry-cache",
            };
          })
        );
      }

      if (extras.has("hardware")) {
        payload.hardware = await deps.detectHardware();
      }

      if (extras.has("probe") || hostId || endpoint) {
        let host: Host | null = null;
        if (hostId) {
          for (const tier of registry.tiers) {
            const matched = tier.hosts.find((candidate) => candidate.id === hostId);
            if (matched) {
              host = matched;
              break;
            }
          }
          if (!host) {
            payload.probe = { error: `hostId not found: ${hostId}` };
          }
        } else if (endpoint) {
          host = {
            id: "manual-endpoint",
            label: "Manual endpoint",
            provider: provider ?? "openai-compatible",
            endpoint,
            models: model ? [{ name: model }] : [],
          };
        } else if (extras.has("probe")) {
          payload.probe = { error: "provide hostId or endpoint" };
        }
        if (host) {
          payload.probe = await probeHostEndpointCompatibility(host, model ?? null);
        }
      }

      return jsonContent(extras.size === 0 && !hostId && !endpoint ? payload.health : payload);
    }
  );

  server.registerTool(
    "record_telemetry",
    {
      description:
        "Record a telemetry event with token usage and cost. Appends to the JSONL telemetry stream " +
        "and awaits that append before returning, so the event is on its way to disk before the " +
        'caller proceeds. A telemetry failure never fails this call — status stays "accepted" — ' +
        'but it is never hidden either: "durability" is "best-effort" when the append completed, ' +
        '"failed" (with a reason) when the writer reported an I/O error, and "none" when the ' +
        'writer itself threw, which is reported as status "error". "writer" carries the ' +
        "process-lifetime failure count when earlier writes have failed.",
      inputSchema: {
        skill: z.string().describe("Skill or operation name"),
        outcome: z
          .enum(["success", "failure", "error", "timeout", "cancelled"])
          .describe("Outcome of the operation"),
        durationMs: z.number().int().min(0).describe("Duration in milliseconds"),
        lane: z.string().optional().describe("Routing lane (e.g. local, cloud, tailscale-ollama)"),
        tokensIn: z.number().int().min(0).optional().describe("Input tokens consumed"),
        tokensOut: z.number().int().min(0).optional().describe("Output tokens generated"),
        model: z.string().optional().describe("Model name for cost estimation"),
        costUsd: z
          .number()
          .min(0)
          .optional()
          .describe("Override cost in USD. If omitted, estimated from model-rates.json"),
        sessionId: z.string().optional().describe("Optional session ID for per-session log stream"),
      },
      annotations: toolAnnotations("record_telemetry"),
    },
    async ({
      skill,
      outcome,
      durationMs,
      lane,
      tokensIn,
      tokensOut,
      model,
      costUsd,
      sessionId,
    }) => {
      let finalCostUsd: number | null = costUsd ?? null;

      // Auto-estimate cost from model rates if not explicitly provided
      if (finalCostUsd === null && (tokensIn !== undefined || tokensOut !== undefined)) {
        const ratesFile = await deps.loadModelRates();
        const estimated = lookupModelCost(
          ratesFile.rates,
          model ?? null,
          tokensIn ?? 0,
          tokensOut ?? 0
        );
        if (estimated !== null) {
          finalCostUsd = estimated;
        }
        // Unknown model: finalCostUsd stays null (never zero)
      }

      const payload: Record<string, unknown> = {
        skill,
        outcome,
        durationMs,
      };

      if (lane !== undefined) payload.lane = lane;
      if (tokensIn !== undefined) payload.tokensIn = tokensIn;
      if (tokensOut !== undefined) payload.tokensOut = tokensOut;
      if (finalCostUsd !== null) payload.costUsd = finalCostUsd;
      if (model !== undefined) payload.model = model;

      // MCP-16: this used to be `void deps.logEvent(...)` followed by an
      // unconditional "recorded". Nothing ordered the append against shutdown,
      // so a server that exited right after the call lost the event outright,
      // and a rejected write became an unhandled rejection. Awaiting costs
      // nothing — logEvent is already async.
      //
      // §11.1 asked whether a telemetry write failure should be able to fail a
      // caller's operation. It should not: this is an observability sink, and a
      // metrics failure taking down routing would be absurd. So the policy is
      // "never fail the caller, never hide the failure" — the three outcomes
      // below are distinguished in the payload instead of collapsed into one
      // cheerful "accepted / best-effort".
      let threwError: string | null = null;
      let writeResult: LogEventResult | void = undefined;
      try {
        writeResult = await deps.logEvent(
          sessionId ? { session: sessionId } : "server",
          "telemetry.record",
          payload
        );
      } catch (error) {
        // The writer broke its own never-throw contract. Distinct from a
        // reported failure, and worth saying so loudly.
        threwError = error instanceof Error ? error.message : String(error);
      }

      // A writer that reports nothing is honoring the old void contract; treat
      // its silence as the best-effort claim it used to make implicitly.
      const reported = writeResult ?? null;
      const reportedFailure =
        reported !== null && reported.ok === false
          ? (reported.error ?? `telemetry write ${reported.outcome}`)
          : null;

      const failureReason = threwError ?? reportedFailure;
      const health = deps.telemetryHealth?.();

      return jsonContent({
        // "accepted", not "recorded": the append was awaited, but a telemetry
        // I/O error is non-fatal by design, so this tool cannot claim the bytes
        // reached disk. `durability` says which of the three happened rather
        // than letting the status imply a guarantee nothing provides.
        status: threwError === null ? "accepted" : "error",
        durability:
          threwError !== null ? "none" : reportedFailure !== null ? "failed" : "best-effort",
        ...(failureReason === null ? {} : { error: failureReason }),
        // Failures from every *other* logEvent call site are fire-and-forget
        // (`void logEvent(...)`), so this counter is the only place they ever
        // surface. Omitted while it is zero to keep the common payload small.
        ...(health && health.failures > 0
          ? {
              writer: {
                failures: health.failures,
                lastError: health.lastError,
                lastFailureAt: health.lastFailureAt,
              },
            }
          : {}),
        fields: Object.keys(payload),
        costUsd: finalCostUsd,
        costSource:
          costUsd !== undefined
            ? "explicit"
            : finalCostUsd !== null
              ? "estimated"
              : "unknown-model",
      });
    }
  );

  server.registerTool(
    "search_tools",
    {
      description: "Search xx-stack MCP tools by name, category, description, and keywords",
      inputSchema: {
        query: z.string().optional().describe("Optional natural language query"),
        // Derived from TOOL_CATEGORIES so the filter can never accept a value the
        // catalog does not use, or reject one it does.
        category: z.enum(TOOL_CATEGORIES).optional().describe("Optional category filter"),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum results to return"),
      },
      annotations: toolAnnotations("search_tools"),
    },
    async ({ query, category, limit }) => {
      const tokens = (query ?? "")
        .toLowerCase()
        .split(/[^a-z0-9_-]+/)
        .map((token) => token.trim())
        .filter(Boolean);

      const filtered = catalogForSurface()
        .filter((entry) => !category || entry.category === category)
        .map((entry) => {
          const haystack = [entry.name, entry.description, ...entry.keywords]
            .join(" ")
            .toLowerCase();
          const score =
            tokens.length === 0
              ? 1
              : tokens.reduce((sum, token) => {
                  if (entry.name === token) return sum + 8;
                  if (entry.name.includes(token)) return sum + 5;
                  if (entry.keywords.some((keyword) => keyword.includes(token))) return sum + 3;
                  if (haystack.includes(token)) return sum + 1;
                  return sum;
                }, 0);
          return { ...entry, score };
        })
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));

      const capped = filtered
        .slice(0, limit ?? 15)
        .map(({ score, ...entry }) => ({ ...entry, matchScore: score }));

      return jsonContent({
        query: query ?? "",
        category: category ?? "all",
        totalMatches: filtered.length,
        returned: capped.length,
        tools: capped,
      });
    }
  );
}
