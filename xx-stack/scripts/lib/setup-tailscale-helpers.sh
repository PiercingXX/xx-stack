resolve_remote_ollama_url() {
  local registry_path="$1"

  if [ -n "$REMOTE_OLLAMA_URL" ]; then
    printf '%s\n' "$REMOTE_OLLAMA_URL"
    return 0
  fi

  if ! command -v node >/dev/null 2>&1; then
    return 0
  fi

  OPENCODE_CONFIG_PATH="$OPENCODE_CONFIG_PATH" REGISTRY_PATH="$registry_path" node <<'NODE'
const fs = require('fs');
const remoteTierId = process.env.XX_STACK_TIER_TAILSCALE_OLLAMA;

function normalize(url) {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim().replace(/\/v1\/?$/, '');
  if (!trimmed || trimmed.includes('REMOTE_HOST') || trimmed.includes('example.invalid')) return '';
  return trimmed;
}

const configPath = process.env.OPENCODE_CONFIG_PATH;
const registryPath = process.env.REGISTRY_PATH;

if (configPath && fs.existsSync(configPath)) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const configUrl = normalize(config.provider?.ollama?.options?.baseURL || config.provider?.ollama?.baseURL || config.provider?.ollama?.url);
    if (configUrl) {
      console.log(configUrl);
      process.exit(0);
    }
  } catch {}
}

if (registryPath && fs.existsSync(registryPath)) {
  try {
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const remoteHosts = registry.tiers?.find((tier) => tier.id === remoteTierId)?.hosts || [];
    const primaryHost = remoteHosts.find((host) => host?.primary === true) || remoteHosts.find((host) => normalize(host?.endpoint));
    const registryUrl = normalize(primaryHost?.endpoint);
    if (registryUrl) {
      console.log(registryUrl);
      process.exit(0);
    }
  } catch {}
}
NODE
}

resolve_remote_openai_compatible_url() {
  local registry_path="$1"

  if [ -n "$REMOTE_OPENAI_COMPAT_URL" ]; then
    printf '%s\n' "$REMOTE_OPENAI_COMPAT_URL"
    return 0
  fi

  if ! command -v node >/dev/null 2>&1; then
    return 0
  fi

  OPENCODE_CONFIG_PATH="$OPENCODE_CONFIG_PATH" REGISTRY_PATH="$registry_path" node <<'NODE'
const fs = require('fs');
const openAiTierId = process.env.XX_STACK_TIER_TAILSCALE_OPENAI_COMPATIBLE;
const sglangRemoteProviderId = process.env.XX_STACK_PROVIDER_SGLANG_REMOTE;
const localAiRemoteProviderId = process.env.XX_STACK_PROVIDER_LOCALAI_REMOTE;

function normalize(url) {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim().replace(/\/v1\/?$/, '');
  if (!trimmed || trimmed.includes('REMOTE_HOST') || trimmed.includes('example.invalid')) return '';
  return trimmed;
}

const configPath = process.env.OPENCODE_CONFIG_PATH;
const registryPath = process.env.REGISTRY_PATH;

if (configPath && fs.existsSync(configPath)) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const configUrl = normalize(
      config.provider?.[sglangRemoteProviderId]?.options?.baseURL
      || config.provider?.[sglangRemoteProviderId]?.baseURL
      || config.provider?.[sglangRemoteProviderId]?.url
      || config.provider?.[localAiRemoteProviderId]?.options?.baseURL
      || config.provider?.[localAiRemoteProviderId]?.baseURL
      || config.provider?.[localAiRemoteProviderId]?.url
    );
    if (configUrl) {
      console.log(configUrl);
      process.exit(0);
    }
  } catch {}
}

if (registryPath && fs.existsSync(registryPath)) {
  try {
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const remoteHosts = registry.tiers?.find((tier) => tier.id === openAiTierId)?.hosts || [];
    const primaryHost = remoteHosts.find((host) => host?.primary === true) || remoteHosts.find((host) => normalize(host?.endpoint));
    const registryUrl = normalize(primaryHost?.endpoint);
    if (registryUrl) {
      console.log(registryUrl);
      process.exit(0);
    }
  } catch {}
}
NODE
}

# ─────────────────────────────────────────────────────────────────────────────
# Host discovery lives in inventory.json now, not here.
#
# This file used to carry ~800 further lines: interactive Tailscale scanning for
# Ollama and OpenAI-compatible peers, plus the code to persist what it found
# directly into the *installed* registry. That competed with the repo inventory:
# `install_platform_registry` copies the generated registry over the installed
# one, so anything discovered here was silently wiped on the next sync, and it
# never flowed back into inventory.json either.
#
# Discovery is now:
#     npm run inventory:scan [-- --write] [--ssh]
#
# which probes five runtimes instead of two, is non-interactive, reads real GPU
# specs, merges idempotently, and writes to the one file every consumer is
# generated from.
#
# The two resolvers above remain because setup still needs to READ the
# configured remote URLs out of the registry.
# ─────────────────────────────────────────────────────────────────────────────
