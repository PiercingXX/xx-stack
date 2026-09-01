detect_local_hardware() {
  local registry_path="$1"

  if ! command -v node >/dev/null 2>&1; then
    echo "warning: node not found; skipping hardware detection." >&2
    return 1
  fi

  REGISTRY_PATH="$registry_path" node <<'NODE'
const fs = require('fs');
const { execFileSync } = require('child_process');

const registryPath = process.env.REGISTRY_PATH;
const localTierId = process.env.XX_STACK_TIER_LOCAL;
const localHostId = process.env.XX_STACK_HOST_LOCAL_WORKSTATION;
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const localTier = registry.tiers.find((tier) => tier.id === localTierId);
const localHost = localTier?.hosts?.find((host) => host.id === localHostId);

if (!localHost) {
  console.log('  skipped hardware detection: local host not found');
  process.exit(0);
}

function safeExec(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

const { existsSync, readdirSync, readFileSync: readFS, realpathSync } = require('fs');

const meminfo = safeExec('cat', ['/proc/meminfo']);
const cpuinfo = safeExec('bash', ['-lc', 'lscpu | sed -n "1,20p"']);

const ramMatch = meminfo.match(/^MemTotal:\s+(\d+)\s+kB$/m);
const ramGb = ramMatch ? Math.round((Number(ramMatch[1]) / 1024 / 1024) * 10) / 10 : null;
const cpuModelMatch = cpuinfo.match(/^Model name:\s+(.+)$/m);
const cpuModel = cpuModelMatch ? cpuModelMatch[1].trim() : localHost.hardware?.cpu || 'Unknown';

let gpuEntries = [];
let totalGpuVramGb = 0;

const nvidiaCsv = safeExec('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader']);
if (nvidiaCsv) {
  gpuEntries = nvidiaCsv
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(',').map((value) => value.trim());
      const name = parts[0];
      const memMatch = (parts[1] || '').match(/([0-9.]+)\s+MiB/i);
      const vramGb = memMatch ? Math.round((Number(memMatch[1]) / 1024) * 10) / 10 : null;
      if (vramGb) totalGpuVramGb += vramGb;
      return vramGb ? `${name} (${vramGb} GB)` : name;
    });
}

if (gpuEntries.length === 0) {
  const drmRoot = '/sys/class/drm';
  const drmCards = existsSync(drmRoot)
    ? readdirSync(drmRoot).filter((name) => /^card\d+$/.test(name))
    : [];

  for (const card of drmCards) {
    const vramFile = `${drmRoot}/${card}/device/mem_info_vram_total`;
    if (!existsSync(vramFile)) continue;
    try {
      const vramBytes = parseInt(readFS(vramFile, 'utf8').trim(), 10);
      if (!vramBytes || isNaN(vramBytes)) continue;
      const vramGb = Math.round((vramBytes / 1024 ** 3) * 10) / 10;
      if (vramGb < 1) continue;
      let gpuName = card;
      try {
        const devicePath = realpathSync(`${drmRoot}/${card}/device`);
        const pciId = devicePath.split('/').pop();
        const lspciOut = safeExec('lspci', ['-s', pciId, '-mm']);
        const fields = lspciOut.split('\n')[0]?.match(/"([^"]*)"/g)?.map((value) => value.slice(1, -1));
        if (fields && fields[3]) gpuName = fields[3];
      } catch {}
      totalGpuVramGb += vramGb;
      gpuEntries.push(`${gpuName} (${vramGb} GB)`);
    } catch {}
  }

  if (gpuEntries.length > 0) {
    const rocmOut = safeExec('rocm-smi', ['--showproductname']);
    if (rocmOut) {
      const productMatches = [...rocmOut.matchAll(/GPU\[(\d+)\].*Card Series:\s*(.+)/g)];
      for (const match of productMatches) {
        const index = parseInt(match[1], 10);
        const productName = match[2].trim();
        if (index < gpuEntries.length) {
          const vramMatch = gpuEntries[index].match(/(\([\d.]+ GB\))$/);
          gpuEntries[index] = `${productName}${vramMatch ? ' ' + vramMatch[1] : ''}`;
        }
      }
    }
  }
}

