#!/usr/bin/env bash
# xx-stack setup for OpenCode + multi-provider endpoints
set -euo pipefail

# Required steps are the reason setup runs: a working registry, a merged agent
# surface, and repaired provider config in the live OpenCode config. Failing
# them is a failed install and must fail the script, not print "ready".
REQUIRED_STEP_FAILURES=()
OPTIONAL_STEP_WARNINGS=()

note_required_step_failure() {
  REQUIRED_STEP_FAILURES+=("$1")
  echo "error: REQUIRED setup step failed: $1" >&2
}

note_optional_step_warning() {
  OPTIONAL_STEP_WARNINGS+=("$1")
  echo "warning: optional setup step failed (continuing): $1" >&2
}

print_step_failure_summary() {
  if [ "${#OPTIONAL_STEP_WARNINGS[@]}" -gt 0 ]; then
    echo ""
    echo "setup finished with ${#OPTIONAL_STEP_WARNINGS[@]} optional step warning(s):" >&2
    for warning in "${OPTIONAL_STEP_WARNINGS[@]}"; do
      echo "  - $warning" >&2
    done
  fi
  if [ "${#REQUIRED_STEP_FAILURES[@]}" -gt 0 ]; then
    echo ""
    echo "setup finished with ${#REQUIRED_STEP_FAILURES[@]} required step failure(s):" >&2
    for failure in "${REQUIRED_STEP_FAILURES[@]}"; do
      echo "  - $failure" >&2
    done
    echo "xx-stack setup FAILED: one or more required steps did not complete." >&2
  fi
}

REPO_DIR="$(cd "$(dirname "$0")" && pwd -P)"
SETUP_CONSTANTS_HELPERS="$REPO_DIR/scripts/lib/setup-constants.sh"
if [ ! -f "$SETUP_CONSTANTS_HELPERS" ]; then
  echo "xx-stack setup failed: missing setup helper library: $SETUP_CONSTANTS_HELPERS" >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$SETUP_CONSTANTS_HELPERS"
LOCAL_OLLAMA_URL="${LOCAL_OLLAMA_URL:-http://127.0.0.1:11434}"
REMOTE_OLLAMA_URL="${REMOTE_OLLAMA_URL:-}"
LOCAL_LLAMA_CPP_URL="${LOCAL_LLAMA_CPP_URL:-http://127.0.0.1:8080}"
REMOTE_OPENAI_COMPAT_URL="${REMOTE_OPENAI_COMPAT_URL:-}"
REMOTE_OPENAI_COMPAT_PORT="${XX_STACK_REMOTE_OPENAI_PORT:-8080}"
LLAMA_CPP_MODEL_DIR="${LLAMA_CPP_MODEL_DIR:-}"
LLAMA_CPP_RUNTIME_CHANNEL="${XX_STACK_LLAMA_CPP_RUNTIME_CHANNEL:-stable}"
XX_STACK_ENABLE_LLAMA_CPP="${XX_STACK_ENABLE_LLAMA_CPP:-1}"
LLAMA_CPP_ROLLOUT_PHASE="${XX_STACK_LLAMA_CPP_ROLLOUT_PHASE:-3}"
XX_STACK_LLAMA_CPP_DEFAULT_ON="${XX_STACK_LLAMA_CPP_DEFAULT_ON:-1}"
XX_STACK_RUN_LLAMA_CPP_REGRESSION="${XX_STACK_RUN_LLAMA_CPP_REGRESSION:-1}"
XX_STACK_ALLOW_MULTI_MODEL="${XX_STACK_ALLOW_MULTI_MODEL:-1}"
export XX_STACK_ALLOW_MULTI_MODEL
LOCAL_LOCALAI_URL="${LOCAL_LOCALAI_URL:-}"
REMOTE_LOCALAI_URL="${REMOTE_LOCALAI_URL:-}"
LOCAL_OPENAI_COMPAT_URL="${LOCAL_OPENAI_COMPAT_URL:-${LOCAL_LLAMA_CPP_URL}}"
REMOTE_SSH_USER="${XX_STACK_REMOTE_SSH_USER:-}"
REMOTE_SSH_PASSWORD="${XX_STACK_REMOTE_SSH_PASSWORD:-}"
REMOTE_SSH_MODE="${XX_STACK_REMOTE_SSH_MODE:-auto}"
REMOTE_SSH_PROMPT="${XX_STACK_REMOTE_SSH_PROMPT:-1}"
BACKEND="${XX_STACK_BACKEND:-llama-cpp}"
STRICT_AGENT_VALIDATION="${XX_STACK_STRICT_AGENT_VALIDATION:-fail}"
INSTALL_MODE="copy"
SYNC_MODELS="1"
PRUNE_UNMANAGED_SHIMS="0"
CONFIRM_PRUNE_UNMANAGED_SHIMS="0"
CONFIG_BACKUP_PATH=""

