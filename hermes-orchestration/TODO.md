# Hermes Orchestration TODO

Last updated: 2026-07-05

> **2026-07-05 retarget:** self-hosted lanes now live on `skippy-debian-5090`
> (4x RTX 5090) over Tailscale — sglang on port 30000 (primary, `qwen3-coder-next`)
> and ollama on port 11434 (fallback, pending `OLLAMA_HOST` exposure on the rig).
> References below to "Debian local llama.cpp" and "Arch over Tailscale" predate
> this and map to the sglang and ollama lanes respectively.
>
> **2026-07-05 (later):** the proxy plan below is now largely IMPLEMENTED via the
> `serve` command in `scripts/hermes_orchestrator.py`: loopback-only bind, mandatory
> bearer token (`HERMES_PROXY_TOKEN`), `/healthz`, `/v1/models`,
> `/v1/chat/completions` (with single-chunk SSE shim for `stream: true`), routing
> through the standard policy with cloud excluded by default, no prompt logging,
> and a user systemd unit (`systemd/hermes-proxy.service`). Remaining from the
> plan: Phase 0/3 (switching Hermes client config to point at the proxy) and true
> token-by-token streaming if interactive UX needs it. Also added since:
> parallel subagents, `bench`, routing telemetry (`logs/routing.jsonl`), argv-level
> command allowlisting, sticky tool probes, named lanes with role/priority, and a
> unit test suite under `tests/`.

## Tomorrow: wire Hermes to the orchestrator through a local proxy

Goal

- Hermes interactive sessions should stop talking directly to the premium GitHub backend.
- Hermes should instead talk to a local orchestrator-owned HTTP endpoint on loopback only.
- That local endpoint should enforce the real routing policy: Debian self-hosted first, then Arch over Tailscale, then premium GitHub fallback only when necessary.

Current state before tomorrow's work

- The orchestrator works and passes smoke tests.
- The orchestrator can already call local `hermes` as the premium fallback executor.
- Hermes itself is not yet fronted by the orchestrator.
- There is no proxy/server implementation in this repo yet.
- Current smoke coverage proves routing behavior, but not a full Hermes -> proxy -> orchestrator interactive path.

Non-negotiable security constraints

- [ ] Bind the new proxy to `127.0.0.1` only.
- [ ] Do not expose the proxy on Tailscale or any public interface.
- [ ] Require a local bearer token or equivalent shared secret even on loopback.
- [ ] Do not log prompt bodies, tokens, or secrets by default.
- [ ] Keep premium fallback credentials inside local Hermes only; do not duplicate them into repo config.

Phase 0: confirm Hermes client constraints before writing code

- [ ] Inspect Hermes request mode closely and confirm whether interactive chat can target a plain OpenAI-compatible `chat/completions` endpoint.
- [ ] Verify whether Hermes must use `codex_responses` or can be switched to a generic local OpenAI-compatible mode.
- [ ] Identify the minimum config keys needed to point Hermes at a local endpoint instead of its current direct premium backend.
- [ ] Decide whether to use the default Hermes profile or a separate orchestrated profile for safer rollback.
- [ ] Record the exact config values and commands needed to switch Hermes into orchestrated mode.

Phase 1: add the local orchestrator proxy surface

- [ ] Add a new serving mode to the repo.
- [ ] Preferred implementation: extend `scripts/hermes_orchestrator.py` with a `serve` command instead of creating a second independent control path.
- [ ] Expose `GET /healthz` for process-level readiness.
- [ ] Expose `GET /v1/models` so Hermes can discover a stable local model surface.
- [ ] Expose `POST /v1/chat/completions` if Hermes can talk to standard OpenAI-compatible chat.
- [ ] If Hermes requires it, also expose `POST /v1/responses` and normalize it into the same orchestrator execution path.
- [ ] Support non-streaming requests first; add streaming only if Hermes requires it for usability.
- [ ] Add config for bind address, port, auth token, and request timeout.

Phase 2: map proxy requests into orchestrator behavior

- [ ] Define the default interactive route for proxied Hermes requests.
- [ ] Minimum acceptable behavior for day one: proxied chat uses the existing local-first `run` path.
- [ ] Decide whether proxied Hermes requests should ever trigger delegated subagents automatically, or if that stays an explicit orchestrator feature for now.
- [ ] Reuse existing lane selection logic instead of duplicating routing rules in the proxy layer.
- [ ] Preserve the current policy order: Debian local -> Arch delegated -> premium GitHub fallback.
- [ ] Keep premium fallback on local Hermes with `gpt-5.3-codex`, then `gpt-5.4`.
- [ ] Return normalized OpenAI-style responses to the client even when the underlying lane was self-hosted or premium fallback.

Phase 3: make Hermes point at the local orchestrator endpoint

- [ ] Create a safe switch plan for Hermes config.
- [ ] Prefer a separate Hermes profile or clearly documented config toggle for orchestrated mode.
- [ ] Point Hermes base URL at the new local proxy once the endpoint is live.
- [ ] Set Hermes to use the local proxy model surface rather than direct premium backend selection.
- [ ] Keep a rollback command ready to restore the direct premium backend if the proxy path fails.
- [ ] Document the exact launch command for orchestrated Hermes sessions.

Phase 4: smoke and acceptance testing

- [ ] Add a proxy-specific smoke test script or extend `scripts/smoke_test.sh` with an optional proxy mode.
- [ ] Test `curl` directly against `GET /healthz`.
- [ ] Test `curl` directly against `GET /v1/models`.
- [ ] Test `curl` directly against `POST /v1/chat/completions` and verify local-first behavior.
- [ ] Verify Arch-offline behavior still falls back to Debian before premium cloud.
- [ ] Verify premium fallback still works when self-hosted lanes are unavailable or unsuitable.
- [ ] Launch Hermes against the local proxy and confirm the UI no longer talks directly to the premium backend.
- [ ] Confirm that opening Hermes in orchestrated mode still feels usable without streaming.

