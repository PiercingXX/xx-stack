---
name: Skills Reference
---

# Runtime Skills Reference

Complete skill inventory for xx-stack.

## Skill Contract Standard

The current skill layer follows a shared contract:

- activation contract: when to use the skill and when not to
- evidence-first execution: inspect repo/runtime state before synthesizing
- deterministic verification: prefer shell, file, config, and artifact checks over model opinion
- explicit degradation: if the repo lacks tests, deploy, or runtime surfaces, say so instead of inventing them

Skills should not assume `bun`, `npm`, `gh`, CI, or production endpoints unless the observed repo surface proves they exist.

Canonical source of truth:

- repo `SKILL.md` files define behavior
- slash-command mirrors and host adapters provide activation surfaces only
- if a mirror conflicts with `SKILL.md`, the canonical repo skill wins and the mismatch should be reported as drift

## Discovery And Shadowing

Skill precedence for xx-stack is:

1. active runtime override configured by the host
2. repo `runtime/skills/<name>/SKILL.md`
3. repo `adapters/skills/<name>.prompt.md`
4. external or bundled host-level skill sources

Shadowing rules:

- same-name skills do not merge across sources
- highest-precedence source wins
- if the canonical repo skill is missing but a mirror remains, treat it as broken wiring
- diagnostics should report shadowed or missing canonical skills explicitly

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
- Model: self-hosted-api/coder-deep

2. plan-feature
- Purpose: Scope feature into testable spec
- Model: self-hosted-api/coder-main

3. plan-architecture
- Purpose: Architecture decisions, risks, verification plan
- Model: self-hosted-api/coder-deep

4. review-code
- Purpose: Production-grade pre-merge review
- Model: self-hosted-api/coder-main

5. deploy-ship
- Purpose: Release gates and deployment verification
- Model: self-hosted-api/coder-main

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
- End-to-end model training and knowledge injection from repository/PDF/Markdown/software stacks

## Utility Workflows (7)

16. diagnose-stack
- Stack health check: verifies MCP server, agent definitions, skill structure, environment variables, and config wiring

17. write-docs
- README/API/deployment doc generation

18. setup-observability
- Metrics, logs, alerts, traces

19. test-qa
- Journey QA with regression checks

20. release-doc-sync
- Post-release documentation synchronization

21. safety-guardrails
- Destructive-command and edit-scope safety mode

22. orchestrate-platform-routing
- Delegation planning across local, remote, and cloud model tiers

## Recommended Feature Path

execution-orchestrator -> plan-feature -> plan-architecture -> implement -> review-code -> test-qa -> benchmark-performance -> deploy-ship -> ops-deploy-land -> ops-canary

## Recommended Incident Path

debug-investigate -> review-code -> deploy-ship -> ops-canary -> reflect-retrospective

## Directory Layout

.xx-stack/skills/
- <skill-name>/SKILL.md (canonical repo skill content)

Installed runtime discovery:
- ~/.config/xx-stack/skills/<skill-name>/SKILL.md (top-level shim created by setup.sh)
- ~/.config/xx-stack/skills/xx-stack/.xx-stack/skills/<skill-name>/SKILL.md (installed canonical copy)

Migration status:
- Native discovery conversion complete for all skills.
- Duplicate and internal orchestration helper skills have been absorbed into `execution-orchestrator` and removed from the user-facing surface.

Telemetry:
- Optional and disabled by default via `.xx-stack/telemetry.json`.
- Recommended only for ops/eval workflows where trend data is actionable.
- Extended to selected orchestration workflows when run metrics improve planning or delivery automation.

## Agent Pairing

- build: primary execution lane
- fast-build: fast implementation lane on the primary alias or local fallback when needed
- plan: primary-first direct planning lane
- architect: reasoning specialist planning lane for delegated subagent work
- execution-orchestrator: primary-first controller with local fallback when primary hosts are unavailable
- performance-engineer: remote performance analysis
- release-manager: release gates and stabilization
- incident-commander: incident triage and recovery

## Delegation Source Of Truth

Use `~/.config/xx-stack/xx-stack-platforms.json` as the live registry for:

- self-hosted hosts, model aliases, and hardware limits
- local fallback hosts and model inventory
- overflow fallback hosts and hardware limits
- cloud providers and escalation policy

Use `.xx-stack/platforms.json` for shipped defaults in the repo.
The agent definitions in `.xx-stack/config.json` are defaults, but installed orchestration should follow the synced runtime registry when deciding where work should run.

## Verification States

Across agents and skills, completion language should map to one of:

- `PASS`: deterministic evidence supports the claim
- `FAIL`: deterministic evidence disproves the claim
- `AMBIGUOUS`: evidence exists but a stronger validation surface is unavailable

