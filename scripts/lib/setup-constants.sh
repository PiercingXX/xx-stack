#!/usr/bin/env bash

if [ -z "$REPO_DIR" ]; then
	REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
fi

REPO_OPENCODE_DIR="${REPO_OPENCODE_DIR:-$REPO_DIR/opencode}"
RUNTIME_CONSTANTS_PATH="${RUNTIME_CONSTANTS_PATH:-$REPO_OPENCODE_DIR/runtime-constants.json}"

# opencode/runtime-constants.json is the single source of truth for these
# identifiers; fail loudly rather than run with a stale hand-maintained copy.
if ! command -v node >/dev/null 2>&1; then
	echo "error: xx-stack setup requires node to load runtime constants from $RUNTIME_CONSTANTS_PATH" >&2
	return 1 2>/dev/null || exit 1
fi

if [ ! -f "$RUNTIME_CONSTANTS_PATH" ]; then
	echo "error: runtime constants file not found: $RUNTIME_CONSTANTS_PATH" >&2
	return 1 2>/dev/null || exit 1
fi

__xx_stack_constant_exports="$(RUNTIME_CONSTANTS_PATH="$RUNTIME_CONSTANTS_PATH" node <<'NODE'
const fs = require('fs');

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

const constants = JSON.parse(fs.readFileSync(process.env.RUNTIME_CONSTANTS_PATH, 'utf8'));
const exports = {
  XX_STACK_TIER_LOCAL: constants.tiers.local,
  XX_STACK_TIER_TAILSCALE_OLLAMA: constants.tiers.tailscaleOllama,
  XX_STACK_TIER_TAILSCALE_OPENAI_COMPATIBLE: constants.tiers.tailscaleOpenAiCompatible,
  XX_STACK_TIER_CLOUD: constants.tiers.cloud,
  XX_STACK_HOST_LOCAL_WORKSTATION: constants.hosts.localWorkstation,
  XX_STACK_HOST_EXAMPLE_GPU_BOX: constants.hosts.exampleGpuBox,
  XX_STACK_HOST_LOCAL_OPENAI_COMPATIBLE: constants.hosts.localOpenAiCompatible,
  XX_STACK_HOST_TAILSCALE_OPENAI_COMPATIBLE_PRIMARY: constants.hosts.tailscaleOpenAiCompatiblePrimary,
  XX_STACK_PROVIDER_OLLAMA_LOCAL: constants.providers.ollamaLocal,
  XX_STACK_PROVIDER_OLLAMA_REMOTE: constants.providers.ollamaRemote,
  XX_STACK_PROVIDER_LLAMA_CPP_LOCAL: constants.providers.llamaCppLocal,
  XX_STACK_PROVIDER_SGLANG_REMOTE: constants.providers.sglangRemote,
  XX_STACK_PROVIDER_LOCALAI_LOCAL: constants.providers.localAiLocal,
  XX_STACK_PROVIDER_LOCALAI_REMOTE: constants.providers.localAiRemote,
  XX_STACK_NETWORK_SCOPE_LOCALHOST: constants.networkScopes.localhost,
  XX_STACK_NETWORK_SCOPE_TAILSCALE: constants.networkScopes.tailscale,
  XX_STACK_NETWORK_SCOPE_INTERNET: constants.networkScopes.internet,
  XX_STACK_OPENCODE_SOURCE_DIR: constants.paths.sourceDir,
  XX_STACK_OPENCODE_COMPAT_DIR: constants.paths.compatDir,
  XX_STACK_OPENCODE_PLATFORMS_FILE: constants.paths.platformsFile,
  XX_STACK_OPENCODE_CONFIG_FILE: constants.paths.configFile,
  XX_STACK_OPENCODE_SKILLS_DIR_NAME: constants.paths.skillsDir,
  XX_STACK_MODEL_RECOMMENDATIONS_FILE: constants.paths.modelRecommendationsFile,
  XX_STACK_GLOBAL_PLATFORMS_FILE: constants.paths.globalPlatformsFile,
  XX_STACK_STATE_DIR_NAME: constants.paths.stateDir,
  XX_STACK_STATE_PROJECTS_DIR_NAME: constants.paths.stateProjectsDir,
};

for (const [key, value] of Object.entries(exports)) {
  if (value === undefined || value === null || value === "") {
    process.stderr.write(`error: runtime constant missing a value for ${key}\n`);
    process.exit(1);
  }
  process.stdout.write(`export ${key}=${shellEscape(value)}\n`);
}
NODE
)" || {
	echo "error: failed to load runtime constants from $RUNTIME_CONSTANTS_PATH" >&2
	return 1 2>/dev/null || exit 1
}
eval "$__xx_stack_constant_exports"
unset __xx_stack_constant_exports

OPENCODE_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
OPENCODE_SKILLS_DIR="$OPENCODE_CONFIG_HOME/$XX_STACK_OPENCODE_SKILLS_DIR_NAME"
OPENCODE_TARGET_DIR="$OPENCODE_SKILLS_DIR/xx-stack"
OPENCODE_RUNTIME_COMPAT_DIR="$OPENCODE_TARGET_DIR/$XX_STACK_OPENCODE_COMPAT_DIR"
OPENCODE_RUNTIME_SKILLS_DIR="$OPENCODE_RUNTIME_COMPAT_DIR/$XX_STACK_OPENCODE_SKILLS_DIR_NAME"
OPENCODE_RUNTIME_PLATFORM_REGISTRY_PATH="$OPENCODE_RUNTIME_COMPAT_DIR/$XX_STACK_OPENCODE_PLATFORMS_FILE"
REPO_OPENCODE_CONFIG_PATH="$REPO_OPENCODE_DIR/$XX_STACK_OPENCODE_CONFIG_FILE"
OPENCODE_CONFIG_PATH="$OPENCODE_CONFIG_HOME/$XX_STACK_OPENCODE_CONFIG_FILE"
GLOBAL_PLATFORM_REGISTRY_PATH="$OPENCODE_CONFIG_HOME/$XX_STACK_GLOBAL_PLATFORMS_FILE"
MODEL_RECOMMENDATIONS_PATH="$REPO_OPENCODE_DIR/$XX_STACK_MODEL_RECOMMENDATIONS_FILE"
STATE_DIR="$HOME/$XX_STACK_STATE_DIR_NAME/$XX_STACK_STATE_PROJECTS_DIR_NAME"

export REPO_OPENCODE_DIR
export RUNTIME_CONSTANTS_PATH
export OPENCODE_CONFIG_HOME
export OPENCODE_SKILLS_DIR
export OPENCODE_TARGET_DIR
export OPENCODE_RUNTIME_COMPAT_DIR
export OPENCODE_RUNTIME_SKILLS_DIR
export OPENCODE_RUNTIME_PLATFORM_REGISTRY_PATH
export REPO_OPENCODE_CONFIG_PATH
export OPENCODE_CONFIG_PATH
export GLOBAL_PLATFORM_REGISTRY_PATH
export MODEL_RECOMMENDATIONS_PATH
export STATE_DIR