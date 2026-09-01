---
name: compose-supervisor-prompts
description: Compose continuation, failover-handoff, review-to-continuation, and memory-compaction prompts from supervisor and memory state. Use when a stalled session needs a bounded continuation, a failover needs a structured handoff, a review must become a mustAddress list, or MEMORY.md needs distillation. Do not use for routing, task CRUD, or running validation.
compatibility: host-agnostic
metadata:
  source: xx-stack native
---

# Compose Supervisor Prompts

## Purpose

Write the four prompt shapes the supervisor used to mint as MCP tools. Read live
state first; then emit one of the templates below. The TypeScript formatters
(`buildContinuationPrompt`, `buildHandoffPrompt`, `buildMemoryCompactionPrompt`)
remain in the server for tests — they are not registered tools.

## Use When

- A completion attempt failed and the same lane must keep working.
- `supervisor_tick` returned `fallback_applied` and the receiving lane needs
  state, not instructions.
- A review produced notes that must become a continuation with a mustAddress
  item per note.
- MEMORY.md has repeated observations that should become durable rules.

## Activation Contract

Use this skill only to compose those prompts.

Read `supervisor_status` (and `agent_memory_get` for compaction or drift) before
writing. Do not invent session ids, lease state, or memory entry ids.

## Workflow

1. Continuation (same lane)
- Read the session. Skip composing if the abort window is active or recovery is
  in flight; wait, do not stack a second prompt.
- Title: `Supervisor continuation directive:`
- Required bullets: session, continuation-attempt (status count + 1),
  current-route as `host/model`, completion-recovery-reason, memory-sync-guard
  enabled/disabled. When a memory-sync guard is on, add agent, scope, and
  `memory-sync-drift: detected|not-detected` from `agent_memory_get`.
- Remaining tasks as a numbered list. If none: continue from the last verified
  artifact; verify with a command, file diff, or explicit evidence.
- When recovery is `validation_could_not_run`, the checklist is environment
  repair (install the command, or hand off). Do not tell the agent to change
  code.
- Credential *locations* may appear; values never do.

2. Failover handoff (new lane)
- Title: `Supervisor failover handoff:`
- Same session/route bullets, recovery-reason `failover_handoff`.
- Sections in this order, state not instructions:
  - Goal
  - Current State (`DONE` / `PARTIAL` / `NOT_STARTED` plus optional detail)
  - Key Decisions and why
  - Traps & Dead Ends (approaches that FAILED)
  - Relevant Files with line ranges
  - Open Work with dependencies
- End with: `Verify, don't trust: treat every claim in this handoff as context
  to verify against the code, not facts to accept.`
- If `revokedLeases` is non-empty: the prior lane's claim is revoked, only this
  lane may write results, and the prior lane's silence is terminal.
- Never paste credential values. Name the path or env var.

3. Review → continuation
- Resolve the repo: caller cwd, else the session's memory-sync cwd.
- Prefer a caller-supplied diff; otherwise `git diff --no-color` in that cwd.
  A failed git is `unavailable`, never an empty diff.
- Redact secrets before compacting (cap ~8000 characters, head+tail).
- One `mustAddress` item per review note, all required. Do not reprint the
  notes under a second heading.
- Recovery-reason `review_to_continuation`. Embed the compacted diff under
  `diff under review:` and name the source (`argument` / `git` / `unavailable`).

4. Memory compaction
- `agent_memory_get` without a token budget (full file).
- Oldest non-superseded entries only. Distill a rule only when two or more
  entries support it; leave one-off facts alone. Do not invent.
- Append each rule with `agent_memory_append`, prefix `[rule <compactionId>]`.
- Mark sources with `agent_memory_mark_superseded` (`supersededBy` = that id).
  Never delete entries.

## Verification

- `PASS`: the prompt matches the chosen template, every required bullet is
  present, and no secret value appears.
- `FAIL`: a session/memory id was invented, notes were duplicated, a failed
  `git diff` was treated as empty, or compaction deleted entries.
- `AMBIGUOUS`: the session exists but memory-sync or lease state could not be
  read; say so in the prompt rather than filling gaps.
