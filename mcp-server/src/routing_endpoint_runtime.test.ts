import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

import type { Host } from "./platform_types.js";
import {
  checkHostModelHealth,
  fetchResidentModels,
  isModelResident,
  networkScopeDenial,
  normalizeModelName,
} from "./routing_endpoint_runtime.js";

/**
 * `fetchResidentModels` is the only thing in the routing path that asks a host
 * what it currently has loaded. The tests that matter here are about what it
 * refuses to answer: an uninspectable host must come back `null` without a
 * request ever leaving the process, because `[]` would read as "idle, whole
 * card free" — the most optimistic possible reading of no information.
 */

const GB = 1073741824;

interface Probe {
  endpoint: string;
  paths: string[];
  close: () => Promise<void>;
}

async function startOllamaStub(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<Probe> {
  const paths: string[] = [];
  const server: Server = createServer((req, res) => {
    paths.push(req.url ?? "");
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    paths,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function jsonHandler(body: unknown, status = 200) {
  return (_req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
}

function ollamaHost(endpoint: string, overrides: Partial<Host> = {}): Host {
  return {
    id: "gpu-box",
    label: "GPU box",
    provider: "ollama",
    endpoint,
    capabilities: { endpointFamily: "ollama", supportsResidentModelInspection: true },
    models: [{ name: "qwen3:30b" }],
    ...overrides,
  };
}

test("fetchResidentModels reports what /api/ps says is loaded, with footprints", async () => {
  const probe = await startOllamaStub(
    jsonHandler({
      models: [
        { name: "qwen3:30b", size: 20 * GB, size_vram: 18 * GB },
        // No size_vram: fall back to total size (partially offloaded model).
        { name: "nomic-embed-text:latest", size: 0.5 * GB },
      ],
    })
  );
  try {
    const resident = await fetchResidentModels(ollamaHost(probe.endpoint));
    assert.deepEqual(resident, [
      { name: "qwen3:30b", vramGb: 18 },
      { name: "nomic-embed-text:latest", vramGb: 0.5 },
    ]);
    assert.deepEqual(probe.paths, ["/api/ps"]);
  } finally {
    await probe.close();
  }
});

test("an inspectable host holding nothing returns [], which is not null", async () => {
  const probe = await startOllamaStub(jsonHandler({ models: [] }));
  try {
    const resident = await fetchResidentModels(ollamaHost(probe.endpoint));
    assert.deepEqual(resident, [], "the host answered: nothing is loaded");
    assert.notEqual(resident, null, "'nothing loaded' and 'cannot be asked' are different facts");
  } finally {
    await probe.close();
  }
});

test("a host without the capability flag is never dialled and resolves to null", async () => {
  const probe = await startOllamaStub(jsonHandler({ models: [{ name: "qwen3:30b" }] }));
  try {
    const flagFalse = await fetchResidentModels(
      ollamaHost(probe.endpoint, {
        capabilities: { endpointFamily: "ollama", supportsResidentModelInspection: false },
      })
    );
    const flagAbsent = await fetchResidentModels(
      ollamaHost(probe.endpoint, { capabilities: { endpointFamily: "ollama" } })
    );
    const noCapabilities = await fetchResidentModels(
      ollamaHost(probe.endpoint, { capabilities: undefined })
    );

    assert.equal(flagFalse, null);
    assert.equal(flagAbsent, null);
    assert.equal(noCapabilities, null);
    assert.deepEqual(probe.paths, [], "no capability flag means no request at all");
  } finally {
    await probe.close();
  }
});

test("every non-Ollama family resolves to null, not to an empty list", async () => {
  const probe = await startOllamaStub(jsonHandler({ models: [] }));
  try {
    // Deliberately contradictory input: the flag says yes, the family has no
    // /api/ps to ask. Unknown wins, and nothing is dialled.
    const resident = await fetchResidentModels(
      ollamaHost(probe.endpoint, {
        provider: "sglang-remote",
        capabilities: {
          endpointFamily: "openai-compatible",
          supportsResidentModelInspection: true,
        },
      })
    );
    assert.equal(resident, null);
    assert.deepEqual(probe.paths, []);
  } finally {
    await probe.close();
  }
});

test("a failed, refused, or malformed probe resolves to null", async () => {
  const errorProbe = await startOllamaStub(jsonHandler({ error: "boom" }, 500));
  const garbageProbe = await startOllamaStub((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("not json at all");
  });
  const shapelessProbe = await startOllamaStub(jsonHandler({ models: "several" }));
  try {
    assert.equal(await fetchResidentModels(ollamaHost(errorProbe.endpoint)), null);
    assert.equal(await fetchResidentModels(ollamaHost(garbageProbe.endpoint)), null);
    assert.equal(await fetchResidentModels(ollamaHost(shapelessProbe.endpoint)), null);
  } finally {
    await Promise.all([errorProbe.close(), garbageProbe.close(), shapelessProbe.close()]);
  }

  // Nothing listening: a connection refusal is unknown, not empty.
  assert.equal(await fetchResidentModels(ollamaHost("http://127.0.0.1:1")), null);
  // Not an HTTP endpoint: refused before any fetch is constructed.
  assert.equal(await fetchResidentModels(ollamaHost("ssh://not-http")), null);
});

test("model names compare on their normal form, so :latest is not a different model", () => {
  assert.equal(normalizeModelName("Qwen3:30B"), "qwen3:30b");
  assert.equal(normalizeModelName("nomic-embed-text:latest"), "nomic-embed-text");
  assert.equal(normalizeModelName("  gpt-oss:20b  "), "gpt-oss:20b");

  const resident = [
    { name: "qwen3:30b", vramGb: 18 },
    { name: "nomic-embed-text:latest", vramGb: 0.5 },
  ];
  assert.equal(isModelResident(resident, "qwen3:30b"), true);
  assert.equal(isModelResident(resident, "QWEN3:30B"), true);
  assert.equal(isModelResident(resident, "nomic-embed-text"), true);
  assert.equal(isModelResident(resident, "qwen3:8b"), false);
  assert.equal(isModelResident(resident, ""), false);
  assert.equal(isModelResident([], "qwen3:30b"), false);
});

/**
 * `networkScopeDenial` is the load-time seatbelt between the registry and the
 * network: a lane may only dial addresses its declared scope allows. The
 * matrices below mirror generate-registries.mjs so both layers stay honest.
 */
function scopedHost(endpoint: string, networkScope?: string): Host {
  return ollamaHost(endpoint, networkScope === undefined ? {} : { networkScope });
}

test("networkScopeDenial accepts endpoints inside their declared scope", () => {
  const accepted: Array<[endpoint: string, scope: string]> = [
    ["http://127.0.0.1:11434", "loopback"],
    ["http://127.255.0.9:8080", "localhost"],
    ["http://localhost:8080", "loopback"],
    ["http://[::1]:3000", "loopback"],
    ["http://100.64.0.1:30000", "tailscale"],
    ["http://100.127.255.254:8080", "tailscale"],
    ["http://example-gpu-box:30000", "tailscale"],
    ["https://example-gpu-box.tail1234.ts.net", "tailscale"],
    ["https://generativelanguage.googleapis.com", "internet"],
  ];
  for (const [endpoint, scope] of accepted) {
    assert.equal(
      networkScopeDenial(scopedHost(endpoint, scope)),
      null,
      `${endpoint} must satisfy scope "${scope}"`
    );
  }
});

test("networkScopeDenial rejects endpoints outside their declared scope", () => {
  const denied: Array<[endpoint: string, scope: string]> = [
    // A loopback tier must never point off-host.
    ["http://192.168.1.10:8080", "loopback"],
    ["http://example-gpu-box:30000", "localhost"],
    ["https://api.example.com", "loopback"],
    ["http://0.0.0.0:11434", "loopback"],
    // A tailscale tier accepts only CGNAT IPs or MagicDNS names.
    ["http://100.63.0.1:30000", "tailscale"],
    ["http://100.128.0.1:30000", "tailscale"],
    ["http://203.0.113.9:8080", "tailscale"],
    ["http://bad_host:30000", "tailscale"],
  ];
  for (const [endpoint, scope] of denied) {
    const denial = networkScopeDenial(scopedHost(endpoint, scope));
    assert.match(
      denial ?? "",
      /outside declared networkScope/,
      `${endpoint} must contradict scope "${scope}"`
    );
  }
});

test("an undeclared scope leaves topology unchecked — nothing to contradict", () => {
  assert.equal(networkScopeDenial(scopedHost("http://10.1.2.3:8000")), null);
  assert.equal(networkScopeDenial(scopedHost("not a url at all")), null);
});

test("a lane whose endpoint contradicts its scope is denied before any request", async () => {
  const probe = await startOllamaStub(jsonHandler({ models: [{ name: "qwen3:30b" }] }));
  try {
    // The stub genuinely listens on 127.0.0.1; only the declared scope makes
    // this host a lie, which is exactly the contradiction the check catches.
    const impostor = ollamaHost(probe.endpoint, { networkScope: "tailscale" });

    assert.equal(await fetchResidentModels(impostor), null);

    const health = await checkHostModelHealth(impostor, "qwen3:30b");
    assert.equal(health.hostHealthy, false);
    assert.equal(health.modelAvailable, false);
    assert.equal(health.source, "none");
    assert.match(health.reason, /networkScope "tailscale"/);
    assert.deepEqual(probe.paths, [], "a denied lane must not be dialled");
  } finally {
    await probe.close();
  }
});

test("scope-consistent hosts keep their normal health and inspection paths", async () => {
  const probe = await startOllamaStub(jsonHandler({ models: [{ name: "qwen3-coder:30b" }] }));
  try {
    const localHost = ollamaHost(probe.endpoint, { networkScope: "loopback" });

    const resident = await fetchResidentModels(localHost);
    assert.deepEqual(resident, [{ name: "qwen3-coder:30b", vramGb: 0 }]);

    const health = await checkHostModelHealth(localHost, "qwen3-coder:30b");
    assert.equal(health.hostHealthy, true);
    assert.equal(health.modelAvailable, true);
    assert.equal(health.source, "live");
  } finally {
    await probe.close();
  }
});
