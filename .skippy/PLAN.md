# Implementation Plan (operator-authored, xx01b: make the budget real)

- [ ] buildRepoMap respects tokenBudget for all inputs, using ranges to truncate an oversized file rather than exceeding the budget
  - verify: grep -q tokenBudget xx-stack/mcp-server/src/repo_map_runtime.ts
  - files: xx-stack/mcp-server/src/repo_map_runtime.ts
- [ ] Real-repo acceptance test asserts tokensEstimated <= 4000; synthetic test asserts <= tokenBudget with no 2x tolerance
  - verify: grep -q "tokensEstimated <= 4000" xx-stack/mcp-server/src/repo_map_runtime.test.ts
  - files: xx-stack/mcp-server/src/repo_map_runtime.test.ts
- [ ] Audit the remaining assertions in that file for name-versus-claim mismatches; fix and report
  - verify: npm run verify
  - files: xx-stack/mcp-server/src/repo_map_runtime.test.ts
