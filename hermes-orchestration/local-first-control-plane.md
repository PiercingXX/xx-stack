# Local-First Control Plane Contract

Status: Active
Owner: hermes orchestration control plane
Last updated: 2026-07-05

## 1) Canonical implementation in this repo

This repo includes executable control-plane artifacts:

- `config/orchestration.json` defines lane endpoints, default models, and cloud gate policy.
- `scripts/hermes_orchestrator.py` is the runnable local-first routing and execution CLI.
- `scripts/smoke_test.sh` is a basic lane health/routing smoke test.

The contract below must match those files.

## 2) Control-plane identity and invariant behavior

- Orchestration decisions are always made on the orchestrator host; inference runs
  on self-hosted lanes first.
- Self-hosted inference host: `skippy-debian-5090` (Debian, 4x RTX 5090), reached
  over Tailscale only (MagicDNS `skippy-debian-5090`).
- Lanes are named config entries (`sglang`, `ollama`, `cloud`) with a `role`
  (`self_hosted` or `cloud`) and numeric `priority`; higher priority is tried first
  and cloud lanes are always policy-gated regardless of priority.
- Mandatory lane order for a primary task (`policy.primary_lane_order`):
  1. `skippy-sglang-5090` (sglang, port 30000)
  2. `skippy-ollama-5090` (ollama, port 11434)
  3. Cloud lane when enabled and needed
- Mandatory lane order for delegated subagent slices (`execution.subagent_profile_orders`):
  1. `skippy-sglang-5090` (preferred — batched parallel serving on 4x 5090)
  2. `skippy-ollama-5090`
  3. Cloud lane for eligible presets only after self-hosted lanes are unavailable or unsuitable

## 3) Current default model mapping

- sglang lane default:
  - `qwen3-coder-next` (262k context window)
- ollama lane default:
  - `qwen3-coder:30b` (update to match `ollama list` on the rig)
- Preferred cloud model when escalation is approved:
  - `gpt-5.3-codex`
- Cloud fallback model:
  - `gpt-5.4`
- Optional cloud lane:
  - local `hermes` CLI premium GitHub lane

## 4) Cloud escalation gate (strict)

Cloud escalation/delegation is valid when one of these is true:

1. Self-hosted lanes cannot satisfy the required model/context/concurrency/latency profile.
2. A specialized model only available through cloud is required.
3. Decomposition has been attempted (or formally rejected with rationale) for constrained workloads.

Cloud is still not a convenience default, but it is now an available delegated lane.

Named delegated routing presets are defined in `config/orchestration.json` under `execution.routing_presets`.

For specialized routing, use `--preset reasoning` or `--required-model` to prove whether a self-hosted lane is a valid option before cloud is considered.

## 5) Why a model can appear to "do nothing"

The common failure mode is expecting tool execution from plain text generation.

- If you run a normal prompt, the model returns text only.
- To force actionable output, use `--require-executable-plan` so the model must return strict JSON.
- To actually run returned shell actions, both must be true:
  - `config/orchestration.json` has `execution.allow_shell_execution` set to `true`
  - command is launched with `--execute-approved`

Example:

```bash
python3 scripts/hermes_orchestrator.py run \
  --task "Find TODOs and show git status" \
  --require-executable-plan \
  --execute-approved
```

## 6) Network and exposure policy

- Self-hosted lanes must use Tailscale-only connectivity.
- Do not expose sglang or ollama endpoints publicly.
- On `skippy-debian-5090`, prefer binding sglang/ollama to the tailnet interface
  (find it with `tailscale ip -4` on the rig) rather than `0.0.0.0`, or firewall the ports to the tailnet.
- Ollama requires `OLLAMA_HOST` to be set away from its `127.0.0.1` default before
  the ollama lane is reachable.

## 7) Required operational checks

Run before relying on orchestration:

```bash
python3 -m unittest discover -s tests
python3 scripts/hermes_orchestrator.py health
python3 scripts/hermes_orchestrator.py route --reason-code PRECHECK
python3 scripts/hermes_orchestrator.py inventory --probe-tool-calls
python3 scripts/hermes_orchestrator.py subagents --task "check one||check two"
```

## 7a) Execution, telemetry, and interactive-surface guarantees

- Subagent slices run in parallel on the selected lane
  (`execution.max_parallel_subagents`, default 4).
- Every chat call (run, subagents, proxy) is logged to
  `execution.routing_log_file` (`logs/routing.jsonl`) with lane, model, latency,
  and token usage. Prompt bodies are never logged.
- Shell actions from executable plans are parsed with `shlex`, rejected on any
  shell metacharacter, matched as whole argv tokens against the allowlist, and
  executed without a shell.
- The `serve` command exposes a loopback-only OpenAI-compatible proxy
  (`/healthz`, `/v1/models`, `/v1/chat/completions`) that enforces this routing
  policy; it requires a bearer token and excludes cloud lanes unless explicitly
  allowed.
- The `bench` command produces qualification-matrix-schema reports in
  `logs/bench/`.

## 8) Capability-aware strict subagent mode

- Subagent lane selection uses capability cache by default.
- Cache file: `logs/capability-cache.json`.
- Cache auto-refresh: every 600s maximum staleness (`execution.capability_cache_max_age_seconds`).
- Strict mode is enabled by default: delegated subagent lanes must pass tool-call probe.
- `qwen3-coder-next` on the sglang lane passes the tool-call probe.
- Tool probe results are reused while a lane's selected model is unchanged
  (`execution.reuse_tool_probe_for_same_model`); `--force-probe` re-probes.
- If no healthy lane passes probe, subagent routing is refused with explicit error.

## 9) Contract drift policy

If any behavior differs between docs and code, treat code and config as source of truth and update docs in the same change.
