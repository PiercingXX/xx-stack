---
name: File Structure & Navigation Guide
---

# xx-stack File Structure Guide

## Primary Entry Points

- README.md
- opencode/SKILLS.md
- opencode/config.json
- opencode/platforms.json
- setup.sh

## Active Runtime Layout

opencode/
- config.json
- platforms.json
- platforms.schema.json
- telemetry.json
- SKILLS.md
- FILE-STRUCTURE.md
- agents/ (8)
- skills/
  - <skill-name>/SKILL.md (canonical repo skill content)

Installed runtime:
- ~/.config/opencode/skills/xx-stack/
- ~/.config/opencode/skills/<skill-name>/SKILL.md (top-level shim discovery format)
- ~/.config/opencode/xx-stack-platforms.json

Compatibility workspace shim:
- .opencode/ -> opencode/

## Active Agents

- fast-build
- deep-thinker
- release-manager
- incident-commander
- execution-orchestrator
- performance-engineer
- rust-rewrite
- model-trainer

## Active Skill Categories

Core:
- ideate-product
- plan-feature
- plan-architecture
- review-code
- deploy-ship

Advanced:
- debug-investigate
- plan-design
- audit-security
- ops-deploy-land
- reflect-retrospective
- plan-autoreview
- ops-canary
- benchmark-performance
- rewrite-rust-oneshot
- train-model-knowledge-injection

Utility:
- write-docs
- setup-observability
- test-qa
- release-doc-sync
- safety-guardrails
- orchestrate-platform-routing

## Recommended Paths

Feature path:
execution-orchestrator -> plan-feature -> plan-architecture -> review-code -> test-qa -> benchmark-performance -> deploy-ship -> ops-canary

Incident path:
debug-investigate -> deploy-ship -> ops-canary -> reflect-retrospective

## Notes

Canonical SKILL.md folders live under `opencode/skills`, but installed OpenCode discovery outside the repo depends on top-level shims under `~/.config/opencode/skills/<skill-name>/SKILL.md`.
Platform inventory for orchestration ships from `opencode/platforms.json` and runs live from `~/.config/opencode/xx-stack-platforms.json`.
Controller-grade orchestration helpers are absorbed into `execution-orchestrator` instead of exposed as standalone user skills.

Agent and skill prompts now follow a shared contract style:
- explicit activation conditions
- evidence-first execution loops
- deterministic verification states (`PASS`, `FAIL`, `AMBIGUOUS`)
- explicit degradation when repo/runtime surfaces are missing
