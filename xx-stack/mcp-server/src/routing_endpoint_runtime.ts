import { residentModelVramGb } from "./host_memory_runtime.js";
import type { EndpointCompatibilityProbe, Host } from "./platform_types.js";

export interface HostModelHealthResult {
  hostHealthy: boolean;
  modelAvailable: boolean;
  latencyMs: number | null;
  checkedModel: string | null;
  source: "live" | "registry" | "none";
  reason: string;
}

export function endpointFamilyForProvider(provider: string): "ollama" | "openai-compatible" {
  const normalized = provider.toLowerCase();
  if (normalized === "ollama" || normalized.startsWith("ollama-")) {
    return "ollama";
  }
  if (
    normalized.includes("llama") ||
    normalized.includes("openai") ||
    normalized.includes("localai")
  ) {
    return "openai-compatible";
  }
  return "openai-compatible";
}

export function endpointFamilyForHost(host: Host): "ollama" | "openai-compatible" {
  return host.capabilities?.endpointFamily ?? endpointFamilyForProvider(host.provider);
}

function ipv4OctetsOf(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^[0-9]{1,3}$/.test(part) ? Number(part) : NaN));
  if (octets.some((octet) => Number.isNaN(octet) || octet > 255)) return null;
  return octets;
}

function isLoopbackHostname(hostname: string): boolean {
  const octets = ipv4OctetsOf(hostname);
  if (octets) return octets[0] === 127;
  return hostname === "localhost" || hostname === "::1";
}

const MAGIC_DNS_HOSTNAME = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;

function isTailscaleHostname(hostname: string): boolean {
  // Tailscale assigns out of 100.64.0.0/10 (CGNAT space); a raw IPv4 literal
  // must come from there, while anything else may only be a MagicDNS name.
  const octets = ipv4OctetsOf(hostname);
  if (octets) return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
  return MAGIC_DNS_HOSTNAME.test(hostname);
}

/**
 * Why a host's endpoint contradicts the network scope it declares, or `null`
 * when it does not.
 *
 * generate-registries.mjs enforces these same rules at generation time; this
 * re-checks at the boundary where a lane would actually be dialled, so a
 * hand-edited registry cannot quietly turn a "loopback" tier into requests to
 * some routable address. Cloud/internet scopes declare public reachability
 * themselves and stay governed by the XX_STACK_ALLOW_CLOUD escalation gate,
 * not by topology; an undeclared scope gives nothing here to contradict.
 *
 * Pure on purpose — the accept/reject matrix is unit-tested without sockets.
 */
export function networkScopeDenial(host: Pick<Host, "endpoint" | "networkScope">): string | null {
  const scope = host.networkScope;
  if (!scope) return null;

  let hostname: string;
  try {
    // new URL lowercases the hostname; bracketed IPv6 keeps its brackets there.
    hostname = new URL(host.endpoint).hostname.replace(/^\[/, "").replace(/\]$/, "");
  } catch {
    return `endpoint "${host.endpoint}" does not parse as a URL for networkScope "${scope}"`;
  }

  if (scope === "localhost" || scope === "loopback") {
    if (!isLoopbackHostname(hostname)) {
      return `endpoint host "${hostname}" is outside declared networkScope "${scope}" (loopback only)`;
    }
    return null;
  }
  if (scope === "tailscale") {
    if (!isTailscaleHostname(hostname)) {
      return `endpoint host "${hostname}" is outside declared networkScope "${scope}" (100.64.0.0/10 or a MagicDNS name required)`;
    }
    return null;
  }
  return null;
}

