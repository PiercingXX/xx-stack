# xx-stack

xx-stack is a production-oriented agent stack for AI-assisted software development.

It includes:

- reusable agent contracts, skills, and routing policy
- a TypeScript MCP server for supervision, routing, and health checks
- a design content pack with workflow assets, evaluation fixtures, and generators

The repository is structured so it can be adapted to different editors, hosts, and model providers without carrying machine-specific assumptions in source control.

## Repository Shape

The repository is split into two layers:

- stack core: runtime contracts, adapters, routing server, setup scripts, hooks, and shared docs
- content pack: design systems, design skills, templates, and design-specific eval assets

Compatibility shims are retained where stability matters:

- `design-systems/` -> `packs/design/design-systems/`
- `design-skills/` -> `packs/design/design-skills/`
- `DESIGN-CATALOG.md` -> `packs/design/DESIGN-CATALOG.md`
- `runtime/skills/design/` -> `packs/design/runtime/skills/design/`
- `evals/golden-tasks/` -> `packs/design/evals/golden-tasks/`

For the boundary contract, see `REPO-LAYERS.md`.

## Source Of Truth

- `runtime/config.json`: shipped agent registry defaults
- `runtime/shared_instructions.md`: shared runtime behavior and delegation rules
- `runtime/SKILLS.md`: canonical skill inventory and contract rules
- `runtime/FILE-STRUCTURE.md`: navigation map
- `REPO-LAYERS.md`: stack-core vs content-pack boundary

## Primary Agents

- `execution-orchestrator`: accountable orchestration and completion gates
- `build`: implementation agent
- `fast-build`: narrow speed lane for small changes
- `plan`: planning-only lane
- `deep-thinker`: architecture, risk, and deep reasoning
- `release-manager`: release and deployment gating
- `incident-commander`: incident handling
- `design-engineer`: design workflow specialist

## Requirements

- Node.js 20+
- an MCP-compatible host that can load the routing server
- at least one reachable model provider or agent runtime configured for your environment

The shipped registry and model recommendations are examples. Replace endpoints, providers, and aliases with values that fit your environment before production use.

## Setup

The repository keeps both integration helper scripts requested for downstream use:

- `./setup-opencode.sh`
- `./setup-vscode.sh`

They remain optional adapters. The repo itself should be treated as host-agnostic source material rather than tied to a single editor or local model runtime.

For VS Code specifically, this repo now ships the workspace surfaces directly:

- `.vscode/mcp.json` wires the local `xx-stack-platform-routing` MCP server for this workspace
- `.github/copilot-instructions.md` gives Copilot the canonical runtime guidance for this repo

For downstream repositories, run `./setup-vscode.sh <target-project>` from this repo to install the same MCP wiring, VS Code prompt mirrors, and Copilot instructions into that workspace.

The VS Code agent mirrors under `adapters/agents/` are generated from `runtime/agents/` by `scripts/sync-vscode-agents.mjs`. Treat the runtime files as the canonical source and regenerate the mirrors instead of hand-editing them.

By default, xx-stack should execute on whatever host model or lane invoked it. Routing and platform inventory are override mechanisms for capability gaps, reliability problems, or explicit delegation, not the default execution path.

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

Verify VS Code agent mirrors are in sync with canonical runtime agents:

```bash
node scripts/sync-vscode-agents.mjs --check
```

Regenerate VS Code agent mirrors from canonical runtime agents:

```bash
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

## Autonomous Todo Loop

For unattended whole-plan execution, use the outer-loop runner instead of relying on the orchestrator prompt alone:

```bash
node scripts/run-agent-loop.mjs \
	--runner 'your-agent-command-that-reads-stdin' \
	--runner-timeout-ms 900000 \
	--todo TODO.md \
	--goal 'Finish the entire todo plan without stopping for intermediate updates.'
```

This creates disk-backed loop state under `.xx-stack/loops/` and keeps retrying until the todo is complete, blocked, stalled, or reaches the iteration limit. See `runtime/AUTONOMOUS_TODO_LOOP.md` for details.

For OpenCode, use the dedicated safe wrapper instead of hand-assembling the runner and preflight commands:

```bash
node scripts/run-opencode-loop.mjs \
	--todo TODO.md
```

Optional model override:

```bash
node scripts/run-opencode-loop.mjs \
	--todo TODO.md \
	--model ollama-local/qwen2.5-coder:14b
```

This wrapper automatically:

- feeds loop prompts to OpenCode through a stdin bridge
- builds a job-scoped minimal OpenCode HOME under the loop state instead of loading the full live host config
- proves both basic liveness and one real tool round-trip before iteration 1
- fails fast with `runner-unhealthy` state if OpenCode is hanging or if headless transport cannot complete a tool loop

Use `--use-live-home` only when you are explicitly debugging the installed host runtime and want to bypass the isolated wrapper path.

At the moment, treat headless OpenCode as unsupported for unattended todo execution unless this preflight passes in your environment. In the current OpenCode dev build we validated here, both `opencode run` and a clean `opencode serve` session API can stage messages but still fail to execute a complete response/tool loop reliably.

If you need the raw lower-level form for a non-OpenCode runner, add a preflight so the loop fails fast instead of burning iterations on a broken runtime:

```bash
node scripts/run-agent-loop.mjs \
	--runner 'your-runner-that-reads-stdin' \
	--runner-preflight 'your-fast-health-check-command' \
	--preflight-input 'health check input' \
	--preflight-success 'expected marker' \
	--preflight-timeout-ms 45000 \
	--todo TODO.md
```

For OpenCode-style headless runs, use `scripts/run-opencode-loop.mjs` instead of assembling the lower-level command yourself.

## Customizing

To add an agent:

1. Create `runtime/agents/<name>.md`.
2. Register it in `runtime/config.json`.
3. Add any host-specific adapter only if you actually need it.

## Host Model Inheritance

- Canonical agent contracts should not hardcode a provider or model unless a host truly requires one.
- VS Code adapter prompts should inherit the current chat model.
- OpenCode installs should clear legacy repo-managed per-agent model pins so host-native inheritance actually takes effect.
- Use routing or explicit model overrides only when the active caller model cannot satisfy the task.

## VS Code Status

- Preferred host for interactive xx-stack use: VS Code + Copilot Chat
- Required workspace surfaces: `.vscode/mcp.json` and `.github/copilot-instructions.md`
- Downstream install path: `./setup-vscode.sh <target-project>`
- Headless OpenCode remains fail-fast only unless `scripts/run-opencode-loop.mjs` preflight passes

To add a skill:

1. Create `runtime/skills/<name>/SKILL.md`.
2. Register it in `runtime/SKILLS.md`.
3. Add adapter surfaces only when required by a downstream host.

To add content-pack material:

1. Put payload files under `packs/design/`.
2. Keep runtime contracts in stack core.
3. Use compatibility shims only when an older path must remain stable.

## Notes

- `.xxignore` is the repo-specific context boundary. `.gitignore` backs it up for general tooling.
- `hooks/` is optional scaffolding, not an assumed runtime.
- Generated or vendored artifacts are not source-of-truth and should stay out of git.
