# xx-stack Copilot Instructions

This repository contains xx-stack, a production-oriented agent stack for AI-assisted software development.

## Repository Structure

- **Stack Core** (`runtime/`, `mcp-server/`, `scripts/`, `adapters/`): Reusable agent contracts, skills, routing policy, and MCP infrastructure
- **Content Packs** (`packs/design/`): Domain-specific content consumed by agents and skills

## Key Files

- `runtime/config.json`: Agent registry defaults
- `runtime/shared_instructions.md`: Shared runtime behavior and delegation rules
- `runtime/SKILLS.md`: Canonical skill inventory
- `runtime/FILE-STRUCTURE.md`: Navigation map
- `REPO-LAYERS.md`: Stack-core vs content-pack boundary

## Primary Agents

- `execution-orchestrator`: Accountable orchestration and completion gates
- `build`: Implementation agent
- `fast-build`: Narrow speed lane for small changes
- `plan`: Planning-only lane
- `deep-thinker`: Architecture, risk, and deep reasoning
- `release-manager`: Release and deployment gating
- `incident-commander`: Incident handling
- `design-engineer`: Design workflow specialist

## Setup Commands

```bash
# Wire a workspace to xx-stack (MCP config, agents, design pack links)
./setup-vscode.sh <target-project>

# Install agents and prompts globally for all VS Code workspaces
./setup-vscode.sh --global

# Verify repo layout
node scripts/verify-repo-layout.mjs

# Sync VS Code agent mirrors
node scripts/sync-vscode-agents.mjs

# Regenerate design catalog
npm --prefix mcp-server run design-pack:catalog
```

Global prompt install alone is not enough: `--global` does not configure MCP
or link the design pack. Run `./setup-vscode.sh <target-project>` in workspace
mode to wire `.vscode/mcp.json` and the design pack symlinks.

## Git Hooks

Pre-commit hook prevents VS Code agent mirrors from drifting. Activate with:

```bash
git config core.hooksPath .githooks
```

## Requirements

- Node.js 20+
- MCP-compatible host
- At least one reachable model provider

## Notes

- Canonical agent contracts live in `runtime/agents/*.md`; `adapters/agents/` are auto-generated from them - edit runtime files, not adapter files
- The repo is host-agnostic - use setup scripts only when integrating with specific editors
- Generated files should stay out of git
