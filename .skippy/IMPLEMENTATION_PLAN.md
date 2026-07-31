# Implementation Plan

- [x] Add `routeArchitectEditor` function to `xx-stack/mcp-server/src/routing_runtime.ts` that selects architect from `coder-deep` lane and editor from `coder-fast` lane using existing registry, returning `{architect: {host, model, reasoning}, editor: {host, model, reasoning}, fallback}`
- [x] Add `registerArchitectEditorTools` function to `xx-stack/mcp-server/src/routing_tools.ts` that registers `route_architect_editor` MCP tool with Zod schema for `{description, preferArchitectHost?, preferEditorHost?}` and handler calling `routeArchitectEditor`
- [x] Wire `registerArchitectEditorTools` into `xx-stack/mcp-server/src/index.ts` by adding import and calling it in the existing tool registration pattern
- [x] Add test file `xx-stack/mcp-server/src/routing_runtime.test.ts` with three test cases: distinct deep/fast lanes resolve correctly, single lane collapses both with clear reasoning, cloud excluded by default
- [x] Ensure the `routeArchitectEditor` function respects `XX_STACK_ALLOW_CLOUD` environment variable for cloud exclusion, reusing the existing gate logic
- [x] Run `npm run verify` to confirm all checks pass and the repository remains green
