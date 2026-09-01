merge_repo_agents_into_global_config() {
  local source_config="$1"
  local target_config="$2"
  local helper_script="$REPO_DIR/scripts/merge-repo-agents-into-global-config.js"

  if ! command -v node >/dev/null 2>&1; then
    echo "warning: node not found; skipping global agent merge." >&2
    return 1
  fi

  if [ ! -f "$source_config" ] || [ ! -f "$target_config" ]; then
    echo "warning: missing config for agent merge (source or target not found)." >&2
    return 1
  fi

  if [ ! -f "$helper_script" ]; then
    echo "warning: missing agent merge helper: $helper_script" >&2
    return 1
  fi

  node "$helper_script" "$source_config" "$target_config"
}

backup_global_config_once() {
  local target_config="$1"

  if [ -n "$CONFIG_BACKUP_PATH" ]; then
    return 0
  fi

  if [ ! -f "$target_config" ]; then
    return 0
  fi

  local backup_path
  backup_path="${target_config}.bak.$(date +"%Y-%m-%dT%H-%M-%S")"
  cp "$target_config" "$backup_path"
  CONFIG_BACKUP_PATH="$backup_path"
  echo "  backed up existing config: $backup_path"
}

initialize_global_config() {
  local source_config="$1"
  local target_config="$2"

  if [ -f "$target_config" ]; then
    return 0
  fi

  if [ ! -f "$source_config" ]; then
    echo "warning: source config not found for initialization: $source_config" >&2
    return 1
  fi

  mkdir -p "$(dirname "$target_config")"
  cp "$source_config" "$target_config"

  if command -v node >/dev/null 2>&1; then
    node - "$target_config" <<'NODE'
const fs = require('fs');
const targetPath = process.argv[2];
const config = JSON.parse(fs.readFileSync(targetPath, 'utf8'));

// OpenCode rejects this legacy extension key in recent builds.
delete config.platformRegistry;

fs.writeFileSync(targetPath, JSON.stringify(config, null, 2) + '\n');
NODE
  fi

  echo "  initialized global config from xx-stack defaults: $target_config"
}

sync_runtime_models_into_global_config() {
  local registry_path="$1"
  local source_config="$2"
  local target_config="$3"
  local ollama_local_url="$4"
  local ollama_remote_url="$5"
  local openai_local_url="$6"
  local openai_remote_url="$7"
  local helper_script="$REPO_DIR/scripts/sync-runtime-config.js"

  if ! command -v node >/dev/null 2>&1; then
    echo "warning: node not found; skipping runtime model sync into global config." >&2
    return 1
  fi

  if [ ! -f "$registry_path" ] || [ ! -f "$source_config" ] || [ ! -f "$target_config" ]; then
    echo "warning: missing registry or config for runtime config sync." >&2
    return 1
  fi

  if [ ! -f "$helper_script" ]; then
    echo "warning: missing runtime config sync helper: $helper_script" >&2
    return 1
  fi

  REGISTRY_PATH="$registry_path" SOURCE_CONFIG="$source_config" TARGET_CONFIG="$target_config" LOCAL_URL="$ollama_local_url" REMOTE_URL="$ollama_remote_url" LOCAL_OPENAI_URL="$openai_local_url" REMOTE_OPENAI_URL="$openai_remote_url" node "$helper_script"
}