if (gpuEntries.length > 0) {
  localHost.hardware.summary = gpuEntries.length === 1 ? gpuEntries[0] : `${gpuEntries.length} GPUs: ${gpuEntries.join(', ')}`;
  localHost.hardware.gpu = gpuEntries;
}

if (ramGb) {
  localHost.hardware.ram = `${ramGb} GB`;
}
if (cpuModel) {
  localHost.hardware.cpu = cpuModel;
}

localHost.hardware.detected = {
  totalGpuVramGb,
  gpuCount: gpuEntries.length,
  detectedAt: new Date().toISOString(),
};

const contextReservePercent = Number(localHost.executionPolicy?.contextReservePercent ?? 25);
const effectiveVramGb = totalGpuVramGb > 0
  ? totalGpuVramGb * (1 - contextReservePercent / 100)
  : 0;
const defaultHeavySliceBudgetGb = 36;
const inferredParallelSlices = effectiveVramGb > 0
  ? Math.max(1, Math.floor(effectiveVramGb / defaultHeavySliceBudgetGb))
  : 1;
const inferredConcurrentModels = Math.max(
  1,
  Math.min(gpuEntries.length || 1, inferredParallelSlices)
);
const allowMultiModel = process.env.XX_STACK_ALLOW_MULTI_MODEL === '1';
const configuredConcurrentModels = Number(localHost.executionPolicy?.maxConcurrentModels || 0);
const resolvedConcurrentModels = allowMultiModel
  ? Math.max(1, configuredConcurrentModels, inferredConcurrentModels)
  : 1;
const configuredParallelSlices = Number(localHost.executionPolicy?.maxParallelSlices || 0);
const resolvedParallelSlices = configuredParallelSlices > 0
  ? Math.max(1, Math.min(configuredParallelSlices, inferredParallelSlices))
  : inferredParallelSlices;

localHost.executionPolicy = {
  ...(localHost.executionPolicy || {}),
  maxParallelSlices: resolvedParallelSlices,
  maxConcurrentModels: resolvedConcurrentModels,
  contextReservePercent,
  scheduling: localHost.executionPolicy?.scheduling || 'balanced',
};

fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
console.log(`  detected local hardware: gpus=${gpuEntries.length} total-vram-gb=${totalGpuVramGb || 0} ram=${ramGb || 'unknown'} parallel-slices=${localHost.executionPolicy.maxParallelSlices}`);
NODE
}

detect_remote_hardware() {
  local registry_path="$1"

  if ! command -v node >/dev/null 2>&1; then
    echo "warning: node not found; skipping remote hardware detection." >&2
    return 1
  fi

  if ! command -v ssh >/dev/null 2>&1; then
    echo "warning: ssh not found; skipping remote hardware detection." >&2
    return 1
  fi

  if [ ! -f "$registry_path" ]; then
    echo "warning: platform registry not found for remote hardware detection: $registry_path" >&2
    return 1
  fi

  local setup_interactive="0"
  if [ "$REMOTE_SSH_PROMPT" = "1" ] && [ -t 0 ] && [ -t 1 ]; then
    setup_interactive="1"
  fi

  REGISTRY_PATH="$registry_path" REMOTE_SSH_USER="$REMOTE_SSH_USER" REMOTE_SSH_PASSWORD="$REMOTE_SSH_PASSWORD" REMOTE_SSH_MODE="$REMOTE_SSH_MODE" SETUP_INTERACTIVE="$setup_interactive" node <<'NODE'
const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');

const registryPath = process.env.REGISTRY_PATH;
const remoteTierId = process.env.XX_STACK_TIER_TAILSCALE_OLLAMA;
const remoteProviderId = process.env.XX_STACK_PROVIDER_OLLAMA_REMOTE;
const remoteUser = (process.env.REMOTE_SSH_USER || '').trim();
const remotePassword = process.env.REMOTE_SSH_PASSWORD || '';
const remoteMode = (process.env.REMOTE_SSH_MODE || 'auto').trim().toLowerCase();
const interactiveSession = process.env.SETUP_INTERACTIVE === '1';
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const remoteTier = registry.tiers.find((tier) => tier.id === remoteTierId);
const remoteHosts = Array.isArray(remoteTier?.hosts)
  ? remoteTier.hosts.filter((host) => host?.provider === remoteProviderId && host?.enabled !== false)
  : [];

function hostFromEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return url.hostname;
  } catch {
    return '';
  }
}

