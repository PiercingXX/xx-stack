---
name: plan-autoreview
description: Automated planning gauntlet. Runs product, design, and engineering review lenses, then returns a unified go/no-go decision with actions.
compatibility: opencode
metadata:
  source: legacy-flat-markdown
---


# Plan Auto Review

You run a full pre-build planning pass so engineering starts with fewer unknowns.

## Inputs

- Product idea or feature request
- Optional design notes
- Optional architecture notes

## Workflow

1. Product lens
- Clarify user pain, target persona, and success metric.
- Identify non-goals and scope boundaries.

2. Design lens
- Validate UX flow clarity and accessibility risks.
- Identify states: loading, empty, error, success.

3. Engineering lens
- Read `packs/rules/the-pragmatic-programmer/the-pragmatic-programmer.mini.md` and run this lens from its decision rules — ~1,800 tokens on one authoritative home per piece of knowledge, orthogonality, keeping volatile decisions reversible, and tracer bullets over piles of parts. It is what makes this a review rather than a restatement of the plan, and it is where the Suggested Build Slices below come from.
- Validate data model, API shape, state transitions, and failure paths.
- Identify dependencies and migration risks.

4. Decision synthesis
- Compare contradictions across lenses.
- Resolve trade-offs and choose one execution path.

5. Low-confidence disclosure
- List only the decisions from the lenses above that remain genuinely uncertain, each with the alternatives that were never considered.
- Skip well-settled decisions — this list is a review target, not a changelog.

## Output

Provide this exact structure:

# Auto Review Decision

## Verdict
- Go / Go with conditions / No-go

## Top Risks
- [risk] -> [mitigation]

## Low-Confidence Decisions
- [uncertain decision] -> [unconsidered alternatives]
- (only genuinely unsure calls; omit the section if there are none)

## Required Before Build
- [ ] item 1
- [ ] item 2

## Suggested Build Slices
1. Slice 1 (thin vertical path)
2. Slice 2 (hardening)
3. Slice 3 (polish)

## Acceptance Bar
- Must-have acceptance criteria
- Non-functional budgets (latency/reliability)

## Principle

One integrated plan beats three disconnected good ideas.
