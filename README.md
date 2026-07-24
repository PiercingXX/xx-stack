# xx-stack

**Local-first orchestration for AI coding agents.**

xx-stack decides *where* an agent's work should run — your own machine first,
your own GPU boxes second, a cloud provider only if you explicitly turn it on —
and gives agents the contracts, skills, and supervision to finish long tasks
without babysitting.

It ships as an [MCP](https://modelcontextprotocol.io) server exposing 33 tools
for routing, health checks, agent profiles, and long-running task supervision.
Any MCP-compatible host can load it (OpenCode, VS Code / Copilot,
and others).

> **Cloud is off by default.** Routing never selects a cloud host unless you set
> `selectionPolicy.cloudEscalation.optIn: true` or export `XX_STACK_ALLOW_CLOUD=1`
> — even when every self-hosted lane is unreachable.

---

## Try it in 5 minutes (no special hardware)

You do not need a GPU, a second machine, or Tailscale to see this working.

```bash
git clone https://github.com/piercingxx/xx-stack
cd xx-stack
npm install
npm --prefix xx-stack/mcp-server run build
```

Confirm the routing server starts and reports its tools:

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node xx-stack/mcp-server/dist/index.js
```

You should see a handshake response followed by 33 tools. That is the whole
server — it runs with no providers configured, and simply reports that no lane
is reachable until you add one.

Run the full verification gate to confirm your checkout is healthy:

```bash
npm run verify
```

This runs the layout checks, agent-mirror sync check, 58 TypeScript tests, and
25 Python tests for the Hermes control plane.

### Route your first task

Point the server at the shipped registry and ask it where a task should run.
This needs no model and no network — routing is a pure decision over the
registry:

```bash
export XX_STACK_REPO="$PWD/xx-stack"

printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"route_task","arguments":{"description":"implement a small bug fix and run tests"}}}' \
  | node xx-stack/mcp-server/dist/index.js
```

You get back a routing decision, including the cloud gate refusing to engage:

```json
{
  "recommendedTier": "local",
  "recommendedHost": "local-fallback",
  "recommendedModel": "coder-fast",
  "reasoning": "Matched keywords for \"local\" tier (score: 4); cloud tier excluded (cloud escalation requires opt-in via selectionPolicy.cloudEscalation.optIn or XX_STACK_ALLOW_CLOUD=1); selected model \"coder-fast\" using host roles and task intent",
  "availableModels": ["coder-fast", "coder-main"],
  "fallback": "primary"
}
```

That is the core loop: describe work, get a lane. Everything else in this repo
exists to make that decision better or to act on it.

### Then point it at a real model

The shipped registry (`xx-stack/runtime/platforms.json`) is an **example** — the
hosts in it resolve to `.invalid` domains on purpose. Edit it to describe hosts
you actually have. The simplest real setup is a local OpenAI-compatible
endpoint — Ollama, llama.cpp's `llama-server`, LocalAI, or anything else that
speaks `/v1/chat/completions`:

```bash
ollama serve            # exposes http://127.0.0.1:11434
```

Then set that endpoint on the `local` tier host in `platforms.json`, re-run the
`route_task` call above, and `check_health` to confirm the lane is reachable.
Nothing else in this repo is required to get value out of it.

---

## What's in here

This repo holds three components that are useful separately and better together.

| Component | What it is | Start here if you want to… |
|---|---|---|
| **[`xx-stack/`](xx-stack/)** | The core. Agent contracts, skills, the routing MCP server, the design content pack. Host-agnostic. | Load the MCP server into any agent host, or reuse the agent/skill contracts. |
| **[`opencode-orchestration/`](opencode-orchestration/)** | The OpenCode integration layer. Installs, registers, and syncs the stack into an OpenCode or VS Code environment. | Actually *install* the stack into a working editor setup. |
| **[`hermes-orchestration/`](hermes-orchestration/)** | A standalone Python control plane that routes inference across self-hosted lanes over Tailscale, with a loopback OpenAI-compatible proxy. | Route raw inference across your own GPU boxes. No Node.js involved. |

**If you're not sure where to start: read this file, then
[`xx-stack/README.md`](xx-stack/README.md).** The other two are opt-in.

### How they relate

`xx-stack/` is the source of truth. To avoid two copies drifting apart,
`opencode-orchestration/` reaches into it by symlink rather than duplicating:

```
opencode-orchestration/mcp-server  ->  ../xx-stack/mcp-server
opencode-orchestration/scripts     ->  ../xx-stack/scripts
opencode-orchestration/packs       ->  ../xx-stack/packs
```

Edit the files under `xx-stack/`; both components see the change.

`hermes-orchestration/` has no code dependency on the other two and can be
copied out and used on its own. It can also plug into the routing layer as a
**single lane** — see below.

### Using Hermes as a routing lane

Hermes exposes its own self-hosted-first lane policy behind one
OpenAI-compatible loopback endpoint. The shipped registries already contain a
`hermes-proxy` host in the `local` tier, **disabled by default**. Turning it on
lets xx-stack delegate lane selection to Hermes instead of picking a backend
directly:

```bash
# 1. Give the proxy a token and start it
mkdir -p ~/.config/hermes-orchestration
printf 'HERMES_PROXY_TOKEN=%s\n' "$(openssl rand -hex 24)" \
  > ~/.config/hermes-orchestration/proxy.env
