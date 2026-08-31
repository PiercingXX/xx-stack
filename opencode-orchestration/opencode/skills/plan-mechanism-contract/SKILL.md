---
name: plan-mechanism-contract
description: Lock a mechanism contract before implementation when the path is unknown — map the baseline, compare alternatives, reject verifier edits, then implement only the selected contract. Use for complex-orchestration and competing hypotheses, not routine edits.
compatibility: opencode
metadata:
  source: xx-stack native
---

# Plan Mechanism Contract

## Purpose

Before generator edits, lock **one** mechanism: what will change, what must not, which alternatives were rejected, and how we will know it worked. Implementation starts only after that contract exists.

This is not a plan document and not an experiment loop. It is a write-gate.

## When to trigger

- `complex-orchestration` where the mechanism is still unknown
- Competing hypotheses about to fan out via `route_parallel_tasks` with `cohortKind: hypothesis`
- A previous attempt failed and the next edit would be a different approach

Do not use it for routine single-surface edits (`small-implementation`, `fast-build`).

## Forbidden surfaces

A mechanism contract must not target:

- tests
- eval / the validation command
- CI
- metric calculation

Those are the verifier. Changing them to make a goal pass is reward-hacking. Record the contract with `finding_record` `kind=mechanism_contract`; a forbidden surface is rejected.

## Procedure

1. **Map the baseline.** Read the current code path and, if a `goalContract` has `validationCmd` or `canaryCmd`, run that command on the **unchanged** tree through `verify_edit`. Record the canary with `finding_record` `kind=canary` (`pass` or `fail` is a measured baseline; `could_not_run` blocks fan-out).
2. **Name alternatives.** At least two mechanism-level options, plus one diagnostic/falsifying option. Each gets a diversity cell: `mechanismFamily`, `surface`, `intent`.
3. **Critique.** For each candidate: why it might work, why it might fail, what it must not touch.
4. **Lock one contract.** Persist via `finding_record` `kind=mechanism_contract` with:
   - selected cell
   - files/surfaces in scope
   - forbidden surfaces (the list above, plus anything the goal contract already constrains)
   - expected metric signature (name + direction; `unknown` stays unknown)
   - fail-fast check
   - rejected alternatives
5. **Implement only that contract.** A material deviation needs a new finding that names the amendment. Do not silently widen scope.
6. **Record the result** with `finding_record` `kind=result`, citing the contract. Force-synthesized work lands in incubator; failures land in diagnostic; unknown metric direction never confirms.

## Parallel hypotheses

When two or more alternatives should run as a cohort, pass them to `route_parallel_tasks` as objects with `cohortKind: hypothesis` and a `diversityCell`. Duplicate cells and same-family overconcentration are flagged on the plan. Restack before dispatch. xx-stack does not dispatch.

Open the cohort with `generation_open` after the canary exists. Close with `generation_close` so late evidence cannot rewrite membership.

## Completion contract

- A mechanism contract finding exists and does not target a forbidden surface
- Canary recorded when the goal contract has a validation command
- Implementation cites the locked contract
- Result finding recorded with an honest lane

## Degradation

If finding tools are unavailable, write the contract to `docs/mechanism-contract.md` (or the active completion contract) with the same fields and say the evidence store is degraded. Still do not edit the verifier.