Phase 5: operational polish

- [ ] Add a dedicated config section for proxy server settings in `config/orchestration.json`.
- [ ] Add clear startup and shutdown commands to `README.md`.
- [ ] Decide whether the proxy should run ad hoc, under `tmux`, or as a user systemd service.
- [ ] If it should persist, add user systemd unit files for the proxy.
- [ ] Add minimal structured logs for lane choice, request id, latency, and fallback reason.
- [ ] Add an explicit warning if the proxy is not on loopback.

Known risks and unknowns to resolve tomorrow

- [ ] Hermes may not be willing to talk to a plain OpenAI-compatible chat endpoint in its current interactive mode.
- [ ] Hermes may require a `responses`-style API instead of `chat/completions`.
- [ ] Streaming may be required for acceptable interactive UX.
- [ ] Automatic delegation from normal chat is not implemented in the orchestrator today; only explicit `subagents` flows do that.
- [ ] Tool-calling semantics may differ between Hermes client expectations and the current orchestrator response shape.
- [ ] Session/history persistence may need to stay entirely in Hermes, with the proxy remaining stateless.

Acceptance criteria for tomorrow

- [ ] Start the proxy locally.
- [ ] Point Hermes at the proxy.
- [ ] Send a normal interactive request from Hermes and confirm it routes through the orchestrator.
- [ ] Confirm normal requests stay self-hosted by default.
- [ ] Confirm delegated work still prefers Arch when applicable.
- [ ] Confirm premium fallback only happens when self-hosted lanes are unavailable or unsuitable.
- [ ] Confirm rollback to direct Hermes backend is documented and works.

Suggested order of execution tomorrow

- [ ] 1. Confirm Hermes client protocol and config toggles.
- [ ] 2. Implement a minimal loopback-only proxy with one working chat endpoint.
- [ ] 3. Prove `curl` against the proxy before touching Hermes config.
- [ ] 4. Switch Hermes to the proxy in a reversible way.
- [ ] 5. Run manual Hermes interactive validation.
- [ ] 6. Add smoke coverage and only then clean up docs.

## Completed in this repo

- [x] Added executable control-plane runner: `scripts/hermes_orchestrator.py`
- [x] Added default local-first routing config: `config/orchestration.json`
- [x] Added smoke runner: `scripts/smoke_test.sh`
- [x] Updated policy docs to match runnable behavior
- [x] Set Debian local default model to `qwen2.5-coder-14b-instruct-q5_k_m`
- [x] Enforced explicit cloud gate and JSONL escalation logging
- [x] Enabled premium GitHub cloud lane with working models (`gpt-5.3-codex`, `gpt-5.4`) via local `hermes` CLI
- [x] Enabled cloud-capable delegated subagents for `hardware-constrained` and `specialized-model` profiles
- [x] Removed Ollama as an orchestrator execution option
- [x] Enforced self-hosted-first delegated routing: Arch -> Debian llama.cpp -> cloud
- [x] Added `--required-model` suitability filter so cloud is only used after self-hosted model mismatch/unavailability
- [x] Added named routing presets (`general`, `coding`, `review`, `long-context`, `reasoning`)
- [x] Added smoke coverage proving self-hosted delegated routing and premium fallback routing

## Still required environment setup

- [x] Replace `REPLACE_WITH_ARCH_TAILSCALE_IP` in `config/orchestration.json`
- [x] Confirm Debian llama.cpp endpoint responds on configured local URL (fixed to `http://127.0.0.1:18081/v1`)
- [x] Confirm Arch llama.cpp endpoint responds on configured Tailscale URL
- [x] Confirm local Hermes config exists at `~/.hermes/config.yaml`
- [ ] Decide whether `execution.allow_shell_execution` should remain disabled (safer default)

- [x] GitHub cloud lane healthy in orchestrator inventory
- [x] Add model inventory command across local/remote/cloud (`inventory`)
- [x] Add tool-call probe support for lane models (`inventory --probe-tool-calls`)
- [x] Store capability cache and recommendation in `logs/capability-cache.json`
- [x] Use capability cache for subagent lane selection
- [x] Validate tool-call compatibility on local model and remote model with inventory probe (local=false, remote=true)
- [x] Add strict mode for subagent routing (`execution.require_tool_call_for_subagents=true`)
- [x] Add periodic capability refresh automation (`refresh-cache` + `scripts/refresh_capability_cache.sh` + user systemd timer units)



## Verification checklist

- [x] `python3 scripts/hermes_orchestrator.py health`
- [x] `python3 scripts/hermes_orchestrator.py route --reason-code PRECHECK`
- [x] `python3 scripts/hermes_orchestrator.py inventory --probe-tool-calls`
- [x] `python3 scripts/hermes_orchestrator.py run --task "Say hello"` (validated with equivalent primary run command)
- [x] `python3 scripts/hermes_orchestrator.py subagents --task "Task A||Task B"`

## Focused fix for "model says it will but does nothing"

- [ ] Use `--require-executable-plan` for tasks that should produce actions
- [ ] Enable `execution.allow_shell_execution=true` only if you want command execution
- [ ] Run with `--execute-approved` to execute only allowlisted commands







Example:

```bash
python3 scripts/hermes_orchestrator.py run \
  --task "List files and show git status" \
  --require-executable-plan \
  --execute-approved
```