async function fetchOllamaModels(endpoint: string): Promise<string[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const url = new URL("/api/tags", endpoint);
    const res = await fetch(url.toString(), { signal: controller.signal });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: { name: string }[] };
    return (data.models ?? []).map((model) => model.name);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOpenAiCompatibleModels(endpoint: string): Promise<string[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const url = new URL("/v1/models", endpoint);
    const res = await fetch(url.toString(), { signal: controller.signal });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    return (data.data ?? []).map((model) => model.id ?? "").filter((id) => id.length > 0);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function pingOllama(endpoint: string): Promise<{ ok: boolean; latencyMs: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const start = Date.now();
  try {
    const url = new URL("/api/tags", endpoint);
    const res = await fetch(url.toString(), { signal: controller.signal });
    return { ok: res.ok || res.status === 200, latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timeout);
  }
}

async function pingOpenAiCompatible(endpoint: string): Promise<{ ok: boolean; latencyMs: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const start = Date.now();
  try {
    const url = new URL("/v1/models", endpoint);
    const res = await fetch(url.toString(), { signal: controller.signal });
    return { ok: res.ok || res.status === 200, latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timeout);
  }
}

/** One model a host reports as currently loaded, with its footprint on the card. */
export interface ResidentModel {
  name: string;
  vramGb: number;
}

/**
 * Which models a host has loaded right now, or `null` when that is unknowable.
 *
 * The distinction is the point. `[]` means the host answered and is holding
 * nothing; `null` means nobody asked or the answer did not arrive. Collapsing
 * the two would let a lane nobody can inspect read as an idle lane with the
 * whole card free, which is the opposite of a safe default.
 *
 * `null` is returned — without dialling anything — whenever
 * `capabilities.supportsResidentModelInspection` is not exactly `true`. Today
 * `generate-registries.mjs` sets that flag only for Ollama runtimes, so this
 * answers for one lane family and stays silent about the rest.
 */
export async function fetchResidentModels(host: Host): Promise<ResidentModel[] | null> {
  if (host.capabilities?.supportsResidentModelInspection !== true) return null;
  // The flag says the host can be asked; the family says which endpoint asks it.
  // Only Ollama exposes /api/ps, so anything else is unknown rather than empty.
  if (endpointFamilyForHost(host) !== "ollama") return null;
  if (!host.endpoint.startsWith("http://") && !host.endpoint.startsWith("https://")) return null;
  // A lane whose URL contradicts its declared scope is not a lane to inspect.
  const scopeDenial = networkScopeDenial(host);
  if (scopeDenial !== null) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const url = new URL("/api/ps", host.endpoint);
    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      models?: Array<{ name?: string; size?: number; size_vram?: number }>;
    };
    if (!Array.isArray(data?.models)) return null;
    return data.models
      .map((model) => ({ name: model?.name ?? "", vramGb: residentModelVramGb(model ?? {}) }))
      .filter((model) => model.name.length > 0);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Ollama reports `qwen3:8b` where a caller may hold `Qwen3:8b` or `qwen3`, and
 * an unsuffixed name means `:latest`. Compare on that normal form only.
 */
export function normalizeModelName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/:latest$/, "");
}

/** Whether `modelName` is among the models a host currently has loaded. */
export function isModelResident(resident: ResidentModel[], modelName: string): boolean {
  const target = normalizeModelName(modelName);
  if (!target) return false;
  return resident.some((model) => normalizeModelName(model.name) === target);
}

export async function fetchHostModels(host: Host): Promise<string[]> {
  return endpointFamilyForHost(host) === "ollama"
    ? fetchOllamaModels(host.endpoint)
    : fetchOpenAiCompatibleModels(host.endpoint);
}

