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
