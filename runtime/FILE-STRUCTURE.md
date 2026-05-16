---
name: File Structure & Navigation Guide
---

# xx-stack File Structure Guide

This file is a navigation map, not a full product overview.

## Start Here

- `README.md` for setup and high-level usage
- `REPO-LAYERS.md` for stack-core vs content-pack boundaries
- `runtime/config.json` for agent registry and policy
- `runtime/shared_instructions.md` for shared runtime behavior
- `runtime/SKILLS.md` for skill conventions and inventory
- `runtime/AUTONOMOUS_TODO_LOOP.md` for unattended todo execution guidance

## Stack Core

`runtime/`
- canonical runtime agents and skills
- shared runtime docs and registry files

`scripts/run-agent-loop.mjs`
- generic outer-loop runner for unattended todo or plan execution

`scripts/run-opencode-loop.mjs`
- OpenCode-specific unattended wrapper with built-in preflight wiring

`scripts/opencode-stdin-runner.mjs`
- bridge that turns stdin prompts into a single `opencode run [message]` invocation

`adapters/`
- adapter-specific agent and prompt mirrors

`mcp-server/`
- TypeScript MCP server source, tests, and package scripts

`hooks/`
- optional local hook scaffolding

`setup-opencode.sh`
- optional host adapter setup script

`setup-vscode.sh`
- optional editor adapter setup and MCP wiring

## Design Content Pack

Canonical design-pack paths:

- `packs/design/design-systems/`
- `packs/design/design-skills/`
- `packs/design/runtime/skills/design/`
- `packs/design/evals/golden-tasks/`
- `packs/design/scripts/`
- `packs/design/DESIGN-CATALOG.md`

## Compatibility Shims

These paths remain for downstream stability:

- `design-systems/`
- `design-skills/`
- `DESIGN-CATALOG.md`
- `runtime/skills/design/`
- `evals/golden-tasks/`
- `scripts/generate-design-catalog.mjs`
- `scripts/evaluate-golden-tasks.mjs`
- `scripts/quality-gate-html.mjs`

## Rule Of Thumb

- Runtime contracts belong in stack core.
- Domain payloads belong in `packs/design/`.
- If a path exists only for backward compatibility, document it as a shim rather than a source of truth.
