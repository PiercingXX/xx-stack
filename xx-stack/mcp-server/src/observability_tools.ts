import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

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
interface ObservabilityToolDeps {
  loadRegistry: () => Promise<Registry>;
  detectHardware: () => Promise<Record<string, unknown>>;
  logEvent: (
    stream: "server" | { session: string },
    type: string,
    payload: Record<string, unknown>
  ) => Promise<void>;
  loadModelRates: () => Promise<ModelRatesFile>;
}

export interface ToolCatalogEntry {
  name: string;
  category: "routing" | "supervisor" | "observability" | "tasks" | "agents";
  description: string;
  keywords: string[];
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
 */
export const TOOL_CATALOG: ToolCatalogEntry[] = [
  {
    name: "list_platforms",
    category: "routing",
    description: "List tiers, hosts, execution policy, and hardware metadata from the registry",
    keywords: ["inventory", "registry", "hosts", "tiers"],
  },
  {
    name: "check_health",
    category: "observability",
    description: "Ping configured model endpoints and report reachability and latency",
    keywords: ["latency", "health", "ping", "availability"],
  },
  {
    name: "list_models",
    category: "observability",
    description: "Fetch model catalogs from reachable model endpoints",
    keywords: ["models", "catalog", "tags"],
  },
  {
    name: "probe_endpoint_compatibility",
    category: "observability",
    description: "Validate OpenAI-compatible behavior for models, chat completions, and JSON mode",
    keywords: ["compatibility", "chat", "json", "probe"],
  },
  {
    name: "route_task",
    category: "routing",
    description: "Recommend best tier, host, and model for a single task",
    keywords: ["route", "single", "placement"],
  },
  {
    name: "route_parallel_tasks",
    category: "routing",
    description: "Schedule many tasks across hosts with capacity-aware wave planning",
    keywords: ["parallel", "schedule", "waves", "capacity"],
  },
  {
    name: "route_task_with_watchdog",
    category: "routing",
    description: "Route task with liveness checks and failover candidates",
    keywords: ["watchdog", "failover", "fallback", "liveness"],
  },
  {
    name: "supervisor_start_session",
    category: "supervisor",
    description: "Start supervised execution state with fallback queue",
    keywords: ["session", "start", "recovery"],
  },
  {
    name: "supervisor_record_event",
    category: "supervisor",
    description: "Record canonical lifecycle events and update session state",
    keywords: ["event", "state", "transition"],
  },
  {
    name: "supervisor_tick",
    category: "supervisor",
    description: "Detect stalls and advance cooldown or fallback",
    keywords: ["tick", "stall", "backoff", "fallback"],
  },
  {
    name: "supervisor_abort_session",
    category: "supervisor",
    description: "Interrupt active supervised session",
    keywords: ["abort", "interrupt"],
  },
  {
    name: "supervisor_record_completion_check",
    category: "supervisor",
    description: "Record deterministic completion evidence and independent judge verdict",
    keywords: ["completion", "evidence", "judge", "qa"],
  },
  {
    name: "supervisor_complete_session",
    category: "supervisor",
    description: "Finalize supervised session outcome with validation gates",
    keywords: ["complete", "terminal", "outcome"],
  },
  {
    name: "supervisor_status",
    category: "supervisor",
    description: "Inspect sessions and circuit-breaker state",
    keywords: ["status", "breaker", "summary"],
  },
  {
    name: "supervisor_emit_continuation_prompt",
    category: "supervisor",
    description: "Generate bounded continuation prompt for stalled work",
    keywords: ["continuation", "prompt", "stalled"],
  },
  {
    name: "supervisor_run_self_test",
    category: "supervisor",
    description: "Run deterministic reliability self-checks",
    keywords: ["self-test", "reliability", "validation"],
  },
  {
    name: "get_hardware",
    category: "observability",
    description: "Detect local CPU/RAM/GPU hardware for routing decisions",
    keywords: ["hardware", "gpu", "vram", "ram"],
  },
  {
    name: "search_tools",
    category: "observability",
    description: "Search the MCP tool catalog by intent, name, and keywords",
    keywords: ["discover", "catalog", "search", "tooling"],
  },
  {
    name: "task_create",
    category: "tasks",
    description: "Create a persistent task record",
    keywords: ["task", "create", "todo", "queue"],
  },
  {
    name: "task_get",
    category: "tasks",
    description: "Fetch one persistent task by ID",
    keywords: ["task", "read", "lookup"],
  },
  {
    name: "task_update",
    category: "tasks",
    description: "Update task status and metadata",
    keywords: ["task", "update", "status", "blockers"],
  },
  {
    name: "task_list",
    category: "tasks",
    description: "List persistent tasks with filtering",
    keywords: ["task", "list", "filter", "backlog"],
  },
  {
    name: "task_suspend",
    category: "tasks",
    description: "Suspend a task with checkpoint metadata for resumption",
    keywords: ["task", "suspend", "checkpoint", "resume"],
  },
  {
    name: "task_resume",
    category: "tasks",
    description: "Resume a suspended or blocked task with a generated continuation directive",
    keywords: ["task", "resume", "continuation", "worktree"],
  },
  {
    name: "agent_list_profiles",
    category: "agents",
    description: "List effective agent policies merged from repo and user config",
    keywords: ["agent", "profile", "policy", "config"],
  },
  {
    name: "agent_preflight",
    category: "agents",
    description: "Validate required MCP servers and tool policy for an agent",
    keywords: ["agent", "mcp", "required", "preflight"],
  },
  {
    name: "agent_filter_tools",
    category: "agents",
    description: "Filter a candidate tool set through agent allow and deny rules",
    keywords: ["agent", "tools", "allow", "deny"],
  },
  {
    name: "agent_validate_profiles",
    category: "agents",
    description: "Validate merged agent profiles and report policy/configuration issues",
    keywords: ["agent", "validate", "lint", "config"],
  },
  {
    name: "agent_memory_get",
    category: "agents",
    description: "Read persistent memory for an agent by scope",
    keywords: ["agent", "memory", "scope", "read"],
  },
  {
    name: "agent_memory_append",
    category: "agents",
    description: "Append persistent memory notes for an agent by scope",
    keywords: ["agent", "memory", "append", "continuity"],
  },
  {
    name: "agent_memory_snapshot_status",
    category: "agents",
    description: "Check memory snapshot sync status and drift for an agent scope",
    keywords: ["agent", "memory", "snapshot", "drift"],
  },
  {
    name: "agent_memory_snapshot_sync",
    category: "agents",
    description: "Write or apply memory snapshots for an agent scope",
    keywords: ["agent", "memory", "snapshot", "sync"],
  },
  {
    name: "build_coordinator_contract",
    category: "agents",
    description: "Generate a hardened coordinator worker contract prompt",
    keywords: ["coordinator", "contract", "worker", "prompt"],
  },
  {
    name: "record_telemetry",
    category: "observability",
    description: "Record a telemetry event with lane, tokensIn, tokensOut, and costUsd",
    keywords: ["telemetry", "cost", "tokens", "lane", "usage"],
  },
  {
    name: "route_architect_editor",
    category: "routing",
    description:
      "Recommend two lanes for a task: an architect lane for deep reasoning and an editor lane for fast execution",
    keywords: ["architect", "editor", "split", "deep", "fast", "pair"],
  },
  {
    name: "route_competitive_task",
    category: "routing",
    description:
      "Produce up to N distinct host/model lanes for competitive fan-out, one git worktree per lane",
    keywords: ["competitive", "fanout", "worktree", "lanes", "diversity"],
  },
  {
    name: "route_review",
    category: "routing",
    description:
      "Recommend a review lane whose model differs from the model that authored the work (reviewer diversity)",
    keywords: ["review", "reviewer", "diversity", "second-opinion"],
  },
  {
    name: "score_candidates",
    category: "routing",
    description:
      "Score candidate task descriptions against the tier keyword matcher and return a deterministic ranking with rationale",
    keywords: ["score", "rank", "candidates", "compare", "selection"],
  },
  {
    name: "supervisor_emit_handoff_prompt",
    category: "supervisor",
    description:
      "Emit a structured failover handoff prompt for the lane taking over: goal, state, decisions, traps, files, open work",
    keywords: ["handoff", "failover", "takeover", "prompt", "continuity"],
  },
  {
    name: "supervisor_force_synthesis",
    category: "supervisor",
    description:
      "Mark a session force_synthesized and demand a best-effort answer from existing evidence with explicit gaps and confidence",
    keywords: ["synthesis", "forced", "budget", "terminal", "partial"],
  },
  {
    name: "review_to_continuation",
    category: "supervisor",
    description:
      "Review uncommitted changes and emit a bounded continuation prompt with a mustAddress item for every review note",
    keywords: ["review", "continuation", "diff", "notes", "mustaddress"],
  },
  {
    name: "agent_memory_mark_superseded",
    category: "agents",
    description:
      "Mark memory entries as superseded by abstracted rules, annotated in place and never deleted (compare-and-swap on expectedHash)",
    keywords: ["agent", "memory", "superseded", "compaction", "rules"],
  },
  {
    name: "agent_memory_compaction_prompt",
    category: "agents",
    description:
      "Emit a deterministic distillation prompt plus candidate memory entries for rule abstraction",
    keywords: ["agent", "memory", "compaction", "distill", "prompt"],
  },
  {
    name: "build_repo_map",
    category: "observability",
    description:
      "Return the most relevant slice of a codebase for a token budget, ranked by git recency, path proximity, and reference counts",
    keywords: ["repo", "map", "context", "budget", "files", "codebase"],
  },
  {
    name: "verify_edit",
    category: "observability",
    description:
      "Run the project's linter and/or tests after an edit and return structured pass/fail with a bounded failure payload",
    keywords: ["verify", "lint", "test", "check", "edit", "gate"],
  },
];

export function registerObservabilityTools(server: McpServer, deps: ObservabilityToolDeps): void {
  server.tool(
    "list_platforms",
    "List all platform tiers, hosts, and their configuration from the xx-stack registry",
    {},
    // MCP-DUP-3: the same shaping `xx platforms` renders, from one module.
    async () => jsonContent(summarizePlatforms(await deps.loadRegistry()))
  );

  server.tool(
    "check_health",
    "Check health and latency of all configured model endpoints in the platform registry",
    {},
    // MCP-DUP-3: the same shaping `xx diagnose` renders, from one module.
    async () => jsonContent(await diagnoseHosts(await deps.loadRegistry()))
  );

  server.tool(
    "list_models",
    "List models available on all reachable model endpoints (provider-aware live query)",
    {},
    async () => {
      const registry = await deps.loadRegistry();
      const allHosts = registry.tiers.flatMap((tier) =>
        tier.hosts
          .filter(
            (host) =>
              host.enabled !== false &&
              (host.endpoint.startsWith("http://") || host.endpoint.startsWith("https://"))
          )
          .map((host) => ({ tier, host }))
      );
      const results = await Promise.all(
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
      return jsonContent(results);
    }
  );

  server.tool(
    "probe_endpoint_compatibility",
    "Probe endpoint compatibility for /v1/models, /v1/chat/completions, and JSON mode semantics",
    {
      hostId: z.string().optional().describe("Host ID from the platform registry"),
      endpoint: z
        .string()
        .optional()
        .describe("Optional endpoint override when hostId is not provided"),
      provider: z
        .string()
        .optional()
        .describe("Provider label for endpoint override (default: openai-compatible)"),
      model: z.string().optional().describe("Optional model override for chat/json probes"),
    },
    async ({ hostId, endpoint, provider, model }) => {
      const registry = await deps.loadRegistry();

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
          return jsonContent({ error: `hostId not found: ${hostId}` });
        }
      } else if (endpoint) {
        host = {
          id: "manual-endpoint",
          label: "Manual endpoint",
          provider: provider ?? "openai-compatible",
          endpoint,
          models: model ? [{ name: model }] : [],
        };
      } else {
        return jsonContent({ error: "provide hostId or endpoint" });
      }

      const result = await probeHostEndpointCompatibility(host, model ?? null);
      return jsonContent(result);
    }
  );

