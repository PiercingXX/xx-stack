/**
 * Shaping for the platform-inspection surface, shared by the MCP tools and the
 * CLI (MCP-DUP-3).
 *
 * `list_platforms` / `xx platforms` and `check_health` / `xx diagnose` used to
 * be byte-identical copies living in observability_tools.ts and cli.ts, with
 * tests on the CLI copy only — so the tool copy could drift with nothing to
 * catch it. Both sides now call these functions, which makes a one-sided
 * behavior change impossible rather than merely discouraged.
 */

import type { HostMemoryPressure } from "./host_memory_runtime.js";
import type { Host, Registry } from "./platform_types.js";
import {
  endpointFamilyForHost,
  fetchResidentModels,
  pingHostEndpoint,
  type ResidentModel,
} from "./routing_runtime.js";
import { laneMemoryPressure } from "./routing_selection_runtime.js";

export interface PlatformsSummary {
  selectionPolicy: Registry["selectionPolicy"];
  tiers: Array<Record<string, unknown>>;
}

/** The exact `{ selectionPolicy, tiers }` payload list_platforms returns. */
export function summarizePlatforms(registry: Registry): PlatformsSummary {
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
  /**
   * Models the host currently has loaded, and what that costs it. Present only
   * for a reachable host that can be asked — `capabilities`
   * `.supportsResidentModelInspection` is true today for Ollama runtimes only.
   * Absent means "not inspectable", never "nothing loaded"; a host that answers
   * with nothing resident reports an empty array.
   */
  residentModels?: string[];
  memoryPressure?: HostMemoryPressure;
}

/**
 * Ping every host in the registry — the disabled / non-HTTP / ping shaping the
 * check_health MCP tool returns. `ping` and `fetchResident` are injectable for
 * tests; both real callers use the defaults from routing_runtime.
 *
 * The defaults swallow their own network errors, but they are injectable — and
 * `Promise.all` would let a single rejection fail the whole diagnose — so each
 host's live work is isolated: a throwing probe degrades only its own host to
 an "unreachable" result with the failure as the reason.
 */
export async function diagnoseHosts(
  registry: Registry,
  ping: (host: Host) => Promise<{ ok: boolean; latencyMs: number }> = pingHostEndpoint,
  fetchResident: (host: Host) => Promise<ResidentModel[] | null> = fetchResidentModels
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
      try {
        const result = await ping(host);
        // Only a reachable, inspectable host is asked; for everything else
        // fetchResident returns null without dialling and both fields stay off
        // the result entirely.
        const resident = result.ok ? await fetchResident(host) : null;
        const pressure = laneMemoryPressure(host, resident);
        return {
          tier: tier.id,
          host: host.id,
          endpoint: host.endpoint,
          provider: host.provider,
          endpointFamily: endpointFamilyForHost(host),
          status: result.ok ? "healthy" : "unreachable",
          latencyMs: result.latencyMs,
          ...(resident ? { residentModels: resident.map((model) => model.name) } : {}),
          ...(pressure ? { memoryPressure: pressure } : {}),
        };
      } catch (error) {
        return {
          tier: tier.id,
          host: host.id,
          status: "unreachable",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    })
  );
}
