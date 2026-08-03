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

import type { Host, Registry } from "./platform_types.js";
import { endpointFamilyForHost, pingHostEndpoint } from "./routing_runtime.js";

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
}

/**
 * Ping every host in the registry — the disabled / non-HTTP / ping shaping the
 * check_health MCP tool returns. `ping` is injectable for tests; both real
 * callers use the default pingHostEndpoint from routing_runtime.
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
