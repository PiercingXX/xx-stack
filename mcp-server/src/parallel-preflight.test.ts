import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { mergeSyncedModels, parseArgs, type ModelEntry } from "./parallel-preflight.js";
import { TIER_IDS } from "./runtime_constants.js";

const execFileAsync = promisify(execFile);
const GB = 1073741824;

// --- merge, never rebuild: curated card data survives a live sync ------------

test("a live sync merges onto existing model cards instead of rebuilding them", () => {
  const registryCard: ModelEntry & { notes: string } = {
    name: "qwen2.5-coder:14b",
    roles: ["build", "review"],
    size: 14 * GB,
    format: "gguf",
    quantization: "Q4_K_M",
    weightBits: 4,
    contextWindow: 32768,
    estimatedVramGb: 9.5,
    supportsToolUse: true,
    toolCallReliability: "validated",
    jsonModeReliability: "validated",
    notes: "curated-by-hand",
  };

  const merged = mergeSyncedModels(
    [registryCard],
    [
      {
        name: "qwen2.5-coder:14b",
        size: 15 * GB,
        details: { quantization_level: "Q4_K_M", family: "qwen2" },
      },
    ]
  );

  assert.equal(merged.length, 1);

  // What a registry write would persist: serialize and reparse, then check
  // that every field routing_selection_runtime consumes is still there.
  const persisted = JSON.parse(JSON.stringify(merged[0])) as Record<string, unknown>;
  assert.equal(persisted.contextWindow, 32768);
  assert.equal(persisted.estimatedVramGb, 9.5);
  assert.equal(persisted.supportsToolUse, true);
  assert.equal(persisted.toolCallReliability, "validated");
  assert.equal(persisted.jsonModeReliability, "validated");
  assert.equal(persisted.weightBits, 4);
  assert.equal(persisted.format, "gguf");
  // Even a field this module does not model survives the round-trip.
  assert.equal(persisted.notes, "curated-by-hand");
  assert.deepEqual(persisted.roles, ["build", "review"]);

  // The live probe remains authoritative for what it actually reported.
  assert.equal(persisted.size, 15 * GB);
  assert.equal(persisted.kernelFamily, "qwen2");

  // A model new to the registry gets the imported marker role.
  const added = mergeSyncedModels([], [{ name: "brand-new:7b", size: GB }]);
  assert.deepEqual(added[0]!.roles, ["imported-from-live-endpoint"]);
});

// --- numeric CLI args must fall back instead of becoming NaN -----------------

test("an unparseable --timeout-ms falls back to the default instead of NaN", () => {
  const args = parseArgs(["--registry", "platforms.json", "--timeout-ms", "not-a-number"]);
  assert.equal(
    args.timeoutMs,
    5000,
    "a NaN timeout aborts every fetch instantly and marks all hosts unreachable"
  );
});

test("finite --timeout-ms values are honored unchanged", () => {
  const args = parseArgs(["--registry", "platforms.json", "--timeout-ms", "1500"]);
  assert.equal(args.timeoutMs, 1500);
});

// --- end to end: persistence policy against a real file ----------------------

function startOllamaStub(models: Array<Record<string, unknown>>): Promise<{
  endpoint: string;
  close: () => Promise<void>;
}> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ models }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        endpoint: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function registryDocument(endpoint: string): Record<string, unknown> {
  return {
    version: 1,
    selectionPolicy: { defaultOrder: [TIER_IDS.tailscaleOllama], rules: [] },
    tiers: [
      {
        id: TIER_IDS.tailscaleOllama,
        label: "remote",
        priority: 1,
        hosts: [
          {
            id: "example-gpu-box",
            label: "Example GPU box",
            provider: "ollama",
            endpoint,
            executionPolicy: { maxParallelSlices: 2, maxConcurrentModels: 2 },
            models: [{ name: "keeper:7b", roles: ["build"], contextWindow: 32768 }],
          },
        ],
      },
    ],
  };
}

async function runPreflight(
  registryPath: string,
  extraArgs: string[]
): Promise<{ code: number; stdout: string }> {
  const cli = fileURLToPath(new URL("./parallel-preflight.js", import.meta.url));
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      cli,
      "--registry",
      registryPath,
      ...extraArgs,
    ]);
    return { code: 0, stdout };
  } catch (error) {
    const err = error as { code?: number | string; stdout?: string };
    return { code: Number(err.code ?? -1), stdout: err.stdout ?? "" };
  }
}

test("a preflight where no host is reachable leaves the registry untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-preflight-dead-"));
  try {
    const registryPath = join(dir, "platforms.json");
    // Port 9 refuses connections immediately — an outage, not a hang.
    const before = `${JSON.stringify(registryDocument("http://127.0.0.1:9"), null, 2)}\n`;
    await writeFile(registryPath, before);

    const run = await runPreflight(registryPath, ["--timeout-ms", "300"]);

    assert.equal(run.code, 1, "an unreachable fleet exits nonzero");
    assert.match(run.stdout, /skipped: no reachable hosts/);
    assert.equal(
      await readFile(registryPath, "utf8"),
      before,
      "a transient probe outage must never persist reachable:false fleet-wide"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a live sync applies atomically and keeps curated fields through the disk round-trip", async () => {
  const stub = await startOllamaStub([
    { name: "keeper:7b", size: 8 * GB, details: { quantization_level: "Q4_0", family: "llama" } },
  ]);
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-preflight-live-"));
  try {
    const registryPath = join(dir, "platforms.json");
    await writeFile(registryPath, JSON.stringify(registryDocument(stub.endpoint)));

    const run = await runPreflight(registryPath, ["--timeout-ms", "abc"]);

    assert.equal(run.code, 0, `a NaN arg must not fail the run: ${run.stdout}`);
    assert.match(run.stdout, /reachable: true/);
    assert.match(run.stdout, /applied \(atomic\)/);

    const persisted = JSON.parse(await readFile(registryPath, "utf8")) as {
      tiers: Array<{ hosts: Array<Record<string, any>> }>;
    };
    const host = persisted.tiers[0]!.hosts[0]!;
    assert.equal(host.hardware.detected.inventorySource, "ollama-api-tags");
    assert.equal(host.models[0].contextWindow, 32768);
    assert.deepEqual(host.models[0].roles, ["build"]);
    assert.equal(host.models[0].kernelFamily, "llama");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});
