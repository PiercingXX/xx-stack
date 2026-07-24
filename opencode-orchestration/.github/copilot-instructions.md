# opencode-orchestration Copilot Instructions

This directory is the OpenCode integration layer for xx-stack: it installs,
registers, and syncs the stack into an OpenCode (and VS Code) environment.

## Directory Structure

- **Stack source** (`opencode/`): canonical agent definitions, skills, platform
  registry, and shared instructions installed into OpenCode
- **Editor mirrors** (`vscode/`): VS Code / Copilot prompt surfaces
- **Routing server** (`mcp-server/`): symlink to `../xx-stack/mcp-server` — the
  single canonical MCP server. Do not edit through the symlink expecting a
  separate copy; there is only one.
- **Scripts** (`scripts/`): symlink to `../xx-stack/scripts` — shared tooling
- **Content pack** (`packs/design/`): design systems, skills, and eval assets

## Key Files

- `opencode/config.json`: OpenCode agent + provider configuration
- `opencode/platforms.json`: live platform registry (hosts, tiers, routing)
- `opencode/shared_instructions.md`: shared runtime behavior and delegation rules
- `opencode/runtime-constants.json`: symlink to the canonical constants in
  `../xx-stack/runtime/`
- `REPO-LAYERS.md`: layer boundaries
- `MAINTAINER-RUNBOOK.md`: common runtime failures and recovery steps

## Routing Policy

Local first, Tailscale-reachable self-hosted second, cloud only when explicitly
opted in via `selectionPolicy.cloudEscalation.optIn` or `XX_STACK_ALLOW_CLOUD=1`.
Never introduce a code path that reaches a cloud provider without that gate.

## Setup Commands

```bash
# Full install into the active OpenCode environment
./setup.sh

# Install or link the stack into OpenCode only
./setup-opencode.sh

# Install or link the stack into VS Code / Copilot surfaces
./setup-vscode.sh

# Verify this component's layout
node scripts/verify-repo-layout.mjs
```

## Requirements

- Node.js 20+
- An OpenCode or MCP-compatible host
- At least one reachable model provider

## Notes

- `.opencode/` exists only as a compatibility shim for runtime discovery that
  still expects that path; `opencode/` is canonical
- `mcp-server/` and `scripts/` are symlinks into `../xx-stack/` — edit the files
  there, and expect changes to affect both components
- Respect `.xxignore` for repo-local context exclusions
