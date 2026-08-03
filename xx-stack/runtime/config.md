# Runtime Configuration

`runtime/config.json` holds the agent registry defaults: the path to the
platform inventory (`runtime/platforms.json`) and per-agent profiles
(mode, model, required MCP servers, tool policy, memory, coordinator flags).

## Task Routing and Fallback

Routing is driven by `runtime/platforms.json`, not by this file. The registry
defines four tiers — `local`, `tailscale-ollama`, `tailscale-openai-compatible`,
and `cloud` (the canonical ids live in `runtime/runtime-constants.json`) — each
with prioritized hosts, and a `selectionPolicy` whose `defaultOrder` controls
fallback order.

Selection logic (`mcp-server/src/routing_selection_runtime.ts`):

- `scoreTiers`: Matches task keywords against tiers and selection rules.
- `hostAllowedForTask` (via `isMultimodalTask` / `isSelfHostedOpenAiLane`): Denies
  self-hosted OpenAI-compatible lanes for multimodal tasks by policy.
- `routeTask`: Picks the best-scoring tier, then falls back through
  `defaultOrder` until a tier with reachable hosts is found.

## Failure Handling

Reliability settings live under `agent.execution-orchestrator.reliability`
(merged from the repo config and the user config at
`~/.config/opencode/config.json`). On repeated failures the supervisor retries
with exponential backoff (`computeBackoffMs`) and advances through fallback
routes; stale sessions are pruned by `pruneSupervisorStore`. Both live in
`mcp-server/src/supervisor_session_runtime.ts`.
