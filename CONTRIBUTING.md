# Contributing to xx-stack

Thanks for your interest in contributing. This document covers the development
setup and the conventions that CI enforces.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/xx-stack.git`
3. Create a branch: `git checkout -b feature/your-feature-name`

## Development Setup

### Prerequisites

- Node.js 20+
- Python 3.11+ (only if you touch `hermes-orchestration/`)
- Git

### Installation

```bash
npm install

# Full verification gate — layout, agent sync, and every test suite
npm run verify
```

`npm run verify` runs every gate CI runs in a single pass: layout, agent mirror
sync, drift, rules coverage, nano tiers, inventory registries, guardrails,
`lint`, `format:check`, the two design-pack gates (`design:golden`,
`design:html-gate`), the MCP server suite, and the Hermes suite.

Two things CI does that `verify` does not, so a green local run is strong
evidence but not proof:

- CI runs the MCP server suite on **Node 20 and 22**; `verify` runs it on
  whatever Node you have.
- CI regenerates `DESIGN-CATALOG.md` (`npm run design:catalog`) and fails if the
  committed copy is stale. `verify` does not, because it mutates the tree.

If you touched the design pack, run `npm run design:catalog` and commit the
result. Otherwise, treat CI as the authority.

### Git Hooks

```bash
git config core.hooksPath .githooks
```

The pre-commit hook runs `npm run agents:check` to verify the VS Code agent
mirrors have not drifted from the canonical contracts.

## Repository Structure

Three components live at the top level. See the [README](README.md) for what
each one is.

**`xx-stack/` is the source of truth.** `opencode-orchestration/` symlinks to it
for `mcp-server/`, `scripts/`, and `packs/` rather than keeping its own copies:

```
opencode-orchestration/mcp-server  ->  ../xx-stack/mcp-server
opencode-orchestration/scripts     ->  ../xx-stack/scripts
opencode-orchestration/packs       ->  ../xx-stack/packs
```

Editing a file "in" `opencode-orchestration/` through one of those symlinks
edits the file in `xx-stack/`. That is intentional — but make the edit at the
real path so the diff is legible.

`hermes-orchestration/` is fully standalone: Python standard library only, no
dependency on the TypeScript stack.

## Contribution Guidelines

### Code Style

- ESLint and Prettier are enforced on TypeScript sources:
  `npm run lint` and `npm run format:check`
- Prettier is deliberately **not** applied to `xx-stack/packs/` — that content is
  largely vendored and reformatting it obscures real diffs. See `.prettierignore`.
- Follow existing patterns; keep functions focused on a single responsibility.

`.eslintrc.json` carries one deliberate exemption that JSON cannot self-document:
`no-console` is disabled for four standalone CLI entrypoints
(`monitor-memory.ts`, `parallel-preflight.ts`, `parallel-smoke.ts`,
`trace-provider-proxy.ts`). Each has a shebang, is wired to an npm script, and
exists to print a human-readable report to stdout. They are listed by exact path
rather than globbed, so a new file does not silently inherit the exemption — if
you add a CLI entrypoint, add it to that list explicitly.

`npm run lint` covers `.ts`, `.mjs`, and `.js`. The scripts under
`xx-stack/scripts/` are a deliberate mix of ESM (`.mjs`) and CommonJS (`.js`) —
see the `//type` note in the root `package.json` — so `.eslintrc.json` gives
them their own overrides: the default parser (they are not in `tsconfig.json`'s
program), `sourceType` split by extension, and `no-require-imports` off for the
CommonJS half. The vendored design pack (`xx-stack/packs/**`) is in
`ignorePatterns` alongside the OpenCode pack copy; it is upstream content, not
ours to restyle.

Lint must be **clean of errors**. Warnings are allowed but should not grow.
`npm run lint` currently reports **0 errors and 1 warning**: a missing return
type at `xx-stack/mcp-server/src/index.ts:130`
(`@typescript-eslint/explicit-function-return-type`). That is the only
outstanding warning — annotate it and this section should say zero.

