# Hermes Local-First Orchestration

> One of the three top-level components of this repo (see the [root README](../README.md)).
> `hermes-orchestration/` is self-contained: a Python control plane with no
> dependency on the TypeScript stack (`mcp-server/`, `runtime/`) or
> `opencode-orchestration/`. Python 3.11+ and the standard library are the only
> requirements.

This directory is a runnable self-hosted-first orchestration control plane for
inference over Tailscale, with cloud fallback only after self-hosted lanes are
unavailable or unsuitable.

## Topology

Self-hosted inference runs on the remote GPU box `example-gpu-box` (the example
inventory's 2x RTX 4090 host), reached over Tailscale (MagicDNS name
`example-gpu-box`). Both lanes ship **disabled** until you point them at a real
machine:

| Lane key | Name | Endpoint | Runtime | Priority | Role |
|----------|------|----------|---------|----------|------|
| `sglang` | `example-gpu-box-sglang` | `http://example-gpu-box:30000/v1` | sglang | 100 | Primary lane when enabled — enable after pointing the machine at hardware you own |
| `ollama` | `example-gpu-box-ollama` | `http://example-gpu-box:11434/v1` | ollama | 70 | Fallback self-hosted lane — **disabled** until Ollama is exposed on the tailnet (see below) |

A cloud lane is not part of the shipped template; add one under `cloud.hermesCli`
in your `inventory.json` and re-run `npm run inventory:sync` if you want Hermes
to hold a last-resort escalation lane.

Lanes are named entries in `config/orchestration.json` with a `role`
(`self_hosted` or `cloud`) and a numeric `priority` — higher priority is tried
first. Cloud lanes are always gated behind explicit policy regardless of priority.
Routing order for both primary tasks and subagents is sglang → ollama → cloud.

### Enabling the ollama lane

The lane ships with `lanes.ollama.enabled: false` because Ollama binds to
`127.0.0.1` by default and is not reachable over Tailscale until you bind it to
the tailnet interface on the rig:

```bash
# On example-gpu-box:
sudo systemctl edit ollama
# Add:
#   [Service]
#   Environment="OLLAMA_HOST=0.0.0.0:11434"
# (or bind only to the tailnet IP; find it with `tailscale ip -4` on the rig)
sudo systemctl restart ollama
```

Then update `lanes.ollama.model` in `config/orchestration.json` to a model that
`ollama list` actually shows (currently assumed: `qwen3-coder:30b`), set
`lanes.ollama.enabled` to `true`, and re-enable the matching
`example-gpu-box-ollama` host in the `tailscale-ollama` tier of
`../runtime/platforms.json` (generated from `inventory.example.json`).

## What is implemented

- Control plane runner: `scripts/hermes_orchestrator.py`
  (`health`, `route`, `run`, `subagents`, `presets`, `inventory`, `refresh-cache`,
  `bench`, `serve`)
- Default routing/model policy: `config/orchestration.json`
- Unit tests: `tests/test_orchestrator.py`
- Smoke checks: `scripts/smoke_test.sh`
- Policy docs aligned to implementation:
  - `local-first-control-plane.md`
  - `cloud-escalation-policy.md`
  - `model-qualification-matrix.md`

## Quick start

1. Verify Tailscale can reach the rig:

```bash
tailscale status | grep example-gpu-box
curl -s http://example-gpu-box:30000/v1/models
```

2. Run unit tests and health checks:

```bash
python3 -m unittest discover -s tests
python3 scripts/hermes_orchestrator.py health
```

3. Route preview (cloud disabled by default):

```bash
python3 scripts/hermes_orchestrator.py route --reason-code PRECHECK
```

4. Run a normal task on the primary lane:

```bash
python3 scripts/hermes_orchestrator.py run --task "Summarize current routing behavior"
```

5. Run delegated subagents (explicit slices run in parallel):

```bash
python3 scripts/hermes_orchestrator.py subagents --task "Task A||Task B"
```

6. Let the model decompose a task into parallel slices:

```bash
python3 scripts/hermes_orchestrator.py subagents \
  --task "Audit the config loading, routing, and logging code paths" \
  --auto-split --parts 3
```

