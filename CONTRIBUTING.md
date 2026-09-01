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
CI-parity (`ci:parity`), `lint`, `format:check`, the five design-pack gates
(`design:golden`, `design:html-gate`, `design:systems-lint`,
`design:craft-refs`, `design:anti-slop-test`), the MCP server suite, and the
Hermes suite.

The two suites are the same set as of 2026-08-14, and that is a property worth
keeping rather than an accident. Until then CI skipped six gates that `verify`
ran:
`rules:check`, `nano:check`, `guardrails:check`, `design:systems-lint`,
`design:craft-refs` and `design:anti-slop-test` existed, passed locally, and
never ran on a pull request. **If you add a gate to `verify`, add it to
`ci.yml` in the same commit.**

Three things CI does that `verify` does not, so a green local run is strong
evidence but not proof:

- CI runs the MCP server suite on **Node 20 and 22**; `verify` runs it on
  whatever Node you have.
- CI regenerates `DESIGN-CATALOG.md` (`npm run design:catalog`) and fails if the
  committed copy is stale. `verify` does not, because it mutates the tree.
- CI runs `npm audit --omit=dev --audit-level=high`. `verify` does not, because
  it needs the network and should stay runnable offline. Dev-only advisories are
  deliberately not a gate; [SECURITY.md](SECURITY.md) says why.

Nothing runs in `verify` that CI skips. If you touched the design pack, run
`npm run design:catalog` and commit the result. Otherwise, treat CI as the
authority.

### Git Hooks

```bash
git config core.hooksPath .githooks
```

The pre-commit hook runs `npm run drift:check` to verify the OpenCode copies
have not drifted from `runtime/`.

## Repository Structure

Three components live at the top level. See the [README](README.md) for what
each one is.

**`xx-stack/` is the source of truth.** `opencode-orchestration/` symlinks to it
for `mcp-server/`, `scripts/`, and `packs/` rather than keeping its own copies:

```
opencode-orchestration/mcp-server  ->  ../mcp-server
opencode-orchestration/scripts     ->  ../scripts
opencode-orchestration/packs       ->  ../packs
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
- Prettier is deliberately **not** applied to `packs/` — that content is
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
`scripts/` are a deliberate mix of ESM (`.mjs`) and CommonJS (`.js`) —
see the `//type` note in the root `package.json` — so `eslint.config.mjs` gives
them their own overrides: the default parser (they are not in `tsconfig.json`'s
program), `sourceType` split by extension. The vendored design pack
(`packs/**`) is ignored alongside the OpenCode pack copy; it is
upstream content, not ours to restyle.

Lint must be **clean of errors**. Warnings are allowed but should not grow.
`npm run lint` currently reports **0 errors and 0 warnings**.

### Dependencies and Portability

- **Dependency budget.** A new runtime dependency in `mcp-server`
  needs justification in the PR — what it does that a `node:` built-in cannot,
  and why vendoring or writing it is worse. Prefer built-ins (the repo already
  uses `node:test` over jest and `node:util` `parseArgs` over an argument
  parser). Dev-only tooling gets more latitude, but the same question applies.
- **Prefer web-standard APIs** (`fetch`, Web Streams, Web Crypto) over
  Node-specific equivalents where they are genuinely equivalent, so the server
  stays portable to Bun/Deno without a rewrite. This is applied
  opportunistically — when you touch a file anyway — not as a churn campaign.

### MCP Tool Development

Full procedure in MANUAL §4 and §12. Two rules a PR is rejected for missing:

- **Register with `server.registerTool(name, config, handler)`.** Every
  `server.tool(...)` overload is `@deprecated` in the SDK we ship and cannot
  express `title`, `outputSchema`, or annotations. A test in
  `observability_tools.test.ts` fails on any remaining `server.tool(` call site.
- **Declare all four annotations** (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`) on the tool's `TOOL_CATALOG` entry, and
  pass them as `annotations: toolAnnotations("<name>")`. One place per tool —
  a second map is the mistake MCP-13 records. Undeclared tools fall back to
  destructive + open-world and fail the drift test, so the gate fails closed
  rather than quietly marking a writer safe to auto-approve.

### Agent Development

Canonical agent contracts live in `runtime/agents/`. The
OpenCode-specialized copies live in `opencode-orchestration/opencode/agents/`
and are gated by `npm run drift:check`.

1. Update the canonical agent `<name>.md`
2. Register the agent in `runtime/config.json`
3. Mirror it into `opencode-orchestration/opencode/agents/` and register it
   there too
4. `npm run drift:check` then `npm run nano:check` if you touched a nano tier

### Skill Development

1. Create `runtime/skills/<name>/SKILL.md`
2. Register it in `runtime/SKILLS.md`
3. Mirror it into `opencode-orchestration/opencode/skills/<name>/SKILL.md`
4. Add a `packs/rules/coverage.json` entry

Skill mirrors are copies, not symlinks, and are **not** generated — so
`npm run drift:check` gates them. It compares names *and content*, normalizing
only the deliberate deltas (`compatibility:`, `model:` pins and the pinned-lane
`description:` tail, `runtime/`→`opencode/` path rewrites, and OpenCode's nested
`skill:` permission syntax).

Anything else that differs is drift, and canonical wins: resync the mirror.
Only if a divergence is genuinely deliberate, add it to `KNOWN_DELTAS` in
`scripts/check-stack-source-drift.mjs` **with a reason** — the entry
must match the exact lines, so it cannot silently swallow the next change. Run
`node scripts/check-stack-source-drift.mjs --names-only` or
`--content-only` to isolate one half while debugging.

### Hardware and Endpoint Config — generated, do not hand-edit

`inventory.json` is the only file you edit to describe machines, networks, and
installed runtimes. These three are **generated from it** and carry a
`_generated` banner:

- `runtime/platforms.json` (built from `inventory.example.json`, so the
  core stays host-agnostic and no clone ships the maintainer's hardware)
- `opencode-orchestration/opencode/platforms.json`
- `hermes-orchestration/config/orchestration.json` — the `lanes` block and the
  cloud-gate fields only; its `execution` and `proxy` sections stay hand-tuned

Run `npm run inventory:sync` after any change. `npm run inventory:check` is part
of `npm run verify` and runs in CI, so drift fails the build rather than
silently diverging.

Adding support for a new inference server means adding one entry to the
`RUNTIMES` table in `scripts/generate-registries.mjs` and one value to
the `kind` enum in `inventory.schema.json`. Note that `endpointFamily` (how the
TypeScript registry inspects models) and `hermesEndpointType` (how Hermes dials
it) are deliberately separate — Ollama is its own family to the TS side but
plain `openai_compatible` to Hermes.

### Routing and Cloud Escalation

Cloud routing is gated by `cloudRoutingAllowed()` in
`mcp-server/src/routing_selection_runtime.ts`, which is fail-safe: an
absent or `false` `selectionPolicy.cloudEscalation.optIn` disables cloud
entirely. **Do not add a code path that reaches a cloud provider without passing
through that gate**, and do not change its default.

### Testing

```bash
npm test              # MCP server suite (547 tests)
npm run hermes:test   # Hermes control plane (83 tests)
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