### Dependencies and Portability

- **Dependency budget.** A new runtime dependency in `xx-stack/mcp-server`
  needs justification in the PR — what it does that a `node:` built-in cannot,
  and why vendoring or writing it is worse. Prefer built-ins (the repo already
  uses `node:test` over jest and `node:util` `parseArgs` over an argument
  parser). Dev-only tooling gets more latitude, but the same question applies.
- **Prefer web-standard APIs** (`fetch`, Web Streams, Web Crypto) over
  Node-specific equivalents where they are genuinely equivalent, so the server
  stays portable to Bun/Deno without a rewrite. This is applied
  opportunistically — when you touch a file anyway — not as a churn campaign.

### Agent Development

Canonical agent contracts live in `xx-stack/runtime/agents/` (and, for the
OpenCode-specialized surface, `opencode-orchestration/opencode/agents/`). Both
editor mirrors are **generated — never hand-edit them**:

| Canonical source | Generated mirror |
|---|---|
| `xx-stack/runtime/agents/` | `xx-stack/adapters/agents/` |
| `opencode-orchestration/opencode/agents/` | `opencode-orchestration/vscode/agents/` |

1. Update the canonical agent `<name>.md`
2. Register the agent in that component's `config.json`
3. Run `npm run agents:sync` to regenerate the mirrors
4. Test with your MCP-compatible host

`npm run agents:check` derives the expected mirror set for **each component** by
reading its agent directory, so a new agent fails the check until step 3 is
done. If the agent deliberately gets no editor mirror — a health probe, a
compatibility alias — add it to that component's `NOT_MIRRORED` in
`xx-stack/scripts/sync-vscode-agents.mjs` **with a reason**. There is no third
option: the check will not quietly skip it. `*.nano.md` variants are derived
tiers, not agents, and are covered by `npm run nano:check` instead.

The generated mirror carries the canonical body verbatim plus `name`,
`description`, and `tools`. It deliberately drops the source's `model:` pin:
those are OpenCode provider ids that the VS Code / Copilot surface cannot
resolve.

Tool lists for a new mirror are derived from the agent's `permission` block
(`edit: deny` drops `editFiles`, `bash: deny` drops `runCommands`). Add an entry
to `TOOL_OVERRIDES` in the same script only if the agent needs something the
permissions do not imply, such as `findTestFailures`.

### Skill Development

1. Create `xx-stack/runtime/skills/<name>/SKILL.md`
2. Register it in `xx-stack/runtime/SKILLS.md`
3. Mirror it into `opencode-orchestration/opencode/skills/<name>/SKILL.md`
4. Add adapter surfaces only when a downstream host requires them

