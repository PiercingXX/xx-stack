# Hermes Local-First Orchestration

> Part of the XX-Stack monorepo (formerly the standalone `hermes-orchestration` repo).
> Everything under `hermes/` is self-contained: a Python control plane with no
> dependency on the TypeScript stack in the rest of the repo.

This directory is a runnable self-hosted-first orchestration control plane for
inference over Tailscale, with cloud fallback only after self-hosted lanes are
unavailable or unsuitable.

## Topology

All self-hosted inference runs on the AI rig `skippy-debian-5090` (Debian, 4x RTX 5090),
reached over Tailscale (MagicDNS name `skippy-debian-5090`):

| Lane key | Name | Endpoint | Runtime | Priority | Role |
|----------|------|----------|---------|----------|------|
| `sglang` | `skippy-sglang-5090` | `http://skippy-debian-5090:30000/v1` | sglang | 100 | Primary lane (262k context, batched parallel subagents) — the only lane currently live |
| `ollama` | `skippy-ollama-5090` | `http://skippy-debian-5090:11434/v1` | ollama | 70 | Fallback self-hosted lane — **disabled** until Ollama is exposed on the tailnet (see below) |
| `cloud` | `github-premium-cloud` | local `hermes` CLI | GitHub premium | 50 | Last-resort escalation |

Lanes are named entries in `config/orchestration.json` with a `role`
(`self_hosted` or `cloud`) and a numeric `priority` — higher priority is tried
first. Cloud lanes are always gated behind explicit policy regardless of priority.
Routing order for both primary tasks and subagents is sglang → ollama → cloud.

### Enabling the ollama lane

The lane ships with `lanes.ollama.enabled: false` because Ollama binds to
`127.0.0.1` by default and is not reachable over Tailscale until you bind it to
the tailnet interface on the rig:

```bash
# On skippy-debian-5090:
sudo systemctl edit ollama
# Add:
#   [Service]
#   Environment="OLLAMA_HOST=0.0.0.0:11434"
# (or bind only to the tailnet IP; find it with `tailscale ip -4` on the rig)
sudo systemctl restart ollama
```

Then update `lanes.ollama.model` in `config/orchestration.json` to a model that
`ollama list` actually shows (currently assumed: `qwen3-coder:30b`), set
`lanes.ollama.enabled` to `true`, and re-enable the matching `overflow` tier
host in `../runtime/platforms.json`.

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
tailscale status | grep skippy
curl -s http://skippy-debian-5090:30000/v1/models
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
requests across the 4x 5090s, so parallel slices are close to free relative to
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
- Prompt bodies are never logged.

A user systemd unit is provided at `systemd/hermes-proxy.service`; it reads
`HERMES_PROXY_TOKEN` from `~/.config/hermes-orchestration/proxy.env`.

## Benchmarking lanes

`bench` measures latency percentiles and throughput for a lane, writing a
report compatible with the model qualification matrix schema:

```bash
python3 scripts/hermes_orchestrator.py bench \
  --lane sglang --parallel 4 --iterations 3 \
  --context-tokens 8000 --max-tokens 256 --profile coding-long
# → logs/bench/<timestamp>-sglang-<model>.json
```

GPU residency still requires on-host `nvidia-smi` telemetry on the rig; run it
alongside the bench.

## Routing telemetry

Every chat call (run, subagents, proxy) appends one JSONL record to
`logs/routing.jsonl` with lane, model, latency, token usage, and error details.
Prompt bodies are not logged. Cloud escalations additionally go to
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

Commands are parsed with `shlex`, rejected if they contain shell
metacharacters (`; | & < > $ \``), matched against the allowlist as whole
argv tokens, and executed **without a shell**. `git status; rm -rf ~` is
rejected outright.

## Cloud escalation

Cloud lanes require the `hermes` CLI on the orchestrator host.

- Cloud is off by default everywhere (`subagents_allow_cloud_default: false`); every cloud use requires an explicit `--allow-cloud`.
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

- Strict tool-call gate is enabled by default (`execution.require_tool_call_for_subagents=true`);
  `qwen3-coder-next` on the sglang lane passes the probe.
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
