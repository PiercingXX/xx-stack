# Implementation Plan (operator-authored, xx-stack task 2: architect→editor split)

- [ ] routeArchitectEditor in routing_runtime.ts reusing existing tier selection and the existing cloud gate
  - verify: grep -q routeArchitectEditor xx-stack/mcp-server/src/routing_runtime.ts
  - files: xx-stack/mcp-server/src/routing_runtime.ts
- [ ] route_architect_editor tool in routing_tools.ts, result shape mirroring route_task; recommendation only, no execution
  - verify: grep -q route_architect_editor xx-stack/mcp-server/src/routing_tools.ts
  - files: xx-stack/mcp-server/src/routing_tools.ts
- [ ] Tests: two-lane split, single-lane collapse with reasoning, cloud excluded by default
  - verify: cd xx-stack/mcp-server && npx tsx --test src/routing_runtime.test.ts
  - files: xx-stack/mcp-server/src/routing_runtime.test.ts
- [ ] npm run verify green
  - verify: npm run verify
