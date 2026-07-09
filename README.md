# XX-Stack

XX-Stack is a self-hosted-first AI orchestration stack. It is the single
consolidated home for what used to be three repos (`XX-Stack`,
`opencode-orchestration`, and `hermes-orchestration`) — see
[Consolidation Notes](#consolidation-notes).

It has two cooperating halves:

- **Agent stack (TypeScript, repo root)** — reusable agent contracts, skills,
  routing policy, a TypeScript MCP server for supervision/routing/health
  checks, editor adapters (VS Code, OpenCode), and a design content pack.
- **Hermes control plane (Python, `hermes/`)** — a runnable local-first
  inference control plane: lane routing over Tailscale, parallel subagents, an
  OpenAI-compatible loopback proxy, lane benchmarking, and capability probing.
  Fully self-contained; see [hermes/README.md](hermes/README.md).

## Topology

All self-hosted inference runs on the AI rig `skippy-debian-5090` (Debian,
4x RTX 5090), reached over Tailscale (MagicDNS). Cloud is strictly opt-in.
There are currently no local inference lanes on the workstation.

| Lane | Endpoint | Runtime | Status |
|------|----------|---------|--------|
| Skippy sglang | `http://skippy-debian-5090:30000/v1` | sglang (`qwen3-coder-next`, 262k ctx) | **Live** — primary + reasoning lane; batches parallel subagents |
| Skippy Ollama | `http://skippy-debian-5090:11434` | ollama (model unverified, assumed `qwen3-coder:30b`) | **Disabled** — not exposed on the tailnet yet; see hermes/README.md to enable |
| Cloud | — | hermes CLI (`gpt-5.3-codex`, fallback `gpt-5.4`) | Last resort, strictly opt-in |

The shipped registry lives in `runtime/platforms.json` (agent stack) and
`hermes/config/orchestration.json` (control plane). Cloud lanes are never
selected while `selectionPolicy.cloudEscalation.optIn` is false and
`XX_STACK_ALLOW_CLOUD` is unset.

## Repository Shape

- stack core: `runtime/` contracts, `adapters/` (VS Code mirrors),
  `mcp-server/`, `scripts/`, `hooks/`, setup scripts, shared docs
- content pack: `packs/design/` — design systems, design skills, templates,
  and design eval assets (see `DESIGN-CATALOG.md`)
- control plane: `hermes/` — Python orchestrator, routing/proxy/bench,
  systemd units, policy docs, unit tests

Compatibility shims are retained where stability matters:

- `design-systems/` -> `packs/design/design-systems/`
- `design-skills/` -> `packs/design/design-skills/`
- `DESIGN-CATALOG.md` -> `packs/design/DESIGN-CATALOG.md`
- `runtime/skills/design/` -> `packs/design/runtime/skills/design/`
- `evals/golden-tasks/` -> `packs/design/evals/golden-tasks/`

For the boundary contract, see `REPO-LAYERS.md`.
For operating the runtime when it is unhealthy, see `MAINTAINER-RUNBOOK.md`.

## Source Of Truth

- `runtime/config.json`: shipped agent registry defaults
- `runtime/platforms.json`: shipped platform/lane registry
- `runtime/shared_instructions.md`: shared runtime behavior and delegation rules
- `runtime/SKILLS.md`: canonical skill inventory and contract rules
- `runtime/FILE-STRUCTURE.md`: navigation map
- `REPO-LAYERS.md`: stack-core vs content-pack boundary
- `hermes/config/orchestration.json`: control-plane lane and policy config

## Primary Agents

- `execution-orchestrator`: accountable orchestration and completion gates
- `parallel-execution-orchestrator`: parallel delegation across healthy remote lanes
- `build`: implementation agent
- `fast-build`: narrow speed lane for small changes
- `plan`: planning-only lane
- `deep-thinker`: architecture, risk, and deep reasoning
- `release-manager`: release and deployment gating
- `incident-commander`: incident handling
- `design-engineer`: design workflow specialist

## Requirements

- Node.js 20+ (agent stack, MCP server)
- Python 3 (hermes control plane; stdlib only)
- an MCP-compatible host that can load the routing server
- Tailscale connectivity to `skippy-debian-5090` for the remote lanes

## Setup

Editor integration helpers:

- `./setup-opencode.sh` — install or link the stack into OpenCode
- `./setup-vscode.sh <target-project>` — install MCP wiring, VS Code prompt
  mirrors, and Copilot instructions into a downstream workspace

For VS Code specifically, this repo ships the workspace surfaces directly:

- `.vscode/mcp.json` wires the local `xx-stack-platform-routing` MCP server
- `.github/copilot-instructions.md` gives Copilot the canonical runtime guidance

The VS Code agent mirrors under `adapters/agents/` are generated from
`runtime/agents/` by `scripts/sync-vscode-agents.mjs`. Treat the runtime files
as the canonical source and regenerate the mirrors instead of hand-editing them.

By default, xx-stack should execute on whatever host model or lane invoked it.
Routing and platform inventory are override mechanisms for capability gaps,
reliability problems, or explicit delegation, not the default execution path.

For the hermes control plane (health checks, routing preview, proxy `serve`
mode, benchmarking, systemd units), follow the quick start in
[hermes/README.md](hermes/README.md).

## Git Hooks

A pre-commit hook prevents VS Code agent mirrors from drifting out of sync:

```bash
git config core.hooksPath .githooks
```

This runs `scripts/sync-vscode-agents.mjs --check` before each commit.

## Common Commands

Run these from repo root unless noted otherwise.

Verify the MCP server:

```bash
npm --prefix mcp-server test
```

Verify repo layout and compatibility shims:

```bash
node scripts/verify-repo-layout.mjs
```

Verify or regenerate VS Code agent mirrors:

```bash
node scripts/sync-vscode-agents.mjs --check
node scripts/sync-vscode-agents.mjs
```

Regenerate the design catalog:

```bash
npm --prefix mcp-server run design-pack:catalog
```

Run golden-task checks:

```bash
npm --prefix mcp-server run design-pack:golden
```

Run the HTML quality gate:

```bash
npm --prefix mcp-server run design-pack:html-gate -- --skill web-prototype path/to/artifact.html
```

Hermes control plane:

```bash
(cd hermes && python3 -m unittest discover -s tests)
python3 hermes/scripts/hermes_orchestrator.py health
python3 hermes/scripts/hermes_orchestrator.py route --reason-code PRECHECK
```

## Autonomous Todo Loop

For unattended whole-plan execution, use the outer-loop runner instead of
relying on the orchestrator prompt alone:

```bash
node scripts/run-agent-loop.mjs \
	--runner 'your-agent-command-that-reads-stdin' \
	--runner-timeout-ms 900000 \
	--todo TODO.md \
	--goal 'Finish the entire todo plan without stopping for intermediate updates.'
```

This creates disk-backed loop state under `.xx-stack/loops/` and keeps retrying
until the todo is complete, blocked, stalled, or reaches the iteration limit.
See `runtime/AUTONOMOUS_TODO_LOOP.md` for details.

For OpenCode, use the dedicated safe wrapper:

```bash
node scripts/run-opencode-loop.mjs --todo TODO.md
```

Optional model override:

```bash
node scripts/run-opencode-loop.mjs --todo TODO.md --model sglang-remote/qwen3-coder-next
```

The wrapper feeds loop prompts to OpenCode through a stdin bridge, builds a
job-scoped minimal OpenCode HOME under the loop state, proves liveness and one
real tool round-trip before iteration 1, and fails fast with
`runner-unhealthy` state if OpenCode is hanging.

At the moment, treat headless OpenCode as unsupported for unattended todo
execution unless this preflight passes in your environment.

## Customizing

To add an agent:

1. Create `runtime/agents/<name>.md`.
2. Register it in `runtime/config.json`.
3. Add any host-specific adapter only if you actually need it.

To add a skill:

1. Create `runtime/skills/<name>/SKILL.md`.
2. Register it in `runtime/SKILLS.md`.
3. Add adapter surfaces only when required by a downstream host.

To add content-pack material:

1. Put payload files under `packs/design/`.
2. Keep runtime contracts in stack core.
3. Use compatibility shims only when an older path must remain stable.

## Host Model Inheritance

- Canonical agent contracts do not hardcode a provider or model unless a host truly requires one.
- VS Code adapter prompts inherit the current chat model.
- OpenCode installs should clear legacy repo-managed per-agent model pins so host-native inheritance actually takes effect.
- Use routing or explicit model overrides only when the active caller model cannot satisfy the task.

## Consolidation Notes

This repo absorbed and replaces two other repos (2026-07-09):

**From `opencode-orchestration`** (deleted upstream):

- the real platform topology (Skippy sglang/ollama over Tailscale, strict
  cloud opt-in) baked into `runtime/platforms.json`, then trimmed to what the
  rig actually serves (verified against the live endpoints on 2026-07-09)
- the `parallel-execution-orchestrator` agent
- four design systems (`github`, `nvidia`, `ollama`, `opencode-ai`)
- `MAINTAINER-RUNBOOK.md` (paths adapted to this repo's layout)

Intentionally not ported: the modularized `mcp-server/src` split (this repo's
tested single-module server has the same 34-tool surface), the opt-in
lifecycle-hooks subsystem, the `trace-provider-proxy`/`parallel-preflight`
debug utilities, and the interactive `setup.sh` hardware/Tailscale discovery
(superseded by the shipped registry plus `setup-opencode.sh`/`setup-vscode.sh`).
Recover them from the old repo's history if ever needed.

**From `hermes-orchestration`** (deleted upstream, was never pushed):

- the entire repo, moved unmodified to `hermes/` (systemd unit paths updated),
  including its README, policy docs, `TODO.md`, config, scripts, and 25 unit tests

## Notes

- `.xxignore` is the repo-specific context boundary. `.gitignore` backs it up for general tooling.
- `hooks/` is optional scaffolding, not an assumed runtime.
- Generated or vendored artifacts are not source-of-truth and should stay out of git.