repair_remote_provider_config() {
  local target_config="$1"
  local remote_ollama_url="$2"
  local remote_openai_url="$3"

  if [ -z "$remote_ollama_url" ] && [ -z "$remote_openai_url" ]; then
    echo "  skipped provider config repair: no remote inference endpoint configured"
    return 0
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "warning: node not found; skipping provider config repair." >&2
    return 1
  fi

  if [ ! -f "$target_config" ]; then
    echo "warning: target config not found for provider repair: $target_config" >&2
    return 1
  fi

  node - "$target_config" "$remote_ollama_url" "$remote_openai_url" <<'NODE'
const fs = require('fs');

const targetPath = process.argv[2];
const remoteOllamaUrl = process.argv[3];
const remoteOpenAiUrl = process.argv[4];
const config = JSON.parse(fs.readFileSync(targetPath, 'utf8'));

config.provider = config.provider || {};
if (remoteOllamaUrl) {
  config.provider.ollama = config.provider.ollama || {};
  config.provider.ollama.npm = config.provider.ollama.npm || '@ai-sdk/openai-compatible';
  config.provider.ollama.name = config.provider.ollama.name || 'Ollama-Debian-Server';
  config.provider.ollama.options = config.provider.ollama.options || {};
  config.provider.ollama.options.baseURL = `${remoteOllamaUrl.replace(/\/$/, '')}/v1`;
}

if (remoteOpenAiUrl) {
  config.provider['sglang-remote'] = config.provider['sglang-remote'] || {};
  config.provider['sglang-remote'].npm = config.provider['sglang-remote'].npm || '@ai-sdk/openai-compatible';
  config.provider['sglang-remote'].name = config.provider['sglang-remote'].name || 'TurboQuant-llama.cpp-Remote';
  config.provider['sglang-remote'].options = config.provider['sglang-remote'].options || {};
  config.provider['sglang-remote'].options.baseURL = `${remoteOpenAiUrl.replace(/\/$/, '')}/v1`;
}

if (Array.isArray(config.disabled_providers)) {
  config.disabled_providers = config.disabled_providers.filter((p) => p !== 'ollama' && p !== 'sglang-remote');
}

fs.writeFileSync(targetPath, JSON.stringify(config, null, 2) + '\n');
console.log('  repaired provider config: remote inference providers enabled and baseURLs updated');
NODE
}

import_existing_opencode_config() {
  local registry_path="$1"
  local target_config="$2"
  local recommendations_path="$3"
  local helper_script="$REPO_DIR/scripts/import-existing-opencode-config.js"

  if ! command -v node >/dev/null 2>&1; then
    echo "warning: node not found; skipping prior config import." >&2
    return 1
  fi

  if [ ! -f "$registry_path" ] || [ ! -f "$target_config" ]; then
    echo "warning: missing registry or target config for prior config import." >&2
    return 1
  fi

  if [ ! -f "$helper_script" ]; then
    echo "warning: missing prior config import helper: $helper_script" >&2
    return 1
  fi

  REGISTRY_PATH="$registry_path" TARGET_CONFIG="$target_config" RECOMMENDATIONS_PATH="$recommendations_path" node "$helper_script"
}