function commandExists(command) {
  try {
    execFileSync('bash', ['-lc', `command -v ${command}`], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function probeRemoteHost(host, targetHost) {
  const sshTarget = remoteUser ? `${remoteUser}@${targetHost}` : targetHost;
  const remoteCommand = [
    'CPU="$(lscpu 2>/dev/null | sed -n "s/^Model name:[[:space:]]*//p" | head -n1 || true)"',
    'RAM_KB="$(awk "/MemTotal/ {print \\$2}" /proc/meminfo 2>/dev/null | head -n1 || true)"',
    'echo "CPU=${CPU:-Unknown}"',
    'echo "RAM_KB=${RAM_KB:-0}"',
    'if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits | while IFS=, read -r name mem; do name="$(printf "%s" "$name" | sed "s/^ *//;s/ *$//")"; mem="$(printf "%s" "$mem" | sed "s/^ *//;s/ *$//")"; echo "GPU=${name} (${mem} MiB)"; done; fi',
    'if ls /sys/class/drm/card*/device/mem_info_vram_total >/dev/null 2>&1; then for f in /sys/class/drm/card*/device/mem_info_vram_total; do v=$(cat "$f" 2>/dev/null || true); [ -n "$v" ] && echo "VRAM_BYTES=$v"; done; fi',
    'exit 0',
  ].join('; ');

  const sshArgs = [
    '-o', `BatchMode=${interactiveSession ? 'no' : 'yes'}`,
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'PreferredAuthentications=password,keyboard-interactive',
    '-o', 'PubkeyAuthentication=no',
    sshTarget,
    `bash -lc '${remoteCommand}'`,
  ];

  const stdio = interactiveSession ? ['inherit', 'pipe', 'inherit'] : ['ignore', 'pipe', 'ignore'];

  const resultFromSpawn = (command, args) => {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      stdio,
    });
    return {
      ok: result.status === 0,
      stdout: (result.stdout || '').trim(),
      stderr: (result.stderr || '').trim(),
      status: result.status,
      error: result.error ? String(result.error.message || result.error) : '',
    };
  };

  const tailscaleName = (host?.discoveredBySetup?.name || '').trim();
  const tailscaleTargets = [
    sshTarget,
    tailscaleName ? (remoteUser ? `${remoteUser}@${tailscaleName}` : tailscaleName) : '',
  ].filter(Boolean);

  const trySsh = () => {
    if (!interactiveSession && remotePassword && commandExists('sshpass')) {
      const sshpassResult = resultFromSpawn('sshpass', ['-p', remotePassword, 'ssh', ...sshArgs]);
      if (sshpassResult.ok) {
        return { ok: true, output: sshpassResult.stdout, method: 'sshpass+ssh', reason: '' };
      }
      const sshpassReason = sshpassResult.stderr || sshpassResult.error || 'sshpass+ssh failed';
      return {
        ok: false,
        output: '',
        method: 'sshpass+ssh',
        reason: sshpassReason,
      };
    }
    const sshResult = resultFromSpawn('ssh', sshArgs);
    if (sshResult.ok) {
      return { ok: true, output: sshResult.stdout, method: 'ssh', reason: '' };
    }
    return { ok: false, output: '', method: 'ssh', reason: sshResult.stderr || sshResult.error || 'ssh failed' };
  };

  const tryTailscaleSsh = () => {
    let lastReason = 'tailscale ssh failed';
    for (const tsTarget of tailscaleTargets) {
      const tailscaleResult = resultFromSpawn('tailscale', ['ssh', tsTarget, 'bash', '-lc', remoteCommand]);
      if (tailscaleResult.ok) {
        return { ok: true, output: tailscaleResult.stdout, method: 'tailscale ssh', reason: '' };
      }
      lastReason = tailscaleResult.stderr || tailscaleResult.error || lastReason;
    }
    return { ok: false, output: '', method: 'tailscale ssh', reason: lastReason };
  };

  const attempts = remoteMode === 'ssh'
    ? [trySsh]
    : remoteMode === 'tailscale'
      ? [tryTailscaleSsh]
      : [trySsh, tryTailscaleSsh];

  const failureReasons = [];
  for (const attempt of attempts) {
    const result = attempt();
    if (result.ok) {
      return { output: result.output, method: result.method, failureReason: '' };
    }
    failureReasons.push(`${result.method}: ${result.reason || 'failed'}`);
  }

  return {
    output: '',
    method: 'failed',
    failureReason: failureReasons.length > 0 ? failureReasons.join(' | ') : 'authentication/connection failed',
  };
}

let detectedCount = 0;
const failures = [];
if (interactiveSession) {
  console.log('  remote hardware probe may prompt for SSH password/passphrase on selected hosts');
} else {
  console.log('  remote hardware probe is running non-interactively; set XX_STACK_REMOTE_SSH_PROMPT=1 to allow password/passphrase prompts');
}
for (const host of remoteHosts) {
  const targetHost = hostFromEndpoint(host.endpoint || '');
  if (!targetHost) {
    continue;
  }

  const probe = probeRemoteHost(host, targetHost);
  const output = probe.output || '';
  if (!output) {
    if (probe.method && probe.method !== 'failed') {
      host.hardware = {
        ...(host.hardware || {}),
        detected: {
          ...(host.hardware?.detected || {}),
          authenticatedAt: new Date().toISOString(),
          probe: probe.method,
          partial: true,
        },
      };
      detectedCount += 1;
      console.log(`  remote hardware probe authenticated: ${host.id || targetHost} via ${probe.method} (no inventory payload, kept existing metadata)`);
      continue;
    }
    failures.push({ host: host.id || targetHost, target: targetHost, reason: probe.failureReason || 'probe returned no output' });
    continue;
  }

  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
  const cpu = lines.find((line) => line.startsWith('CPU='))?.slice(4) || '';
  const ramKb = Number(lines.find((line) => line.startsWith('RAM_KB='))?.slice(7) || 0);
  const gpuLines = lines.filter((line) => line.startsWith('GPU=')).map((line) => line.slice(4));
  const vramBytes = lines
    .filter((line) => line.startsWith('VRAM_BYTES='))
    .map((line) => Number(line.slice(11) || 0))
    .filter((value) => Number.isFinite(value) && value > 0);

  const totalVramGbFromSysfs = vramBytes.length > 0
    ? Math.round((vramBytes.reduce((sum, value) => sum + value, 0) / 1073741824) * 10) / 10
    : 0;
  const totalVramGbFromNvidia = gpuLines
    .map((line) => {
      const match = line.match(/\(([0-9.]+)\s*MiB\)/i);
      return match ? Number(match[1]) / 1024 : 0;
    })
    .reduce((sum, value) => sum + value, 0);
  const totalGpuVramGb = Math.round((Math.max(totalVramGbFromSysfs, totalVramGbFromNvidia) || 0) * 10) / 10;
  const ramGb = ramKb > 0 ? Math.round((ramKb / 1024 / 1024) * 10) / 10 : 0;

  host.hardware = {
    ...(host.hardware || {}),
    summary: gpuLines.length === 1 ? gpuLines[0] : (gpuLines.length > 1 ? `${gpuLines.length} GPUs: ${gpuLines.join(', ')}` : (host.hardware?.summary || 'Remote hardware detected')),
    cpu: cpu || host.hardware?.cpu || 'Unknown',
    ram: ramGb > 0 ? `${ramGb} GB` : (host.hardware?.ram || 'Unknown'),
    gpu: gpuLines.length > 0 ? gpuLines : (host.hardware?.gpu || []),
    detected: {
      ...(host.hardware?.detected || {}),
      gpuCount: gpuLines.length,
      totalGpuVramGb,
      detectedAt: new Date().toISOString(),
      probe: 'ssh',
    },
  };

  detectedCount += 1;
  if (probe.method && probe.method !== 'failed') {
    console.log(`  remote hardware probe success: ${host.id || targetHost} via ${probe.method}`);
  }
}

fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
console.log(`  detected remote hardware via probe: ${detectedCount}/${remoteHosts.length} hosts`);
if (failures.length > 0) {
  console.log('  remote hardware probe failures:');
  for (const failure of failures) {
    console.log(`    - ${failure.host} (${failure.target}): ${failure.reason}`);
  }
}
NODE
}

