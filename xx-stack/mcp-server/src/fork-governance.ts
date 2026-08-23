import { appendFile, mkdir, readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { atomicWriteTextFile } from "./io_runtime.js";

const execFileAsync = promisify(execFile);

export type ChannelConfig = {
  repo: string;
  ref: string;
};

export type GovernanceConfig = {
  channels: {
    stable: ChannelConfig;
    experimental: ChannelConfig;
  };
  driftThreshold: {
    maxStableAdvancesWithoutExperimental: number;
  };
  logs: {
    governanceLogPath: string;
    statePath: string;
    artifactPipelineLogPath: string;
  };
};

export type GovernanceState = {
  stableHead: string | null;
  experimentalHead: string | null;
  stableAdvanceCountWithoutExperimental: number;
  updatedAt: string;
};

type ArtifactLogInput = {
  inputHash: string;
  patchVersion: string;
  outputHash: string;
  reproducibilityLogPath: string;
  kernelFamily: string;
  sourceChannel: string;
};

function defaultConfigPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "fork-governance.json");
}

function expandHome(pathValue: string): string {
  if (!pathValue.startsWith("~/")) return pathValue;
  return resolve(homedir(), pathValue.slice(2));
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

/**
 * The outcome of one `git ls-remote`. The distinction is the point: a resolved
 * ref that does not exist is `{ status: "ok", head: null }` — a real answer —
 * while `{ status: "error" }` means we never got an answer at all (network
 * outage, auth wall, rate limit). Collapsing the two would let a total outage
 * read as "no movement" and silently pass the promotion gate.
 */
export type RemoteHeadResult = { status: "ok"; head: string | null } | { status: "error" };

export type RemoteHeadResolver = (repo: string, ref: string) => Promise<RemoteHeadResult>;

export async function resolveRemoteHead(repo: string, ref: string): Promise<RemoteHeadResult> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-remote", `https://github.com/${repo}.git`, ref],
      {
        timeout: 10_000,
      }
    );
    const line = stdout.split("\n").find((item) => item.trim().length > 0);
    if (!line) return { status: "ok", head: null };
    const hash = line.split(/\s+/)[0];
    return { status: "ok", head: hash || null };
  } catch {
    return { status: "error" };
  }
}

async function appendJsonl(path: string, payload: unknown): Promise<void> {
  await ensureParent(path);
  await appendFile(path, `${JSON.stringify(payload)}\n`, "utf-8");
}