require_flag_value() {
  if [ $# -lt 2 ] || [ -z "$2" ]; then
    echo "xx-stack setup failed: $1 requires a value" >&2
    exit 1
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --mode)
      require_flag_value "$@"
      INSTALL_MODE="$2"
      shift 2
      ;;
    --mode=*)
      INSTALL_MODE="${1#--mode=}"
      shift
      ;;
    --skip-model-sync)
      SYNC_MODELS="0"
      shift
      ;;
    --backend)
      require_flag_value "$@"
      BACKEND="$2"
      shift 2
      ;;
    --backend=*)
      BACKEND="${1#--backend=}"
      shift
      ;;
    --strict-agent-validation)
      require_flag_value "$@"
      STRICT_AGENT_VALIDATION="$2"
      shift 2
      ;;
    --strict-agent-validation=*)
      STRICT_AGENT_VALIDATION="${1#--strict-agent-validation=}"
      shift
      ;;
    --prune-unmanaged-shims)
      PRUNE_UNMANAGED_SHIMS="1"
      shift
      ;;
    --confirm-prune-unmanaged-shims)
      PRUNE_UNMANAGED_SHIMS="1"
      CONFIRM_PRUNE_UNMANAGED_SHIMS="1"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

if [ "$INSTALL_MODE" != "copy" ] && [ "$INSTALL_MODE" != "move" ]; then
  echo "xx-stack setup failed: unknown --mode '$INSTALL_MODE' (use copy or move)" >&2
  exit 1
fi

if [ -n "$LOCAL_LOCALAI_URL" ] && { [ -z "$LOCAL_OPENAI_COMPAT_URL" ] || [ "$LOCAL_OPENAI_COMPAT_URL" = "$LOCAL_LLAMA_CPP_URL" ]; }; then
  LOCAL_OPENAI_COMPAT_URL="$LOCAL_LOCALAI_URL"
fi
if [ -z "$REMOTE_OPENAI_COMPAT_URL" ] && [ -n "$REMOTE_LOCALAI_URL" ]; then
  REMOTE_OPENAI_COMPAT_URL="$REMOTE_LOCALAI_URL"
fi

if [ "$BACKEND" != "ollama" ] && [ "$BACKEND" != "llama-cpp" ] && [ "$BACKEND" != "localai" ] && [ "$BACKEND" != "both" ]; then
  echo "xx-stack setup failed: unknown --backend '$BACKEND' (use ollama, llama-cpp, localai, or both)" >&2
  exit 1
fi

if [ "$STRICT_AGENT_VALIDATION" != "fail" ] && [ "$STRICT_AGENT_VALIDATION" != "warn" ]; then
  echo "xx-stack setup failed: unknown --strict-agent-validation '$STRICT_AGENT_VALIDATION' (use fail or warn)" >&2
  exit 1
fi

if [ "$LLAMA_CPP_ROLLOUT_PHASE" != "0" ] && [ "$LLAMA_CPP_ROLLOUT_PHASE" != "1" ] && [ "$LLAMA_CPP_ROLLOUT_PHASE" != "2" ] && [ "$LLAMA_CPP_ROLLOUT_PHASE" != "3" ]; then
  echo "xx-stack setup failed: unknown XX_STACK_LLAMA_CPP_ROLLOUT_PHASE '$LLAMA_CPP_ROLLOUT_PHASE' (use 0, 1, 2, or 3)" >&2
  exit 1
fi

backend_includes() {
  local lane="$1"
  case "$BACKEND" in
    both)
      return 0
      ;;
    "$lane")
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

if [ ! -d "$REPO_OPENCODE_DIR/skills" ]; then
  echo "xx-stack setup failed: missing opencode/skills in $REPO_DIR" >&2
  exit 1
fi

mkdir -p "$STATE_DIR"
mkdir -p "$OPENCODE_SKILLS_DIR"

SETUP_CONFIG_HELPERS="$REPO_DIR/scripts/lib/setup-config-helpers.sh"
if [ ! -f "$SETUP_CONFIG_HELPERS" ]; then
  echo "xx-stack setup failed: missing setup helper library: $SETUP_CONFIG_HELPERS" >&2
  exit 1
