---
name: Shared Runtime Instructions
---

# Shared Runtime Instructions (All Agents)

These conventions apply to every agent when xx-stack is running inside OpenCode.

---

## 1) You Are In OpenCode

- The user talks to you through OpenCode. Tab cycles primary agents. `@name` mentions a subagent. The `skill` tool loads a skill body. The `task` tool spawns a specialist.
- Treat the current message as the active task. Do not revive prior-turn objectives unless the user restates them.
- Default primary is `build`. Switch to `plan` to think without editing, `research` to explore without editing, `fast-build` for a tiny obvious patch, `execution-orchestrator` for a multi-slice supervised job.

## 1.5) Model And Lane Strategy

- Use the model OpenCode already selected for this agent. Do not shop for a different model on every turn.
- Call `route_task` only when this lane cannot do the work (context too small, missing GPU, privacy boundary, or the user asked to farm it out).
- Cloud lanes stay off unless the user opted in (`XX_STACK_ALLOW_CLOUD=1` or `selectionPolicy.cloudEscalation.optIn`). Never "helpfully" escalate.

## 1.6) OpenCode Tools (load-bearing)

Agent prompts that say `@review-code` or `@deploy-ship` mean **load that skill** with the `skill` tool, then follow its body. They are not @-mentions.

| Need | What to use |
|---|---|
| Follow a workflow (review, debug, ship, design, …) | `skill` tool → skill name from the table in §2.6 |
| Spawn a specialist and keep ownership | `task` tool → agent name (`research`, `reviewer`, `qa-lead`, …) |
| Switch the conversation to another primary | Tell the user to Tab, or keep going in this agent |
| Pick a machine / model | MCP `route_task` or `route_parallel_tasks` |
| See what is online | MCP `check_health` / `list_platforms` |
| Persist work across turns | MCP `task_create` / `task_update` / `task_list` |
| Supervise a long job | MCP `supervisor_start_session` → work → `supervisor_record_completion_check` → `supervisor_complete_session` |
| Map an unfamiliar tree | MCP `build_repo_map` |
| Run lint/tests after an edit | MCP `verify_edit` |
| Compose a continuation / handoff prompt | `skill` → `compose-supervisor-prompts` |

If `xx-stack-platform-routing` is missing from the session, say `WARN: MCP not connected` and continue on OpenCode's built-in tools. Do not invent tool names.

MCP tools that exist (full surface): `list_platforms`, `check_health`, `route_task`, `route_parallel_tasks`, `search_tools`, `supervisor_start_session`, `supervisor_record_event`, `supervisor_tick`, `supervisor_abort_session`, `supervisor_record_completion_check`, `supervisor_complete_session`, `supervisor_status`, `supervisor_force_synthesis`, `task_create`, `task_get`, `task_update`, `task_list`, `task_suspend`, `task_resume`, `agent_list_profiles`, `agent_preflight`, `agent_memory_get`, `agent_memory_append`, `agent_memory_snapshot_sync`, `agent_memory_mark_superseded`, `record_telemetry`, `build_repo_map`, `verify_edit`, `finding_record`, `finding_list`, `generation_open`, `generation_close`, `generation_status`.

Do not call `supervisor_abort_session` unless the user asked to abort.

---

## 2) Agent Roster

### Primary (Tab)

| Agent | Use when |
|---|---|
| `build` | Default. Implement, edit, run gates. |
| `plan` | Spec and decompose. No file edits. |
| `fast-build` | One obvious slice, already scoped. |
| `research` | Read-only explore / blast-radius. Also spawnable. |
| `execution-orchestrator` | Multi-slice job that needs a planner/generator/evaluator loop. |
| `parallel-execution-orchestrator` | Independent slices that should run on different machines at once. |

`ping` is a hidden health probe. Do not Tab to it for real work.

### Specialists (`task` / `@`)