function parseArg(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

async function loadConfig(): Promise<GovernanceConfig> {
  const configPath = parseArg("--config") ?? defaultConfigPath();
  const config = await readJson<GovernanceConfig>(configPath, {
    channels: {
      stable: { repo: "ggml-org/llama.cpp", ref: "master" },
      experimental: { repo: "PrismML-Eng/llama.cpp", ref: "prism" },
    },
    driftThreshold: {
      maxStableAdvancesWithoutExperimental: 3,
    },
    logs: {
      governanceLogPath: "~/.config/opencode/xx-stack-logs/fork-governance.jsonl",
      statePath: "~/.config/opencode/xx-stack-logs/fork-governance-state.json",
      artifactPipelineLogPath: "~/.config/opencode/xx-stack-logs/model-artifact-pipeline.jsonl",
    },
  });

  config.logs.governanceLogPath = expandHome(config.logs.governanceLogPath);
  config.logs.statePath = expandHome(config.logs.statePath);
  config.logs.artifactPipelineLogPath = expandHome(config.logs.artifactPipelineLogPath);
  return config;
}

/**
 * One full governance check against an injectable head resolver.
 *
 * Appends the jsonl event and — only when both channels resolved — persists the
 * next state atomically, then returns the payload plus the process exit code:
 * 0 when production promotion may proceed, nonzero otherwise. A failed
 * resolution is fail-closed: no state overwrite (so recovery cannot mistake a
 * restored connection for a phantom advance), a distinct "unverifiable" status
 * in the payload, and gateProductionPromotion forced false.
 */
export async function runDriftCheckAgainst(
  config: GovernanceConfig,
  resolveRemote: RemoteHeadResolver
): Promise<{ payload: Record<string, unknown>; exitCode: number }> {
  const prior = await readJson<GovernanceState>(config.logs.statePath, {
    stableHead: null,
    experimentalHead: null,
    stableAdvanceCountWithoutExperimental: 0,
    updatedAt: new Date(0).toISOString(),
  });

  const [stableResult, experimentalResult] = await Promise.all([
    resolveRemote(config.channels.stable.repo, config.channels.stable.ref),
    resolveRemote(config.channels.experimental.repo, config.channels.experimental.ref),
  ]);

  const unverifiable = stableResult.status === "error" || experimentalResult.status === "error";
  const stableHead = stableResult.status === "ok" ? stableResult.head : null;
  const experimentalHead = experimentalResult.status === "ok" ? experimentalResult.head : null;

  let stableAdvanceCountWithoutExperimental = prior.stableAdvanceCountWithoutExperimental;

  if (!unverifiable) {
    const stableMoved = stableHead !== null && stableHead !== prior.stableHead;
    const experimentalMoved =
      experimentalHead !== null && experimentalHead !== prior.experimentalHead;

    if (stableMoved && !experimentalMoved) {
      stableAdvanceCountWithoutExperimental += 1;
    } else if (experimentalMoved) {
      stableAdvanceCountWithoutExperimental = 0;
    }
  }

  const driftRiskHigh =
    !unverifiable &&
    stableAdvanceCountWithoutExperimental >
      config.driftThreshold.maxStableAdvancesWithoutExperimental;

  const payload = {
    at: new Date().toISOString(),
    type: "fork.governance.check",
    status: unverifiable ? ("unverifiable" as const) : ("ok" as const),
    stable: {
      repo: config.channels.stable.repo,
      ref: config.channels.stable.ref,
      head: stableHead,
    },
    experimental: {
      repo: config.channels.experimental.repo,
      ref: config.channels.experimental.ref,
      head: experimentalHead,
    },
    stableAdvanceCountWithoutExperimental,
    threshold: config.driftThreshold.maxStableAdvancesWithoutExperimental,
    driftRiskHigh,
    // Fail closed: an unverifiable check never green-lights promotion.
    gateProductionPromotion: !unverifiable && !driftRiskHigh,
  };

  await appendJsonl(config.logs.governanceLogPath, payload);

  if (!unverifiable) {
    const nextState: GovernanceState = {
      stableHead,
      experimentalHead,
      stableAdvanceCountWithoutExperimental,
      updatedAt: new Date().toISOString(),
    };

    await ensureParent(config.logs.statePath);
    await atomicWriteTextFile(config.logs.statePath, `${JSON.stringify(nextState, null, 2)}\n`);
  }

  return { payload, exitCode: payload.gateProductionPromotion ? 0 : 1 };
}

async function runDriftCheck(): Promise<void> {
  const config = await loadConfig();
  const { payload, exitCode } = await runDriftCheckAgainst(config, resolveRemoteHead);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  // exitCode (not process.exit) so pending stdout pipe writes flush — same
  // pattern as cli.ts; a piped consumer must see the whole JSON document.
  process.exitCode = exitCode;
}

function requiredArg(name: string, value: string | null): string {
  if (value && value.trim().length > 0) return value;
  throw new Error(`Missing required argument: ${name}`);
}

async function logArtifactPipeline(): Promise<void> {
  const config = await loadConfig();
  const input = {
    inputHash: parseArg("--input-hash"),
    patchVersion: parseArg("--patch-version"),
    outputHash: parseArg("--output-hash"),
    reproducibilityLogPath: parseArg("--repro-log"),
    kernelFamily: parseArg("--kernel-family") ?? "unknown",
    sourceChannel: parseArg("--source-channel") ?? "experimental",
  };

  const payload: ArtifactLogInput = {
    inputHash: requiredArg("--input-hash", input.inputHash),
    patchVersion: requiredArg("--patch-version", input.patchVersion),
    outputHash: requiredArg("--output-hash", input.outputHash),
    reproducibilityLogPath: requiredArg("--repro-log", input.reproducibilityLogPath),
    kernelFamily: input.kernelFamily,
    sourceChannel: input.sourceChannel,
  };

  const event = {
    at: new Date().toISOString(),
    type: "artifact.pipeline.record",
    ...payload,
  };

  await appendJsonl(config.logs.artifactPipelineLogPath, event);
  process.stdout.write(`${JSON.stringify(event, null, 2)}\n`);
}

async function main(): Promise<void> {
  const action = process.argv[2] ?? "check-drift";

  if (action === "check-drift") {
    await runDriftCheck();
    return;
  }

  if (action === "log-artifact") {
    await logArtifactPipeline();
    return;
  }

  throw new Error(`Unsupported action: ${action}. Use check-drift or log-artifact.`);
}

// --- Direct execution guard (same realpath pattern as cli.ts / index.ts) ---
// Without it, importing this module from a test would execute a live check.

const isDirectExecution = ((): boolean => {
  if (!process.argv[1]) return false;
  const realOrSelf = (candidate: string): string => {
    try {
      return realpathSync(candidate);
    } catch {
      return resolve(candidate);
    }
  };
  return realOrSelf(process.argv[1]) === realOrSelf(fileURLToPath(import.meta.url));
})();

if (isDirectExecution) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    // exitCode (not process.exit) so pending stderr pipe writes flush.
    process.exitCode = 1;
  });
}
