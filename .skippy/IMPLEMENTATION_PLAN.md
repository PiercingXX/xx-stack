# Implementation Plan

- [x] In `repo_map_runtime.ts`, modify `buildRepoMap` to enforce token budget by truncating file ranges when a single file exceeds the budget
- [x] In `repo_map_runtime.test.ts`, add assertion `result.tokensEstimated <= 4000` in the real-repo acceptance test
- [x] In `repo_map_runtime.test.ts`, fix the synthetic budget test to assert `result.tokensEstimated <= tokenBudget` instead of `<= 160`
- [x] In `repo_map_runtime.test.ts`, audit all test assertions and fix any that don't match their test name's claimed property
- [x] Run `rm -rf dist && npm test` to verify all tests pass with corrected budget enforcement
