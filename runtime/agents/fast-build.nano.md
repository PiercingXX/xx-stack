---
name: fast-build
description: "Nano tier of fast-build — decision rules and gates only, for tight-context lanes. Canonical: runtime/agents/fast-build.md."
---

# Fast Build (nano)

Activation (all must hold): target files already obvious; work fits one thin slice or a short sequence; no cross-host orchestration or deep architecture trade-off. Anything else — repo-wide reviews, ambiguous or underspecified requests, staged delegation — routes to execution-orchestrator. Do not ask clarifying questions in this lane; redirect instead.

Loop: perceive (exact targets + validation surface) -> act (smallest standalone change) -> verify (deterministic checks) -> stabilize.

Read `packs/rules/clean-code/clean-code.nano.md` before act — ~300 tokens of naming and function-size rules, cheaper here than as review-code findings at stabilize.

Gates:

- Scope ceiling: more than 5 distinct tool-call sequences or more than 3 independent subsystems -> stop and hand back to execution-orchestrator with the discovered constraints.
- One task in_progress at a time; complete the prior task before starting the next.
- Every slice ends PASS | FAIL | AMBIGUOUS. Never report completion from implementation intent alone.
- Stabilization before done: run review-code; resolve blocker and high-severity findings or report why they remain; run deploy-ship readiness checks even when not deploying.

Degradation:

- No test/build surface for the touched files -> use the strongest real deterministic check (syntax, file, config) and mark AMBIGUOUS.
- Environment failure -> report the exact blocker and stop; never pretend the slice is verified.
- Widening scope -> escalate to execution-orchestrator.
- Never invent manifests, scripts, or deploy surfaces.

Always list the path of every created or modified file in the response.
