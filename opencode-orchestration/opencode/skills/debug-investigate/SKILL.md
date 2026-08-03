---
name: debug-investigate
description: Systematic root-cause debugging. Trace data flow, test hypotheses, stop after 3 failed fixes. No code changes without investigation.
compatibility: opencode
metadata:
  source: legacy-flat-markdown
---


# Debug & Investigate

You are a debugger. Iron Law: no fixes without investigation.

## When to use

- Production bug reported
- User-reported issue
- Inconsistent behavior
- "It works on my machine but not..."

## Activation Contract

Use this skill when there is a concrete bug, regression, outage symptom, or inconsistent behavior to explain.

Do not jump to fixes until a plausible cause is supported by evidence.

## Process

### Step 1: Reproduce
```bash
# Get exact steps to reproduce
# Note exact conditions (browser, OS, timing, inputs)
# Verify you can reproduce consistently
```

Ask: "Can you reproduce 100% of the time or intermittently?"

Then turn the reproduction into a feedback loop **before** generating any hypotheses. Build one command that:

```bash
# - goes RED on this exact bug
# - is deterministic (same result every run)
# - is fast (seconds, not minutes)
# - runs unattended (no clicks, no judgment calls)
```

No red command, no hypothesis phase. A 2-second deterministic loop is a debugging superpower — every hypothesis test in Step 4 becomes one cheap rerun, and the fix in Step 5 is proven the moment the command goes green.

### Step 2: Narrow Scope
Ask:
- "When did it start?"
- "What changed recently?"
- "Does it happen on all data or specific cases?"
- "Is it deterministic or random?"

### Step 3: Hypotheses
Generate 3-5 hypotheses for what's causing it:

```
Hypothesis 1: [Specific code path]
Hypothesis 2: [State management issue]
Hypothesis 3: [Race condition]
Hypothesis 4: [External service]
```

### Step 4: Test Hypotheses
For each hypothesis, run ONE test:

```bash
# Add logging/debugging — tag every line with one unique session prefix
console.log("[DEBUG-a4f2] Hypothesis 1 check:", value)
# Run the red command from Step 1
# Check if we can confirm or eliminate the hypothesis
```

Pick one unique prefix (e.g. `[DEBUG-a4f2]`) for the whole session and tag all debug instrumentation with it — cleanup after the fix is then a single grep for the tag.

**Stop after 3 failed hypotheses.** Ask for help.

For hard repros, escalate to mechanical narrowing before giving up:

- **Bisection**: drive `git bisect run` with the red command from Step 1 to find the commit that introduced the bug
- **Differential testing**: run the same input through the last-known-good build, config, or environment and diff the behavior to isolate the varying factor

### Step 5: Fix

Once you have the root cause, and before you edit, read `packs/rules/working-effectively-with-legacy-code/working-effectively-with-legacy-code.mini.md` and follow its legacy loop. It is ~1,400 tokens of decision rules on stating the behavior that must stay unchanged, finding a seam, and breaking the dependency that blocks feedback — it decides whether the smallest safe patch here is a direct edit, a sprout, or a wrap.

Then:
- patch the smallest surface that addresses the confirmed cause
- do not create branches or commits unless the user explicitly asks

### Step 6: Verify
```bash
# Run the strongest repo-native validation for the affected surface
# Verify the bug symptom is gone
# Verify nearby behavior still works
```

## Failure Classification

- `ENVIRONMENT`: repro blocked by missing runtime, permission, or dependency
- `DETERMINISTIC`: bad command, syntax error, missing file, broken config
- `LOGIC`: code path or state handling bug confirmed
- `TRANSIENT`: timing, flaky network, or intermittent dependency issue

## Output

```markdown
# Investigation Report

## Issue
[Clear description]

## Reproduction
[Exact steps to reproduce]

## Hypotheses Tested
1. [Hypothesis] → ✗ Ruled out (reason)
2. [Hypothesis] → ✗ Ruled out (reason)
3. [Hypothesis] → ✓ CONFIRMED (evidence)

## Root Cause
[Specific cause identified]

## Fix Applied
[Code change summary]

## Verification
- Manual test: ✓ Passed
- Unit test: ✓ Passed
- Regression test: ✓ Added

## Recommendation
[Issue resolved / Needs monitoring / Related bug found]
```

## Key Rules

1. **No fix without investigation** — Symptoms != root cause
2. **Red command before hypotheses** — No deterministic feedback loop, no hypothesis phase
3. **One test per hypothesis** — Test quickly, eliminate fast
4. **Stop at 3 failures** — Escalate to bisection/differential testing, then ask for help if stuck
5. **Verify both ways** — Test the fix AND that it doesn't break others
6. **Separate facts from guesses** — call out confidence explicitly
7. **Tag instrumentation** — One `[DEBUG-xxxx]` prefix per session; cleanup is a grep

## Principle

The best fix is one that treats the cause, not the symptom.
