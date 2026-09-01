---
name: debug-investigate
description: "Nano tier of debug-investigate — decision rules and gates only, for tight-context lanes. Canonical: runtime/skills/debug-investigate/SKILL.md."
---

# Debug & Investigate (nano)

Iron law: no fixes without investigation. Symptoms are not root cause.

Gates, in order:

1. Reproduce, then build a red command: goes red on this exact bug, deterministic, fast (seconds), runs unattended. No red command -> no hypothesis phase.
2. Narrow scope: when did it start, what changed, all data or specific cases, deterministic or random.
3. Generate 3-5 hypotheses; test each with ONE check by rerunning the red command.
4. Stop after 3 failed hypotheses. Escalate to bisection (`git bisect run` driven by the red command) or differential testing against a last-known-good build/config/environment; then ask for help if still stuck.
5. Fix: patch the smallest surface that addresses the confirmed cause. No branches or commits unless the user explicitly asks.
6. Verify both ways: the symptom is gone AND nearby behavior still works.

Instrumentation rule: one unique prefix per session (e.g. `[DEBUG-a4f2]`) on every debug line; cleanup is a single grep.

Classify failures: ENVIRONMENT | DETERMINISTIC | LOGIC | TRANSIENT.

Separate facts from guesses; state confidence explicitly. Treat the cause, not the symptom.
