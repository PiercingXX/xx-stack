import { existsSync, readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Host, Registry } from "./platform_types.js";
import {
  endpointFamilyForHost,
  fetchHostModels,
  pingHostEndpoint,
  probeHostEndpointCompatibility,
} from "./routing_runtime.js";

import { jsonContent } from "./agent_tool_helpers.js";
import { logEvent } from "./log_worker.js";

// Telemetry config. Resolved relative to this module so the server
// can be relocated between components without editing source.
const TELEMETRY_CONFIG_CANDIDATES = [
  "../../runtime/telemetry.json",
  "../../../runtime/telemetry.json",
] as const;

interface TelemetryConfig {
  enabled: boolean;
  fields: string[];
}

let _telemetryConfig: TelemetryConfig | null = null;

function loadTelemetryConfig(): TelemetryConfig {
  if (_telemetryConfig) return _telemetryConfig;
  for (const candidate of TELEMETRY_CONFIG_CANDIDATES) {
    const url = new URL(candidate, import.meta.url);
    if (existsSync(url)) {
      _telemetryConfig = JSON.parse(readFileSync(url, "utf8")) as TelemetryConfig;
      return _telemetryConfig;
    }
  }
  _telemetryConfig = { enabled: false, fields: [] };
  return _telemetryConfig;
}
interface ObservabilityToolDeps {
  loadRegistry: () => Promise<Registry>;
  detectHardware: () => Promise<Record<string, unknown>>;
}

interface ToolCatalogEntry {
  name: string;
  category: "routing" | "supervisor" | "observability" | "tasks" | "agents";
  description: string;
  keywords: string[];
}

const TOOL_CATALOG: ToolCatalogEntry[] = [
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
];

// Rate table for cost estimation. Resolved relative to this module so the server
// can be relocated between components without editing source.
const RATE_TABLE_CANDIDATES = [
  "../../runtime/rate-table.json",
  "../../../runtime/rate-table.json",
] as const;

type RateTable = Record<string, number>;

let _rateTable: RateTable | null = null;

function loadRateTable(): RateTable {
  if (_rateTable) return _rateTable;
  for (const candidate of RATE_TABLE_CANDIDATES) {
    const url = new URL(candidate, import.meta.url);
    if (existsSync(url)) {
      _rateTable = JSON.parse(readFileSync(url, "utf8")) as RateTable;
      return _rateTable;
    }
  }
  _rateTable = {};
  return _rateTable;
}

/**
 * Compute estimated cost in USD for a given model and token counts.
 * Returns null when the model is not in the rate table (honest gap over
 * a misleading zero).
 */
function computeCostUsd(model: string | null, tokensIn: number, tokensOut: number): number | null {
  if (!model) return null;
  const rate = loadRateTable()[model];
  if (rate === undefined) return null;
  // Rate is USD per 1K tokens (input+output combined at the same rate).
  return rate * ((tokensIn + tokensOut) / 1000);
}

/**
 * Log a telemetry event with per-lane usage and cost fields.
 *
 * The event is written to the existing server JSONL sink via logEvent.
 * Cost is an estimate computed from the static rate table; if the model
 * is not in the table, costUsd is null.
 */
// Test-only export to verify telemetry config loading without side effects.
export function __testLoadTelemetryConfig(): TelemetryConfig {
  return loadTelemetryConfig();
}

export async function logTelemetry(params: {
  lane: string;
  skill: string;
  outcome: string;
  durationMs: number;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
}): Promise<void> {
  const config = loadTelemetryConfig();
  if (!config.enabled) return;

  const costUsd = computeCostUsd(params.model, params.tokensIn, params.tokensOut);
  void logEvent("server", "skill.run", {
    ts: new Date().toISOString(),
    skill: params.skill,
    outcome: params.outcome,
    durationMs: params.durationMs,
    lane: params.lane,
    tokensIn: params.tokensIn,
    tokensOut: params.tokensOut,
    costUsd,
    model: params.model,
  });
}

export function registerObservabilityTools(server: McpServer, deps: ObservabilityToolDeps): void {
  server.tool(
    "list_platforms",
    "List all platform tiers, hosts, and their configuration from the xx-stack registry",
    {},
    async () => {
      const registry = await deps.loadRegistry();
      const summary = registry.tiers.map((tier) => ({
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

      return jsonContent({
        selectionPolicy: registry.selectionPolicy,
        tiers: summary,
      });
    }
  );

  server.tool(
    "check_health",
    "Check health and latency of all configured model endpoints in the platform registry",
    {},
    async () => {
      const registry = await deps.loadRegistry();
      const allHosts = registry.tiers.flatMap((tier) => tier.hosts.map((host) => ({ tier, host })));
      const results = await Promise.all(
        allHosts.map(async ({ tier, host }) => {
          if (host.enabled === false) {
            return { tier: tier.id, host: host.id, status: "disabled" };
          }
          if (!host.endpoint.startsWith("http://") && !host.endpoint.startsWith("https://")) {
            return {
              tier: tier.id,
              host: host.id,
              status: "skipped",
              reason: "not an HTTP endpoint",
            };
          }
          const ping = await pingHostEndpoint(host);
          return {
            tier: tier.id,
            host: host.id,
            endpoint: host.endpoint,
            provider: host.provider,
            endpointFamily: endpointFamilyForHost(host),
            status: ping.ok ? "healthy" : "unreachable",
            latencyMs: ping.latencyMs,
          };
        })
      );
      return jsonContent(results);
    }
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
