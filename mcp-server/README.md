# @xx-stack/mcp-server

Local-first routing and supervision for AI coding agents, exposed over
[MCP](https://modelcontextprotocol.io).

Routing, supervision, tasks, memory, and evidence tools, plus 2
lifecycle hook tools (`_Stop`, `_PostCompact`) registered only when
`XX_STACK_HOOK_TOOLS=1`. Specialized routing (watchdog, architect/editor,
competitive, review) is `route_task` with a `mode` argument.
`XX_STACK_TOOL_SURFACE=routing` keeps only inventory, health, routing, and
`search_tools`. Continuation / handoff / review / compaction prompts are the
`compose-supervisor-prompts` skill, not MCP tools.

**Cloud is off by default.** Routing never selects a cloud host unless you set
`selectionPolicy.cloudEscalation.optIn` in your registry or export
`XX_STACK_ALLOW_CLOUD=1` — even when every self-hosted lane is unreachable.

## Use it

Add to your MCP host config:

```json
{
  "mcpServers": {
    "xx-stack-platform-routing": {
      "command": "node",
      "args": ["/absolute/path/to/xx-stack/mcp-server/dist/index.js"]
    }
  }
}
```

The server starts with no configuration and reports that no lane is reachable
until you point it at a platform registry:

```bash
export XX_STACK_REPO=/path/to/xx-stack   # git root; contains runtime/platforms.json
```

It also reads a live registry from `~/.config/opencode/xx-stack-platforms.json`
when present, which takes precedence.

## Registry

The registry describes your machines, how they are reached, and what runs on
them. In the full repo it is generated from a single `inventory.json`, including
Tailscale auto-discovery. See the project README for that workflow.

## Source

https://github.com/piercingxx/xx-stack — MIT.
