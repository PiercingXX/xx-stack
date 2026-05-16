# xx-stack VS Code Instructions

Use xx-stack through the canonical runtime surface.

## Source Of Truth

- `runtime/agents/*.md` and `runtime/shared_instructions.md` define the real behavior contract.
- `adapters/agents/*.agent.md` and `adapters/skills/*.prompt.md` are VS Code mirrors for discovery, not separate policy sources.
- If a same-name adapter mirror disagrees with the runtime file, report drift and follow the runtime file.

## Execution Model

- Use the current VS Code chat model by default. Do not hardcode or assume a repo-managed model pin.
- Prefer accountable delegation over agent transfer-and-exit. The orchestrator keeps end-to-end responsibility unless the runtime proves native handoff and the user explicitly asks for it.
- Treat named todo or plan files as disk-backed state. Update them as you complete slices instead of keeping the whole plan only in chat.
- Do not claim completion without deterministic evidence.

## VS Code Workspace Requirements

- This repo expects the MCP server in `.vscode/mcp.json` to expose `xx-stack-platform-routing`.
- For downstream repositories, run `./setup-vscode.sh <target-project>` from this repo to install the VS Code agent mirrors, prompts, MCP wiring, and this instructions file.
- Global prompt install alone is not enough for MCP-backed orchestration. Use workspace mode when a project needs xx-stack routing and supervision tools.

## Common Validation

- `npm --prefix mcp-server test`
- `node scripts/verify-repo-layout.mjs`

## Current OpenCode Status

- Use VS Code as the primary interactive host.
- Treat headless OpenCode as fail-fast only unless `scripts/run-opencode-loop.mjs` preflight passes in the current environment.