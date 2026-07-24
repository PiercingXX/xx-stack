---
name: Skills Reference
---

# OpenCode Skills Reference

Complete skill inventory for xx-stack.

## Skill Contract Standard

The current skill layer follows a shared contract:

- activation contract: when to use the skill and when not to
- evidence-first execution: inspect repo/runtime state before synthesizing
- deterministic verification: prefer shell, file, config, and artifact checks over model opinion
- explicit degradation: if the repo lacks tests, deploy, or runtime surfaces, say so instead of inventing them

Skills should not assume `bun`, `npm`, `gh`, CI, or production endpoints unless the observed repo surface proves they exist.

## Graceful Degradation

Not every workflow is equally critical.

Critical workflow surface:
- `execution-orchestrator`
- `fast-build`
- `review-code`
- `debug-investigate`
- `deploy-ship`

Graceful/optional workflow surface:
- `benchmark-performance`
- `ops-canary`
- `setup-observability`
- `release-doc-sync`
- `reflect-retrospective`

If an optional workflow lacks the required runtime surface, it should degrade to planning, readiness notes, or partial verification instead of inventing success.

## Routing Hints

Additional routing pattern:

- use direct activation conditions before broad synthesis
- prefer deterministic inspection before reasoning-heavy delegation
- escalate to model-heavy synthesis only when direct evidence is insufficient

## Core Workflows (5)

1. ideate-product
- Purpose: Product validation through forcing questions
- Model: sglang-remote/qwen3-coder-next

2. plan-feature
- Purpose: Scope feature into testable spec
- Model: sglang-remote/qwen3-coder-next

3. plan-architecture
- Purpose: Architecture decisions, risks, verification plan
- Model: sglang-remote/qwen3-coder-next

4. review-code
- Purpose: Production-grade pre-merge review
- Model: sglang-remote/qwen3-coder-next

5. deploy-ship
- Purpose: Release gates and deployment verification
- Model: sglang-remote/qwen3-coder-next

## Advanced Workflows (10)

6. debug-investigate
- Root-cause debugging workflow

7. plan-design
- Design system and UX review

8. audit-security
- OWASP/STRIDE security audit

9. ops-deploy-land
- Post-deploy operations and rollback

10. reflect-retrospective
- Post-project retrospective

11. plan-autoreview
- Automated product/design/engineering planning gauntlet

12. ops-canary
- Post-deploy canary monitoring

13. benchmark-performance
- Performance regression benchmarking

14. rewrite-rust-oneshot
- Autonomous one-shot full-application rewrite to Rust with compile/test auto-repair loops

15. train-model-knowledge-injection
- End-to-end model training and knowledge injection from GitHub/PDF/Markdown/software stacks

## Utility Workflows (6)

16. write-docs
- README/API/deployment doc generation

17. setup-observability
- Metrics, logs, alerts, traces

18. test-qa
- Journey QA with regression checks

19. release-doc-sync
- Post-release documentation synchronization

20. safety-guardrails
- Destructive-command and edit-scope safety mode

21. orchestrate-platform-routing
- Delegation planning across local, remote, and cloud model tiers

## Recommended Feature Path

execution-orchestrator -> plan-feature -> plan-architecture -> implement -> review-code -> test-qa -> benchmark-performance -> deploy-ship -> ops-deploy-land -> ops-canary

## Recommended Incident Path

debug-investigate -> review-code -> deploy-ship -> ops-canary -> reflect-retrospective

## Directory Layout

opencode/skills/
- <skill-name>/SKILL.md (canonical repo skill content)

Installed runtime discovery:
- ~/.config/opencode/skills/<skill-name>/SKILL.md (top-level shim created by setup.sh)
- ~/.config/opencode/skills/xx-stack/.opencode/skills/<skill-name>/SKILL.md (installed canonical copy)

Migration status:
- Native discovery conversion complete for all skills.
- Duplicate and internal orchestration helper skills have been absorbed into `execution-orchestrator` and removed from the user-facing surface.

Telemetry:
- Optional and disabled by default via `opencode/telemetry.json`.
- Recommended only for ops/eval workflows where trend data is actionable.
- Extended to selected orchestration workflows when run metrics improve planning or delivery automation.

## Agent Pairing

- build: local fast execution
- fast-build: local fast lane for small obvious tasks
- plan: local-first direct planning lane
- architect: remote-preferred specialist planning lane for delegated subagent work
- execution-orchestrator: default local controller for routing, staged execution, and verification
- performance-engineer: remote perf analysis
- release-manager: release gates and stabilization
- incident-commander: incident triage and recovery

## Delegation Source Of Truth

Use `~/.config/opencode/xx-stack-platforms.json` as the live registry for:

- local Ollama hosts and model inventory
- remote Ollama hosts, IP addresses, and hardware limits
- cloud providers and escalation policy

Use `opencode/platforms.json` for shipped defaults in the repo.
The agent definitions in `opencode/config.json` are defaults, but installed orchestration should follow the synced runtime registry when deciding where work should run.

## Verification States

Across agents and skills, completion language should map to one of:

- `PASS`: deterministic evidence supports the claim
- `FAIL`: deterministic evidence disproves the claim
- `AMBIGUOUS`: evidence exists but a stronger validation surface is unavailable

