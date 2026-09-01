# Hermes Orchestration TODO

The loopback proxy itself is done (`serve`, systemd unit, auth, routing
telemetry). Remaining work is pointing the Hermes *client* at that proxy.

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

The example self-hosted topology is the `example-gpu-box` machine in
`inventory.example.json`.