  server.tool(
    "get_hardware",
    "Detect local hardware (GPUs, VRAM, RAM) for routing decisions",
    {},
    async () => jsonContent(await deps.detectHardware())
  );

  server.tool(
    "record_telemetry",
    "Record a telemetry event with token usage and cost. Appends to the JSONL telemetry stream " +
      "and awaits that append before returning, so the event is on its way to disk before the " +
      "caller proceeds. Durability is best-effort: the telemetry writer treats I/O errors as " +
      'non-fatal, so status "accepted" means the append call completed, not that bytes are ' +
      'durable. A write that actively rejects is reported as status "error".',
    {
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
      // nothing — logEvent is already Promise<void>.
      let writeError: string | null = null;
      try {
        await deps.logEvent(
          sessionId ? { session: sessionId } : "server",
          "telemetry.record",
          payload
        );
      } catch (error) {
        writeError = error instanceof Error ? error.message : String(error);
      }

      return jsonContent({
        // "accepted", not "recorded": the append was awaited, but the telemetry
        // writer swallows I/O errors by design, so this tool cannot honestly
        // claim the bytes reached disk. `durability` says so out loud rather
        // than letting the status imply a guarantee nothing provides.
        status: writeError === null ? "accepted" : "error",
        durability: writeError === null ? "best-effort" : "none",
        ...(writeError === null ? {} : { error: writeError }),
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

  server.tool(
    "search_tools",
    "Search xx-stack MCP tools by name, category, description, and keywords",
    {
      query: z.string().optional().describe("Optional natural language query"),
      category: z
        .enum(["routing", "supervisor", "observability", "tasks", "agents"])
        .optional()
        .describe("Optional category filter"),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum results to return"),
    },
    async ({ query, category, limit }) => {
      const tokens = (query ?? "")
        .toLowerCase()
        .split(/[^a-z0-9_-]+/)
        .map((token) => token.trim())
        .filter(Boolean);

      const filtered = TOOL_CATALOG.filter((entry) => !category || entry.category === category)
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
