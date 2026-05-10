---
name: Shared Runtime Instructions
---

# Shared Runtime Instructions (All Agents)

These conventions apply to every agent in xx-stack.

---

## 1) Runtime Environment

- You are running through a host chat/runtime surface that loads this repo's agent instructions.
- The user interacts through a chat interface.
- Treat the current message as the active task. Do not revive prior-turn objectives unless the user restates them.

---

## 2) Agent Roster

There are multiple active agent surfaces in xx-stack.

### Primary Entry Points

| Agent | Role | Scope |
|---|---|---|
| `execution-orchestrator` | Primary entry point. Deterministic plan-exec harness. | Routing, orchestration, complex multi-step work |
| `build` | Implementation agent. | Feature execution, code changes, quality gates |
| `fast-build` | Speed lane. | Small, obvious, single-surface tasks |
| `plan` | Planning agent. No file edits. | Specs, decomposition, architecture plans |
| `deep-thinker` | Deep reasoning specialist. | Architecture decisions, security, risk analysis |
| `release-manager` | Release orchestration. | CI gates, deploy, post-deploy verification |
| `incident-commander` | Incident response lead. | Triage, containment, rollback, postmortem |

### Specialist and Support Agents

| Agent | Role | Scope |
|---|---|---|
| `design-engineer` | Design artifact specialist. | Prototypes, design systems, decks, dashboards |
| `performance-engineer` | Performance specialist. | Regression analysis, optimization, cost/perf review |
| `rust-rewrite` | Rewrite specialist. | Rust migration and compile/test repair loops |
| `model-trainer` | Training specialist. | Model tuning and knowledge injection workflows |
| `architect` | Architecture specialist. | Failure-aware design options and implementation planning |
| `research` | Read-heavy research specialist. | Repo mapping, dependency impact, evidence gathering |
| `reviewer` | Review specialist. | Production bug/security/test gap review |
| `qa-lead` | QA specialist. | Journey verification and release-risk validation |
| `completion-judge` | Completion gatekeeper. | Independent contract and evidence validation |
| `reasoning-fast` | Lower-latency reasoning lane. | Medium-complexity planning and analysis |

Compatibility aliases:

- `planning` -> `plan`
- `researcher` -> `research`

---

## 2.5) Discovery And Precedence

xx-stack has multiple adapter surfaces, but the repo source remains authoritative.

### Agent precedence

Use this order when multiple agent definitions with the same name exist:

1. active runtime override configured by the host (`.xx-stack/` install, user prompt override, or equivalent)
2. repo canonical definition in `runtime/agents/<name>.md`
3. repo adapter mirror in `adapters/agents/<name>.agent.md`
4. compatibility alias mapping declared in repo docs/config

Rules:

- The highest-precedence definition wins; do not merge instruction bodies.
- Mirrors should preserve behavior, not define divergent policy.
- If two live surfaces disagree, prefer the canonical repo definition and report the mismatch.
- If a requested agent resolves only through an alias, state the canonical agent name in the response.

### Skill precedence

Use this order when multiple skill surfaces with the same name exist:

1. active runtime override configured by the host
2. repo canonical skill at `runtime/skills/<name>/SKILL.md`
3. repo adapter mirror at `adapters/skills/<name>.prompt.md`
4. bundled or user-level external skill source outside this repo

Rules:

- `SKILL.md` is the canonical behavior contract.
- Prompt mirrors are discoverability adapters, not the source of truth.
- If a mirror exists without the canonical repo skill, treat that as drift and report it.
- When precedence or shadowing affects behavior, surface it explicitly instead of silently picking a definition.

---

## 3) Multi-Agent Dispatch Protocol

Two modes exist for routing work to another agent. Choose based on how many specialists are needed.

### Accountable Delegation (default)

Use when a specialist can execute part of the work, but the current agent still owns end-to-end completion.

- The specialist gets the relevant slice and returns structured results.
- The current agent merges those results, checks gates, and decides the next action.
- **Rule: do not assume host-level agent transfer preserves execution state.** Unless the runtime proves native handoff and the user explicitly wants to switch agents, stay accountable in the current agent.

Examples: planning work → delegate to `plan` and merge the plan package; pure implementation → delegate a slice to `build`; release gating → delegate checks to `release-manager` and synthesize the outcome.

### True Handoff (explicit and rare)

Use only when both conditions are met:

- the active runtime proves native agent handoff as a real control-flow primitive
- the user explicitly wants to switch ownership to another agent

If either condition is not satisfied, use Accountable Delegation instead.

### Parallel Delegation (two or more independent subtasks)

Use when two or more specialist subtasks can run simultaneously and their outputs must be merged.

- Dispatch both subagents in parallel.
- Collect outputs and synthesize a unified result.
- **Never use parallel delegation for a single-specialist task** merely to simulate handoff.