Skill mirrors are copies, not symlinks, and are **not** generated — so
`npm run drift:check` gates them. It compares names *and content*, normalizing
only the deliberate deltas (`compatibility:`, `model:` pins and the pinned-lane
`description:` tail, `runtime/`→`opencode/` and `adapters/`→`vscode/` path
rewrites, and OpenCode's nested `skill:` permission syntax). The same check
covers `xx-stack/adapters/skills/` against
`opencode-orchestration/vscode/skills/`, which are hand-maintained on both
sides.

Anything else that differs is drift, and canonical wins: resync the mirror.
Only if a divergence is genuinely deliberate, add it to `KNOWN_DELTAS` in
`xx-stack/scripts/check-stack-source-drift.mjs` **with a reason** — the entry
must match the exact lines, so it cannot silently swallow the next change. Run
`node xx-stack/scripts/check-stack-source-drift.mjs --names-only` or
`--content-only` to isolate one half while debugging.

### Hardware and Endpoint Config — generated, do not hand-edit

`inventory.json` is the only file you edit to describe machines, networks, and
installed runtimes. These three are **generated from it** and carry a
`_generated` banner:

- `xx-stack/runtime/platforms.json` (built from `inventory.example.json`, so the
  core stays host-agnostic and no clone ships the maintainer's hardware)
- `opencode-orchestration/opencode/platforms.json`
- `hermes-orchestration/config/orchestration.json` — the `lanes` block and the
  cloud-gate fields only; its `execution` and `proxy` sections stay hand-tuned

Run `npm run inventory:sync` after any change. `npm run inventory:check` is part
of `npm run verify` and runs in CI, so drift fails the build rather than
silently diverging.

Adding support for a new inference server means adding one entry to the
`RUNTIMES` table in `xx-stack/scripts/generate-registries.mjs` and one value to
the `kind` enum in `inventory.schema.json`. Note that `endpointFamily` (how the
TypeScript registry inspects models) and `hermesEndpointType` (how Hermes dials
it) are deliberately separate — Ollama is its own family to the TS side but
plain `openai_compatible` to Hermes.

### Routing and Cloud Escalation

Cloud routing is gated by `cloudRoutingAllowed()` in
`xx-stack/mcp-server/src/routing_selection_runtime.ts`, which is fail-safe: an
absent or `false` `selectionPolicy.cloudEscalation.optIn` disables cloud
entirely. **Do not add a code path that reaches a cloud provider without passing
through that gate**, and do not change its default.

### Testing

```bash
npm test              # MCP server suite (290 tests)
npm run hermes:test   # Hermes control plane (25 tests)
npm run layout:verify # Component layout and compatibility symlinks
```

Add tests for new functionality. The design pack has two gates, both run by
`npm run verify` and by CI:

- `npm run design:golden` — golden-task scoring for the agent contracts.
- `npm run design:html-gate` — structural gate over every HTML template and
  example in the pack. With no arguments it sweeps the pack and applies the
  **generic** gates (document shell, semantic layout, no external code). Pass
  `--skill <name>` and it additionally applies that skill's **acceptance
  profile** (section count, `<h1>`, CTA, keywords) — that is the mode an agent
  uses on its own generated artifact, and it is deliberately stricter than the
  sweep, because a finished deliverable is held to more than a seed template is.

Two scoping rules in that gate are worth knowing before you file a bug against
it:

- **Webfont CDNs are not "external dependencies."** `<link>` to
  `fonts.googleapis.com`/`fonts.gstatic.com` passes, and so do `preconnect` /
  `preload` hints. Skills instruct webfonts by name (see
  `workflow-skills/wireframe-sketch/SKILL.md`). External CSS or JS from any
  other host still fails.
- **Fragments are not documents.** A file with no `<html>` and no `<body>` is
  markup meant to be included elsewhere, so doctype / viewport / `<title>` /
  `:root` are skipped for it. Content rules still apply.

Profiles may set `requireSemanticLayout: false` for surfaces that are fixed
canvases rather than documents (sprite sheets, device-frame screens, wireframe
canvases). Genuine one-off deviations go in the `exempt` map in
`workflow-skills/quality-gates.json`, **with a reason** — it is a record of a
decision, not a mute button.

### The `.xxignore` file

`.xxignore` is the repo-local _agent context_ boundary — it tells agents what not
to sweep into context. It is not a substitute for `.gitignore`, which governs
what must not be committed. If you add a large vendored or generated surface,
add it to both.

### Documentation

- Update `README.md` for user-facing changes
- Update this file for process changes
- Keep machine-specific details (hostnames, IPs, absolute paths) out of
  committed files — use placeholders and document the substitution

## Pull Request Process

1. Run `npm run verify` and make sure it passes
2. Update documentation as needed
3. Ensure all CI checks pass
4. Address review comments and push updates

## Code of Conduct

- Be respectful and inclusive
- Accept constructive criticism gracefully
- Focus on what is best for the community
- Show empathy towards other community members

## Questions?

Open an issue.
