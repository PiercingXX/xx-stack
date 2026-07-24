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

resolve_remote_network_scope() {
  local registry_path="$1"
  local remote_url="$2"

  if ! command -v node >/dev/null 2>&1; then
    return 0
  fi

  REGISTRY_PATH="$registry_path" REMOTE_URL="$remote_url" node <<'NODE'
const fs = require('fs');
const remoteTierId = process.env.XX_STACK_TIER_TAILSCALE_OLLAMA;

function normalize(url) {
  if (!url || typeof url !== 'string') return '';
  return url.trim().replace(/\/v1\/?$/, '').replace(/\/$/, '');
}

const registryPath = process.env.REGISTRY_PATH;
const remoteUrl = normalize(process.env.REMOTE_URL || '');
if (!registryPath || !fs.existsSync(registryPath)) {
  process.exit(0);
}

try {
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const remoteHosts = registry.tiers?.find((tier) => tier.id === remoteTierId)?.hosts || [];
  const matchedHost = remoteHosts.find((host) => normalize(host?.endpoint) === remoteUrl);
  const primaryHost = matchedHost || remoteHosts.find((host) => host?.primary === true) || remoteHosts[0];
  const scope = primaryHost?.networkScope;
  if (scope) {
    console.log(scope);
  }
} catch {}
NODE
}

is_tailscale_remote_url() {
  local network_scope="$1"
  local url="$2"

  if [ "$network_scope" = "$XX_STACK_NETWORK_SCOPE_TAILSCALE" ]; then
    return 0
  fi

  case "$url" in
    http://100.*|https://100.*|*ts.net*|*tailnet*)
      return 0
      ;;
  esac

  return 1
}

