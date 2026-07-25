# @xx-stack/mcp-server

Local-first routing and supervision for AI coding agents, exposed over
[MCP](https://modelcontextprotocol.io).

33 tools covering platform inventory, health checks, task routing, agent
profiles, and supervision of long-running work.

**Cloud is off by default.** Routing never selects a cloud host unless you set
`selectionPolicy.cloudEscalation.optIn` in your registry or export
`XX_STACK_ALLOW_CLOUD=1` — even when every self-hosted lane is unreachable.

## Use it

Add to your MCP host config:

```json
{
  "mcpServers": {
    "xx-stack-platform-routing": {
      "command": "npx",
      "args": ["-y", "@xx-stack/mcp-server"]
    }
  }
}
```

The server starts with no configuration and reports that no lane is reachable
until you point it at a platform registry:

```bash
export XX_STACK_REPO=/path/to/xx-stack/xx-stack   # contains runtime/platforms.json
```

It also reads a live registry from `~/.config/opencode/xx-stack-platforms.json`
when present, which takes precedence.

## Registry

The registry describes your machines, how they are reached, and what runs on
them. In the full repo it is generated from a single `inventory.json`, including
Tailscale auto-discovery. See the project README for that workflow.

## Source

https://github.com/piercingxx/xx-stack — MIT.
