#!/usr/bin/env bash
# xx-stack setup for OpenCode + multi-provider endpoints
set -eo pipefail

SETUP_STEP_WARNINGS=()

note_step_failure() {
  SETUP_STEP_WARNINGS+=("$1")
  echo "warning: setup step failed (continuing): $1" >&2
}

print_step_warning_summary() {
  if [ ${#SETUP_STEP_WARNINGS[@]} -eq 0 ]; then
    return 0
  fi
  echo ""
  echo "setup finished with ${#SETUP_STEP_WARNINGS[@]} step warning(s):" >&2
  for warning in "${SETUP_STEP_WARNINGS[@]}"; do
    echo "  - $warning" >&2
  done
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
RESOLVED_REMOTE_OLLAMA_URL=""
RESOLVED_REMOTE_OPENAI_COMPAT_URL=""
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

while [ $# -gt 0 ]; do
  case "$1" in
    --mode)
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
      BACKEND="$2"
      shift 2
      ;;
    --backend=*)
      BACKEND="${1#--backend=}"
      shift
      ;;
    --strict-agent-validation)
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

echo "Exporting xx-stack skills for OpenCode discovery..."
prune_obsolete_unmanaged_skill_shims "$OPENCODE_RUNTIME_SKILLS_DIR" "$OPENCODE_SKILLS_DIR" || note_step_failure "prune_obsolete_unmanaged_skill_shims"
export_skills_for_opencode "$OPENCODE_RUNTIME_SKILLS_DIR" "$OPENCODE_SKILLS_DIR" || note_step_failure "export_skills_for_opencode"

echo "Installing platform registry for orchestration-aware routing..."
install_platform_registry "$OPENCODE_RUNTIME_PLATFORM_REGISTRY_PATH" "$GLOBAL_PLATFORM_REGISTRY_PATH" || note_step_failure "install_platform_registry"

echo "Detecting local hardware for routing and recommendations..."
detect_local_hardware "$OPENCODE_RUNTIME_PLATFORM_REGISTRY_PATH" || note_step_failure "detect_local_hardware"

echo "Importing providers and model preferences from existing OpenCode config..."
import_existing_opencode_config "$OPENCODE_RUNTIME_PLATFORM_REGISTRY_PATH" "$OPENCODE_CONFIG_PATH" "$MODEL_RECOMMENDATIONS_PATH" || note_step_failure "import_existing_opencode_config"

REMOTE_OLLAMA_URL="$(resolve_remote_ollama_url "$OPENCODE_RUNTIME_PLATFORM_REGISTRY_PATH")"
confirm_remote_tailscale_ollama_url "$OPENCODE_RUNTIME_PLATFORM_REGISTRY_PATH" "$REMOTE_OLLAMA_URL"
REMOTE_OLLAMA_URL="$RESOLVED_REMOTE_OLLAMA_URL"
REMOTE_OPENAI_COMPAT_URL="$(resolve_remote_openai_compatible_url "$OPENCODE_RUNTIME_PLATFORM_REGISTRY_PATH")"
confirm_remote_tailscale_openai_compatible_url "$OPENCODE_RUNTIME_PLATFORM_REGISTRY_PATH" "$REMOTE_OPENAI_COMPAT_URL" "$BACKEND"
REMOTE_OPENAI_COMPAT_URL="$RESOLVED_REMOTE_OPENAI_COMPAT_URL"

prompt_openai_compatible_endpoints

if backend_includes "llama-cpp"; then
  setup_llama_cpp_host "$OPENCODE_RUNTIME_PLATFORM_REGISTRY_PATH" "$LOCAL_OPENAI_COMPAT_URL" "$REMOTE_OPENAI_COMPAT_URL" || BACKEND="ollama"
fi

if backend_includes "localai"; then
  persist_openai_compatible_hosts_in_registry "$OPENCODE_RUNTIME_PLATFORM_REGISTRY_PATH" "$LOCAL_OPENAI_COMPAT_URL" "$REMOTE_OPENAI_COMPAT_URL" "localai"
fi

apply_llama_cpp_rollout_phase "$OPENCODE_RUNTIME_PLATFORM_REGISTRY_PATH"

prompt_remote_ssh_user "$OPENCODE_RUNTIME_PLATFORM_REGISTRY_PATH"

echo "Detecting remote hardware from reachable Tailscale hosts (best effort)..."
detect_remote_hardware "$OPENCODE_RUNTIME_PLATFORM_REGISTRY_PATH" || note_step_failure "detect_remote_hardware"

echo "Syncing discovered Ollama models into platform registry..."
sync_platform_models "$OPENCODE_RUNTIME_PLATFORM_REGISTRY_PATH" "$LOCAL_OLLAMA_URL" "$REMOTE_OLLAMA_URL" "$LOCAL_OPENAI_COMPAT_URL" "$REMOTE_OPENAI_COMPAT_URL" || note_step_failure "sync_platform_models"

run_llama_cpp_regression_gate "$OPENCODE_RUNTIME_PLATFORM_REGISTRY_PATH" || note_step_failure "run_llama_cpp_regression_gate"

evaluate_llama_cpp_host_support_matrix "$OPENCODE_RUNTIME_PLATFORM_REGISTRY_PATH"

echo "Recommending local models when Ollama inventory is empty..."
recommend_local_models_if_empty "$OPENCODE_RUNTIME_PLATFORM_REGISTRY_PATH" || note_step_failure "recommend_local_models_if_empty"

echo "Refreshing installed platform registry after sync..."
install_platform_registry "$OPENCODE_RUNTIME_PLATFORM_REGISTRY_PATH" "$GLOBAL_PLATFORM_REGISTRY_PATH" || note_step_failure "install_platform_registry"

echo "Backing up existing OpenCode config before mutation..."
backup_global_config_once "$OPENCODE_CONFIG_PATH" || note_step_failure "backup_global_config_once"

echo "Initializing global OpenCode config when missing..."
initialize_global_config "$REPO_OPENCODE_CONFIG_PATH" "$OPENCODE_CONFIG_PATH" || note_step_failure "initialize_global_config"

echo "Merging xx-stack subagents into global OpenCode config..."
merge_repo_agents_into_global_config "$REPO_OPENCODE_CONFIG_PATH" "$OPENCODE_CONFIG_PATH" || note_step_failure "merge_repo_agents_into_global_config"

echo "Syncing discovered runtime models into global OpenCode config..."
sync_runtime_models_into_global_config "$OPENCODE_RUNTIME_PLATFORM_REGISTRY_PATH" "$REPO_OPENCODE_CONFIG_PATH" "$OPENCODE_CONFIG_PATH" "$LOCAL_OLLAMA_URL" "$REMOTE_OLLAMA_URL" "$LOCAL_OPENAI_COMPAT_URL" "$REMOTE_OPENAI_COMPAT_URL" || note_step_failure "sync_runtime_models_into_global_config"

echo "Reapplying canonical xx-stack agent surface after model sync..."
merge_repo_agents_into_global_config "$REPO_OPENCODE_CONFIG_PATH" "$OPENCODE_CONFIG_PATH" || note_step_failure "merge_repo_agents_into_global_config"

echo "Repairing remote provider settings in global OpenCode config..."
repair_remote_provider_config "$OPENCODE_CONFIG_PATH" "$REMOTE_OLLAMA_URL" "$REMOTE_OPENAI_COMPAT_URL" || note_step_failure "repair_remote_provider_config"

echo "Ensuring xx-stack MCP server is installed and registered..."
ensure_xx_stack_mcp_server_registration "$OPENCODE_CONFIG_PATH" "$OPENCODE_TARGET_DIR"

echo "Ensuring VS Code MCP workspace config includes xx-stack server..."
ensure_vscode_workspace_mcp_config "$OPENCODE_TARGET_DIR" "$REPO_DIR" || note_step_failure "ensure_vscode_workspace_mcp_config"

echo "Validating merged agent profiles in global OpenCode config..."
validate_merged_agent_profiles "$OPENCODE_CONFIG_PATH" "$STRICT_AGENT_VALIDATION"

echo "Running xx-stack MCP startup self-test..."
self_test_xx_stack_mcp_server "$OPENCODE_CONFIG_PATH"

SKILL_COUNT="$(find "$OPENCODE_RUNTIME_SKILLS_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"

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
print_llama_cpp_startup_recipes
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

print_step_warning_summary
