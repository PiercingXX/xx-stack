---
name: plan-decision-map
description: Multi-session planning for large foggy projects. Build a persistent map of decision tickets backed by the MCP task tools, then resolve one decision per session until the path is clear. Output is decisions, not implementation.
compatibility: host-agnostic
metadata:
  source: xx-stack native
---

# Plan Decision Map

## Purpose

Some projects are too large and too foggy for a one-shot plan. `plan-feature`
and `plan-architecture` produce a single-session artifact; the autonomous TODO
loop executes a flat list. This skill is the layer above both: a **persistent
map of decision tickets** that survives across sessions, where each session
resolves exactly one decision, until enough fog has cleared that the ordinary
plan and build skills can take over.

**Plan, don't do.** The output of this skill is resolved decisions and a
navigable map — never implementation. When a region of the map is clear, hand
it off to `plan-feature`, `plan-architecture`, or a build skill.

## Activation Contract

Use this skill when:

- the project is too large or too uncertain to plan in one context window
- planning must span multiple sessions and the state between them must persist
- the blocking problem is unresolved _decisions_, not unexecuted _tasks_

Do not use it when:

- a single-session spec or architecture doc is enough (`plan-feature`,
  `plan-architecture`)
- the work is already a flat, executable list (the autonomous TODO loop owns
  that)
- the user wants implementation now — this skill never implements

## The Map Model

The map is backed by the MCP task tools (`task_create`, `task_get`,
`task_list`, `task_update`).

- **Map = parent task.** Create one task titled `Decision map: <project>`,
  tagged `decision-map`. Its `description` holds the map index (see below).
- **Decision ticket = child task.** Each ticket is a task tagged
  `map:<map-task-id>` plus one type tag. Its title is the decision question;
  its `blockedBy` field carries the blocking edges to other tickets.
- **Blocking edges are real.** If ticket B cannot be decided until ticket A is,
  B's `blockedBy` lists A's task id. Never work a blocked ticket.

### Map index format

The map task's `description` is the index — one line per ticket, plus the fog
section:

```
## Decisions
- [open] Which storage backend for run artifacts?
- [done] Single binary or daemon + CLI? — Single binary; daemon deferred. (detail: ticket checkpoint)

## Fog
- Something about multi-tenant auth — question not yet precise enough to ticket
```

Rules for the index:

- **One-line answers on the map, detail linked.** A resolved ticket gets one
  sentence on the index line. The full rationale lives in the ticket's
  `lastCheckpoint` or a linked repo doc (a short ADR-style note is ideal) —
  never inline on the map.
- **Refer to tickets by title**, in the index and in all prose. Task ids are
  for `blockedBy` edges and tool calls, not for humans.
- Update the index via `task_update` on the map task every time a ticket is
  created or resolved. A stale index is a broken map.

### Durable decision records (ADRs)

A resolved decision ticket gets a durable record, not just a checkpoint note. Write a short numbered ADR:

- location: `docs/adr/NNNN-slug.md` (`docs/adr/` created on first use; `NNNN` is
  zero-padded and sequential)
- sections, in order: **Status**, **Context**, **Decision**, **Consequences** —
  a few sentences each, no more
- link the ADR from the ticket's `lastCheckpoint` and from the ticket's line on
  the map index

The map's one-line answers stay navigable because the real rationale has a stable home the next session can read.

### Fog of war

Unknowns that cannot yet be stated as a precise question live in the **Fog**
section of the index, not as tickets. An item graduates to a ticket only when:

- the question fits in one sentence, and
- resolving it plausibly fits in one session / one context window

If it does not fit, split it or leave it in the fog. Vague tickets rot.

### Ticket types

Every ticket carries exactly one type tag:

- `type:research` — answer requires gathering evidence (repo, docs, ecosystem).
  Independent research tickets may fan out in parallel via
  `route_parallel_tasks`; each fan-out result must come back as cited findings
  attached to its ticket.
- `type:prototype` — answer requires building a throwaway spike. The spike is
  evidence, not product code; record the finding and discard or quarantine the
  code.
- `type:interrogate` — answer requires the user to decide. Run the
  `interrogate-plan` skill against the ticket's question: one question at a
  time, each with a recommended answer.
- `type:task` — a concrete follow-up that is not a decision (for example
  "write the ADR for X"). Keep these rare; if the map fills with `type:task`
  items, the project has left the fog and belongs in the ordinary build flow.

## Modes

### Charting mode — build or extend the map

Used at project start and whenever resolved decisions reveal new territory.

1. **Evidence first.** Inspect the repo and runtime state before writing any
   ticket. A question the codebase already answers is not a decision — record
   the fact with its evidence and move on.
2. Create the map task if absent; otherwise `task_get` it and read the index.
3. Add fog items for everything unclear. Graduate to tickets only what passes
   the precision bar above.
4. Set `blockedBy` edges between tickets. Order emerges from edges, not from a
   guessed sequence.
5. Update the map index. Do **not** resolve anything in charting mode.

### Working mode — resolve one decision

1. `task_get` the map, read the index, `task_list` the tickets.
2. Pick one **unblocked, unclaimed** ticket (no unresolved `blockedBy`, no
   `owner`, status `todo`).
3. **Claim before work.** Set `owner` and status `in_progress` via
   `task_update` before doing anything else. A ticket someone else has claimed
   is off limits — pick another or stop.
4. Resolve it according to its type (research / prototype / interrogate /
   task).
5. Record: one-line answer on the map index, full rationale in a durable ADR
   (see Durable decision records) linked from the ticket's `lastCheckpoint`,
   status `done`.
6. Re-check the fog: does this answer make a fog item precise enough to
   ticket? Does it unblock tickets? Update edges and the index.
7. **Stop.** One decision per session is a hard rule. Resolving a decision
   changes the terrain; the next session starts by re-reading the map, not by
   momentum.

## Degradation

If the MCP task tools are unavailable, do not invent them and do not skip
persistence. Back the map with a repo markdown file instead:

- location: `docs/decision-map.md` (or `decision-map.md` at the repo root if
  no `docs/` exists)
- same structure: `## Decisions` index, `## Fog`, plus a `## Tickets` section
  where each ticket records `status`, `owner`, `type`, `blocked by:
<ticket titles>`, and its resolution detail
- claiming = writing your `owner` line before working; edges = the
  `blocked by` lines

State explicitly in your output which backing is in use. If neither task tools
nor a writable repo exist, report that the map cannot persist and stop —
a decision map that evaporates at session end is worse than none.

## Handoff

When a work area has no open or blocked decision tickets left, its fog has
cleared. Say so, and hand off: `plan-feature` / `plan-architecture` for the
detailed spec, then the build skills. The map stays alive for the regions
still in fog.

## Verification State

- `PASS`: the map is persisted (task store or file), the index matches the
  tickets, and this session resolved at most one decision with linked detail
- `FAIL`: the map could not be persisted, or a blocked/claimed ticket was
  worked
- `AMBIGUOUS`: the map is persisted but a resolved answer lacks evidence or
  linked rationale
