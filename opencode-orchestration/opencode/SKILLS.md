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

## Skill Authoring Contract

When writing or editing a skill:

- the `description` is a routing contract: what the skill does, when to use it, and what differentiates it from its neighbors — never a workflow summary (an agent that reads a step summary in the description skips loading the body)
- progressive disclosure: inline what every branch of the skill needs; link the rest
- references go one level deep, never chained — a linked document must not require following a further link to be usable
- positive steering over negation: say what to do, not only what to avoid
- delete no-op lines: if removing a line would not change the agent's behavior, remove it
- every step states checkable completion criteria — what done looks like, in a form that can be verified
- match instruction strictness to task fragility: loose heuristics for robust tasks, templates for structured output, exact scripts for fragile sequences
- test every skill against the weakest model it will run on — for this stack that rule is load-bearing (tight-context local lanes are the audience), and it is the acceptance test for any nano-tier skill variant

## Guidance Tiers (full / nano)

Critical-surface guidance ships in two sizes, matching the rules pack's tier convention (`packs/rules/manifest.json`):

- full: the canonical file — `opencode/skills/<name>/SKILL.md` for skills, `opencode/agents/<name>.md` for agents.
- nano (~1-2KB): `SKILL.nano.md` beside the skill, `opencode/agents/<name>.nano.md` beside the agent. Decision rules and gates only — no examples or output templates.

The five critical surfaces carry nanos: `execution-orchestrator` and `fast-build` (agents), `review-code`, `debug-investigate`, `deploy-ship` (skills).

Pick the tier from the lane's context window, the same budget convention as the rules pack's `defaultTier`: full when the lane holds the whole file plus the task and code; nano for tight-context lanes that would otherwise get truncation or nothing. Nanos here are exact copies of the xx-stack canonical nanos — they carry no OpenCode-specific content, and `npm run nano:check` (scripts/check-nano-tiers.mjs) enforces byte parity and fails when a canonical edit lands without a nano review.

The weakest-model acceptance test from the Skill Authoring Contract above is the acceptance test for every nano — tight-context local lanes are exactly who it serves.

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

## Advanced Workflows (15)

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

16. plan-decision-map
- Multi-session decision-map planning: persistent map of decision tickets backed by the task tools, one decision resolved per session until the fog clears

17. interrogate-plan
- One-question-at-a-time decision interrogation with a recommended answer per question; owns the questioning phase delegated by the plan-* skills

18. research-deep
- Budget-bounded iterative research loop (search → read → reason → reflect) with an explicit knowledge-gaps queue and completion-judge-gated termination

19. plan-mechanism-contract
- Lock a mechanism contract before implementation when the path is unknown; write-gates tests/eval/CI/metrics

20. design-prototype
- Ships HTML design artifacts — web prototypes, mobile screens, decks, dashboards, office docs — by reading the design content pack (`packs/design/design-systems/`, `packs/design/design-skills/`, `packs/design/workflow-skills/`) rather than inventing visual language

## Utility Workflows (9)

21. diagnose-stack
- Stack health check: verifies MCP server, agent definitions, skill structure, environment variables, and config wiring

22. write-docs
- README/API/deployment doc generation

23. setup-observability
- Metrics, logs, alerts, traces

24. test-qa
- Journey QA with regression checks

25. release-doc-sync
- Post-release documentation synchronization

26. safety-guardrails
- Destructive-command and edit-scope safety mode

27. orchestrate-platform-routing
- Delegation planning across the four registry tiers: `local`, `tailscale-openai-compatible`, `tailscale-ollama`, `cloud`

28. ensemble-consensus
- Ask at least three models the same question in parallel — across machines, or
  three local models when nothing can be delegated — then merge the answers and
  report where they disagreed

29. compose-supervisor-prompts
- Compose continuation, failover-handoff, review-to-continuation, and memory-compaction prompts from supervisor and memory state

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

## Slash Commands

OpenCode loads `.opencode/command/*.md` (this directory when the workspace is linked).

| Command | Starts |
|---|---|
| `/review` | `reviewer` + `review-code` |
| `/plan` | `plan` |
| `/debug` | `debug-investigate` |
| `/ship` | `release-manager` + `deploy-ship` |
| `/explore` | `research` (+ `build_repo_map` when MCP is up) |
| `/route` | `orchestrate-platform-routing` + `route_task` |
| `/judge` | `completion-judge` |

## Agent Pairing

- build: default Tab agent — implement and gate
- plan: Tab — no edits, executable plan package
- research: Tab or spawn — read-only explore
- fast-build: Tab — one obvious slice
- execution-orchestrator: Tab — supervised multi-slice loop (needs supervisor MCP tools)
- parallel-execution-orchestrator: Tab — farm independent slices across machines
- architect / reviewer / qa-lead / completion-judge: spawn only
- release-manager / incident-commander: spawn for ship and fire
- ping: hidden health probe, not a Tab lane

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

