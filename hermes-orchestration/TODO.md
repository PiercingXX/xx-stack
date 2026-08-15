# Hermes Orchestration TODO

Last updated: 2026-08-02

> **2026-08-02 reconciliation:** this file had drifted badly — Phases 1, 2, 4 and 5
> of the proxy plan shipped months ago but their checkboxes were never ticked, so
> ~90 lines read as outstanding work that was already done. Every item below was
> re-verified against `scripts/hermes_orchestrator.py`, `config/orchestration.json`,
> `tests/test_orchestrator.py` and `README.md` before being marked. The genuinely
> open work is now the short list at the top.

## Open work

Everything else in this file is done. These are the only outstanding items, and
the first two are the blockers — the rest depend on what they find.

### 1. Confirm Hermes client constraints (was Phase 0)

- [ ] Inspect Hermes' request mode and confirm whether interactive chat can target
      a plain OpenAI-compatible `chat/completions` endpoint.
- [ ] Verify whether Hermes must use `codex_responses`, or can be switched to a
      generic local OpenAI-compatible mode.
- [ ] Identify the minimum config keys needed to point Hermes at a local endpoint.
- [ ] Decide: default Hermes profile, or a separate orchestrated profile for
      safer rollback.
- [ ] Record the exact config values and commands needed to switch modes.

This is inspection of `~/.hermes/config.yaml` and the Hermes client itself —
outside this repo, and it holds premium-backend credentials.

### 2. Point Hermes at the proxy (was Phase 3)

Blocked on item 1. The proxy side is finished and serving; only the client
switch remains.

- [ ] Point the Hermes base URL at `http://127.0.0.1:8180`.
- [ ] Set Hermes to use the proxy model surface rather than direct premium
      backend selection.
- [ ] Keep a rollback command ready to restore the direct premium backend.
- [ ] Document the exact launch command for orchestrated Hermes sessions.
- [ ] Manual validation: send a normal interactive request and confirm it routes
      through the orchestrator, stays self-hosted by default, and that premium
      fallback only fires when self-hosted lanes are unavailable or unsuitable.

### 3. Conditional — only if item 1 says so

- [ ] `POST /v1/responses`, normalized into the same execution path. Only needed
      if Hermes cannot use `chat/completions`.
- [ ] True token-by-token streaming. Today `stream: true` gets a single-chunk SSE
      shim (`_send_stream_shim`), which is correct but not incremental. Only worth
      building if interactive UX actually feels bad — a judgment call from using it.

### 4. Small, independent

- [ ] Extend `scripts/smoke_test.sh` with an optional proxy mode. Low value:
      `ProxyTests` in `tests/test_orchestrator.py` already covers `/healthz`,
      `/v1/models` (auth required, lane models listed), chat routing to a lane,
      and bad-token rejection against a live server on a real socket.
- [ ] Decide whether `execution.allow_shell_execution` stays disabled.
      Currently `false`, which is the safer default and matches how the rest of
      the stack gates execution. Recommendation: leave it off.

## Shipped

### Proxy surface (was Phase 1)

- [x] `serve` command on `scripts/hermes_orchestrator.py` — one control path, not
      a second binary
- [x] `GET /healthz` (no auth, process readiness)
- [x] `GET /v1/models` (bearer auth, lane model surface)
- [x] `POST /v1/chat/completions`
- [x] Non-streaming first; `stream: true` answered with an SSE shim
- [x] Config for bind host, port, auth token env var, and request timeout
      (`proxy.*` plus `execution.request_timeout_seconds`)

### Proxy → orchestrator mapping (was Phase 2)

- [x] Proxied chat uses the existing local-first path
- [x] Lane selection reuses `primary_lane_order` / `lane_from_config` /
      `check_lane_health` / `model_matches_requirement` — no routing rules
      duplicated in the proxy layer
- [x] Policy order preserved; cloud excluded unless `--allow-cloud` or
      `proxy.allow_cloud=true`
- [x] Premium fallback stays on the local `hermes` CLI lane
- [x] Responses normalized to OpenAI shape regardless of which lane served them
- [x] **Decided:** proxied chat never auto-triggers delegated subagents. Fan-out
      stays an explicit `subagents` invocation.

