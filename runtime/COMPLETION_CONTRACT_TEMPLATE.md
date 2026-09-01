# Completion Contract

## Objective

- [What this slice must accomplish]

## Scope

- In scope: [files/surfaces]
- Out of scope: [explicit exclusions]

## Acceptance Criteria

- [ ] C1: [specific measurable criterion]
- [ ] C2: [specific measurable criterion]
- [ ] C3: [specific measurable criterion]

## Required Verification Commands

1. `[command 1]`
2. `[command 2]`
3. `[command 3]`

## Metric (optional)

- Name: [metric]
- Direction: maximize | minimize | unknown (unknown stays unknown; never store a silent 0)
- Baseline: [measured value | unknown] (provenance: measured | placeholder | unknown)
- Maturity: smoke | full
- Canary command (unchanged tree, before fan-out): `[command]` — `could_not_run` blocks fan-out; fail is a measured baseline

## Required Evidence

- [ ] Command outputs captured
- [ ] File diff or artifact evidence captured
- [ ] Regression checks completed

## Completion Protocol

1. Generator implements and records evidence.
2. Orchestrator records evidence with `supervisor_record_completion_check` (`checkType=evidence`).
3. `completion-judge` evaluates contract + evidence.
4. Orchestrator records judge verdict with `supervisor_record_completion_check` (`checkType=judge`).
5. Only after both checks pass can `supervisor_complete_session` use outcome `completed`.
6. Record a finding (`finding_record`) when this slice was an experiment: confirmed only for a real completion with a known metric direction; incubator for salvage (`force_synthesized`); diagnostic for failures. After `generation_close`, late evidence cannot rewrite membership.
