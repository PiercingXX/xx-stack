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

## Goal Contract (required shape for loop items)

Every item registered for autonomous/supervised execution carries an explicit five-part goal contract, captured at task registration (`task_create` / `task_update`, field `goalContract`):

1. `objective` — one sentence stating what the item achieves.
2. `constraints` — what must NOT change while pursuing the objective.
3. `validationCmd` (optional but strongly recommended) — the exact shell command that proves progress. Run it through `verify_edit`; the supervisor completion path expects a `verify_edit` result for this exact command in the completion evidence.
4. `stopCondition` — the verifiable condition that defines done. Completion evaluation cites this stop condition; the completion judge and forced synthesis evaluate against it.
5. `docsNote` (optional) — the docs commitment: what documentation must be updated when the goal is met.

Mandatory anti-reward-hacking clause, carried by every contract and binding on every loop iteration:

> do not delete, skip, weaken, or narrow tests to make the goal pass

That clause guards one direction only — degrading the verifier so a goal
passes. The inverse failure is manufacturing work so a run looks productive,
and it is carried alongside:

> a null result is a valid completion — do not manufacture a change to look
> productive; finding nothing worth changing is a real answer when the evidence
> shows you looked

This matters most for **prospecting** goals — find dead code, find performance
wins, find vulnerabilities. Their honest answer is often "nothing worth
changing", and a `stopCondition` written carelessly makes that answer
unreachable: the condition stays unmet by construction, `_Stop` objects at
every end-turn until the caller's rejection budget is spent, and the cheapest
way for the agent to silence the objection is to invent a diff. Write the
condition so a null result can satisfy it.

Bad — unsatisfiable when the honest answer is "none":

> stopCondition: at least one performance regression is fixed

Good — satisfiable either way, and still demands evidence:

> stopCondition: the profiler ran over the hot paths and every candidate is
> either fixed or recorded with the measurement showing it below the 5% bar

A null result is not a licence for thin evidence. Completion still has to show
the scan ran, what it was judged against, and what it found — see
SUPERVISOR_COMPLETION_LOOP_RUNBOOK.md.

Meta-prompting rule: before writing the contract, inspect the repo and surface hidden constraints (build/test commands, conventions, invariants, files other work depends on) so the contract reflects reality rather than assumptions. A contract written without that inspection is a guess, not a contract.

When a linked task carries a contract, `supervisor_complete_session` refuses `completed` until the completion evidence references the contract's `validationCmd` (reason code `goal_contract_validation_evidence_missing`), and the finalized result cites each contract's stop condition.

## Stop Gating: Hook-Aware Harnesses vs. the Prompt Contract

The contract above is enforced at the prompt layer for every harness. A *hook-aware* harness — one that adopts the underscore-prefixed MCP lifecycle-hook convention — gets the same gating enforced structurally, for free:

- `_Stop` — called by the harness when the model signals `end_turn`. It returns an empty string when there is no objection to stopping, or a bounded objection naming the concrete open supervised work (task id + unmet stop condition) otherwise. A non-empty result means the agent keeps working.
- `_PostCompact` — called by the harness after context compaction. It returns the supervised state to re-inject into the fresh context: open tasks, their goal contracts and stop conditions, worktree resume notes, leases, live sessions, and the memory entrypoint pointer.

Both hooks are ordinary MCP tools, so no protocol change is involved, and both re-derive everything from existing stores — they create no new state.

Registration is **off by default**: a harness that is not hook-aware would see `_Stop` and `_PostCompact` as ordinary callable tools. Opt in with:

```bash
XX_STACK_HOOK_TOOLS=1
```

Without the flag they are absent from `tools/list` entirely, and the loop keeps the prompt-level contract described above — the behavior is unchanged.

Provider-side contract these hooks honor (mirroring the convention's expectations):

- fast — no filesystem walks or expensive scans; callers time out at ~2.5s and treat a timeout as "no objection".
- deterministic — identical store state produces byte-identical output.
- empty string from `_Stop` means "no objection".
- bounded objections — the caller enforces a rejection budget, so each objection names one concrete unmet condition the agent can close in a single round, rather than restating the whole goal contract.
- observed state, never instructions — the caller injects this text at tool-result trust, not system trust, so the hooks report state and let the agent decide.

Scoping is optional: both hooks accept `{ agentId?, sessionId? }` and degrade to a fleet-wide open-work summary when neither is supplied.

## Generated State

The runner creates state under `.xx-stack/loops/<todo-name>/` by default:

- `loop-manifest.json` — outer-loop session metadata
- `OUTER_LOOP_STATE.md` — current iteration summary and escalation hints
- `ACTIVE_COMPLETION_CONTRACT.md` — the current slice contract if you do not pass a custom path
- `logs/iteration-XXX-prompt.md` — exact prompt per iteration
- `logs/iteration-XXX-stdout.log` and `logs/iteration-XXX-stderr.log` — raw agent output
- `logs/preflight-stdout.log` and `logs/preflight-stderr.log` — runner health probe logs when preflight is enabled
- `generations/gen_N/generation_boundary.json` — written when a generation closes (`--generation-size` or `<loop-state>GENERATION_CLOSE</loop-state>`). Canonical findings live in the MCP finding store; this file is the loop's commit acknowledgement so resume cannot rewrite that generation.

## Exit Conditions

- success: the agent emits the completion promise, default `<promise>DONE</promise>`
- runner-unhealthy: the optional preflight command timed out, failed, missed the required success marker, or exposed a headless transport that cannot complete a tool loop
- blocked: the agent emits `<loop-state>BLOCKED</loop-state>`
- stalled: no durable progress is detected for the configured stalled threshold
- exhausted: max iterations is reached
- generation close: the agent emits `<loop-state>GENERATION_CLOSE</loop-state>`, or `--generation-size N` elapses — the loop writes a boundary and continues. This is not a terminal loop status.

## Reliability Notes

- Progress is measured from the todo file, completion contract, and git workspace fingerprint.
- Each runner invocation is bounded by `--runner-timeout-ms`, so a hung host process cannot block the loop forever.
- Preflight can prove the host runtime is healthy before iteration 1, which is critical for headless OpenCode-style runs.
- A stalled streak of 2 or more instructs the agent to decompose the current todo item before more code changes.
- The loop is resumable because all control state is written to disk.

## Important Limitation

This design maximizes unattended completion reliability, but no model-driven system can guarantee perfect correctness on every task. The outer loop guarantees deterministic retry and state recovery, not perfect model judgment.

For OpenCode specifically, the current headless dev build still has a deeper transport limitation in addition to the older liveness problems: a clean `opencode serve` session API can create sessions and stage user/assistant messages, but it still does not reliably drive a full assistant response or tool loop from the exposed HTTP routes. Until that changes upstream, `scripts/run-opencode-loop.mjs` should be treated as a fail-fast safety wrapper, not as a guaranteed unattended execution path.
