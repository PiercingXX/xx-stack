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

## Notes

- `.xxignore` is the repo-specific context boundary. `.gitignore` backs it up for general tooling.
- `hooks/` is optional scaffolding, not an assumed runtime.
- Generated or vendored artifacts are not source-of-truth and should stay out of git.
