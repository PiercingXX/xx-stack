# Hermes Orchestration TODO

The loopback proxy itself is done (`serve`, systemd unit, auth, routing
telemetry). Remaining work is pointing the Hermes *client* at that proxy.

### 1. Confirm Hermes client constraints (was Phase 0)

- [x] Inspect Hermes' request mode and confirm whether interactive chat can target
      a plain OpenAI-compatible `chat/completions` endpoint.
- [x] Verify whether Hermes must use `codex_responses`, or can be switched to a
      generic local OpenAI-compatible mode.
- [x] Identify the minimum config keys needed to point Hermes at a local endpoint.
- [x] Decide: default Hermes profile, or a separate orchestrated profile for
      safer rollback.
- [x] Record the exact config values and commands needed to switch modes.

`~/.hermes/config.yaml` already speaks OpenAI-compatible `chat/completions`
(`provider: custom`, `base_url: …/v1`). No `/v1/responses` adapter is required
for the client switch. The live default is often a custom backend, not the
proxy — switching is opt-in via `scripts/switch-hermes-to-proxy.sh` (dry-run
unless `--apply`; always writes a timestamped backup). Do not overwrite the
live file unattended.

### 2. Point Hermes at the proxy (was Phase 3)

Script and docs are in the repo. Applying the switch on a live machine is still
an operator step.

- [x] Point the Hermes base URL at `http://127.0.0.1:8180` (script; not auto-applied).
- [x] Set Hermes to use the proxy model surface rather than direct premium
      backend selection (`provider: custom` + proxy `base_url`).
- [x] Keep a rollback command ready to restore the direct premium backend
      (`cp ~/.hermes/config.yaml.bak.<timestamp> ~/.hermes/config.yaml`).
- [x] Document the exact launch command for orchestrated Hermes sessions
      (`python3 scripts/hermes_orchestrator.py serve`, then the client).
- [ ] Manual validation: send a normal interactive request and confirm it routes
      through the orchestrator, stays self-hosted by default, and that premium
      fallback only fires when self-hosted lanes are unavailable or unsuitable.

### 3. Conditional — only if item 1 says so

- [ ] `POST /v1/responses`, normalized into the same execution path. Only needed
      if Hermes cannot use `chat/completions`.
- [ ] True token-by-token streaming. Today `stream: true` gets a single-chunk SSE
      shim (`_send_stream_shim`), which is correct but not incremental. Only worth
      building if interactive UX actually feels bad — a judgment call from using it.

The example self-hosted topology is the `example-gpu-box` machine in
`inventory.example.json`.