scan_reachable_tailscale_ollama_candidates() {
  local tailscale_status_json=""

  if ! command -v tailscale >/dev/null 2>&1; then
    return 0
  fi

  if ! command -v node >/dev/null 2>&1; then
    return 0
  fi

  if ! command -v curl >/dev/null 2>&1; then
    return 0
  fi

  tailscale_status_json="$(tailscale status --json 2>/dev/null || true)"
  if [ -z "$tailscale_status_json" ]; then
    return 0
  fi

  TAILSCALE_STATUS_JSON="$tailscale_status_json" node <<'NODE'
const { execFileSync } = require('child_process');

function isIPv4(value) {
  return /^\d+\.\d+\.\d+\.\d+$/.test(value || '');
}

function displayName(peer) {
  const dnsName = (peer.DNSName || '').replace(/\.$/, '');
  if (dnsName) {
    return dnsName.split('.')[0];
  }
  return peer.HostName || peer.ComputedName || peer.Name || 'tailscale-peer';
}

function modelCountFor(url) {
  try {
    const raw = execFileSync('curl', ['-fsS', '--max-time', '2', `${url}/api/tags`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const payload = JSON.parse(raw);
    return Array.isArray(payload.models) ? payload.models.length : 0;
  } catch {
    return null;
  }
}

let status;
try {
  status = JSON.parse(process.env.TAILSCALE_STATUS_JSON || '{}');
} catch {
  process.exit(0);
}

const candidates = [];
for (const peer of Object.values(status.Peer || {})) {
  if (peer.Online === false) {
    continue;
  }

  const ips = [...new Set([...(peer.TailscaleIPs || []), ...(peer.Addresses || [])].filter(isIPv4))];
  for (const ip of ips) {
    const url = `http://${ip}:11434`;
    const count = modelCountFor(url);
    if (count === null) {
      continue;
    }
    candidates.push({
      name: displayName(peer),
      ip,
      url,
      count,
    });
    break;
  }
}

candidates
  .sort((left, right) => left.name.localeCompare(right.name) || left.ip.localeCompare(right.ip))
  .forEach((candidate) => {
    process.stdout.write(`${candidate.name}\t${candidate.ip}\t${candidate.url}\t${candidate.count}\n`);
  });
NODE
}

scan_reachable_tailscale_openai_compatible_candidates() {
  local tailscale_status_json=""

  if ! command -v tailscale >/dev/null 2>&1; then
    return 0
  fi

  if ! command -v node >/dev/null 2>&1; then
    return 0
  fi

  if ! command -v curl >/dev/null 2>&1; then
    return 0
  fi

  tailscale_status_json="$(tailscale status --json 2>/dev/null || true)"
  if [ -z "$tailscale_status_json" ]; then
    return 0
  fi

  TAILSCALE_STATUS_JSON="$tailscale_status_json" REMOTE_OPENAI_COMPAT_PORT="$REMOTE_OPENAI_COMPAT_PORT" node <<'NODE'
const { execFileSync } = require('child_process');

function isIPv4(value) {
  return /^\d+\.\d+\.\d+\.\d+$/.test(value || '');
}

function displayName(peer) {
  const dnsName = (peer.DNSName || '').replace(/\.$/, '');
  if (dnsName) {
    return dnsName.split('.')[0];
  }
  return peer.HostName || peer.ComputedName || peer.Name || 'tailscale-peer';
}

function modelCountFor(url) {
  try {
    const raw = execFileSync('curl', ['-fsS', '--max-time', '2', `${url}/v1/models`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const payload = JSON.parse(raw);
    return Array.isArray(payload.data) ? payload.data.length : 0;
  } catch {
    return null;
  }
}

let status;
try {
  status = JSON.parse(process.env.TAILSCALE_STATUS_JSON || '{}');
} catch {
  process.exit(0);
}

const port = String(process.env.REMOTE_OPENAI_COMPAT_PORT || '8080').trim() || '8080';
const candidates = [];
for (const peer of Object.values(status.Peer || {})) {
  if (peer.Online === false) {
    continue;
  }

  const ips = [...new Set([...(peer.TailscaleIPs || []), ...(peer.Addresses || [])].filter(isIPv4))];
  for (const ip of ips) {
    const url = `http://${ip}:${port}`;
    const count = modelCountFor(url);
    if (count === null) {
      continue;
    }
    candidates.push({
      name: displayName(peer),
      ip,
      url,
      count,
    });
    break;
  }
}

candidates
  .sort((left, right) => left.name.localeCompare(right.name) || left.ip.localeCompare(right.ip))
  .forEach((candidate) => {
    process.stdout.write(`${candidate.name}\t${candidate.ip}\t${candidate.url}\t${candidate.count}\n`);
  });
NODE
}

resolve_configured_tailscale_remote_urls() {
  local registry_path="$1"

  if [ -z "$registry_path" ] || [ ! -f "$registry_path" ]; then
    return 0
  fi

  if ! command -v node >/dev/null 2>&1; then
    return 0
  fi

  REGISTRY_PATH="$registry_path" node <<'NODE'
const fs = require('fs');
const remoteTierId = process.env.XX_STACK_TIER_TAILSCALE_OLLAMA;
const tailscaleScope = process.env.XX_STACK_NETWORK_SCOPE_TAILSCALE;

function normalize(url) {
  if (!url || typeof url !== 'string') return '';
  return url.trim().replace(/\/v1\/?$/, '').replace(/\/$/, '');
}

function isTailscaleHost(host) {
  const endpoint = normalize(host?.endpoint);
  return Boolean(endpoint) && (
    host?.networkScope === tailscaleScope ||
    /^https?:\/\/100\./.test(endpoint) ||
    /ts\.net|tailnet/.test(endpoint)
  );
}

try {
  const registry = JSON.parse(fs.readFileSync(process.env.REGISTRY_PATH, 'utf8'));
  const remoteHosts = (registry.tiers?.find((tier) => tier.id === remoteTierId)?.hosts || [])
    .filter(isTailscaleHost)
    .sort((left, right) => Number(Boolean(right?.primary)) - Number(Boolean(left?.primary)));

  const seen = new Set();
  for (const host of remoteHosts) {
    const endpoint = normalize(host?.endpoint);
    if (!endpoint || seen.has(endpoint)) {
      continue;
    }
    seen.add(endpoint);
    process.stdout.write(`${endpoint}\n`);
  }
} catch {}
NODE
}

resolve_configured_tailscale_openai_compatible_urls() {
  local registry_path="$1"

  if [ -z "$registry_path" ] || [ ! -f "$registry_path" ]; then
    return 0
  fi

  if ! command -v node >/dev/null 2>&1; then
    return 0
  fi

  REGISTRY_PATH="$registry_path" node <<'NODE'
const fs = require('fs');
const openAiTierId = process.env.XX_STACK_TIER_TAILSCALE_OPENAI_COMPATIBLE;
const tailscaleScope = process.env.XX_STACK_NETWORK_SCOPE_TAILSCALE;

function normalize(url) {
  if (!url || typeof url !== 'string') return '';
  return url.trim().replace(/\/v1\/?$/, '').replace(/\/$/, '');
}

function isTailscaleHost(host) {
  const endpoint = normalize(host?.endpoint);
  return Boolean(endpoint) && (
    host?.networkScope === tailscaleScope ||
    /^https?:\/\/100\./.test(endpoint) ||
    /ts\.net|tailnet/.test(endpoint)
  );
}

try {
  const registry = JSON.parse(fs.readFileSync(process.env.REGISTRY_PATH, 'utf8'));
  const remoteHosts = (registry.tiers?.find((tier) => tier.id === openAiTierId)?.hosts || [])
    .filter(isTailscaleHost)
    .sort((left, right) => Number(Boolean(right?.primary)) - Number(Boolean(left?.primary)));

  const seen = new Set();
  for (const host of remoteHosts) {
    const endpoint = normalize(host?.endpoint);
    if (!endpoint || seen.has(endpoint)) {
      continue;
    }
    seen.add(endpoint);
    process.stdout.write(`${endpoint}\n`);
  }
} catch {}
NODE
}

persist_remote_ollama_hosts_in_registry() {
  local registry_path="$1"
  local selected_candidates="$2"

  if [ -z "$registry_path" ] || [ ! -f "$registry_path" ] || [ -z "$selected_candidates" ]; then
    return 0
  fi

  if ! command -v node >/dev/null 2>&1; then
    return 0
  fi

  REGISTRY_PATH="$registry_path" SELECTED_CANDIDATES="$selected_candidates" node <<'NODE'
const fs = require('fs');

const registryPath = process.env.REGISTRY_PATH;
const remoteTierId = process.env.XX_STACK_TIER_TAILSCALE_OLLAMA;
const remoteProviderId = process.env.XX_STACK_PROVIDER_OLLAMA_REMOTE;
const tailscaleScope = process.env.XX_STACK_NETWORK_SCOPE_TAILSCALE;
const selectedCandidates = (process.env.SELECTED_CANDIDATES || '')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    const [name = '', ip = '', url = '', count = '0'] = line.split('\t');
    return {
      name,
      ip,
      url: url.replace(/\/$/, ''),
      count: Number(count) || 0,
    };
  })
  .filter((entry) => entry.url);

function normalize(url) {
  if (!url || typeof url !== 'string') return '';
  return url.trim().replace(/\/v1\/?$/, '').replace(/\/$/, '');
}

function slugify(value) {
  return (value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

try {
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const tier = registry.tiers?.find((item) => item.id === remoteTierId);
  if (!tier || selectedCandidates.length === 0) {
    process.exit(0);
  }

  const existingHosts = Array.isArray(tier.hosts) ? tier.hosts : [];
  const preservedHosts = existingHosts.filter((host) => {
    const endpoint = normalize(host?.endpoint);
    if (!endpoint || endpoint.includes('REMOTE_HOST')) {
      return false;
    }
    return host?.networkScope !== 'tailscale';
  });

  const usedIds = new Set(preservedHosts.map((host) => host.id).filter(Boolean));
  const nextHosts = selectedCandidates.map((candidate, index) => {
    const endpoint = normalize(candidate.url);
    const existing = existingHosts.find((host) => normalize(host?.endpoint) === endpoint) || null;
    let hostId = existing?.id || `tailscale-${slugify(candidate.name || candidate.ip || `remote-${index + 1}`)}`;
    if (!hostId || usedIds.has(hostId)) {
      const baseId = hostId || `tailscale-remote-${index + 1}`;
      let suffix = 2;
      while (usedIds.has(hostId)) {
        hostId = `${baseId}-${suffix}`;
        suffix += 1;
      }
    }
    usedIds.add(hostId);

    return {
      ...(existing || {}),
      id: hostId,
      label: existing?.label || `${candidate.name || candidate.ip} remote Ollama`,
      provider: remoteProviderId,
      endpoint,
      networkScope: tailscaleScope,
      primary: index === 0,
      connectionNotes: existing?.connectionNotes || 'Managed by setup from detected reachable Tailscale Ollama peers.',
      hardware: existing?.hardware || {
        summary: 'Document this after setup if it matters for routing',
        cpu: 'Optional',
        ram: 'Optional',
        gpu: [],
        limits: [
          'Prefer for delegated subagents and long-form reasoning overflow',
          'Keep local workstation free for low-latency edit/test loops',
          'Tune executionPolicy once hardware is detected or documented for this host'
        ]
      },
      executionPolicy: existing?.executionPolicy || {
        maxParallelSlices: 1,
        maxConcurrentModels: 2,
        contextReservePercent: 25,
        scheduling: 'balanced',
      },
      models: Array.isArray(existing?.models) ? existing.models : [],
      discoveredBySetup: {
        source: 'tailscale-scan',
        name: candidate.name,
        ip: candidate.ip,
        modelCount: candidate.count,
      },
    };
  });

  tier.hosts = [...nextHosts, ...preservedHosts.map((host) => ({ ...host, primary: false }))];
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
} catch {}
NODE
}

persist_tailscale_openai_compatible_hosts_in_registry() {
  local registry_path="$1"
  local selected_candidates="$2"
  local backend_lane="$3"

  if [ -z "$registry_path" ] || [ ! -f "$registry_path" ] || [ -z "$selected_candidates" ]; then
    return 0
  fi

  if ! command -v node >/dev/null 2>&1; then
    return 0
  fi

  REGISTRY_PATH="$registry_path" SELECTED_CANDIDATES="$selected_candidates" BACKEND_LANE="$backend_lane" node <<'NODE'
const fs = require('fs');

const registryPath = process.env.REGISTRY_PATH;
const backend = (process.env.BACKEND_LANE || '').trim();
const openAiTierId = process.env.XX_STACK_TIER_TAILSCALE_OPENAI_COMPATIBLE;
const localAiRemoteProviderId = process.env.XX_STACK_PROVIDER_LOCALAI_REMOTE;
const sglangRemoteProviderId = process.env.XX_STACK_PROVIDER_SGLANG_REMOTE;
const tailscaleScope = process.env.XX_STACK_NETWORK_SCOPE_TAILSCALE;
const providerId = backend === 'localai' ? localAiRemoteProviderId : sglangRemoteProviderId;
const selectedCandidates = (process.env.SELECTED_CANDIDATES || '')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    const [name = '', ip = '', url = '', count = '0'] = line.split('\t');
    return {
      name,
      ip,
      url: url.replace(/\/$/, ''),
      count: Number(count) || 0,
    };
  })
  .filter((entry) => entry.url);

function normalize(url) {
  if (!url || typeof url !== 'string') return '';
  return url.trim().replace(/\/v1\/?$/, '').replace(/\/$/, '');
}

function slugify(value) {
  return (value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

try {
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const tier = registry.tiers?.find((item) => item.id === openAiTierId);
  if (!tier || selectedCandidates.length === 0) {
    process.exit(0);
  }

  const existingHosts = Array.isArray(tier.hosts) ? tier.hosts : [];
  const preservedHosts = existingHosts.filter((host) => {
    const endpoint = normalize(host?.endpoint);
    if (!endpoint || endpoint.includes('REMOTE_HOST')) {
      return false;
    }
    return host?.networkScope !== 'tailscale';
  });

  const usedIds = new Set(preservedHosts.map((host) => host.id).filter(Boolean));
  const nextHosts = selectedCandidates.map((candidate, index) => {
    const endpoint = normalize(candidate.url);
    const existing = existingHosts.find((host) => normalize(host?.endpoint) === endpoint) || null;
    let hostId = existing?.id || `tailscale-openai-${slugify(candidate.name || candidate.ip || `remote-${index + 1}`)}`;
    if (!hostId || usedIds.has(hostId)) {
      const baseId = hostId || `tailscale-openai-${index + 1}`;
      let suffix = 2;
      while (usedIds.has(hostId)) {
        hostId = `${baseId}-${suffix}`;
        suffix += 1;
      }
    }
    usedIds.add(hostId);

    return {
      ...(existing || {}),
      id: hostId,
      label: existing?.label || `${candidate.name || candidate.ip} remote OpenAI-compatible`,
      provider: providerId,
      endpoint,
      networkScope: tailscaleScope,
      primary: index === 0,
      enabled: true,
      connectionNotes: existing?.connectionNotes || 'Managed by setup from detected reachable Tailscale OpenAI-compatible peers.',
      capabilities: {
        ...(existing?.capabilities || {}),
        endpointFamily: 'openai-compatible',
        supportsResidentModelInspection: false,
      },
      executionPolicy: existing?.executionPolicy || {
        maxParallelSlices: 1,
        maxConcurrentModels: 2,
        contextReservePercent: 25,
        scheduling: 'balanced',
      },
      models: Array.isArray(existing?.models) ? existing.models : [],
      discoveredBySetup: {
        source: 'tailscale-scan',
        name: candidate.name,
        ip: candidate.ip,
        modelCount: candidate.count,
      },
    };
  });

  tier.hosts = [...nextHosts, ...preservedHosts.map((host) => ({ ...host, primary: false }))];
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
} catch {}
NODE
}

confirm_remote_tailscale_ollama_url() {
  local registry_path="$1"
  local current_url="$2"
  local candidates=""
  local candidate_count=0
  local index=0
  local selected_rows=""
  local configured_url=""
  local default_marker=""
  local candidate_name
  local candidate_ip
  local candidate_url
  local candidate_models
  local default_choice=""
  local -a candidate_urls=()
  local -a candidate_names=()
  local -a candidate_ips=()
  local -a candidate_rows=()
  local -a candidate_default_flags=()
  local -a configured_urls=()
  local -a default_candidate_indexes=()
  local -a default_candidate_rows=()

  RESOLVED_REMOTE_OLLAMA_URL="$current_url"

  if ! command -v tailscale >/dev/null 2>&1; then
    return 0
  fi

  if [ ! -t 0 ] || [ ! -t 1 ]; then
    if [ -n "$current_url" ] && ! ollama_endpoint_reachable "$current_url"; then
      echo "warning: configured remote Tailscale Ollama endpoint is unreachable: $current_url" >&2
    fi
    echo "warning: Tailscale Ollama host selection is interactive-only; keeping the current remote configuration during non-interactive setup." >&2
    return 0
  fi

  if [ -n "$current_url" ] && ! ollama_endpoint_reachable "$current_url"; then
    echo "warning: configured remote Tailscale Ollama endpoint is unreachable: $current_url" >&2
  fi

  while IFS= read -r configured_url; do
    [ -n "$configured_url" ] || continue
    configured_urls+=("$configured_url")
  done < <(resolve_configured_tailscale_remote_urls "$registry_path")

  candidates="$(scan_reachable_tailscale_ollama_candidates)"

  if [ -z "$candidates" ]; then
    echo "  no reachable Tailscale peers exposing Ollama on :11434 were detected; keeping the current remote configuration"
    return 0
  fi

  while IFS=$'\t' read -r candidate_name candidate_ip candidate_url candidate_models; do
    [ -n "$candidate_url" ] || continue
    candidate_urls+=("$candidate_url")
    candidate_names+=("$candidate_name")
    candidate_ips+=("$candidate_ip")
    candidate_rows+=("$candidate_name"$'\t'"$candidate_ip"$'\t'"$candidate_url"$'\t'"$candidate_models")
    candidate_default_flags+=("0")
    candidate_count=$((candidate_count + 1))
  done <<< "$candidates"

  if [ "$candidate_count" -eq 0 ]; then
    return 0
  fi

  for configured_url in "${configured_urls[@]}"; do
    for index in "${!candidate_urls[@]}"; do
      if [ "${candidate_urls[$index]}" = "$configured_url" ]; then
        if [ "${candidate_default_flags[$index]}" != "1" ]; then
          candidate_default_flags[$index]="1"
          default_candidate_indexes+=("$index")
          default_candidate_rows+=("${candidate_rows[$index]}")
        fi
        break
      fi
    done
  done

  if [ ${#default_candidate_indexes[@]} -gt 0 ]; then
    for index in "${default_candidate_indexes[@]}"; do
      if [ -n "$default_choice" ]; then
        default_choice+="," 
      fi
      default_choice+="$((index + 1))"
    done
  fi

  echo "  reachable Tailscale peers exposing Ollama on :11434:"
  for index in "${!candidate_rows[@]}"; do
    default_marker=""
    if [ "${candidate_default_flags[$index]}" = "1" ]; then
      default_marker=" default"
    fi
    echo "    [$((index + 1))] ${candidate_names[$index]} (${candidate_ips[$index]}) models=$(printf '%s' "${candidate_rows[$index]}" | awk -F '\t' '{print $4}')${default_marker}"
  done

  if [ ${#default_candidate_rows[@]} -gt 0 ]; then
    for index in "${!default_candidate_rows[@]}"; do
      selected_rows+="${default_candidate_rows[$index]}"$'\n'
    done
    echo "  auto-selected previously configured reachable Tailscale host set"
  elif [ -n "$current_url" ] && ollama_endpoint_reachable "$current_url"; then
    echo "  keeping the current reachable remote configuration"
    return 0
  else
    selected_rows+="${candidate_rows[0]}"$'\n'
    echo "  auto-selected first reachable Tailscale Ollama host"
  fi

  IFS=$'\t' read -r candidate_name candidate_ip candidate_url candidate_models <<< "${selected_rows%%$'\n'*}"
  RESOLVED_REMOTE_OLLAMA_URL="$candidate_url"
  persist_remote_ollama_hosts_in_registry "$registry_path" "$selected_rows"
  echo "  selected remote Tailscale Ollama hosts:"
  while IFS=$'\t' read -r candidate_name candidate_ip candidate_url candidate_models; do
    [ -n "$candidate_url" ] || continue
    if [ "$candidate_url" = "$RESOLVED_REMOTE_OLLAMA_URL" ]; then
      echo "    - $candidate_name ($candidate_ip) primary"
    else
      echo "    - $candidate_name ($candidate_ip)"
    fi
  done <<< "$selected_rows"
  return 0
}

confirm_remote_tailscale_openai_compatible_url() {
  local registry_path="$1"
  local current_url="$2"
  local backend_lane="$3"
  local candidates=""
  local candidate_count=0
  local index=0
  local selected_rows=""
  local configured_url=""
  local default_marker=""
  local candidate_name
  local candidate_ip
  local candidate_url
  local candidate_models
  local -a candidate_urls=()
  local -a candidate_names=()
  local -a candidate_ips=()
  local -a candidate_rows=()
  local -a candidate_default_flags=()
  local -a configured_urls=()
  local -a default_candidate_rows=()

  RESOLVED_REMOTE_OPENAI_COMPAT_URL="$current_url"

  if ! command -v tailscale >/dev/null 2>&1; then
    return 0
  fi

  if [ ! -t 0 ] || [ ! -t 1 ]; then
    if [ -n "$current_url" ] && ! openai_compatible_endpoint_reachable "$current_url"; then
      echo "warning: configured remote Tailscale OpenAI-compatible endpoint is unreachable: $current_url" >&2
    fi
    echo "warning: Tailscale OpenAI-compatible host selection is interactive-only; keeping the current remote configuration during non-interactive setup." >&2
    return 0
  fi

  if [ -n "$current_url" ] && ! openai_compatible_endpoint_reachable "$current_url"; then
    echo "warning: configured remote Tailscale OpenAI-compatible endpoint is unreachable: $current_url" >&2
  fi

  while IFS= read -r configured_url; do
    [ -n "$configured_url" ] || continue
    configured_urls+=("$configured_url")
  done < <(resolve_configured_tailscale_openai_compatible_urls "$registry_path")

  candidates="$(scan_reachable_tailscale_openai_compatible_candidates)"

  if [ -z "$candidates" ]; then
    echo "  no reachable Tailscale peers exposing OpenAI-compatible endpoints on :$REMOTE_OPENAI_COMPAT_PORT were detected; keeping the current remote configuration"
    return 0
  fi

  while IFS=$'\t' read -r candidate_name candidate_ip candidate_url candidate_models; do
    [ -n "$candidate_url" ] || continue
    candidate_urls+=("$candidate_url")
    candidate_names+=("$candidate_name")
    candidate_ips+=("$candidate_ip")
    candidate_rows+=("$candidate_name"$'\t'"$candidate_ip"$'\t'"$candidate_url"$'\t'"$candidate_models")
    candidate_default_flags+=("0")
    candidate_count=$((candidate_count + 1))
  done <<< "$candidates"

  if [ "$candidate_count" -eq 0 ]; then
    return 0
  fi

  for configured_url in "${configured_urls[@]}"; do
    for index in "${!candidate_urls[@]}"; do
      if [ "${candidate_urls[$index]}" = "$configured_url" ]; then
        if [ "${candidate_default_flags[$index]}" != "1" ]; then
          candidate_default_flags[$index]="1"
          default_candidate_rows+=("${candidate_rows[$index]}")
        fi
        break
      fi
    done
  done

  echo "  reachable Tailscale peers exposing OpenAI-compatible endpoints on :$REMOTE_OPENAI_COMPAT_PORT:"
  for index in "${!candidate_rows[@]}"; do
    default_marker=""
    if [ "${candidate_default_flags[$index]}" = "1" ]; then
      default_marker=" default"
    fi
    echo "    [$((index + 1))] ${candidate_names[$index]} (${candidate_ips[$index]}) models=$(printf '%s' "${candidate_rows[$index]}" | awk -F '\t' '{print $4}')${default_marker}"
  done

  if [ ${#default_candidate_rows[@]} -gt 0 ]; then
    for index in "${!default_candidate_rows[@]}"; do
      selected_rows+="${default_candidate_rows[$index]}"$'\n'
    done
    echo "  auto-selected previously configured reachable Tailscale OpenAI-compatible host set"
  elif [ -n "$current_url" ] && openai_compatible_endpoint_reachable "$current_url"; then
    echo "  keeping the current reachable remote OpenAI-compatible configuration"
    return 0
  else
    selected_rows+="${candidate_rows[0]}"$'\n'
    echo "  auto-selected first reachable Tailscale OpenAI-compatible host"
  fi

  IFS=$'\t' read -r candidate_name candidate_ip candidate_url candidate_models <<< "${selected_rows%%$'\n'*}"
  RESOLVED_REMOTE_OPENAI_COMPAT_URL="$candidate_url"
  REMOTE_OPENAI_COMPAT_URL="$candidate_url"
  persist_tailscale_openai_compatible_hosts_in_registry "$registry_path" "$selected_rows" "$backend_lane"
  echo "  selected remote Tailscale OpenAI-compatible hosts:"
  while IFS=$'\t' read -r candidate_name candidate_ip candidate_url candidate_models; do
    [ -n "$candidate_url" ] || continue
    if [ "$candidate_url" = "$RESOLVED_REMOTE_OPENAI_COMPAT_URL" ]; then
      echo "    - $candidate_name ($candidate_ip) primary"
    else
      echo "    - $candidate_name ($candidate_ip)"
    fi
  done <<< "$selected_rows"
  return 0
}