prompt_remote_ssh_user() {
  local registry_path="$1"

  if [ -n "$REMOTE_SSH_USER" ]; then
    return 0
  fi

  if [ ! -t 0 ] || [ ! -t 1 ]; then
    return 0
  fi

  if [ ! -f "$registry_path" ]; then
    return 0
  fi

  local remote_count="0"
  local tailscale_only="0"
  if command -v node >/dev/null 2>&1; then
    local remote_info
    remote_info="$(REGISTRY_PATH="$registry_path" node <<'NODE'
const fs = require('fs');
try {
  const remoteTierId = process.env.XX_STACK_TIER_TAILSCALE_OLLAMA;
  const remoteProviderId = process.env.XX_STACK_PROVIDER_OLLAMA_REMOTE;
  const tailscaleScope = process.env.XX_STACK_NETWORK_SCOPE_TAILSCALE;
  const registry = JSON.parse(fs.readFileSync(process.env.REGISTRY_PATH, 'utf8'));
  const remoteTier = registry.tiers?.find((tier) => tier.id === remoteTierId);
  const hosts = Array.isArray(remoteTier?.hosts)
    ? remoteTier.hosts.filter((host) => host?.provider === remoteProviderId && host?.enabled !== false && host?.endpoint)
    : [];
  const tailscaleHosts = hosts.filter((host) => {
    const endpoint = String(host?.endpoint || '');
    return host?.networkScope === tailscaleScope || /^https?:\/\/100\./.test(endpoint) || /ts\.net|tailnet/.test(endpoint);
  });
  const tailscaleOnly = hosts.length > 0 && tailscaleHosts.length === hosts.length;
  process.stdout.write(`${hosts.length}:${tailscaleOnly ? '1' : '0'}`);
} catch {
  process.stdout.write('0:0');
}
NODE
)"
    remote_count="${remote_info%%:*}"
    tailscale_only="${remote_info##*:}"
  fi

  if [ "$remote_count" = "0" ]; then
    return 0
  fi

  local default_user="${USER:-}"
  REMOTE_SSH_USER="$default_user"

  if [ -n "$REMOTE_SSH_USER" ]; then
    export XX_STACK_REMOTE_SSH_USER="$REMOTE_SSH_USER"
    echo "  using default SSH user for remote hardware probe: $REMOTE_SSH_USER"
  else
    echo "  no default SSH user available; remote hardware probe will run best-effort without explicit username"
  fi

  if [ -n "$REMOTE_SSH_USER" ]; then
    if [ "$tailscale_only" = "1" ]; then
      REMOTE_SSH_MODE="auto"
      echo "  all selected remote hosts are Tailscale endpoints; using remote probe transport: auto (ssh first, tailscale fallback)"
    else
      REMOTE_SSH_MODE="auto"
      echo "  using remote probe transport: $REMOTE_SSH_MODE"
    fi
    export XX_STACK_REMOTE_SSH_MODE="$REMOTE_SSH_MODE"

    unset XX_STACK_REMOTE_SSH_PASSWORD
    REMOTE_SSH_PASSWORD=""
    if [ "$REMOTE_SSH_PROMPT" = "1" ]; then
      echo "  native SSH password/passphrase prompts are enabled for remote hardware probing"
    else
      echo "  remote hardware probing stays non-interactive by default; set XX_STACK_REMOTE_SSH_PROMPT=1 to allow SSH password/passphrase prompts"
    fi
  fi
}