export interface Host {
  id: string;
  label: string;
  provider: string;
  endpoint: string;
  capabilities?: {
    endpointFamily?: "ollama" | "openai-compatible";
    supportsResidentModelInspection?: boolean;
  };
  primary?: boolean;
  networkScope?: string;
  enabled?: boolean;
  reachable?: boolean;
  hardware?: {
    summary?: string;
    cpu?: string;
    ram?: string;
    gpu?: string[];
    limits?: string[];
    detected?: {
      totalGpuVramGb?: number;
      gpuCount?: number;
    };
  };
  models?: Array<
    | string
    | {
        name?: string;
        roles?: string[];
        size?: number;
        format?: string;
        quantization?: string;
        weightBits?: number;
        kernelFamily?: string;
        contextWindow?: number;
        estimatedVramGb?: number;
        supportsToolUse?: boolean;
        toolCallReliability?: "unknown" | "low" | "validated";
        jsonModeReliability?: "unknown" | "low" | "validated";
      }
  >;
  delegationPolicy?: {
    preferredTaskTypes?: string[];
    avoidTaskTypes?: string[];
  };
  executionPolicy?: {
    maxParallelSlices?: number;
    maxConcurrentModels?: number;
    contextReservePercent?: number;
    scheduling?: string;
  };
}

export interface Tier {
  id: string;
  label: string;
  priority: number;
  usageGuidance?: string;
  hosts: Host[];
}

export interface SelectionRule {
  name: string;
  when: string;
  preferTier: string;
}

export interface Registry {
  version: number;
  selectionPolicy: {
    defaultOrder: string[];
    cloudEscalation?: {
      optIn?: boolean;
      note?: string;
    };
    rules: SelectionRule[];
  };
  tiers: Tier[];
}

export interface RouteRecommendation {
  recommendedTier: string;
  recommendedHost: string | null;
  recommendedModel: string | null;
  reasoning: string;
  availableModels: string[];
  fallback: string | null;
}

export interface EndpointCompatibilityProbe {
  endpoint: string;
  provider: string;
  endpointFamily: "ollama" | "openai-compatible";
  modelRequested: string | null;
  modelResolved: string | null;
  checks: {
    modelsEndpoint: { ok: boolean; status?: number; reason?: string };
    chatCompletion: { ok: boolean; status?: number; reason?: string };
    jsonMode: { ok: boolean; status?: number; reason?: string };
  };
}
