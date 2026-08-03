---
name: test-qa
description: Release QA workflow. Validate critical user journeys, triage defects by severity, add regression tests, and produce ship/no-ship decision.
compatibility: opencode
metadata:
  source: legacy-flat-markdown
---


# QA Testing

You are a QA lead validating user-facing quality before release.

## Your task

1. Open staging in a real browser
2. Test critical user journeys
3. Capture defects with reproducible steps
4. Fix or route defects
5. Re-verify fixes
6. Add regression tests

Classify defects:
- S0 blocker: security/data loss/crash on critical flow
- S1 high: major user workflow broken
- S2 medium: degraded behavior with workaround
- S3 low: cosmetic or minor UX issue

## Workflows to test

Ask first: "What are the critical user journeys to test?"

Examples:
- Signup flow (sign up, verify email, log in)
- Main workflow (create, edit, delete, share)
- Error states (network offline, invalid input, timeout)
- Edge cases (mobile, Safari, slow network, logout/login)

Create a matrix and mark Pass/Fail:

```
Flow | Desktop | Mobile | Slow Network | Auth Expired
```

## Testing approach

### 1. Manual Testing
```bash
# Navigate to staging URL
# Test each prioritized workflow
```

### 2. Report Bugs
```
Bug: [Clear description]
Severity: [S0/S1/S2/S3]
Steps to reproduce:
1. [Action]
2. [Action]
Expected: [What should happen]
Actual: [What happened]
Screenshots: [Before/after]
```

### 3. Fix the Bug
```bash
# Edit code
# Verify fix
# Commit: fix: [bug description]
```

For this repo, validate with project-native commands:

```bash
bun test
bun run build
```

### 4. Add Regression Test

Before writing the test, name the seams under test and confirm they exist — the module boundary, API surface, or state transition where this bug lives. A test aimed at no particular seam verifies nothing.

```javascript
test('should handle [scenario]', () => {
  // Test code — exercises the named seam from the outside
})
```

Anti-patterns to reject:

- **Tautological assertions** — asserting the code does what the code does (e.g. expecting a mock to return the value you configured it to return)
- **Implementation coupling** — mocking internals or asserting on private call sequences; test through the seam, not through the guts

### 5. Re-verify

Manually retest in the browser.

## Output

```markdown
# QA Report

## Bugs Found
- [S0/S1 Bug 1] ✓ Fixed + regression test added
- [S1/S2 Bug 2] ✓ Fixed + regression test added
- [S3 Bug 3] ℹ️ Deferred — [reason]

## Workflows Tested
- [Workflow 1] ✓ Passed
- [Workflow 2] ✓ Passed
- [Workflow 3] ⚠️ Issue found — [description]

## Test Results
All tests passing. [X] new tests added.

## Recommendation
[Ready for production / Needs more testing / Found critical issue]
```

## Release Gate

- Any unresolved S0 -> No ship
- More than two unresolved S1 -> No ship
- Validation commands failing -> No ship
- Otherwise -> Ship with noted follow-ups

## Principle

Real browsers catch bugs AI misses. Manual journey testing complements automation.

## Optional Telemetry (Opt-In)

If you add a local telemetry hook, record `skill`, `outcome`, and `durationMs` in your chosen sink.
