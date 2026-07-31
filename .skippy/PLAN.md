# Implementation Plan (operator-authored, xx-stack task 1: repo map)

- [ ] repo_map_runtime.ts: heuristic ranking (git recency, focus proximity, regex reference counts), budget fitting, .xxignore/.gitignore filtering
  - verify: test -f xx-stack/mcp-server/src/repo_map_runtime.ts
  - files: xx-stack/mcp-server/src/routing_runtime.ts
- [ ] repo_map_tools.ts exposing build_repo_map in the canonical registerXxxTools shape; registered in index.ts
  - verify: grep -q build_repo_map xx-stack/mcp-server/src/index.ts
  - files: xx-stack/mcp-server/src/routing_tools.ts, xx-stack/mcp-server/src/index.ts
- [ ] repo_map_runtime.test.ts with node:test — budget truncation, ignore filtering, focus reordering, and a REAL-repo run under 2s
  - verify: cd xx-stack/mcp-server && npx tsx --test src/repo_map_runtime.test.ts
  - files: xx-stack/mcp-server/src/reliability.test.ts
- [ ] npm run verify green
  - verify: npm run verify