7. List named routing presets:

```bash
python3 scripts/hermes_orchestrator.py presets
```

8. Use a preset that can reach cloud only after self-hosted lanes are unsuitable
   (cloud is off by default; `--allow-cloud` is required for any cloud use):

```bash
python3 scripts/hermes_orchestrator.py subagents \
  --task "Task A||Task B" \
  --preset reasoning \
  --allow-cloud
```

## Parallel subagents

Subagent slices run concurrently on the selected lane via a thread pool
(`execution.max_parallel_subagents`, default 4). sglang batches concurrent
requests across the box's GPUs, so parallel slices are close to free relative to
sequential execution.

## Local proxy mode (serve)

`serve` exposes the routing policy as a loopback OpenAI-compatible endpoint so
interactive clients (e.g. Hermes) can route through the orchestrator instead of
talking directly to any backend:

```bash
export HERMES_PROXY_TOKEN="$(openssl rand -hex 24)"
python3 scripts/hermes_orchestrator.py serve
# → http://127.0.0.1:8180  with endpoints /healthz, /v1/models, /v1/chat/completions
```

- Binds loopback-only by default (`proxy.bind_host`); a warning is printed for
  anything else.
- Requires a bearer token (env var named by `proxy.auth_token_env`, `--token`,
  or explicit `--no-auth`).
- `model: "auto"` (or omitted) uses the standard routing order; naming a real
  model restricts routing to lanes that serve it.
- Cloud lanes are excluded unless started with `--allow-cloud` or
  `proxy.allow_cloud=true`.
- `stream: true` is answered with a single-chunk SSE shim (the upstream call is
  non-streaming).
- Prompt bodies are never logged — there is no code path that writes them and no
  switch that would enable one.
- Request bodies are capped (8 MiB → `413`) and the handler socket has a
  timeout, so a slow or oversized client cannot park a thread.
- Lane health checks are memoized per lane for
  `proxy.health_check_ttl_seconds` (default 30) instead of probing on every
  request; failures are cached too, so a lane that just recovered may wait out
  the TTL. Set it to `0` to probe every request.

