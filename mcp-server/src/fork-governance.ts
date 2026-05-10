import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

type ChannelConfig = {
  repo: string;
  ref: string;
};

type GovernanceConfig = {
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

type GovernanceState = {
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

async function resolveRemoteHead(repo: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-remote", repo, ref], {
      timeout: 10_000,
    });
    const line = stdout.split("\n").find((item) => item.trim().length > 0);
    if (!line) return null;
    const hash = line.split(/\s+/)[0];
    return hash || null;
  } catch {
    return null;
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
      stable: { repo: "origin", ref: "main" },
      experimental: { repo: "experimental", ref: "main" },
    },
    driftThreshold: {
      maxStableAdvancesWithoutExperimental: 3,
    },
    logs: {
      governanceLogPath: "~/.config/xx-stack/xx-stack-logs/fork-governance.jsonl",
      statePath: "~/.config/xx-stack/xx-stack-logs/fork-governance-state.json",
      artifactPipelineLogPath: "~/.config/xx-stack/xx-stack-logs/model-artifact-pipeline.jsonl",
    },
  });

  config.logs.governanceLogPath = expandHome(config.logs.governanceLogPath);
  config.logs.statePath = expandHome(config.logs.statePath);
  config.logs.artifactPipelineLogPath = expandHome(config.logs.artifactPipelineLogPath);
  return config;
}

async function runDriftCheck(): Promise<void> {
  const config = await loadConfig();
  const prior = await readJson<GovernanceState>(config.logs.statePath, {
    stableHead: null,
    experimentalHead: null,
    stableAdvanceCountWithoutExperimental: 0,
    updatedAt: new Date(0).toISOString(),
  });

  const [stableHead, experimentalHead] = await Promise.all([
    resolveRemoteHead(config.channels.stable.repo, config.channels.stable.ref),
    resolveRemoteHead(config.channels.experimental.repo, config.channels.experimental.ref),
  ]);

  let stableAdvanceCountWithoutExperimental = prior.stableAdvanceCountWithoutExperimental;

  const stableMoved = stableHead !== null && stableHead !== prior.stableHead;
  const experimentalMoved = experimentalHead !== null && experimentalHead !== prior.experimentalHead;

  if (stableMoved && !experimentalMoved) {
    stableAdvanceCountWithoutExperimental += 1;
  } else if (experimentalMoved) {
    stableAdvanceCountWithoutExperimental = 0;
  }

  const driftRiskHigh =
    stableAdvanceCountWithoutExperimental > config.driftThreshold.maxStableAdvancesWithoutExperimental;

  const payload = {
    at: new Date().toISOString(),
    type: "fork.governance.check",
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
    gateProductionPromotion: !driftRiskHigh,
  };

  await appendJsonl(config.logs.governanceLogPath, payload);

  const nextState: GovernanceState = {
    stableHead,
    experimentalHead,
    stableAdvanceCountWithoutExperimental,
    updatedAt: new Date().toISOString(),
  };

  await ensureParent(config.logs.statePath);
  await writeFile(config.logs.statePath, `${JSON.stringify(nextState, null, 2)}\n`, "utf-8");

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(payload.gateProductionPromotion ? 0 : 1);
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

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