chmod 600 ~/.config/hermes-orchestration/proxy.env

set -a; . ~/.config/hermes-orchestration/proxy.env; set +a
python3 hermes-orchestration/scripts/hermes_orchestrator.py serve &

# 2. Confirm it is up
curl -s http://127.0.0.1:8180/healthz

# 3. Flip enabled -> true on the hermes-proxy host
#    in xx-stack/runtime/platforms.json
```

The `hermes-auto` model on that host is virtual: Hermes resolves the real
backend per its own policy, so xx-stack sees one stable lane instead of needing
to know about every GPU box.

---

## Requirements

- **Node.js 20+** — for the MCP server and tooling
- **Python 3.11+** — only for `hermes-orchestration/` (standard library only)
- **An MCP-compatible host** — OpenCode, VS Code, or your own client
- **At least one reachable model provider** — local or remote; see above

---

## Common commands

Run from the repo root.

| Command | What it does |
|---|---|
| `npm run verify` | Full gate: layout, agent sync, all tests |
| `npm test` | MCP server test suite (58 tests) |
| `npm run hermes:test` | Hermes control plane tests (25 tests) |
| `npm run layout:verify` | Check both components' file layout and symlinks |
| `npm run lint` / `npm run format` | ESLint / Prettier over the TypeScript sources |
| `npm run agents:sync` | Regenerate VS Code agent mirrors from canonical contracts |
| `npm run design:catalog` | Regenerate the design system catalog |
| `npm run design:golden` | Run the golden-task evaluations |

Enable the pre-commit hook that keeps agent mirrors in sync:

```bash
git config core.hooksPath .githooks
```

---

## A note on the examples

The registries and docs reference a machine called `skippy-debian-5090` — a
8×RTX 5090 Debian box reached over Tailscale. **That is the author's hardware,
included as a worked example, not a requirement.** Replace those hosts with your
own (or delete them) in:

- `xx-stack/runtime/platforms.json`
- `opencode-orchestration/opencode/platforms.json`
- `hermes-orchestration/config/orchestration.json`

Nothing here assumes you have that rig. The stack degrades to "route everything
locally" when no other lane is reachable.

---

## Layout

```
.
├── xx-stack/                  Core: agents, skills, MCP server, design pack
├── opencode-orchestration/    OpenCode + VS Code install layer
├── hermes-orchestration/      Python inference control plane (standalone)
├── .github/workflows/ci.yml   CI: layout, lint, tests, design pack, hermes
└── .xxignore                  Agent context boundary (see CONTRIBUTING.md)
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: `npm run verify` must pass,
canonical agent contracts live in `xx-stack/runtime/agents/` (the
`adapters/` mirrors are generated), and generated files stay out of git.

## License

[MIT](LICENSE).

The design content pack under `xx-stack/packs/design/` includes material derived
from upstream projects that carry their own licenses and attribution — see the
`LICENSE` files within those skill directories.