A user systemd unit is provided at `systemd/hermes-proxy.service`; it reads
`HERMES_PROXY_TOKEN` from `~/.config/hermes-orchestration/proxy.env` and runs
the service sandboxed (no privilege escalation, read-only filesystem with only
the repo's `logs/` directory writable).
See [Installing the systemd units](#installing-the-systemd-units) below.

## Using this as an xx-stack routing lane

The proxy is what lets the rest of the repo use Hermes without knowing anything
about your lanes. Both shipped platform registries already carry a
`hermes-proxy` host in the `local` tier, **disabled by default**:

- `../runtime/platforms.json`
- `../opencode-orchestration/opencode/platforms.json`

Start the proxy (above), then set `enabled: true` on that host. xx-stack will
route to `http://127.0.0.1:8180` and Hermes applies its own self-hosted-first
lane policy behind it.

### Pointing the Hermes *client* at the proxy

Interactive Hermes is configured in `~/.hermes/config.yaml`, which is outside
this repo and often already points at a custom OpenAI-compatible URL. Do not
overwrite that file unattended.

The proxy speaks `chat/completions` at `http://127.0.0.1:8180/v1`. A backup-
then-switch helper lives at `scripts/switch-hermes-to-proxy.sh`:

```bash
# print the planned edit; writes nothing
./scripts/switch-hermes-to-proxy.sh

# timestamped backup, then set base_url to the proxy
./scripts/switch-hermes-to-proxy.sh --apply
```

Start the proxy first (`python3 scripts/hermes_orchestrator.py serve`, or the
systemd unit). Rollback is `cp ~/.hermes/config.yaml.bak.<timestamp> ~/.hermes/config.yaml`.

The host advertises a single virtual model, `hermes-auto` — Hermes resolves the
real backend per request, so xx-stack sees one stable lane rather than needing
its own entry for every GPU box. Its tool-call reliability is marked
`unverified` because that depends on whichever backend Hermes selects; run
`python3 scripts/hermes_orchestrator.py refresh-cache --probe-tool-calls` to see
per-lane tool support.

Leave the host disabled if you would rather have xx-stack address your
self-hosted endpoints directly. The two approaches are alternatives, not layers
to stack.

## Benchmarking lanes

`bench` measures latency percentiles and throughput for a lane, writing a
report compatible with the model qualification matrix schema:

```bash
python3 scripts/hermes_orchestrator.py bench \
  --lane sglang --parallel 4 --iterations 3 --warmup 1 \
  --context-tokens 8000 --max-tokens 256 --profile coding-long
# → logs/bench/<timestamp>-sglang-<model>.json
```

### Output validity gate

`tokens_per_sec` feeds model qualification, so a speed number is only published
for output the bench can certify. A sample is **excluded** when the reply was
truncated (`finish_reason == "length"`), finished abnormally, was too short to
assess, or was degenerate — fewer than 8 distinct word tokens, or a
repeated-trigram ratio above 0.5. Without this, a model stuck in a repetition
loop emits many tokens very fast and scores as the *best* lane. Rule borrowed
as an idea from `drumih/turbo-fieldfare` `docs/COMMUNITY_BENCHMARKS.md`
(Apache-2.0).

Excluded samples are listed individually in `excluded_samples` and summarized in
`exclusions_by_reason` — nothing is silently dropped. A run reporting
`publishable: false` with `publish_blockers` must not be used to qualify a
model.

Two more things the report is careful about:

- **Estimates never share a field with measurements.** `tokens_per_sec` is
  provider-reported `usage.completion_tokens` only, and is `null` when the
  provider sent none; the `len(reply)//4` fallback lands in
  `tokens_per_sec_estimated` with `tokens_estimated: true`.
- **Warmup is excluded from timing but not discarded.** `--warmup` (default 1)
  runs before timing starts so cold model load — seconds on the sglang lane —
  stays out of `total_wall_seconds`, and its cost is still reported in
  `warmup_seconds`.

`gpu_residency_pass` and `lane_classification` are emitted as `null`: the bench
is an HTTP client and cannot see the remote rig's GPUs, and classification needs
lane thresholds that are not yet set. See `model-qualification-matrix.md` for
both, and collect on-host `nvidia-smi` telemetry alongside the bench.

## Routing telemetry

Every chat call (run, subagents, proxy) appends one JSONL record to
`logs/routing.jsonl` with lane, model, latency, token usage, and error details.
Proxy records also carry `attempts` — the per-lane skip/failure reasons — and a
request that no lane could serve writes its own `ok: false` record instead of
disappearing. Prompt bodies are not logged. Cloud escalations additionally go to
`logs/cloud-escalations.jsonl`.

## Executable plans and command execution

The model does not execute tools by default. To force action-ready output:

```bash
python3 scripts/hermes_orchestrator.py run \
  --task "Find TODOs and show git status" \
  --require-executable-plan
```

To execute allowed commands returned by that plan, set
`execution.allow_shell_execution` to `true` and pass `--execute-approved`.

Commands pass three layers before they run, all of which must succeed:

1. **Parse** with `shlex`; any token containing a shell metacharacter
   (`; | & < > $ \`` newline) or a `+` is rejected. `+` is there because it
   terminates `find -exec cmd {} +`. Commands are then executed **without a
   shell**, so `git status; rm -rf ~` is rejected outright and could not expand
   even if it were not.
2. **Whole-token prefix match** against `execution.allowed_command_prefixes`
   (`git statusx` does not match `git status`).
3. **Per-argument screening of every remaining argument** — this is the part
   that used to be missing. A prefix match no longer waves through whatever
   follows it. Arguments in the denylist (`-exec`, `-execdir`, `-delete`,
   `-fprintf`, `--pre`, `--pre-glob`, `--ext-diff`, `-c`, `--exec-path`,
   `--node-options`, `--require`, `--prefix`, `-p`, `-o`, `-z`, …) are refused,
   and every path argument must resolve inside the working directory, so
   `cat ~/.hermes/config.yaml`, `cat /etc/passwd` and `ls -la /tmp` are refused.

The shipped allowlist is `pwd`, `ls`, `cat`, `git status`, `git diff`,
`git log`, `python3 -m pytest`, `npm test`. `find` and `rg` were removed: their
process-spawning flags are numerous and version-dependent, so a denylist is not
a trustworthy boundary for them. The denylist still covers their known forms if
you re-add them, but you are on your own for flags nobody has enumerated yet.

**Residual limits — this is not a sandbox:**

- `npm test` and `python3 -m pytest` run code the *repository* controls
  (`package.json` scripts, `conftest.py`). Allowlisting them trusts the
  checkout, not the model. Drop them if the checkout is untrusted.
- `cat`/`ls` can read any file inside the working directory, including a stray
  `.env`. Containment is a workspace boundary, not a secrets boundary.
- The denylist enumerates known-bad flags; a new one is uncovered until added.
- The real boundary is still the double gate below. Treat the allowlist as
  defense in depth, not as the thing standing between a model and your host.

## Cloud escalation

Cloud lanes require the `hermes` CLI on the orchestrator host.

- Cloud is off by default everywhere, and the default **fails closed**: enabling
  cloud without `--allow-cloud` requires all three of
  `policy.require_manual_cloud_escalation: false`,
  `policy.cloud_enabled_by_default: true` and
  `execution.subagents_allow_cloud_default: true`. If any key is missing —
  `config/orchestration.json` is partly machine-generated, so keys can be
  dropped on regeneration — cloud stays off. The same applies to
  `execution.allow_cloud_subagent_delegation` and
  `execution.cloud_subagent_profiles`: a missing key narrows cloud eligibility,
  never widens it.
- Primary task fallback can use cloud when `--allow-cloud` is passed.
- Subagent delegation can use cloud for eligible presets with `--allow-cloud`, and only after self-hosted lanes are unavailable or unsuitable for the requested task/model.
- Escalation events are written to `logs/cloud-escalations.jsonl`.
- Preferred cloud model: `gpt-5.3-codex`; fallback: `gpt-5.4`.

## Named Routing Presets

- `general`: default sglang-first preset.
- `coding`: self-hosted-first coding preset with `gpt-5.3-codex` cloud fallback only when necessary.
- `review`: self-hosted review/refactor preset with cloud fallback only when necessary.
- `long-context`: sglang lane serves 262k context; cloud only after hardware-limit exhaustion.
- `reasoning`: specialized preset that explicitly requires `gpt-5.3-codex` and can fall back to `gpt-5.4`.

## Model Discovery And Delegation Fit

```bash
python3 scripts/hermes_orchestrator.py inventory --probe-tool-calls
```

This writes `logs/capability-cache.json` with lane health, available models,
tool-call probe results, and the recommended subagent lane/model.

- Strict tool-call gate is enabled by default (`execution.require_tool_call_for_subagents=true`)
  and applies to **every** routing preset, not just one task profile;
  `qwen3-coder-next` on the sglang lane passes the probe. If no healthy
  self-hosted lane passes it, subagent routing is refused rather than silently
  falling back.
- Tool probes are **sticky per model**: as long as a lane's selected model is
  unchanged, the previous probe result is reused instead of burning an
  inference call (`execution.reuse_tool_probe_for_same_model`). Pass
  `--force-probe` to re-probe.

## Periodic Capability Refresh

```bash
python3 scripts/hermes_orchestrator.py refresh-cache --probe-tool-calls
./scripts/refresh_capability_cache.sh
```

Optional user systemd units are provided in `systemd/`:

- `systemd/hermes-capability-refresh.service` + `.timer`
- `systemd/hermes-proxy.service`

## Installing the systemd units

The unit files are **templates**: they contain a `__HERMES_DIR__` placeholder
because systemd requires absolute paths and this checkout can live anywhere.
Do not install them by hand — run the helper, which substitutes the real path
for this checkout:

```bash
./scripts/install_systemd_units.sh
```

It writes the resolved units into `~/.config/systemd/user/` and prints the
remaining steps (creating the token file, then `systemctl --user enable --now`).
Re-run it if you ever move or rename the repository.
