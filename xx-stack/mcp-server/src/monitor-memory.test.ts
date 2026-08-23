import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parseArgs } from "./monitor-memory.js";

const execFileAsync = promisify(execFile);
const GB = 1073741824;

// --- unparseable numeric args must fall back, never become NaN ---------------

test("unparseable numeric CLI args fall back to defaults instead of NaN", () => {
  const args = parseArgs([
    "--registry",
    "registry.json",
    "--timeout-ms",
    "not-a-number",
    "--context-gb-per-model",
    "abc",
    "--extra-context-gb",
    "Infinity",
  ]);
  assert.equal(args.timeoutMs, 3000);
  assert.equal(args.contextGbPerModel, 3);
  assert.equal(args.extraContextGb, 2);
});

test("finite numeric CLI args are honored unchanged", () => {
  const args = parseArgs([
    "--registry",
    "registry.json",
    "--timeout-ms",
    "1500",
    "--context-gb-per-model",
    "5.5",
    "--extra-context-gb",
    "-2",
  ]);
  assert.equal(args.timeoutMs, 1500);
  assert.equal(args.contextGbPerModel, 5.5);
  assert.equal(args.extraContextGb, -2);
});

// --- end to end: a bad --timeout-ms must not make every host unreachable -----

function startOllamaStub(): Promise<{ endpoint: string; close: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const body =
      req.url === "/api/ps"
        ? { models: [{ name: "qwen3:30b", size: 20 * GB, size_vram: 8 * GB }] }
        : { models: [{ name: "qwen3:30b", size: 12 * GB }] };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        endpoint: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

async function writeRegistry(dir: string, endpoint: string): Promise<string> {
  const registryPath = join(dir, "platforms.json");
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 1,
      selectionPolicy: { defaultOrder: ["local"], rules: [] },
      tiers: [
        {
          id: "local",
          label: "Local",
          hosts: [
            {
              id: "gpu-box",
              label: "GPU box",
              provider: "ollama",
              endpoint,
              capabilities: { supportsResidentModelInspection: true },
              hardware: { detected: { totalGpuVramGb: 48 } },
            },
          ],
        },
      ],
    })
  );
  return registryPath;
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

test("--timeout-ms that parses to NaN falls back so hosts stay reachable", async () => {
  const stub = await startOllamaStub();
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-monitor-nan-"));
  try {
    const registryPath = await writeRegistry(dir, stub.endpoint);
    const parsed = JSON.parse(
      await runMonitor(registryPath, ["--json", "--timeout-ms", "abc"])
    ) as { hosts: Array<{ status: string; reason?: string }> };

    assert.equal(parsed.hosts.length, 1);
    assert.equal(
      parsed.hosts[0].status,
      "ok",
      `a NaN timeout aborted the probe instantly: ${JSON.stringify(parsed.hosts[0])}`
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});