fi
SETUP_ENDPOINT_HELPERS="$REPO_DIR/scripts/lib/setup-endpoint-helpers.sh"
if [ ! -f "$SETUP_ENDPOINT_HELPERS" ]; then
  echo "xx-stack setup failed: missing setup helper library: $SETUP_ENDPOINT_HELPERS" >&2
  exit 1
fi
SETUP_REGISTRY_HELPERS="$REPO_DIR/scripts/lib/setup-registry-helpers.sh"
if [ ! -f "$SETUP_REGISTRY_HELPERS" ]; then
  echo "xx-stack setup failed: missing setup helper library: $SETUP_REGISTRY_HELPERS" >&2
  exit 1
fi
SETUP_HARDWARE_HELPERS="$REPO_DIR/scripts/lib/setup-hardware-helpers.sh"
if [ ! -f "$SETUP_HARDWARE_HELPERS" ]; then
  echo "xx-stack setup failed: missing setup helper library: $SETUP_HARDWARE_HELPERS" >&2
  exit 1
fi
SETUP_MODEL_HELPERS="$REPO_DIR/scripts/lib/setup-model-helpers.sh"
if [ ! -f "$SETUP_MODEL_HELPERS" ]; then
  echo "xx-stack setup failed: missing setup helper library: $SETUP_MODEL_HELPERS" >&2
  exit 1
fi
SETUP_SKILL_HELPERS="$REPO_DIR/scripts/lib/setup-skill-helpers.sh"
if [ ! -f "$SETUP_SKILL_HELPERS" ]; then
  echo "xx-stack setup failed: missing setup helper library: $SETUP_SKILL_HELPERS" >&2
  exit 1
fi
SETUP_TAILSCALE_HELPERS="$REPO_DIR/scripts/lib/setup-tailscale-helpers.sh"
if [ ! -f "$SETUP_TAILSCALE_HELPERS" ]; then
  echo "xx-stack setup failed: missing setup helper library: $SETUP_TAILSCALE_HELPERS" >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$SETUP_CONFIG_HELPERS"
# shellcheck source=/dev/null
. "$SETUP_ENDPOINT_HELPERS"
# shellcheck source=/dev/null
. "$SETUP_REGISTRY_HELPERS"
# shellcheck source=/dev/null
. "$SETUP_HARDWARE_HELPERS"
# shellcheck source=/dev/null
. "$SETUP_MODEL_HELPERS"
# shellcheck source=/dev/null
. "$SETUP_SKILL_HELPERS"
# shellcheck source=/dev/null
. "$SETUP_TAILSCALE_HELPERS"

# `.opencode/` is a compatibility shim for runtime discovery that still expects
# that path; `opencode/` is canonical. setup-opencode.sh creates it in workspace
# mode, but setup.sh must not depend on that having run first — several steps
# below resolve through it.
if [ ! -e "$OPENCODE_RUNTIME_COMPAT_DIR" ] && [ -d "$OPENCODE_TARGET_DIR/$XX_STACK_OPENCODE_SOURCE_DIR" ]; then
  ln -s "$XX_STACK_OPENCODE_SOURCE_DIR" "$OPENCODE_RUNTIME_COMPAT_DIR" \
    && echo "  created compatibility shim: $OPENCODE_RUNTIME_COMPAT_DIR -> $XX_STACK_OPENCODE_SOURCE_DIR"
fi

echo "Exporting xx-stack skills for OpenCode discovery..."
prune_obsolete_unmanaged_skill_shims "$OPENCODE_RUNTIME_SKILLS_DIR" "$OPENCODE_SKILLS_DIR" || note_optional_step_warning "prune_obsolete_unmanaged_skill_shims"
export_skills_for_opencode "$OPENCODE_RUNTIME_SKILLS_DIR" "$OPENCODE_SKILLS_DIR" || note_required_step_failure "export_skills_for_opencode"

# Regenerate the registry from inventory.json first, so setup can never install
# a stale topology. Required when inventory.json exists: installing the stale
# committed registry over a newer inventory quietly forks the topology.
XX_STACK_GENERATOR="$REPO_DIR/../scripts/generate-registries.mjs"
if [ -f "$REPO_DIR/../inventory.json" ] && [ -f "$XX_STACK_GENERATOR" ]; then
  echo "Regenerating platform registry from inventory.json..."
  node "$XX_STACK_GENERATOR" || note_required_step_failure "generate_registries_from_inventory"
elif [ -f "$XX_STACK_GENERATOR" ]; then
  echo "  no inventory.json found — installing the committed registry."
  echo "  to describe your own machines: cp inventory.example.json inventory.json"