### Security constraints

- [x] Binds `127.0.0.1` only by default
- [x] Not exposed on Tailscale or any public interface
- [x] Bearer token mandatory (`HERMES_PROXY_TOKEN`) even on loopback; `--no-auth`
      must be passed explicitly
- [x] Prompt bodies never logged — structurally, not by a flag. No code path
      writes a request body anywhere. The old `proxy.log_prompts` key was
      credited here in the 2026-08-02 reconciliation but was never read by
      anything; it has been deleted from the config and from `ProxyServer`
      rather than left as a control that does not control anything (HERMES-9).
- [x] Premium credentials stay inside local Hermes; never duplicated into repo config
- [x] Explicit stderr warning when bound to a non-loopback host

### Operational polish (was Phase 5)

- [x] Dedicated `proxy` section in `config/orchestration.json`
- [x] Startup documented in `README.md` ("Local proxy mode (serve)")
- [x] **Decided:** runs as a user systemd service — `systemd/hermes-proxy.service`,
      reading its token from `~/.config/hermes-orchestration/proxy.env`
- [x] Structured routing logs to `logs/routing.jsonl` — lane, model, latency,
      usage, and requested model. Proxy events now also carry `attempts` (the
      per-lane skip/failure reasons) and a request that no lane could serve
      writes its own `ok: false` record. The 2026-08-02 reconciliation claimed
      `attempts` was already in the log; it was not — until this change it
      appeared only in the 502 HTTP response body (HERMES-DOC-1, HERMES-12).

### Earlier control-plane work

- [x] Control-plane runner `scripts/hermes_orchestrator.py`, local-first routing
      config, and smoke runner `scripts/smoke_test.sh`
- [x] Explicit cloud gate with JSONL escalation logging
- [x] Premium GitHub lane via the local `hermes` CLI (`gpt-5.3-codex`, `gpt-5.4`)
- [x] Self-hosted-first delegated routing; Ollama removed as an execution option
- [x] `--required-model` suitability filter so cloud is reached only after a
      self-hosted mismatch
- [x] Named routing presets: `general`, `coding`, `review`, `long-context`, `reasoning`
- [x] Model inventory across local/remote/cloud, with tool-call probing, a
      capability cache at `logs/capability-cache.json`, and cache-driven subagent
      lane selection
- [x] Strict mode `execution.require_tool_call_for_subagents`
- [x] Periodic capability refresh (`refresh-cache` + systemd timer units)

### Environment setup

- [x] Arch Tailscale IP filled in; Debian and Arch llama.cpp endpoints confirmed
- [x] Local Hermes config present at `~/.hermes/config.yaml`
- [x] GitHub cloud lane healthy in the orchestrator inventory

### Verification

- [x] `health`, `route --reason-code PRECHECK`, `inventory --probe-tool-calls`,
      `run --task ...`, and `subagents --task "A||B"` all validated
- [x] Automated suite under `tests/` — 58 tests covering command safety (against
      the *shipped* allowlist, with a negative case per known bypass), lane
      ordering and priority re-sorting, cloud-gate fail-closed defaults, routing
      and fallback, tool-call gating across every shipped preset, credential
      helper timeouts, and the proxy (auth, keep-alive body draining, body cap,
      failure telemetry)

## Usage notes

Not tasks — guidance for the "model says it will, but does nothing" failure mode:

- Use `--require-executable-plan` for tasks that should produce actions.
- Enable `execution.allow_shell_execution=true` only if you want command execution.
- Run with `--execute-approved` to execute only allowlisted commands.

```bash
python3 scripts/hermes_orchestrator.py run \
  --task "List files and show git status" \
  --require-executable-plan \
  --execute-approved
```

## Historical note

The 2026-07-05 retarget moved self-hosted lanes to `gpu-rig`
(8x RTX 5090) over Tailscale: sglang on port 30000 (primary, `qwen3-coder-next`)
and ollama on port 11434 (fallback, pending `OLLAMA_HOST` exposure on the rig).
Older references to "Debian local llama.cpp" and "Arch over Tailscale" map to the
sglang and ollama lanes respectively.