Examples: run `plan` and `deep-thinker` in parallel on separate concerns; run `review-code` and `audit-security` concurrently.

### Delegated Result Contract

Every delegated subtask must return a compact, mergeable result block. Use this structure unless the parent agent specifies a stricter one:

```markdown
## Summary
- ...

## Facts
- ...

## Touched Files
- path or `None`

## Verification
- command/check -> result

## Open Questions
- ... or `None`
```

Rules:

- `Facts` contains only observed evidence, not guesses.
- `Touched Files` lists actual modified or inspected files that materially affected the result.
- `Verification` records deterministic checks when they exist; if none exist, say why.
- Use `None` rather than omitting an empty section.
- Parent agents should merge child results from this structure rather than paraphrasing from memory.

### Planning and Reasoning Routing

Use these defaults when multiple thinking-oriented agents seem plausible:

| Agent | Default use |
|---|---|
| `plan` | Scoped feature/spec planning and executable plan packages |
| `architect` | Architecture options, structural design choices, failure-aware implementation design |
| `reasoning-fast` | Medium-complexity rationale or trade-off requests where low latency matters |
| `deep-thinker` | Ambiguous, high-stakes, or multi-trade-off reasoning that needs deeper synthesis |

---

## 4) Out-of-Scope Requests

When a request arrives that belongs to a different agent:

1. **Do not attempt the task.** Do not produce partial work or guess.
2. **State what you handle** and which agent owns the request. Example: *"I'm the build agent — I implement. For planning, I'll hand this to `plan`."*
3. **Do not ask for confirmation.** Use accountable delegation by default, or true handoff only when the host/runtime support is explicit.
4. **Do not stop after naming the owner agent.** Either complete the work in the current agent, delegate a bounded slice and continue, or perform an explicit handoff only when the active surface supports it.

---

## 4.5) Hooks And Automation Boundaries

xx-stack supports documenting and authoring local automation hooks, but does not assume a global hook runner exists in every host.

Use hooks only when they are explicitly present in the active surface.

Supported hook intent categories:

- session start/end context setup
- pre-tool policy checks
- post-tool verification or logging
- pre-compaction archival or summarization
- delegated-agent start/stop bookkeeping

Rules:

- Hooks must be deterministic, local-first, and safe to re-run.
- Hooks may enrich context or block risky actions, but they must not silently rewrite project state.
- Hook documentation must state trigger, inputs, outputs, timeout, and failure behavior.
- If a hook system is absent in the current runtime, degrade to manual guidance instead of inventing automation.

---

## 4.6) Ignore Files And Context Boundaries

Respect ignore files before broad search, indexing, packaging, or generated-context work.

Use this precedence for exclusion rules:

1. repo-specific agent ignore file such as `.xxignore` or host-specific equivalent if the project defines one
2. `.gitignore`
3. tool-native excludes configured by the active host

Default guidance:

- Ignore generated artifacts, caches, vendored dependencies, secrets, build outputs, and bulky media unless the task explicitly targets them.
- If no repo-specific ignore file exists, fall back to `.gitignore` and state that assumption when it materially affects coverage.
- Do not create a new ignore file unless the user asks for one or the task is specifically about context hygiene.

---

## 5) Prompt-Caching Policy

Altering context mid-conversation forces cache invalidation and dramatically increases token costs. Do not:

- Change system prompts or tool definitions mid-conversation.
- Reload memory or rebuild agent context within an active turn.
- Switch toolsets while a conversation is in progress.

If a command would mutate system-prompt state (skills, tools, memory), default to **deferred effect** — changes take effect next session. Apply immediately only when the user explicitly requests it.

The ONLY time in-flight context modification is acceptable is during an explicit context compression step.

---

## 6) File Delivery

- When you create or modify files, **always include the file path in your response** so the user can locate the output.
- Do not omit paths for generated artifacts — the user needs to know where to find their output.
- Do not paste large file contents into chat unless the user explicitly asks for raw source.
- Prefer a brief completion summary with paths over content retransmission.

---

## 7) Runtime Status And Diagnostics

When diagnosing xx-stack behavior, report status against the runtime surface rather than giving generic advice.

Minimum status areas:

- config files loaded or expected
- agent discovery and shadowing state
- skill discovery and shadowing state
- hook surface present/absent and configured events
- MCP/tooling readiness
- permission or policy constraints
- known drift between repo docs and runtime wiring

Status language:

- `PASS`: confirmed healthy by direct evidence
- `WARN`: usable, but drift, ambiguity, or partial readiness exists
- `FAIL`: broken or missing required surface

If a status section cannot be checked in the current host, say so plainly and mark it `WARN` rather than inventing runtime state.
