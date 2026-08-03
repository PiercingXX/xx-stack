import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  bytesToGb,
  computeHostMemoryPressure,
  contextHeadroomGb,
  estimatedFreeGb,
  isOverloaded,
  residentModelVramGb,
  usableVramGb,
} from "./host_memory_runtime.js";

const execFileAsync = promisify(execFile);
const GB = 1073741824;

// --- the arithmetic itself -------------------------------------------------

test("bytesToGb rounds to one decimal and treats absent sizes as zero", () => {
  assert.equal(bytesToGb(18 * GB), 18);
  assert.equal(bytesToGb(6.54 * GB), 6.5);
  assert.equal(bytesToGb(0), 0);
  assert.equal(bytesToGb(null), 0);
  assert.equal(bytesToGb(undefined), 0);
  assert.equal(bytesToGb(Number.NaN), 0);
});

test("residentModelVramGb prefers the on-card figure over the total", () => {
  assert.equal(residentModelVramGb({ size: 20 * GB, size_vram: 18 * GB }), 18);
  // size_vram of 0 means nothing is on the card; fall back to the total size,
  // which is what a partially offloaded model reports.
  assert.equal(residentModelVramGb({ size: 20 * GB, size_vram: 0 }), 20);
  assert.equal(residentModelVramGb({ size: 20 * GB }), 20);
  assert.equal(residentModelVramGb({}), 0);
});

test("usableVramGb subtracts the reserve, and an unknown card stays zero", () => {
  assert.equal(usableVramGb(48, 25), 36);
  assert.equal(usableVramGb(24, 0), 24);
  assert.equal(usableVramGb(0, 25), 0, "no reported VRAM is unknown, not 0% of something");
});

test("contextHeadroomGb is per-resident-model plus a flat allowance", () => {
  assert.equal(contextHeadroomGb(0), 2);
  assert.equal(contextHeadroomGb(2), 8);
  assert.equal(contextHeadroomGb(2, 4, 1), 9);
});

test("estimatedFreeGb floors at zero and isOverloaded needs a known card", () => {
  assert.equal(estimatedFreeGb(36, 14.5, 8), 13.5);
  assert.equal(estimatedFreeGb(18, 14.5, 8), 0, "never reports negative free VRAM");
  assert.equal(isOverloaded(18, 14.5, 8), true);
  assert.equal(isOverloaded(36, 14.5, 8), false);
  assert.equal(isOverloaded(0, 14.5, 8), false, "a host with no reported VRAM is not 'overloaded'");
});

test("computeHostMemoryPressure ties the pieces together", () => {
  assert.deepEqual(
    computeHostMemoryPressure({ totalVramGb: 48, residentVramGb: [8, 6.5] }),
    {
      totalVramGb: 48,
      reservePercent: 25,
      usableVramGb: 36,
      usedVramGb: 14.5,
      contextHeadroomGb: 8,
      estimatedFreeGb: 13.5,
      residentModelCount: 2,
      overload: false,
    },
    "defaults match the monitor's documented formula"
  );

  const tight = computeHostMemoryPressure({
    totalVramGb: 24,
    reservePercent: 25,
    residentVramGb: [8, 6.5],
  });
  assert.equal(tight.usableVramGb, 18);
  assert.equal(tight.estimatedFreeGb, 0);
  assert.equal(tight.overload, true);

  const empty = computeHostMemoryPressure({ totalVramGb: 24, residentVramGb: [] });
  assert.equal(empty.residentModelCount, 0);
  assert.equal(empty.usedVramGb, 0);
  assert.equal(empty.contextHeadroomGb, 2);
});

// --- golden: monitor-memory's output did not move --------------------------

/**
 * The arithmetic above was lifted out of `monitor-memory.ts` so the router
 * could use the same numbers instead of growing a second copy of them
 * (MCP-DUP-3 records three cases where the second copy drifted). Extraction is
 * only safe if the CLI's output is unchanged, so this drives the real compiled
 * CLI end to end — argument parsing, host filtering, both endpoints, human and
 * JSON rendering — against a fixture registry and a stub Ollama, and pins every
 * byte it prints.
 */

interface Stub {
  endpoint: string;
  close: () => Promise<void>;
}

async function startOllamaStub(): Promise<Stub> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const body =
      req.url === "/api/ps"
        ? {
            models: [
              { name: "qwen3:30b", size: 20 * GB, size_vram: 8 * GB },
              { name: "qwen2.5-coder:14b", size: 9 * GB, size_vram: 6.5 * GB },
            ],
          }
        : { models: [{ name: "qwen3:30b", size: 12 * GB }, { name: "qwen2.5-coder:14b" }] };
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

function fixtureRegistry(endpoint: string): unknown {
  return {
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
            endpoint,
            capabilities: { endpointFamily: "ollama", supportsResidentModelInspection: true },
            executionPolicy: {
              maxParallelSlices: 3,
              maxConcurrentModels: 2,
              contextReservePercent: 25,
            },
            hardware: { detected: { totalGpuVramGb: 48, gpuCount: 1 } },
          },
          {
            id: "unroutable-box",
            label: "Unroutable box",
            provider: "ollama",
            endpoint: "ssh://not-http",
            capabilities: { endpointFamily: "ollama", supportsResidentModelInspection: true },
            hardware: { detected: { totalVramGb: 8 } },
          },
          {
            id: "sglang-box",
            label: "SGLang box",
            provider: "sglang-remote",
            endpoint: "http://127.0.0.1:1",
            capabilities: {
              endpointFamily: "openai-compatible",
              supportsResidentModelInspection: false,
            },
            hardware: { detected: { totalGpuVramGb: 24 } },
          },
        ],
      },
    ],
  };
}

