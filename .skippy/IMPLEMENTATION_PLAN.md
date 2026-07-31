# Implementation Plan

- [x] Create `xx-stack/mcp-server/src/repo_map_runtime.ts` with `buildRepoMap` function that ranks files by git recency, path proximity to `focusPaths`, and import/reference counts via regex, respecting `.xxignore` and `.gitignore`, and returns `{ files, tokensEstimated, method: "heuristic" }`
- [x] Create `xx-stack/mcp-server/src/repo_map_tools.ts` with `registerRepoMapTools(server, deps)` that registers tool `build_repo_map` with Zod schema for `{ root, tokenBudget?, focusPaths?, includeSymbols? }` and calls `buildRepoMap` from runtime
- [x] Edit `xx-stack/mcp-server/src/index.ts` to import and call `registerRepoMapTools(server, deps)` alongside existing tool registrations
- [x] Create `xx-stack/mcp-server/src/repo_map_runtime.test.ts` with unit tests for budget truncation, ignore-file filtering, and focus reordering using `node:test` runner
- [x] Add acceptance test in `xx-stack/mcp-server/src/repo_map_runtime.test.ts` that runs `buildRepoMap` on the real repo root, asserts it returns in under 2 seconds and that `focusPaths` measurably reorders results
- [x] Run `npm run verify` from `xx-stack/` and confirm it exits with code 0
