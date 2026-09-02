
# opencode-orchestration

**The OpenCode install layer for xx-stack.**

> One of three components in this repo. Start with the
> [root README](../README.md) if you haven't already — it covers the quickstart
> and how the components fit together.
>
> `mcp-server/`, `scripts/`, and `packs/` here are **symlinks into the git
> root**, not copies. Edit files at their real path (`mcp-server/`, `runtime/`,
> `scripts/`, `packs/`).

This component takes the host-agnostic stack at the git root
(`runtime/`, `mcp-server/`) and installs it into a working OpenCode
environment: agent modes you can Tab, skills the `skill` tool can load,
slash commands, MCP registration, and a live platform registry.

After setup, OpenCode's default agent is `build`. Tab to `plan`, `research`,
`fast-build`, or `execution-orchestrator`. Slash commands: `/review`, `/plan`,
`/debug`, `/ship`, `/explore`, `/route`, `/judge`.

The goal is to replace cloud AI usage with self-hosted inference — your
workstation as the primary control plane, Tailscale-reachable hosts as the
distributed execution tier, and cloud only when you explicitly opt in.

It is a routing, reliability, and install layer — not a general app framework
and not a marketplace-oriented package.

## What This Component Does

This component packages and installs `xx-stack` for use inside OpenCode.

It provides:

- agent definitions and skills under `opencode/`
- a routing MCP server under `mcp-server/` (symlink)
- setup scripts that install, sync, and register the stack
- a platform registry that decides where work should run
- supervisor and watchdog controls for long-running autonomous execution

The main agent is `execution-orchestrator`.
Its job is to keep work local when possible, expand to Tailscale-reachable self-hosted hosts when useful, and never touch cloud providers unless cloud escalation is explicitly opted in.

## Architecture At A Glance

The intended operating model is:

1. local workstation first
2. remote self-hosted hosts over Tailscale second (the example inventory ships one stand-in, `example-gpu-box`, a 2x RTX 4090 box with sglang and ollama lanes — both disabled until you point it at a real machine)
3. cloud never, unless explicitly opted in via `selectionPolicy.cloudEscalation.optIn` or `XX_STACK_ALLOW_CLOUD=1`

The shipped platform registry now uses Tailscale-first tier IDs such as `tailscale-openai-compatible` and `tailscale-ollama`.
Those names reflect the actual runtime surface more directly: local plus Tailscale-distributed self-hosted inference, with cloud optional and removable.

Current preferred self-hosted lane:

1. local llama.cpp or compatible OpenAI-style endpoint when available
2. Tailscale-reachable OpenAI-compatible hosts (`example-gpu-box` sglang on :30000 when you enable that machine)
3. Tailscale-reachable Ollama hosts as compatibility fallback
4. cloud only when explicitly opted in and a workflow truly needs it

## Canonical Repo Surfaces

These are the maintained source surfaces in this repo:

- `opencode/` — OpenCode-specialized copies of agents and skills. Canonical
  source is `../runtime/`; `npm run drift:check` is the gate.
- `mcp-server/` — symlink to `../mcp-server`
- `scripts/` — symlink to `../scripts`
- `setup.sh`
- `setup-opencode.sh`
- `README.md`
- `REPO-LAYERS.md`
- `MAINTAINER-RUNBOOK.md`

`.opencode/` exists only as a compatibility shim for runtime discovery that still expects that path.

For layer details and maintainer guidance, see [REPO-LAYERS.md](REPO-LAYERS.md).
For common runtime failures and recovery steps, see [MAINTAINER-RUNBOOK.md](MAINTAINER-RUNBOOK.md).

## What Happens After Setup

1. `./setup.sh` installs the stack into the active OpenCode environment.
2. The routing MCP server is registered in OpenCode config.
3. A live platform registry is created or updated for host and model decisions.
4. Agent routing starts using the local machine first and the Tailscale mesh second.

For the baked-in canonical stack surfaces themselves:

- `./setup-opencode.sh` installs or links the repo stack into OpenCode


## Requirements

- Linux shell
- `opencode` on `PATH`
- local `llama-server` or equivalent OpenAI-compatible llama.cpp endpoint reachable at `http://127.0.0.1:8080`
- optional `ollama` on `PATH` for compatibility lanes
- optional Tailscale connectivity to remote self-hosted endpoints

## Install Or Update

```bash
git clone https://github.com/piercingxx/xx-stack.git
cd xx-stack/opencode-orchestration
./setup.sh
```

## Operating Notes

- `setup.sh` defaults to the TurboQuant llama.cpp lane
- interactive setup can discover reachable remote hosts over Tailscale
- local hardware is probed so concurrency and registry defaults can be tuned to the current machine
- `XX_STACK_ALLOW_MULTI_MODEL=0` forces more conservative single-model behavior
- full skill inventory is documented in `opencode/SKILLS.md`
- cloud support is strictly opt-in (`selectionPolicy.cloudEscalation.optIn` in `opencode/platforms.json`, or `XX_STACK_ALLOW_CLOUD=1`); routing never falls back to cloud hosts without it, and this repo remains fully usable without any cloud provider

## Maintainer Priorities

The main work for this repo is not public packaging.
The main work is:

1. keep setup predictable
2. keep routing policy auditable
3. keep local and Tailscale host selection reliable
4. keep the MCP server composition root small
5. reduce compatibility drag when it no longer helps the private runtime

If the repo starts drifting toward public ecosystem concerns, that is usually the wrong priority unless it directly improves the private OpenCode workflow.

## Lifecycle Hooks And Execution Guardrails

The MCP server supports opt-in lifecycle hooks for task and supervisor transitions.

- hook events: `task.created`, `task.updated`, `supervisor.event_recorded`
- hooks are disabled by default
- each hook command must be explicitly allowlisted
- hook args are validated against a safe pattern to block shell injection attempts

Configure hooks in repo-local or user-local OpenCode config:

```json
{
  "lifecycleHooks": {
    "enabled": true,
    "allowedCommands": ["echo"],
    "events": {
      "task.updated": [
        {
          "command": "echo",
          "args": ["task-updated"],
          "timeoutMs": 1500,
          "allowFailure": true
        }
      ]
    }
  }
}
```

Internal hardware probes are also protected by an execution allowlist.

## Debugging Provider Prompt Passthrough

If a model appears to stall before tool calls, capture the exact outbound provider payload that `opencode run` sends.
This is especially useful when comparing llama.cpp behavior against the Ollama fallback lane.

```bash
cd mcp-server
npm run trace:provider -- \
  --agent parallel-execution-orchestrator \
  --prompt "Call check_health only. /no_think" \
  --timeout-sec 120
```

Artifacts are written under `/tmp/opencode-provider-trace-<timestamp>/`:

- `proxy-trace.ndjson`: full request and response trace at the local HTTP proxy
- `opencode-run.log`: `opencode run --print-logs` output
- `summary.json`: quick indicators, including whether `/no_think` appeared in outbound payloads
