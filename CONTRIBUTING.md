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

`npm run verify` is the same gate CI runs. If it passes locally, CI should pass.

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

Lint must be **clean of errors**. Warnings are allowed but should not grow;
`npm run lint` currently reports zero of both.

### Agent Development

Canonical agent contracts live in `xx-stack/runtime/agents/`. The files under
`xx-stack/adapters/agents/` are **generated mirrors** — never hand-edit them.

1. Update `xx-stack/runtime/agents/<name>.md`
2. Register the agent in `xx-stack/runtime/config.json`
3. Run `npm run agents:sync` to regenerate the mirrors
4. Test with your MCP-compatible host

### Skill Development

1. Create `xx-stack/runtime/skills/<name>/SKILL.md`
2. Register it in `xx-stack/runtime/SKILLS.md`
3. Add adapter surfaces only when a downstream host requires them

### Routing and Cloud Escalation

Cloud routing is gated by `cloudRoutingAllowed()` in
`xx-stack/mcp-server/src/routing_selection_runtime.ts`, which is fail-safe: an
absent or `false` `selectionPolicy.cloudEscalation.optIn` disables cloud
entirely. **Do not add a code path that reaches a cloud provider without passing
through that gate**, and do not change its default.

### Testing

```bash
npm test              # MCP server suite (58 tests)
npm run hermes:test   # Hermes control plane (25 tests)
npm run layout:verify # Component layout and compatibility symlinks
```

Add tests for new functionality. The design pack has its own gates:
`npm run design:golden` and `npm run design:html-gate`.

### The `.xxignore` file

`.xxignore` is the repo-local *agent context* boundary — it tells agents what not
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
