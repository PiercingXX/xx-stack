# Goal

A routing pattern where one model reasons/plans the change and a second,
cheaper/faster model applies it — each potentially on a different machine.
This is xx-stack's own thesis (heterogeneous machines, heterogeneous roles)
applied one level deeper.

# Requirements

- Tool `route_architect_editor`, args:
  `{ description, preferArchitectHost?, preferEditorHost? }`.
- Reuse EXISTING tier selection: a reasoning-strong lane for the architect
  (the `coder-deep` alias / reasoning role) and a low-latency lane for the
  editor (`coder-fast`), both drawn from the live registry. Do not invent a
  parallel selection mechanism.
- Output `{ architect: {host, model, reasoning}, editor: {host, model,
  reasoning}, fallback }`, mirroring the existing `route_task` result shape
  so callers stay uniform.
- This is a ROUTING RECOMMENDATION ONLY. Do not execute edits here —
  execution is the agent's job, and that boundary is what keeps this server
  headless.
- Cloud stays excluded unless the existing opt-in gate is set
  (`XX_STACK_ALLOW_CLOUD=1`); reuse the gate, do not re-implement it.

# Files

- Edit: `xx-stack/mcp-server/src/routing_runtime.ts` (add `routeArchitectEditor`)
- Edit: `xx-stack/mcp-server/src/routing_tools.ts` (the new tool)
- Edit/New: `xx-stack/mcp-server/src/routing_runtime.test.ts`
- Reference only: `hermes-orchestration/model-qualification-matrix.md`,
  `xx-stack/runtime/model-recommendations.json`
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

1. Given a registry with distinct deep/fast lanes, architect and editor
   resolve to different, appropriate lanes.
2. With only one lane available, both collapse to it WITH clear reasoning in
   the output (not a silent duplicate).
3. Cloud excluded by default; included only under the existing opt-in.
4. Tests cover all three cases. `npm run verify` green.