fi

echo "Installing platform registry for orchestration-aware routing..."
# Seed the LIVE registry from the generated repo registry, then enrich the live
# copy in place. Everything below writes to the live registry, never to the repo:
# opencode/platforms.json is generated from inventory.json, and mutating it here
# would make `npm run inventory:check` fail and quietly fork the topology.
# The live registry is also what the MCP server reads first at runtime.
mkdir -p "$OPENCODE_CONFIG_HOME"
if [ -f "$REPO_OPENCODE_DIR/$XX_STACK_OPENCODE_PLATFORMS_FILE" ]; then
  cp -f "$REPO_OPENCODE_DIR/$XX_STACK_OPENCODE_PLATFORMS_FILE" "$GLOBAL_PLATFORM_REGISTRY_PATH"
  echo "  seeded live registry from generated topology: $GLOBAL_PLATFORM_REGISTRY_PATH"
else
  note_required_step_failure "seed_platform_registry"
fi

echo "Detecting local hardware for routing and recommendations..."
detect_local_hardware "$GLOBAL_PLATFORM_REGISTRY_PATH" || note_optional_step_warning "detect_local_hardware"

echo "Importing providers and model preferences from existing OpenCode config..."
import_existing_opencode_config "$GLOBAL_PLATFORM_REGISTRY_PATH" "$OPENCODE_CONFIG_PATH" "$MODEL_RECOMMENDATIONS_PATH" || note_required_step_failure "import_existing_opencode_config"

# Remote host topology comes from inventory.json, which the registry above was
# generated from. Setup no longer runs its own interactive Tailscale discovery:
# it wrote into the *installed* registry, which this script overwrites on every
# run, so those findings were silently lost and never reached inventory.json.
#
#   npm run inventory:scan -- --write   discover peers and merge them
#   npm run inventory:enable -- <host>  turn a lane on (all are off by default)
#   npm run inventory:sync              regenerate this registry
#
REMOTE_OLLAMA_URL="$(resolve_remote_ollama_url "$GLOBAL_PLATFORM_REGISTRY_PATH")"
REMOTE_OPENAI_COMPAT_URL="$(resolve_remote_openai_compatible_url "$GLOBAL_PLATFORM_REGISTRY_PATH")"

# `prompt_openai_compatible_endpoints` used to be called here but has never been
# defined in this repo — setup died on it under `set -e`. Endpoint topology now
# comes from inventory.json, so there is nothing to prompt for. Change endpoints
# with `npm run inventory:scan` / by editing inventory.json, then re-run setup.

if backend_includes "llama-cpp"; then
  setup_llama_cpp_host "$GLOBAL_PLATFORM_REGISTRY_PATH" "$LOCAL_OPENAI_COMPAT_URL" "$REMOTE_OPENAI_COMPAT_URL" || BACKEND="ollama"
fi

if backend_includes "localai"; then
  persist_openai_compatible_hosts_in_registry "$GLOBAL_PLATFORM_REGISTRY_PATH" "$LOCAL_OPENAI_COMPAT_URL" "$REMOTE_OPENAI_COMPAT_URL" "localai"
fi

apply_llama_cpp_rollout_phase "$GLOBAL_PLATFORM_REGISTRY_PATH"

prompt_remote_ssh_user "$GLOBAL_PLATFORM_REGISTRY_PATH"

echo "Detecting remote hardware from reachable Tailscale hosts (best effort)..."
detect_remote_hardware "$GLOBAL_PLATFORM_REGISTRY_PATH" || note_optional_step_warning "detect_remote_hardware"

echo "Syncing discovered Ollama models into platform registry..."
sync_platform_models "$GLOBAL_PLATFORM_REGISTRY_PATH" "$LOCAL_OLLAMA_URL" "$REMOTE_OLLAMA_URL" "$LOCAL_OPENAI_COMPAT_URL" "$REMOTE_OPENAI_COMPAT_URL" || note_optional_step_warning "sync_platform_models"

# `run_llama_cpp_regression_gate` and `evaluate_llama_cpp_host_support_matrix`
# were called here but are likewise undefined. Removed rather than stubbed —
# reintroduce them alongside a real implementation.

echo "Recommending local models when Ollama inventory is empty..."
recommend_local_models_if_empty "$GLOBAL_PLATFORM_REGISTRY_PATH" || note_optional_step_warning "recommend_local_models_if_empty"

# (No re-install step: enrichment already happened in the live registry.)