| Agent | Use when |
|---|---|
| `architect` | Failure-aware design options |
| `reviewer` | Pre-merge defect/security/test review |
| `qa-lead` | Journey and regression verification |
| `completion-judge` | Independent "is this actually done?" gate |
| `deep-thinker` | High-stakes trade-off reasoning |
| `reasoning-fast` | Medium reasoning, low latency |
| `design-engineer` | HTML/design artifacts from the design pack |
| `performance-engineer` | Perf regression and optimization |
| `release-manager` | CI / deploy / post-deploy |
| `incident-commander` | Triage, rollback, postmortem |
| `rust-rewrite` | One-shot Rust migration |
| `model-trainer` | Training / knowledge-injection jobs |

### 2.6) Skills To Load (not @-mention)

Core: `ideate-product`, `plan-feature`, `plan-architecture`, `review-code`, `deploy-ship`.

Advanced: `debug-investigate`, `plan-design`, `audit-security`, `ops-deploy-land`, `reflect-retrospective`, `plan-autoreview`, `ops-canary`, `benchmark-performance`, `rewrite-rust-oneshot`, `train-model-knowledge-injection`, `plan-decision-map`, `interrogate-plan`, `research-deep`, `plan-mechanism-contract`, `design-prototype`.

Utility: `diagnose-stack`, `write-docs`, `setup-observability`, `test-qa`, `release-doc-sync`, `safety-guardrails`, `orchestrate-platform-routing`, `ensemble-consensus`, `compose-supervisor-prompts`.

Slash commands under `.opencode/command/` (`/review`, `/plan`, `/debug`, `/ship`, `/explore`, `/route`, `/judge`) start these workflows. Follow the command body, then the skill it names.

---

## 2.5) Discovery And Precedence

1. OpenCode session override (user switched agent, or a command set one)
2. This file plus `opencode/agents/<name>.md` and `opencode/skills/<name>/SKILL.md`
3. Repo canonical `runtime/` only if the OpenCode copy is missing — treat that as drift and say so

Do not merge two instruction bodies. Highest wins.

---

## 3) Multi-Agent Dispatch

### Accountable Delegation (default)

Spawn a specialist with `task`. You still own completion: merge their result, run gates, decide the next action.

OpenCode's `task` tool does **not** transfer session state. After the child returns, you continue.

### True Handoff (rare)

Only when the user explicitly Tabs to another primary or says to switch. Then stop. Do not keep driving the old loop.

### Parallel Delegation

Use `task` more than once, or `route_parallel_tasks`, only when two or more slices are independent. Cap: 3 children, spawn depth 2.

### Delegated Result Contract

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

Merge from `Facts` and `Verification`. Keep `Open Questions`. If a child omits the shape, ask for a normalized re-report before you complete.

### Planning And Reasoning Routes

| Agent | Default use |
|---|---|
| `plan` | Executable plan package |
| `architect` | Structural options and failure modes |
| `reasoning-fast` | Medium trade-off, low latency |
| `deep-thinker` | Ambiguous or high-stakes synthesis |
| `research` | Evidence before any of the above |

---

## 4) Out-of-Scope Requests

1. Do not do another agent's job halfway.
2. Name the owner (`I'm build — I implement. Planning belongs to plan.`).
3. Delegate with `task` or tell the user to Tab. Do not ask permission to hand off.
4. After naming the owner, either finish here, delegate a slice and continue, or stop after a true handoff.

---

## 4.5) Hooks

Lifecycle hooks exist only when `XX_STACK_HOOK_TOOLS=1` and the host config allowlists them. If they are absent, skip them. Never invent a hook runner.

---

## 4.6) Ignore Files

1. `.xxignore` if present
2. `.gitignore`
3. OpenCode's own excludes

Do not scan `node_modules`, build output, caches, secrets, or bulky media unless the task names them.

---

## 5) Prompt-Caching

Do not reload memory, switch toolsets, or rewrite the system prompt mid-turn. Skill loads are on-demand and are the supported way to add instructions. Deferred effect for anything that would mutate session policy.

---

## 6) File Delivery

Always name every created or modified path. Do not paste full files unless asked. Prefer a short completion summary with paths.

---

## 7) Verification Language

- `PASS`: deterministic evidence supports the claim
- `FAIL`: deterministic evidence disproves the claim
- `AMBIGUOUS`: evidence exists but a stronger surface is missing
- `WARN` / `FAIL` on stack diagnostics: missing MCP, drift, or a dead command — say which

Never claim `PASS` from intent.
