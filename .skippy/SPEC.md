# Goal

`buildRepoMap` does not respect its token budget on this repository, and
the acceptance test that was supposed to catch that does not check it.

Measured: `buildRepoMap({ root: <this repo>, tokenBudget: 4000 })` returns
`tokensEstimated: 76187` — 19x the budget — and one file. The real-repo
acceptance test calls exactly that and asserts elapsed time, non-empty
results, method, and `tokensEstimated > 0`. It never asserts
`tokensEstimated <= tokenBudget`, which is the single property the test
exists to prove.

# Requirements

1. `tokensEstimated` MUST be <= `tokenBudget` for any input. If a single
   file exceeds the whole budget, include a truncated RANGE of it rather
   than the whole file, or omit it and say so — never blow the budget.
   The return shape already carries `ranges`; use it.
2. Fix the real-repo acceptance test to assert
   `result.tokensEstimated <= 4000` — the budget it passes in.
3. Fix the synthetic budget test too: it currently allows `<= 160` for a
   budget of 80 ("within 2x budget"). A 2x tolerance is not a budget.
   Assert `<= tokenBudget`.
4. Re-check every other assertion in that test file the same way: does it
   assert the property its name claims? Report any others you find, and
   fix them.

# Hard constraints

- SCOPE IS LAW: repo_map_runtime.ts, repo_map_tools.ts if needed, and
  repo_map_runtime.test.ts. Nothing else.
- Do not weaken the budget to make the test pass — the budget is the
  feature.
- `npm test` compiles to dist/ and runs `dist/*.test.js`; tsc does NOT
  clean dist, so stale compiled tests from other branches can run. Remove
  dist before trusting a result.

# Acceptance criteria

1. A direct call `buildRepoMap({ root: <repo root>, tokenBudget: 4000 })`
   returns `tokensEstimated <= 4000`. Prove it in the loop report by
   running it, not by describing it.
2. Both budget tests assert `<= tokenBudget` with no multiplier.
3. `npm run verify` green after `rm -rf xx-stack/mcp-server/dist`.
