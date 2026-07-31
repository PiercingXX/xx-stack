# Goal

Add an MCP tool that, given a repo root and a token budget, returns the most
relevant slice of the codebase (ranked files + key symbols) to feed into a
routed task. xx-stack routes a task to a machine but never decides what code
context goes in the prompt — and that matters most for the small local models
this stack targets, where the window is tight.

# Requirements

- Tool `build_repo_map`, args:
  `{ root: string, tokenBudget?: number (default 8000), focusPaths?: string[],
  includeSymbols?: boolean }`.
- PHASE 1 ONLY in this task, no new dependencies: rank by cheap signals — git
  recency, path proximity to `focusPaths`, and import/reference counts via
  regex — returning a ranked file list with byte/line ranges that fit the
  budget. Phase 2 (tree-sitter) is explicitly OUT of scope; leave the return
  shape ready for it.
- Return `{ files: [{ path, score, ranges, symbols? }], tokensEstimated,
  method: "heuristic"|"treesitter" }` — `method` is "heuristic" here.
- Respect `.xxignore` (an existing repo convention) and `.gitignore`.
- No network calls. Must work with zero optional deps installed.

# Files

- New: `xx-stack/mcp-server/src/repo_map_runtime.ts` (pure logic + ranking)
- New: `xx-stack/mcp-server/src/repo_map_tools.ts` (the tool)
- New: `xx-stack/mcp-server/src/repo_map_runtime.test.ts`
- Edit: `xx-stack/mcp-server/src/index.ts` (register the tool group)

# Ground rules for this repo (from its own TODO — non-negotiable)

- New MCP tools register via `server.tool(name, description, zodSchema, handler)`
  and are wired in `xx-stack/mcp-server/src/index.ts` through a
  `registerXxxTools(server, deps)` function — see `routing_tools.ts` for the
  canonical shape. Follow it; do not invent a second registration style.
- Tests use the built-in `node:test` runner (see `reliability.test.ts`). Add a
  `*.test.ts` beside new runtime files.
- The MCP server is ESM (`"type": "module"`) — import local files WITH the `.js`
  extension. Shared `xx-stack/scripts/*.js` helpers are CommonJS; ESM
  entrypoints use `.mjs`.
- After any change touching `inventory.json`/schema/registries: run
  `npm run inventory:sync` then `npm run inventory:check` (CI fails on drift).
- xx-stack is a HEADLESS, local-first MCP control plane. No GUI. Cloud stays
  opt-in. `inventory.json` stays the single source of truth.
- Final gate: `npm run verify` (layout + agents + drift + inventory + tests +
  hermes). It is green on a clean checkout — keep it that way.

# Rules carried from the Skippy side (earned the hard way)

- SCOPE IS LAW: touch only the files this task names. Report anything else you
  find; never fix it in passing.
- A numeric limit or a security property needs an assertion against the REAL
  artifact, not a fixture.
- Verify commands must be quote-free shell and must be capable of FAILING if
  the claim is false.

# Acceptance criteria

1. Returns a budget-respecting ranked map on THIS repo in under 2 seconds —
   assert against the real repository, not a fixture.
2. `focusPaths` measurably reorders results toward the focus (test asserts a
   file under the focus path outranks one outside it).
3. Unit tests cover budget truncation, ignore-file filtering, focus reordering.
4. `npm run verify` green.
