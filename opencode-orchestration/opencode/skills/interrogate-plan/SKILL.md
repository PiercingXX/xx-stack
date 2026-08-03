---
name: interrogate-plan
description: Stress-test a plan, spec, or decision by walking its decision tree one question at a time, each question carrying a recommended answer, until no unresolved branches remain. The user decides; the skill only asks.
compatibility: opencode
metadata:
  source: xx-stack native
---

# Interrogate Plan

## Purpose

Find every unresolved branch in a plan or decision and close them one question
at a time. This is the generic interrogation loop: `ideate-product` applies
the same pattern to product ideas; this skill applies it to technical
decisions, plans, and specs. Other skills (`plan-feature`,
`plan-architecture`, `plan-decision-map`'s `type:interrogate` tickets)
delegate their questioning phases here instead of restating interview
mechanics.

## Activation Contract

Use this skill when:

- a plan, spec, or design has decisions that only the user can make
- another skill reaches its questioning phase and delegates here
- a `plan-decision-map` ticket of `type:interrogate` is being worked

Do not use it for:

- product-idea validation (`ideate-product` owns that)
- questions the repo or environment can answer deterministically — check
  first, ask never
- debugging interviews (`debug-investigate` owns its own narrowing questions)

## The Loop

### 1. Build the branch list

Read the plan, spec, or decision under interrogation. Enumerate every
unresolved branch — every point where the plan says "or", assumes silently, or
depends on a choice nobody has made. The calling skill may seed this list with
its own decision areas.

### 2. Evidence before questions

For each branch, check whether the repo or environment already answers it:
existing code paths, configs, schemas, dependency manifests, runtime
registries, prior ADRs. A fact you can verify is **recorded with its
evidence, never asked**. Asking the user something `grep` can answer wastes
their one scarce resource.

### 3. Ask exactly one question per message

For each remaining branch, in dependency order:

- state the decision in one sentence
- present the top 2–4 candidate answers
- **recommend one**, with the single decisive reason

Never bundle questions. A multi-part interrogation bewilders and produces
worse answers than a sequence of single decisions.

### 4. The user decides

The recommendation is advice, not a default. If the user picks against it,
record their choice and move on — note the disagreement once, do not
relitigate.

### 5. Record before proceeding

Write the user's answer into the plan document (or the ticket, when called
from `plan-decision-map`) **before** asking the next question. An answer that
lives only in conversation history is lost state.

### 6. Loop until clean

An answer often exposes new branches. Add them to the list and continue.
Terminate only when no unresolved branch remains — then return control to the
calling skill or summarize the resolved decision set.

## Degradation

If no user is available to answer (non-interactive or autonomous run):

- do not silently self-answer
- emit the full ordered question list, each with its candidate answers and
  recommendation, and mark the plan `AMBIGUOUS`
- adopt recommended answers only if the caller explicitly authorized
  auto-resolution, and label every such answer `ASSUMED` in the plan document

## Verification State

- `PASS`: no unresolved branches remain; every answer is recorded in the plan
  artifact with who decided it (user, evidence, or labeled assumption)
- `FAIL`: the plan artifact could not be updated, or questions were bundled or
  skipped
- `AMBIGUOUS`: branches remain open (including the non-interactive
  degradation path)

## Principle

One question, one recommendation, one recorded answer. The skill asks; the
user decides.