echo "Backing up existing OpenCode config before mutation..."
backup_global_config_once "$OPENCODE_CONFIG_PATH" || note_required_step_failure "backup_global_config_once"

echo "Initializing global OpenCode config when missing..."
initialize_global_config "$REPO_OPENCODE_CONFIG_PATH" "$OPENCODE_CONFIG_PATH" || note_required_step_failure "initialize_global_config"

echo "Merging xx-stack subagents into global OpenCode config..."
merge_repo_agents_into_global_config "$REPO_OPENCODE_CONFIG_PATH" "$OPENCODE_CONFIG_PATH" || note_required_step_failure "merge_repo_agents_into_global_config"

echo "Syncing discovered runtime models into global OpenCode config..."
sync_runtime_models_into_global_config "$GLOBAL_PLATFORM_REGISTRY_PATH" "$REPO_OPENCODE_CONFIG_PATH" "$OPENCODE_CONFIG_PATH" "$LOCAL_OLLAMA_URL" "$REMOTE_OLLAMA_URL" "$LOCAL_OPENAI_COMPAT_URL" "$REMOTE_OPENAI_COMPAT_URL" || note_required_step_failure "sync_runtime_models_into_global_config"

echo "Reapplying canonical xx-stack agent surface after model sync..."
merge_repo_agents_into_global_config "$REPO_OPENCODE_CONFIG_PATH" "$OPENCODE_CONFIG_PATH" || note_required_step_failure "merge_repo_agents_into_global_config"

echo "Repairing remote provider settings in global OpenCode config..."
repair_remote_provider_config "$OPENCODE_CONFIG_PATH" "$REMOTE_OLLAMA_URL" "$REMOTE_OPENAI_COMPAT_URL" || note_required_step_failure "repair_remote_provider_config"

echo "Ensuring xx-stack MCP server is installed and registered..."
ensure_xx_stack_mcp_server_registration "$OPENCODE_CONFIG_PATH" "$OPENCODE_TARGET_DIR"

echo "Validating merged agent profiles in global OpenCode config..."
validate_merged_agent_profiles "$OPENCODE_CONFIG_PATH" "$STRICT_AGENT_VALIDATION"

echo "Running xx-stack MCP startup self-test..."
self_test_xx_stack_mcp_server "$OPENCODE_CONFIG_PATH"

# Best-effort count for the ready banner: a missing skills dir must reach the
# failure summary below instead of killing the script here under set -e.
if ! SKILL_COUNT="$(find "$OPENCODE_RUNTIME_SKILLS_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"; then
  SKILL_COUNT=0
fi

echo "xx-stack ready (opencode + model endpoints)."
echo "  backend lane: $BACKEND"
if [ "$BACKEND" = "ollama" ] && [ -z "${XX_STACK_BACKEND:-}" ]; then
  echo "  defaulted to backend: ollama"
fi
if [ "$XX_STACK_ENABLE_LLAMA_CPP" = "1" ]; then
  echo "  llama.cpp rollout flag: enabled"
else
  echo "  llama.cpp rollout flag: disabled (set XX_STACK_ENABLE_LLAMA_CPP=1 to enable the TurboQuant llama.cpp lane)"
fi
# `print_llama_cpp_startup_recipes` was called here but has never been defined —
# the last of three such calls that made setup exit 127 before finishing.
echo "  install mode: $INSTALL_MODE"
echo "  skills root: $OPENCODE_TARGET_DIR"
echo "  state dir: $STATE_DIR"
echo "  discovered skills: $SKILL_COUNT"
if backend_includes "ollama"; then
  check_ollama_endpoint "local ollama" "$LOCAL_OLLAMA_URL" || true
  check_ollama_endpoint "remote ollama (tailscale)" "$REMOTE_OLLAMA_URL" || true
fi
if backend_includes "llama-cpp"; then
  check_openai_compatible_endpoint "local llama.cpp" "$LOCAL_OPENAI_COMPAT_URL" || true
  check_openai_compatible_endpoint "remote OpenAI-compatible" "$REMOTE_OPENAI_COMPAT_URL" || true
fi
if backend_includes "localai"; then
  check_openai_compatible_endpoint "local LocalAI" "$LOCAL_OPENAI_COMPAT_URL" || true
  check_openai_compatible_endpoint "remote OpenAI-compatible" "$REMOTE_OPENAI_COMPAT_URL" || true
fi

print_step_failure_summary

if [ "${#REQUIRED_STEP_FAILURES[@]}" -gt 0 ]; then
  exit 1
fi
