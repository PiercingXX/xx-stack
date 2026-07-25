---
name: ensemble-consensus
description: Ask the same question of several models at once across your own machines, then merge their answers into one result that reports where they agreed, where they disagreed, and how confident the merge is.
compatibility: host-agnostic
metadata:
  source: xx-stack native
---

# Ensemble Consensus

## Purpose

Run one prompt against **multiple models in parallel** on hardware you own, then
synthesise a single answer from all of them.

This is different from parallel delegation. `route_parallel_tasks` splits
*different* work across lanes to go faster. This skill sends the *same* work to
several models to go **deeper**: disagreement between models is signal, and a
merged answer with that signal attached is more trustworthy than any single
model's output.

Use it when being wrong is expensive and latency is not the constraint:
architecture decisions, security review, ambiguous requirements, risky
migrations, "is this actually correct?" checks.

Do **not** use it for routine edits, quick lookups, or anything where you would
not read a second opinion anyway. It costs N times the compute of one call.

## When to trigger

- The user asks for a second opinion, a review panel, a sanity check, or
  explicitly for "several models"
- The task is high-stakes and irreversible
- A single model has already produced an answer you have reason to doubt
- The user asks to compare models on a real task

## Procedure

### 1. Pick the panel

Call `list_platforms` and select **enabled, reachable** hosts. Prefer diversity
over count — two different model families beat three checkpoints of one, because
correlated models fail the same way.

- Aim for 3 members; 2 is the minimum, 5 is the practical ceiling.
- Skip any host whose `enabled` is false. A disabled lane is a deliberate
  choice; never quietly enable one.
- Never add a cloud member unless `selectionPolicy.cloudEscalation.optIn` is
  true or `XX_STACK_ALLOW_CLOUD=1`. Cloud is opt-in here exactly as everywhere
  else in this stack.
- If fewer than 2 members are available, **say so and answer normally** rather
  than pretending an ensemble ran.

### 2. Fan out

Send every member the identical prompt. Do not tailor it per model — divergence
must come from the models, not from differently-worded inputs.

Use `route_parallel_tasks` with the same task description repeated once per
member, or dispatch directly to each host. Record for each member: host id,
model name, and the full response.

Members are independent. Never show one member's answer to another before all
have responded — that collapses the ensemble into an echo.

### 3. Compare

Extract the substantive claims from each response, then classify:

- **Unanimous** — every member agrees
- **Majority** — most agree, at least one dissents
- **Split** — no clear majority
- **Unique** — exactly one member raised it

A unique claim is not automatically wrong. A single model spotting a real bug
the others missed is the most valuable output an ensemble produces. Judge unique
claims on their merits, not their vote count.

### 4. Merge

Produce one answer, structured as:

```
## Answer
<the merged result, written as a direct answer to the original question>

## Confidence
unanimous | majority (n/m) | split — no consensus

## Where the models disagreed
- <claim> — agreed: <hosts>; dissented: <hosts>; assessment: <your judgement>

## Worth checking
- <unique or unresolved claims the user should verify>

## Panel
- <host> / <model>
```

Rules for the merge:

- **Never average conflicting answers into mush.** If two models say "use X" and
  one says "use Y", pick one and justify it — do not emit "you could use X or Y".
- **Report split verdicts as split.** A genuine 50/50 is information. Manufacturing
  false consensus is the main way ensembles mislead.
- Prefer the answer with reasoning you can verify over the answer with more
  votes. Consensus among models is not evidence; it is correlation.
- Keep the merged answer the same length a single good answer would be. The
  disagreement detail goes in its own section, not smeared through the result.

## Failure modes

- **A member times out** — proceed with the rest, name the member that dropped,
  and lower the reported confidence.
- **All members agree and are all wrong** — the most dangerous case. Unanimity
  on a question none of the models is equipped to answer is worth less than one
  competent answer. If the question needs knowledge the panel plainly lacks, say
  that instead of reporting high confidence.
- **One member returns malformed output** — exclude it, say you excluded it.
- **Only one member available** — this is not an ensemble. Answer normally and
  state that no panel was formed.

## Completion contract

Report honestly:

- how many members were asked and how many answered
- the exact confidence class, never rounded up
- every claim where the panel split

Do not describe an ensemble as unanimous when a member failed to respond.
