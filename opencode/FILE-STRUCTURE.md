---
name: File Structure & Navigation Guide
---

# xx-stack File Structure Guide

This file is a navigation map, not a full product overview.

## Start Here

- `README.md` for setup and high-level usage
- `REPO-LAYERS.md` for stack-core vs content-pack boundaries
- `opencode/config.json` for agent registry and policy
- `opencode/shared_instructions.md` for shared runtime behavior
- `opencode/SKILLS.md` for skill conventions and inventory

## Stack Core

`opencode/`
- canonical runtime agents and skills
- shared runtime docs and registry files

`vscode/`
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
- `packs/design/opencode/skills/design/`
- `packs/design/evals/golden-tasks/`
- `packs/design/scripts/`
- `packs/design/DESIGN-CATALOG.md`

## Compatibility Shims

These paths remain for downstream stability:

- `design-systems/`
- `design-skills/`
- `DESIGN-CATALOG.md`
- `opencode/skills/design/`
- `evals/golden-tasks/`
- `scripts/generate-design-catalog.mjs`
- `scripts/evaluate-golden-tasks.mjs`
- `scripts/quality-gate-html.mjs`

## Rule Of Thumb

- Runtime contracts belong in stack core.
- Domain payloads belong in `packs/design/`.
- If a path exists only for backward compatibility, document it as a shim rather than a source of truth.
