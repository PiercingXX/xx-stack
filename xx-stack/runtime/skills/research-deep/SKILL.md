---
name: research-deep
description: Answer a hard question by iterating search → read → reason → reflect under an explicit token budget, maintaining a knowledge-gaps queue until the answer passes the completion-judge's definitive-with-citations bar or the budget runs out.
compatibility: host-agnostic
metadata:
  source: xx-stack native
---

# Research Deep

## Purpose

Iterative multi-hop investigation with unknowns as first-class state. The
existing research agents map a codebase in one pass; this skill is for
questions that no single pass can answer — where each finding exposes the next
sub-question. It keeps an explicit **knowledge-gaps queue**, spends a bounded
budget, and refuses to call an answer done until it is definitive and cited.

## Activation Contract

Use this skill when:

- the question needs multiple hops of evidence gathering (find A to know what
  B to look for)
- a first-pass answer already failed or is doubted
- the user asks for deep, thorough, or exhaustive research

Do not use it for:

- single-lookup questions — answer them directly
- one-pass codebase orientation (the research/researcher agents own that)
- decisions the user must make (`interrogate-plan`)

## Budget

The loop is budget-bounded, following the shared token-budget convention
(the same convention `build_repo_map` and the rules-pack tiering use).
Precedence:

1. an explicit budget supplied by the caller or the ticket
2. derived from the routed lane's context window in the platform registry
   (leave headroom for the answer itself)
3. stack default: 8000 tokens of gathered evidence per round, capped at 10
   rounds

Track spend after every round. Budget exhaustion is a terminal condition (see
Termination) — never a reason to silently keep going.

## State

Two artifacts persist across rounds; everything else is disposable working
context.

**Gap queue** — sub-questions the reflect step discovers. The original
question is pinned and always last to close:

```
## Gap Queue
- [open]     Q0 (original): <the question>
- [open]     Q1: <sub-question> (independent)
- [answered] Q2: <sub-question> → <one-line finding> [cite]
```

**Citations ledger** — every finding recorded as claim + source. Valid
sources: file path with line range, command plus its output, doc path, URL.
A claim with no ledger entry does not exist.

## The Round

Each round: pick **one** action, execute it, update the gap queue and ledger.

- **search** — find candidate sources for an open gap. Online: web search.
  Offline: repo and docs search (`grep`, `docs/`, `build_repo_map`, local
  artifacts).
- **visit** — read one specific source found by search: a file, a doc, a URL.
  Extract findings into the ledger with citations. For URLs, prefer a local
  reader service when the inventory declares one enabled (a machine's
  `services` entry with `kind: "reader"` — see
  `runtime/READER-SERVICE-RUNBOOK.md`): it returns LLM-friendly markdown.
  When none is declared, disabled, or unreachable, fall back to plain fetch —
  absence degrades, it never escalates to a cloud reader.
- **reflect** — reread the ledger against the gap queue: close answered gaps,
  add newly exposed ones, drop gaps the original question no longer needs.
- **answer** — draft the final answer. Only legal when every open gap blocking
  Q0 is closed.

### Action toggling (anti-loop guard)

If an action just failed or returned what a previous round already returned
(same results, same page, same conclusion), **disable that action for the
next round** and pick a different one. Re-enable it after another action
changes the state. This is the preemptive form of the supervisor's stall
detection: two identical searches in a row means the query is exhausted, not
that a third will differ.

### Fan-out

When reflect leaves two or more **independent** open gaps (neither needs the
other's answer), fan them out via `route_parallel_tasks` — one sub-question
per task, each with an explicit slice of the remaining budget. Results return
as cited findings merged into the ledger. Never fan out dependent gaps;
sequence them.

## Offline Degradation

Web search and URL visits are optional surface. When offline or when no web
tool exists, the loop is unchanged — search and visit degrade to repo files,
`docs/`, local artifacts, and command output. Say in the answer that research
was local-only; never fake web coverage, and never treat offline as a reason
to escalate to a cloud surface.

## Termination — judge-gated

Drafting an answer does not end the loop. The **completion-judge agent**
(`runtime/agents/completion-judge.md`) applies the bar: definitive, every
claim cited from the ledger, no open gap ignored.

- **PASS** — deliver the answer with its citations.
- **FAIL** — retry with reset: discard the working context (drafts,
  reasoning, dead-end notes). Carry forward only the original question, the
  gap queue, the citations ledger, and the **judge's failure reason injected
  verbatim** as the top constraint of the fresh attempt. Deduct spent budget.
  Continuing in a polluted context repeats the same miss; the reset is the
  point.
- **Budget exhausted** — stop and deliver a best-effort answer explicitly
  labeled as such: state confidence, list every remaining open gap, cite what
  is cited. Never present a budget-exhausted answer as a judge-passed one.

## Verification State

- `PASS`: the completion judge returned PASS and every claim carries a ledger
  citation
- `FAIL`: the loop stalled with all actions toggled off, or the answer
  contains uncited claims
- `AMBIGUOUS`: budget exhausted — best-effort answer delivered with open gaps
  declared

## Principle

Unknowns are state, not vibes. If the gap queue doesn't say it's open, you've
stopped researching and started guessing.
