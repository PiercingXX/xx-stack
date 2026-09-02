---
name: File Structure & Navigation Guide
---

# OpenCode Orchestration File Structure Guide

This file is a navigation map, not a full product overview. It deliberately
carries no inventory counts — the counts drift the moment an agent or skill is
added, and `opencode/SKILLS.md` plus the directories themselves are the
authority. To see what exists, list the directory.

## Start Here

- `README.md` for install and high-level usage
- `REPO-LAYERS.md` for stack-core vs content-pack boundaries
- `opencode/config.json` for the agent registry, `default_agent`, MCP, and policy
- `opencode/command/` for slash commands
- `opencode/shared_instructions.md` for shared runtime behavior
- `opencode/SKILLS.md` for skill conventions and the skill inventory
- `opencode/platforms.json` for the shipped platform registry
- `MAINTAINER-RUNBOOK.md` for install and release operations

## Stack Core

`opencode/`
- OpenCode-specialized agents and skills
- shared runtime docs and registry files (`config.json`, `platforms.json`,
  `platforms.schema.json`, `telemetry.json`)

`opencode/agents/`
- one `.md` per agent; `<name>.nano.md` beside an agent is its tight-context
  variant, byte-identical to the xx-stack canonical nano

`opencode/skills/`
- one `<skill-name>/SKILL.md` per skill; `SKILL.nano.md` beside a skill is its
  tight-context variant

`opencode/command/`
- OpenCode slash commands (`/review`, `/plan`, `/debug`, `/ship`, `/explore`, `/route`, `/judge`)

`scripts/run-agent-loop.mjs`
- generic outer-loop runner for unattended todo or plan execution

`scripts/run-opencode-loop.mjs`
- OpenCode-specific unattended wrapper with built-in preflight wiring

`scripts/opencode-stdin-runner.mjs`
- bridge that turns stdin prompts into a single `opencode run [message]` invocation

`mcp-server/`
- symlink to `mcp-server`: TypeScript MCP server source, tests, and
  package scripts. One copy shared with the core component.

`hooks/`
- optional local hook scaffolding

`setup.sh`
- top-level installer for this component

`setup-opencode.sh`
- OpenCode host adapter setup

## Installed Runtime

Discovery outside the repo reads from the OpenCode config directory, not from
the repo tree:

- `~/.config/opencode/skills/<skill-name>/SKILL.md` (top-level shim discovery format)
- `~/.config/opencode/skills/xx-stack/` (installed canonical copy)
- `~/.config/opencode/xx-stack-platforms.json` (live platform registry)

`opencode/platforms.json` ships the defaults; the installed file is what actually
runs.

## Content Packs

`packs/` is a symlink to `packs` — one copy shared with the core
component.

Design pack:

- `packs/design/design-systems/`
- `packs/design/design-skills/`
- `packs/design/workflow-skills/`
- `packs/design/evals/golden-tasks/`
- `packs/design/scripts/`
- `packs/design/DESIGN-CATALOG.md`

Rules pack:

- `packs/rules/`

## Compatibility Shims

These paths remain for downstream stability:

- `design-systems/`
- `design-skills/`
- `DESIGN-CATALOG.md`
- `opencode/skills/design/`
- `evals/golden-tasks/`

## Rule Of Thumb

- Runtime contracts belong in stack core.
- Domain payloads belong in `packs/`.
- If a path exists only for backward compatibility, document it as a shim rather
  than a source of truth.
- Agent and skill prompts follow a shared contract style: explicit activation
  conditions, evidence-first execution loops, deterministic verification states
  (`PASS`, `FAIL`, `AMBIGUOUS`), and explicit degradation when repo or runtime
  surfaces are missing.
