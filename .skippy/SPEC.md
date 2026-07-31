# Goal

Two related pieces: (a) record which EDIT FORMAT each model reliably
produces, alongside the existing reliability fields; (b) add a tool that,
after an edit, runs the project's linter/tests and returns a structured
pass/fail plus failure payload for a continuation prompt.

Edit-format choice is the single biggest lever on local-model editing
reliability, and the lint/test loop turns prompt guidance into a closed loop.

# Requirements

- `inventory.schema.json`, in the `model` definition (which already has
  `additionalProperties: true`):
  - `editFormat`: enum `["whole","diff","diff-fenced","udiff"]`
  - `editFormatReliability`: enum `["validated","unverified","unreliable"]`
- Propagate both through `xx-stack/scripts/generate-registries.mjs` into the
  generated registries.
- Add the fields to a couple of models in `inventory.example.json` and
  `inventory.json` as examples, defaulting to `unverified`. Do NOT claim
  `validated` for a model nobody has measured — that is a state assertion
  without evidence.
- New tool `verify_edit` `{ cwd, lintCmd?, testCmd? }` →
  `{ lint: {ok, output}, test: {ok, output} }`.
- `verify_edit` MUST shell out through the existing execution-policy path
  (`execution_policy.ts` / `validateExecRequest`). Do not bypass the policy
  gate — that gate is the reason this server can run headless safely.
- Truncate captured output to a sane named cap and surface the FAILING TAIL —
  that is what a continuation prompt needs. Shape the output so it can feed
  `supervisor_emit_continuation_prompt`.

# Files

- Edit: `inventory.schema.json`, `inventory.example.json`, `inventory.json`
- Edit: `xx-stack/scripts/generate-registries.mjs`
- New: `xx-stack/mcp-server/src/verify_edit_tools.ts` + matching `*.test.ts`
- Edit: `xx-stack/mcp-server/src/index.ts` (register)
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

1. Schema accepts the new fields and REJECTS values outside the enums.
2. `npm run inventory:sync` then `npm run inventory:check` clean — no drift.
3. `verify_edit` returns ok=false with the failing tail when a command fails,
   and goes through validateExecRequest (assert the policy path is used, not
   just that the command ran).
4. Output truncation asserted against a REAL oversized output, not a fixture.
5. `npm run verify` green.