async function postJsonWithStatus(
  url: string,
  payload: unknown
): Promise<{ ok: boolean; status: number; json: unknown | null; reason?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    let json: unknown | null = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      json: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function modelNamesForHost(host: Host | null): string[] {
  return (host?.models ?? [])
    .map((model) => (typeof model === "string" ? model : model?.name))
    .filter((modelName): modelName is string => Boolean(modelName));
}

export async function probeHostEndpointCompatibility(
  host: Host,
  requestedModel: string | null = null
): Promise<EndpointCompatibilityProbe> {
  const endpoint = host.endpoint.replace(/\/$/, "");
  const endpointFamily = endpointFamilyForHost(host);
  const provider = host.provider;

  const models = await fetchHostModels(host);
  const resolvedModel = requestedModel ?? models[0] ?? modelNamesForHost(host)[0] ?? null;

  const modelsCheck = {
    ok: models.length > 0,
    status: models.length > 0 ? 200 : 0,
    reason: models.length > 0 ? undefined : "no models returned from live endpoint",
  };

  if (!resolvedModel) {
    return {
      endpoint,
      provider,
      endpointFamily,
      modelRequested: requestedModel,
      modelResolved: null,
      checks: {
        modelsEndpoint: modelsCheck,
        chatCompletion: {
          ok: false,
          status: 0,
          reason: "no model available for chat completion probe",
        },
        jsonMode: {
          ok: false,
          status: 0,
          reason: "no model available for JSON probe",
        },
      },
    };
  }

  const chatProbe = await postJsonWithStatus(`${endpoint}/v1/chat/completions`, {
    model: resolvedModel,
    max_tokens: 16,
    temperature: 0,
    messages: [
      { role: "system", content: "Respond briefly." },
      { role: "user", content: "Reply with the word ok." },
    ],
  });

  const jsonProbe = await postJsonWithStatus(`${endpoint}/v1/chat/completions`, {
    model: resolvedModel,
    max_tokens: 64,
    temperature: 0,
    messages: [
      { role: "system", content: "Return valid JSON only." },
      { role: "user", content: 'Return {"status":"ok","value":1}.' },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "probe_response",
        schema: {
          type: "object",
          properties: {
            status: { type: "string" },
            value: { type: "number" },
          },
          required: ["status", "value"],
          additionalProperties: false,
        },
      },
    },
  });

  return {
    endpoint,
    provider,
    endpointFamily,
    modelRequested: requestedModel,
    modelResolved: resolvedModel,
    checks: {
      modelsEndpoint: modelsCheck,
      chatCompletion: {
        ok: chatProbe.ok,
        status: chatProbe.status,
        reason: chatProbe.ok ? undefined : (chatProbe.reason ?? "chat completion probe failed"),
      },
      jsonMode: {
        ok: jsonProbe.ok,
        status: jsonProbe.status,
        reason: jsonProbe.ok ? undefined : (jsonProbe.reason ?? "json mode probe failed"),
      },
    },
  };
}

export async function pingHostEndpoint(host: Host): Promise<{ ok: boolean; latencyMs: number }> {
  return endpointFamilyForHost(host) === "ollama"
    ? pingOllama(host.endpoint)
    : pingOpenAiCompatible(host.endpoint);
}

export async function checkHostModelHealth(
  host: Host,
  modelName: string | null
): Promise<HostModelHealthResult> {
  const checkedModel = modelName ?? null;

  if (host.enabled === false || host.reachable === false) {
    return {
      hostHealthy: false,
      modelAvailable: false,
      latencyMs: null,
      checkedModel,
      source: "none",
      reason: "host disabled or marked unreachable",
    };
  }

  if (!host.endpoint.startsWith("http://") && !host.endpoint.startsWith("https://")) {
    return {
      hostHealthy: false,
      modelAvailable: false,
      latencyMs: null,
      checkedModel,
      source: "none",
      reason: "endpoint is not HTTP(S)",
    };
  }

  // Deny before dialling: an endpoint that contradicts its declared scope is
  // unhealthy by definition, whatever might answer if it were pinged.
  const scopeDenial = networkScopeDenial(host);
  if (scopeDenial !== null) {
    return {
      hostHealthy: false,
      modelAvailable: false,
      latencyMs: null,
      checkedModel,
      source: "none",
      reason: scopeDenial,
    };
  }

  const ping = await pingHostEndpoint(host);
  if (!ping.ok) {
    return {
      hostHealthy: false,
      modelAvailable: false,
      latencyMs: ping.latencyMs,
      checkedModel,
      source: "live",
      reason: "endpoint unreachable",
    };
  }

  const liveModels = await fetchHostModels(host);
  const modelCatalog = liveModels.length > 0 ? liveModels : modelNamesForHost(host);
  const modelAvailable = checkedModel
    ? modelCatalog.includes(checkedModel)
    : modelCatalog.length > 0;

  return {
    hostHealthy: true,
    modelAvailable,
    latencyMs: ping.latencyMs,
    checkedModel,
    source: liveModels.length > 0 ? "live" : "registry",
    reason: modelAvailable
      ? "host reachable and model available"
      : `host reachable but model ${checkedModel ?? "<unset>"} missing`,
  };
}
