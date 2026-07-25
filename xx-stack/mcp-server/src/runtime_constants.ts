import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type RuntimeConstants = {
  tiers: {
    local: string;
    tailscaleOllama: string;
    tailscaleOpenAiCompatible: string;
    cloud: string;
  };
  hosts: {
    localWorkstation: string;
    skippyDebian5090: string;
    testBenchArchlinux: string;
    localOpenAiCompatible: string;
    tailscaleOpenAiCompatiblePrimary: string;
    hermesProxy: string;
  };
  providers: {
    ollamaLocal: string;
    ollamaRemote: string;
    ollama5090: string;
    llamaCppLocal: string;
    sglangRemote: string;
    localAiLocal: string;
    localAiRemote: string;
    hermesProxy: string;
  };
  networkScopes: {
    localhost: string;
    tailscale: string;
    internet: string;
  };
  paths: {
    canonicalSourceDir: string;
    sourceDir: string;
    compatDir: string;
    platformsFile: string;
    configFile: string;
    skillsDir: string;
    modelRecommendationsFile: string;
    globalPlatformsFile: string;
    stateDir: string;
    stateProjectsDir: string;
  };
};

// runtime-constants.json is resolved relative to this module so the server can
// be relocated between components without editing source. `runtime/` is the
// canonical xx-stack config directory; `opencode/` is the standalone
// opencode-orchestration layout and is kept as a fallback.
const CONSTANTS_CANDIDATES = [
  // Bundled copy, written into the package root by `prepack`. This is what a
  // published install resolves — the repo-relative paths below do not exist
  // inside a tarball, and without this the server threw on startup.
  "../runtime-constants.json",
  "../../runtime/runtime-constants.json",
  "../../opencode/runtime-constants.json",
] as const;

function loadRuntimeConstants(): RuntimeConstants {
  const tried: string[] = [];
  for (const candidate of CONSTANTS_CANDIDATES) {
    const url = new URL(candidate, import.meta.url);
    tried.push(url.pathname);
    if (existsSync(url)) {
      return JSON.parse(readFileSync(url, "utf8")) as RuntimeConstants;
    }
  }
  throw new Error(
    `xx-stack mcp-server: runtime-constants.json not found. Looked in:\n  ${tried.join("\n  ")}\n` +
      `Expected a sibling runtime/ (or opencode/) directory next to mcp-server/.`
  );
}

const runtimeConstants = loadRuntimeConstants();

export const TIER_IDS = runtimeConstants.tiers;
export const HOST_IDS = runtimeConstants.hosts;
export const PROVIDER_IDS = runtimeConstants.providers;
export const NETWORK_SCOPES = runtimeConstants.networkScopes;
export const PATH_CONSTANTS = runtimeConstants.paths;

// Directories that may hold a stack source file, in resolution order:
//   runtime/   canonical xx-stack layout
//   opencode/  opencode-orchestration layout
//   .opencode/ legacy compatibility shim
function sourceDirsInOrder(): string[] {
  return [PATH_CONSTANTS.canonicalSourceDir, PATH_CONSTANTS.sourceDir, PATH_CONSTANTS.compatDir];
}

export function repoFileCandidates(cwd: string, fileName: string, includeParent = false): string[] {
  const dirs = sourceDirsInOrder();
  const candidates = dirs.map((dir) => join(cwd, dir, fileName));

  if (includeParent) {
    candidates.push(...dirs.map((dir) => join(cwd, "..", dir, fileName)));
  }

  return candidates;
}

export function repoCompatFileCandidates(cwd: string, fileName: string): string[] {
  return repoFileCandidates(cwd, fileName, true);
}

export function resolveRepoFilePath(repoRoot: string, fileName: string): string {
  const candidates = repoFileCandidates(repoRoot, fileName);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export function liveRegistryPath(homeDir = homedir()): string {
  return join(homeDir, ".config", "opencode", PATH_CONSTANTS.globalPlatformsFile);
}

export function liveConfigPath(homeDir = homedir()): string {
  return join(homeDir, ".config", "opencode", PATH_CONSTANTS.configFile);
}

export function repoRegistryPath(homeDir = homedir()): string {
  const repoRoot =
    process.env.XX_STACK_REPO || resolve(homeDir, ".config/opencode/skills/xx-stack");
  return resolveRepoFilePath(repoRoot, PATH_CONSTANTS.platformsFile);
}
