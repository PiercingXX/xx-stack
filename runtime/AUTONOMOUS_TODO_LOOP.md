# Autonomous Todo Loop

This runbook turns `execution-orchestrator` into a Ralph-style outer loop with disk-backed state.

## Why This Exists

Prompt instructions alone do not force another iteration. The outer loop provides the missing control plane:

- durable todo and contract state on disk
- deterministic completion signal parsing
- retry and stall detection
- per-iteration logs and resumable state

## Command

Run from the repository root:

```bash
node scripts/run-agent-loop.mjs \
  --runner 'your-agent-command-that-reads-stdin' \
  --runner-timeout-ms 900000 \
  --todo TODO.md \
  --goal 'Finish the entire todo plan without stopping for intermediate updates.'
```

The `--runner` command must:

- read the prompt from stdin
- execute the agent in the current repo
- write the agent response to stdout

For OpenCode, prefer the dedicated wrapper:

```bash
node scripts/run-opencode-loop.mjs \
  --todo TODO.md
```

That wrapper automatically routes prompts through `scripts/opencode-stdin-runner.mjs`, builds a job-scoped minimal OpenCode HOME under the loop state, and runs a preflight that proves both basic liveness and one real tool round-trip before iteration 1.

The loop also supports host health validation before iteration 1 for generic non-OpenCode runners:

```bash
node scripts/run-agent-loop.mjs \
  --runner 'your-runner-that-reads-stdin' \
  --runner-preflight 'your-fast-health-check-command' \
  --preflight-input 'health check input' \
  --preflight-success 'expected marker' \
  --preflight-timeout-ms 45000 \
  --todo TODO.md
```

For OpenCode, prefer `scripts/run-opencode-loop.mjs` rather than manually reproducing this wiring. Use `--use-live-home` only when you need to debug the installed host config directly.

If that wrapper exits with `runner-unhealthy`, treat the current OpenCode runtime as not viable for unattended autonomous work in that environment. The safe behavior is to stop immediately instead of retrying loop iterations against a transport that is only staging messages or hanging before tool execution.

Use preflight when the host runner might hang or fail before your real stack prompt is even processed.

## Generated State

The runner creates state under `.xx-stack/loops/<todo-name>/` by default:

- `loop-manifest.json` — outer-loop session metadata
- `OUTER_LOOP_STATE.md` — current iteration summary and escalation hints
- `ACTIVE_COMPLETION_CONTRACT.md` — the current slice contract if you do not pass a custom path
- `logs/iteration-XXX-prompt.md` — exact prompt per iteration
- `logs/iteration-XXX-stdout.log` and `logs/iteration-XXX-stderr.log` — raw agent output
- `logs/preflight-stdout.log` and `logs/preflight-stderr.log` — runner health probe logs when preflight is enabled

## Exit Conditions

- success: the agent emits the completion promise, default `<promise>DONE</promise>`
- runner-unhealthy: the optional preflight command timed out, failed, missed the required success marker, or exposed a headless transport that cannot complete a tool loop
- blocked: the agent emits `<loop-state>BLOCKED</loop-state>`
- stalled: no durable progress is detected for the configured stalled threshold
- exhausted: max iterations is reached

## Reliability Notes

- Progress is measured from the todo file, completion contract, and git workspace fingerprint.
- Each runner invocation is bounded by `--runner-timeout-ms`, so a hung host process cannot block the loop forever.
- Preflight can prove the host runtime is healthy before iteration 1, which is critical for headless OpenCode-style runs.
- A stalled streak of 2 or more instructs the agent to decompose the current todo item before more code changes.
- The loop is resumable because all control state is written to disk.

## Important Limitation

This design maximizes unattended completion reliability, but no model-driven system can guarantee perfect correctness on every task. The outer loop guarantees deterministic retry and state recovery, not perfect model judgment.

For OpenCode specifically, the current headless dev build still has a deeper transport limitation in addition to the older liveness problems: a clean `opencode serve` session API can create sessions and stage user/assistant messages, but it still does not reliably drive a full assistant response or tool loop from the exposed HTTP routes. Until that changes upstream, `scripts/run-opencode-loop.mjs` should be treated as a fail-fast safety wrapper, not as a guaranteed unattended execution path.