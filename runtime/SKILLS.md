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

The critical workflow surface ships in two sizes, following the same tier convention as the rules pack (`packs/rules/manifest.json`):

- full: the canonical file — `runtime/skills/<name>/SKILL.md` for skills, `runtime/agents/<name>.md` for agents. Always the source of truth.
- nano (~1-2KB): `SKILL.nano.md` beside the canonical skill, `runtime/agents/<name>.nano.md` beside the canonical agent. Decision rules and gates only — severity ladders, merge gates, iron laws, activation and degradation rules. No examples, no output templates.

Nano variants exist for the five critical surfaces: `execution-orchestrator` and `fast-build` are agents (nano lives in `runtime/agents/`); `review-code`, `debug-investigate`, and `deploy-ship` are skills (nano lives beside each `SKILL.md`).

Hosts and routers pick the tier from the target lane's context window, under the same budget convention as the rules pack's `defaultTier`: full when the lane comfortably holds the canonical file plus the task and code; nano for tight-context lanes that would otherwise drop the guidance entirely. The nano is derived from the canonical file and never contradicts it. Drift is enforced by `scripts/check-nano-tiers.mjs` (`npm run nano:check`), which pins each canonical file's hash — a canonical edit without a nano review fails CI — and requires the opencode mirror of each nano to stay byte-identical.

The weakest-model acceptance test from the Skill Authoring Contract above applies doubly here: every nano must be tested against the weakest model that will run it — the nano tier exists for exactly those lanes.

## Discovery And Shadowing

Skill precedence for xx-stack is:

1. active runtime override configured by the host
2. repo `runtime/skills/<name>/SKILL.md`
3. OpenCode-specialized copy at `opencode-orchestration/opencode/skills/<name>/SKILL.md` when that host is in use
4. external or bundled host-level skill sources

Shadowing rules:

- same-name skills do not merge across sources
- highest-precedence source wins
- diagnostics should report shadowed or missing canonical skills explicitly

Brand picking for the design pack lives in `design-prototype` (and the pack
paths `packs/design/design-systems/<brand>/DESIGN.md` and
`packs/design/design-skills/<style>/SKILL.md`). There is no separate
design-system-pick skill.

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

Canonical skills declare no model. Per `shared_instructions.md` §1.5 the host or
caller model runs the skill unless a routing tool or an explicit override says
otherwise, so this inventory records what each skill is for, not what it runs on.

1. ideate-product

- Purpose: Product validation through forcing questions

2. plan-feature

- Purpose: Scope feature into testable spec

3. plan-architecture

- Purpose: Architecture decisions, risks, verification plan

4. review-code

- Purpose: Production-grade pre-merge review

5. deploy-ship

- Purpose: Release gates and deployment verification

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

runtime/skills/

- <skill-name>/SKILL.md (canonical repo skill content)

Installed runtime discovery:

- ~/.config/opencode/skills/<skill-name>/SKILL.md (top-level shim created by opencode-orchestration/setup.sh)
- ~/.config/opencode/skills/xx-stack/ (installed canonical copy)

Migration status:

- Native discovery conversion complete for all skills.
- Duplicate and internal orchestration helper skills have been absorbed into `execution-orchestrator` and removed from the user-facing surface.

Telemetry:

- Optional and disabled by default via `runtime/telemetry.json`.
- Recommended only for ops/eval workflows where trend data is actionable.
- Extended to selected orchestration workflows when run metrics improve planning or delivery automation.

## Agent Pairing

- build: primary execution lane (OpenCode default)
- fast-build: fast implementation lane on the primary alias or local fallback when needed
- plan: primary-first direct planning lane
- research: read-only explore — Tab or spawn (`mode: all`)
- architect: reasoning specialist planning lane for delegated subagent work
- execution-orchestrator: primary-first controller with local fallback when primary hosts are unavailable
- performance-engineer: remote performance analysis
- release-manager: release gates and stabilization
- incident-commander: incident triage and recovery

## Delegation Source Of Truth

Use `~/.config/opencode/xx-stack-platforms.json` as the live registry for:

- `local` hosts and their model inventory
- `tailscale-openai-compatible` hosts, endpoints, and hardware limits
- `tailscale-ollama` hosts, endpoints, and hardware limits
- `cloud` providers and escalation policy

Those four ids are the entire tier vocabulary; they are defined in
`runtime/runtime-constants.json` and are the only values that can match.

Use `runtime/platforms.json` for shipped defaults in the repo.
The agent definitions in `runtime/config.json` are defaults, but installed orchestration should follow the synced runtime registry when deciding where work should run.

## Verification States

Across agents and skills, completion language should map to one of:

- `PASS`: deterministic evidence supports the claim
- `FAIL`: deterministic evidence disproves the claim
- `AMBIGUOUS`: evidence exists but a stronger validation surface is unavailable
