---
name: ensemble-consensus
description: Ask the same question of at least three models at once — across your machines when possible, or three local models when not — then merge their answers into one result that reports where they agreed, where they disagreed, and how confident the merge is.
compatibility: host-agnostic
metadata:
  source: xx-stack native
---

# Ensemble Consensus

## Purpose

Run one prompt against **at least three models in parallel**, then synthesise a
single answer from all of them.

This is different from parallel delegation. `route_parallel_tasks` splits
*different* work across lanes to go faster. This skill sends the *same* work to
several models to go **deeper**: disagreement between models is signal, and a
merged answer carrying that signal is more trustworthy than any single model's
output.

Use it when being wrong is expensive and latency is not the constraint:
architecture decisions, security review, ambiguous requirements, risky
migrations, "is this actually correct?" checks.

Do **not** use it for routine edits, quick lookups, or anything where you would
not read a second opinion anyway. It costs at least 3x the compute of one call.

## When to trigger

- The user asks for a second opinion, a review panel, a sanity check, or
  explicitly for "several models"
- The task is high-stakes and irreversible
- A single model has already produced an answer you have reason to doubt
- The user asks to compare models on a real task

## The three-member floor

**Three responses is the minimum. Never run this skill with fewer.**

Two models give you agreement or deadlock, and deadlock is useless — there is no
tiebreak and no way to tell a lone correct dissent from a lone wrong one. Three
is the smallest panel where a minority position is meaningful.

## Procedure

### 1. Build the panel — three members, however you can get them

Call `list_platforms` and take **enabled, reachable** hosts. Then apply, in
order, whichever of these gets you to three:

**a. Distributed (preferred).** Three or more different machines. Prefer
diversity over count — three different model families beat three checkpoints of
one, because correlated models fail the same way. Cap at 5; past that you are
paying for redundancy, not coverage.

**b. Mixed.** Fewer than three machines available, so combine what remote
capacity exists with local models to reach three. A remote member plus two local
models is a valid panel.

**c. Local-only fallback.** No delegation possible at all — nothing else is
reachable, or nothing else is enabled. **Do not skip the ensemble.** Select
three *different models* on the local host and run the panel there:

- Call `check_health` with `include: ["models"]` for the local host and pick three genuinely distinct
  models. Different families first (e.g. a qwen, a llama, a mistral); different
  parameter sizes of the same family second; different quantisations of the same
  weights **last**, and say so, because those are near-duplicates and will agree
  for uninteresting reasons.
- Run them sequentially if the host cannot hold three at once. Respect the
  host's `maxConcurrentModels` and `maxParallelSlices` — swapping models is
  slower than parallel remote calls, and that is fine. This path trades latency
  for a real second and third opinion.
- Collect all three answers, then have the local model **distil** them into the
  merged result using step 4.

**If the local host cannot offer three distinct models either**, stop and say
so plainly: report how many you could form, answer the question normally, and
state that no ensemble ran. Never present a one- or two-model answer as an
ensemble result.

Never add a cloud member unless `selectionPolicy.cloudEscalation.optIn` is true
or `XX_STACK_ALLOW_CLOUD=1`. A short panel is not a reason to reach for cloud —
cloud is opt-in here exactly as everywhere else in this stack.

Never enable a disabled lane to make up the numbers. A disabled lane is a
deliberate choice.

### 2. Fan out

Send every member the identical prompt. Do not tailor it per model — divergence
must come from the models, not from differently-worded inputs.

Use `route_parallel_tasks` with the same task description repeated once per
member, or dispatch to each host directly. On the local-only path, run each
model in turn with the same prompt. Record for each member: host id, model name,
and the full response.

Members are independent. Never show one member's answer to another before all
have responded — that collapses the ensemble into an echo.

### 3. Compare

Extract the substantive claims from each response, then classify:

- **Unanimous** — all three or more agree
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
- <host> / <model>      (mode: distributed | mixed | local-only)
```

Rules for the merge:

- **Never average conflicting answers into mush.** If two models say "use X" and
  one says "use Y", pick one and justify it — do not emit "you could use X or Y".
- **Report split verdicts as split.** A genuine three-way disagreement is
  information. Manufacturing false consensus is the main way ensembles mislead.
- Prefer the answer with reasoning you can verify over the answer with more
  votes. Consensus among models is not evidence; it is correlation.
- On the local-only path, say so in the panel line. Three models on one box that
  share a family or quantisation lineage agree more easily than three separate
  machines, so treat unanimity there as weaker evidence and note that.
- Keep the merged answer the same length a single good answer would be. The
  disagreement detail goes in its own section, not smeared through the result.

## Failure modes

- **A member times out** — if two or more still answered, proceed, name the
  member that dropped, and lower the reported confidence. If it takes you below
  three responses, say the panel was short and do not call the result an
  ensemble verdict.
- **All members agree and are all wrong** — the most dangerous case, and more
  likely on the local-only path where models are related. Unanimity on a
  question none of the panel is equipped to answer is worth less than one
  competent answer. If the question needs knowledge the panel plainly lacks, say
  that instead of reporting high confidence.
- **One member returns malformed output** — exclude it, say you excluded it, and
  apply the three-response floor to what remains.
- **Fewer than three distinct models exist anywhere** — answer normally and
  state that no panel was formed.

## Completion contract

Report honestly:

- how many members were asked, how many answered, and which mode was used
- the exact confidence class, never rounded up
- every claim where the panel split

Do not describe an ensemble as unanimous when a member failed to respond, and do
not describe a two-model result as an ensemble at all.
