#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import assert from "node:assert/strict";

import { routeParallelTasks } from "./routing_runtime.js";
import {
  PATH_CONSTANTS,
  TIER_IDS,
  repoCompatFileCandidates,
  liveConfigPath,
  liveRegistryPath,
} from "./runtime_constants.js";

type Host = {
  id: string;
  endpoint?: string;
  reachable?: boolean;
  executionPolicy?: {
    maxParallelSlices?: number;
    maxConcurrentModels?: number;
  };
};

type Tier = {
  id: string;
  hosts?: Host[];
};

type Registry = {
  tiers?: Tier[];
};

type Config = {
  agent?: Record<
    string,
    {
      mode?: string;
      model?: string;
    }
  >;
};

function resolveRegistryPath(): string {
  const cwd = process.cwd();
  const workspaceCandidates = repoCompatFileCandidates(cwd, PATH_CONSTANTS.platformsFile);
  for (const candidate of workspaceCandidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  const home = os.homedir();
  const candidates = [liveRegistryPath(home), workspaceCandidates[0]];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function resolveConfigPath(): string {
  const cwd = process.cwd();
  const candidates = repoCompatFileCandidates(cwd, PATH_CONSTANTS.configFile);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return liveConfigPath();
}

function effectiveCapacity(host: Host): number {
  return Math.max(
    1,
    Math.min(
      Number(host.executionPolicy?.maxParallelSlices ?? 1),
      Number(host.executionPolicy?.maxConcurrentModels ?? 1)
    )
  );
}

/** Same default the preflight uses; a hung endpoint must not stall the run. */
const FETCH_TIMEOUT_MS = 5000;

async function fetchModelCount(endpoint: string): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, "")}/api/tags`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    return Array.isArray(data?.models) ? data.models.length : 0;
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const registryPath = resolveRegistryPath();
  const configPath = resolveConfigPath();
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8")) as Registry;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Config;

  const agent = config.agent?.["parallel-execution-orchestrator"];
  assert.ok(agent, "parallel-execution-orchestrator agent is missing in config");
  assert.equal(agent?.mode, "primary", "parallel-execution-orchestrator must be primary mode");

  const remoteTier = (registry.tiers ?? []).find((tier) => tier.id === TIER_IDS.tailscaleOllama);
  assert.ok(remoteTier, `${TIER_IDS.tailscaleOllama} tier is missing`);
  const remoteHosts = (remoteTier?.hosts ?? []).filter((host) =>
    (host.endpoint ?? "").startsWith("http")
  );
  assert.ok(remoteHosts.length >= 2, `at least two ${TIER_IDS.tailscaleOllama} hosts are required`);

  const healthResults: Array<{ hostId: string; modelCount: number; endpoint: string }> = [];
  for (const host of remoteHosts) {
    const endpoint = host.endpoint ?? "";
    const modelCount = await fetchModelCount(endpoint);
    assert.ok(modelCount > 0, `host ${host.id} has no models visible at ${endpoint}`);
    healthResults.push({ hostId: host.id, modelCount, endpoint });
  }

  const totalCapacity = remoteHosts.reduce((sum, host) => sum + effectiveCapacity(host), 0);
  assert.ok(totalCapacity >= 4, `expected total remote capacity >= 4, got ${totalCapacity}`);

  const syntheticTasks = [
    "delegate parallel research on architecture options",
    "parallel subagent deep reasoning on tradeoffs",
    "delegate multi-step analysis for migration risk",
    "parallel overflow synthesis for implementation plan",
    "delegate broad research and investigate regressions",
    "parallel subagent review of reliability constraints",
    "delegate long-context analysis of codebase risks",
    "parallel reasoning and architecture decision memo",
  ];

  const schedule = routeParallelTasks(syntheticTasks, registry as never);
  const assignments = schedule.assignments.filter(
    (item: Record<string, unknown>) => item.status !== "unassigned"
  );
  assert.equal(assignments.length, syntheticTasks.length, "all synthetic tasks must be assigned");

  const remoteAssignments = assignments.filter(
    (item: Record<string, unknown>) => item.tier === TIER_IDS.tailscaleOllama
  );
  assert.ok(
    remoteAssignments.length >= 6,
    `most delegation tasks should route to ${TIER_IDS.tailscaleOllama} tier`
  );

  const wave1 = remoteAssignments.filter((item: Record<string, unknown>) => item.wave === 1);
  const distinctWave1Hosts = new Set(wave1.map((item: Record<string, unknown>) => item.host));
  assert.ok(distinctWave1Hosts.size >= 2, "wave 1 should utilize both remote hosts");

  const hostUtilization = schedule.hostUtilization.filter(
    (item: Record<string, unknown>) => item.tier === TIER_IDS.tailscaleOllama
  );
  for (const utilization of hostUtilization) {
    assert.ok(
      Number(utilization.parallelCapacity) >= 2,
      `host ${utilization.host} parallel capacity should be >= 2 for max throughput`
    );
  }

  console.log("parallel smoke tests passed");
  console.log(`registry: ${registryPath}`);
  console.log(`config: ${configPath}`);
  console.log(`remote-capacity-total: ${totalCapacity}`);
  console.log(`remote-hosts-checked: ${healthResults.length}`);
  for (const health of healthResults) {
    console.log(`- ${health.hostId}: models=${health.modelCount} endpoint=${health.endpoint}`);
  }
  console.log(`remote-wave1-hosts: ${[...distinctWave1Hosts].join(", ")}`);
  console.log(`remote-assignment-count: ${remoteAssignments.length}/${assignments.length}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`parallel-smoke failed: ${message}`);
  process.exit(1);
});