async function runMonitor(registryPath: string, extraArgs: string[]): Promise<string> {
  const cli = fileURLToPath(new URL("./monitor-memory.js", import.meta.url));
  const { stdout } = await execFileAsync(process.execPath, [
    cli,
    "--registry",
    registryPath,
    ...extraArgs,
  ]);
  return stdout;
}

test("golden: monitor-memory's JSON output is unchanged by the extraction", async () => {
  const stub = await startOllamaStub();
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-monitor-"));
  try {
    const registryPath = join(dir, "platforms.json");
    await writeFile(registryPath, JSON.stringify(fixtureRegistry(stub.endpoint), null, 2), "utf-8");

    const parsed = JSON.parse(await runMonitor(registryPath, ["--json"])) as Record<
      string,
      unknown
    >;
    assert.equal(parsed.registryPath, registryPath);
    assert.equal(parsed.contextGbPerModel, 3);
    assert.equal(parsed.extraContextGb, 2);
    assert.equal(typeof parsed.generatedAt, "string");

    assert.deepEqual(parsed.hosts, [
      {
        hostId: "gpu-box",
        hostLabel: "GPU box",
        endpoint: stub.endpoint,
        status: "ok",
        reservePercent: 25,
        totalVramGb: 48,
        usableVramGb: 36,
        loadedModelCount: 2,
        loadedModels: [
          { name: "qwen3:30b", loadedVramGb: 8 },
          { name: "qwen2.5-coder:14b", loadedVramGb: 6.5 },
        ],
        usedVramGb: 14.5,
        // /api/tags reports a 12 GB catalog entry, above the 8 GB peak resident.
        referenceModelGb: 12,
        contextHeadroomGb: 8,
        estimatedFreeGb: 13.5,
        safeAdditionalLargeModels: 1,
        overload: false,
        configuredMaxParallelSlices: 3,
        configuredMaxConcurrentModels: 2,
      },
      {
        hostId: "unroutable-box",
        hostLabel: "Unroutable box",
        endpoint: "ssh://not-http",
        status: "invalid-endpoint",
        reservePercent: 25,
        totalVramGb: 8,
        usableVramGb: 6,
        reason: "Host endpoint missing or invalid",
      },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test("golden: monitor-memory's human output is unchanged by the extraction", async () => {
  const stub = await startOllamaStub();
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-monitor-"));
  try {
    const registryPath = join(dir, "platforms.json");
    await writeFile(registryPath, JSON.stringify(fixtureRegistry(stub.endpoint), null, 2), "utf-8");

    // Non-default context settings, so the printed formula and the arithmetic
    // are both pinned: 2 models * 5 GB + 1 GB = 11 GB of headroom on top of
    // 14.5 GB of weights, against 36 GB usable.
    const stdout = await runMonitor(registryPath, [
      "--context-gb-per-model",
      "5",
      "--extra-context-gb",
      "1",
    ]);

    assert.equal(
      stdout,
      [
        "xx-stack model load monitor",
        `registry: ${registryPath}`,
        "context headroom formula: loaded_models * 5 GB + 1 GB",
        "",
        "host: GPU box (gpu-box)",
        `endpoint: ${stub.endpoint}`,
        "status: ok",
        "vram total/usable: 48 GB / 36 GB (reserve 25%)",
        "loaded models: 2",
        "  - qwen3:30b: 8 GB",
        "  - qwen2.5-coder:14b: 6.5 GB",
        "estimated used VRAM: 14.5 GB",
        "reference large-model size: 12 GB",
        "context headroom: 11 GB",
        "estimated free VRAM: 10.5 GB",
        "safe additional large models: 0",
        "configured slices/models: 3/2",
        "",
        "host: Unroutable box (unroutable-box)",
        "endpoint: ssh://not-http",
        "status: invalid-endpoint",
        "vram total/usable: 8 GB / 6 GB (reserve 25%)",
        "reason: Host endpoint missing or invalid",
        "",
        "",
      ].join("\n")
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test("golden: an overloaded host still prints its warning", async () => {
  const stub = await startOllamaStub();
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-monitor-"));
  try {
    const registryPath = join(dir, "platforms.json");
    const registry = fixtureRegistry(stub.endpoint) as {
      tiers: Array<{ hosts: Array<Record<string, any>> }>;
    };
    // 24 GB card, 25% reserve => 18 GB usable, against 14.5 GB resident + 8 GB
    // of context headroom.
    registry.tiers[0]!.hosts[0]!.hardware = { detected: { totalGpuVramGb: 24, gpuCount: 1 } };
    await writeFile(registryPath, JSON.stringify(registry, null, 2), "utf-8");

    const stdout = await runMonitor(registryPath, []);
    assert.match(stdout, /vram total\/usable: 24 GB \/ 18 GB \(reserve 25%\)/);
    assert.match(stdout, /estimated free VRAM: 0 GB/);
    assert.match(stdout, /safe additional large models: 0/);
    assert.match(
      stdout,
      /warning: projected load exceeds usable VRAM after context headroom/,
      "the overload warning is the CLI's whole reason for existing"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});