validate_merged_agent_profiles() {
  local config_path="$1"
  local strict_mode="$2"

  if [ -z "$config_path" ] || [ ! -f "$config_path" ]; then
    echo "xx-stack setup failed: OpenCode config not found for agent validation: $config_path" >&2
    return 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "warning: node not found; skipping merged agent validation gate." >&2
    return 0
  fi

  CONFIG_PATH="$config_path" STRICT_MODE="$strict_mode" node <<'NODE'
const fs = require('fs');

const configPath = process.env.CONFIG_PATH;
const strictMode = process.env.STRICT_MODE === 'warn' ? 'warn' : 'fail';
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const agents = config?.agent && typeof config.agent === 'object' ? config.agent : {};
const mcpFromMap = config?.mcp && typeof config.mcp === 'object' ? Object.keys(config.mcp) : [];
const mcpFromArray = Array.isArray(config?.mcpServers) ? config.mcpServers.map((item) => String(item || '')).filter(Boolean) : [];
const configuredMcpServers = [...new Set([...mcpFromMap, ...mcpFromArray])];

function wildcardMatch(pattern, candidate) {
  const escaped = String(pattern || '')
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(String(candidate || ''));
}

function isMcpEntryMisconfigured(name, entry) {
  if (entry === null || entry === false || entry === undefined) {
    return `${name} is disabled or null`;
  }
  if (typeof entry !== 'object') {
    return `${name} is not an object`;
  }
  if (entry.enabled === false) {
    return `${name} is explicitly disabled`;
  }
  const command = typeof entry.command === 'string'
    ? entry.command.trim()
    : (Array.isArray(entry.command)
      ? entry.command.map((item) => String(item || '').trim()).filter(Boolean).join(' ')
      : '');
  const transport = typeof entry.transport === 'string' ? entry.transport.trim() : '';
  if (!command && !transport) {
    return `${name} is missing command/transport`;
  }
  return null;
}

const validModes = new Set(['primary', 'subagent']);
const errors = [];
const warnings = [];

if (config?.mcp && typeof config.mcp === 'object') {
  for (const [mcpName, mcpEntry] of Object.entries(config.mcp)) {
    const reason = isMcpEntryMisconfigured(mcpName, mcpEntry);
    if (reason) {
      warnings.push({ mcpServer: mcpName, reason: `mcp entry misconfigured: ${reason}` });
    }
  }
}

for (const [agentId, rawProfile] of Object.entries(agents)) {
  if (!rawProfile || typeof rawProfile !== 'object') {
    errors.push({ agentId, reason: 'agent profile must be an object' });
    continue;
  }

  const profile = rawProfile;
  if (!validModes.has(String(profile.mode || ''))) {
    errors.push({ agentId, reason: `invalid mode '${String(profile.mode || '')}' (expected primary or subagent)` });
  }

  const required = Array.isArray(profile.requiredMcpServers)
    ? profile.requiredMcpServers.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const missing = required.filter((name) => !configuredMcpServers.some((configured) => wildcardMatch(name, configured)));
  if (missing.length > 0) {
    errors.push({ agentId, reason: `missing required MCP servers: ${missing.join(', ')}` });
  }

  const allow = Array.isArray(profile?.toolPolicy?.allow) ? profile.toolPolicy.allow : null;
  const deny = Array.isArray(profile?.toolPolicy?.deny) ? profile.toolPolicy.deny : null;
  if (allow && deny && allow.some((item) => deny.includes(item))) {
    warnings.push({ agentId, reason: 'toolPolicy allow and deny overlap on one or more patterns' });
  }

  const memoryEnabled = profile?.memory?.enabled === true;
  const memoryScope = profile?.memory?.scope;
  if (memoryEnabled && memoryScope && !['user', 'project', 'local'].includes(String(memoryScope))) {
    warnings.push({ agentId, reason: `unsupported memory.scope '${String(memoryScope)}'` });
  }
}

const payload = {
  status: errors.length === 0 ? 'ok' : (strictMode === 'warn' ? 'warn' : 'fail'),
  strictMode,
  configPath,
  configuredMcpServers,
  errorCount: errors.length,
  warningCount: warnings.length,
  errors,
  warnings,
};

if (errors.length > 0 && strictMode === 'fail') {
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

if (warnings.length > 0 || errors.length > 0) {
  console.log(JSON.stringify(payload, null, 2));
}
NODE
}

ensure_xx_stack_mcp_server_registration() {
  local target_config="$1"
  local install_root="$2"
  local mcp_server_dir="$install_root/mcp-server"
  local mcp_entrypoint="$mcp_server_dir/dist/index.js"
  local helper_script="$REPO_DIR/scripts/ensure-xx-stack-mcp-server-registration.js"

  if ! command -v node >/dev/null 2>&1; then
    echo "xx-stack setup failed: node is required to run the xx-stack MCP server." >&2
    return 1
  fi

  if [ ! -d "$mcp_server_dir" ]; then
    echo "xx-stack setup failed: missing mcp-server directory at $mcp_server_dir" >&2
    return 1
  fi

  if [ ! -f "$mcp_entrypoint" ]; then
    if ! command -v npm >/dev/null 2>&1; then
      echo "xx-stack setup failed: npm is required to build the xx-stack MCP server (missing $mcp_entrypoint)." >&2
      return 1
    fi

    echo "  building xx-stack MCP server..."
    if [ -f "$mcp_server_dir/package-lock.json" ]; then
      (cd "$mcp_server_dir" && npm ci --no-audit --no-fund)
    else
      (cd "$mcp_server_dir" && npm install --no-audit --no-fund)
    fi
    (cd "$mcp_server_dir" && npm run build)
  fi

  if [ ! -f "$mcp_entrypoint" ]; then
    echo "xx-stack setup failed: MCP server build did not produce $mcp_entrypoint" >&2
    return 1
  fi

  if [ ! -f "$target_config" ]; then
    echo "xx-stack setup failed: OpenCode config not found for MCP registration: $target_config" >&2
    return 1
  fi

  if [ ! -f "$helper_script" ]; then
    echo "warning: missing MCP registration helper: $helper_script" >&2
    return 1
  fi

  TARGET_CONFIG="$target_config" MCP_ENTRYPOINT="$mcp_entrypoint" node "$helper_script"
}

self_test_xx_stack_mcp_server() {
  local target_config="$1"

  if ! command -v node >/dev/null 2>&1; then
    echo "xx-stack setup failed: node is required for MCP self-test." >&2
    return 1
  fi

  if [ ! -f "$target_config" ]; then
    echo "xx-stack setup failed: OpenCode config not found for MCP self-test: $target_config" >&2
    return 1
  fi

  TARGET_CONFIG="$target_config" node <<'NODE'
const fs = require('fs');
const { spawn } = require('child_process');

const configPath = process.env.TARGET_CONFIG;
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const entry = config?.mcp?.['xx-stack-platform-routing'];

if (!entry || typeof entry !== 'object') {
  console.error('xx-stack setup failed: mcp.xx-stack-platform-routing is missing from global OpenCode config.');
  process.exit(1);
}

if (entry.enabled === false || entry.disable === true) {
  console.error('xx-stack setup failed: mcp.xx-stack-platform-routing is disabled.');
  process.exit(1);
}

const command = Array.isArray(entry.command)
  ? entry.command.map((item) => String(item || '').trim()).filter(Boolean)
  : (typeof entry.command === 'string' ? entry.command.split(/\s+/).filter(Boolean) : []);

if (command.length === 0) {
  console.error('xx-stack setup failed: mcp.xx-stack-platform-routing.command is empty.');
  process.exit(1);
}

const executable = command[0];
const args = command.slice(1);

const entrypointArg = args.find((arg) => /index\.js$/i.test(String(arg)));
if (entrypointArg && !fs.existsSync(entrypointArg)) {
  console.error(`xx-stack setup failed: MCP entrypoint does not exist: ${entrypointArg}`);
  process.exit(1);
}

let child;
try {
  child = spawn(executable, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false,
    env: process.env,
  });
} catch (error) {
  console.error(`xx-stack setup failed: could not spawn MCP process (${executable}): ${error.message}`);
  process.exit(1);
}

let stderrBuffer = '';
let exitedEarly = false;
let exitCode = null;

child.stderr.on('data', (chunk) => {
  stderrBuffer += String(chunk || '');
});

child.on('exit', (code) => {
  exitedEarly = true;
  exitCode = code;
});

const timeoutMs = 900;
setTimeout(() => {
  if (!child.pid) {
    console.error('xx-stack setup failed: MCP process did not start.');
    process.exit(1);
  }

  if (exitedEarly) {
    const reason = stderrBuffer.trim() || `exit code ${exitCode}`;
    console.error(`xx-stack setup failed: MCP process exited during startup (${reason}).`);
    process.exit(1);
  }

  child.kill('SIGTERM');
  console.log('  MCP self-test: PASS (xx-stack-platform-routing startup ok)');
  process.exit(0);
}, timeoutMs);
NODE
}