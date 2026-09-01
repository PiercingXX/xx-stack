# Supervisor Completion Loop Runbook

This runbook defines the strict completion flow for supervised sessions.

## Goal

Prevent incomplete work from being marked as completed.
Prevent drifted memory state from being treated as completion-safe.

## Required Loop

1. Implement targeted changes for current slice.
2. Run deterministic verification commands.
3. Record completion evidence:
   - call `supervisor_record_completion_check`
   - `checkType: evidence`
4. Run independent judge review (`completion-judge`).
5. Record judge verdict:
   - call `supervisor_record_completion_check`
   - `checkType: judge`
   - `verdict: pass|fail`
6. If verdict is `fail`, repair and repeat from step 1.
7. If memory sync guard is enabled, ensure `agent_memory_get` reports `snapshot.driftDetected=false`.
8. Only after evidence is fresh, judge verdict is `pass`, and memory drift is resolved, call `supervisor_complete_session` with `outcome: completed`.

## Goal Contract Gate

When a task linked to the session carries a `goalContract` (see `runtime/AUTONOMOUS_TODO_LOOP.md` for the required shape):

- completion evaluation cites the contract's `stopCondition` — the finalized result includes `goalContractCitations`.
- if the contract has a `validationCmd`, `supervisor_complete_session` expects a `verify_edit` result for that exact command in the completion evidence summary; otherwise it refuses with reason code `goal_contract_validation_evidence_missing`.
- the anti-reward-hacking clause is binding: do not delete, skip, weaken, or narrow tests to make the goal pass.

## Failure Reasons and Repair Focus

- `completion_validation_failed`: produce fresh output first.
- `completion_evidence_missing`: capture deterministic artifacts (tests, command output, diff proof).
- `completion_evidence_stale`: rerun verification after latest output.
- `completion_judge_missing_or_failed`: treat judge feedback as blocking.
- `completion_judge_before_evidence`: record evidence first, then re-run judge.
- `completion_memory_drift_detected`: run snapshot status, sync using capture/apply direction, then re-check until drift is cleared.
- `goal_contract_validation_evidence_missing`: run the goal contract's `validationCmd` through `verify_edit` and record its result as completion evidence, citing the contract's `stopCondition`.

## Terminal States

Sessions end in one of three distinguished outcomes — the record never blurs them:

- `completed` — the strict loop finished: fresh evidence, judge pass, memory drift resolved, goal contracts satisfied.
- failed (`blocked` / `interrupted` / `exhausted`) — the work did not finish and no synthesis was demanded.
- `force_synthesized` — budget-exhausted forced synthesis (below). Never presented as a normal completion. The finding store records it as an incubator `partial_output` finding; it cannot be promoted to confirmed.

### Terminal is terminal — ending something that already ended is a no-op

A session that reached `completed`, `interrupted`, `exhausted`, or `force_synthesized` has a finished record. Nothing rewrites it, including a request to end it again.

- **`supervisor_abort_session` against a terminal session writes nothing.** No status change, no `session.interrupted` event, no lease revocation. It answers `{"status": "already_terminal", "reasonCode": "session_terminal", "sessionId": "...", "priorStatus": "<the status it actually holds>"}`. It reports what happened rather than echoing the transition that was requested.
- **Three distinct outcomes, three distinct answers.** `interrupted` = live work was stopped by this call. `already_terminal` = the session had already ended and nothing was touched. `missing` = no such session ID. Do not collapse the middle one into either neighbour: "I aborted it" and "it was already over" are different facts about the fleet.
- **Aborting a `running`, `cooldown`, or `blocked` session is unchanged**, lease revocation included — that path is already idempotent, and those three statuses are live sessions that can still move.
- **`task_suspend` carries the same rule.** A `done`, `canceled`, or `force_synthesized` task is rejected with `{"status": "rejected", "reasonCode": "task_terminal", "taskStatus": "<current>"}` and nothing is written. Without it a finished task could be resurrected into `suspended`, undoing `applyForceSynthesisOutcome` — the exact erasure the three distinguished terminal states exist to prevent. The lease fence runs **first** and is unchanged, so an expired or revoked claim is still reported as a lease failure rather than a terminal one.

Deliberately **not** implemented: a running-vs-pending distinction on abort. The control plane holds no kill channel (see the lease invariants below), so which of the two a live session is in is unknowable from here. Reporting a guess would be worse than reporting the transition honestly.

## Budget-Exhausted Forced Synthesis (`force_synthesized`)

When a budget, step, or stall threshold trips (max attempts per slice, max consecutive failures, hard session timeout, progress-stall threshold, or a session already `exhausted`/`blocked`), the accumulated partial work should not be discarded. Call `supervisor_force_synthesis`:

- it verifies a trigger actually tripped (otherwise it refuses with `force_synthesis_not_triggered` — keep running the normal loop);
- it marks the session `force_synthesized` (a terminal state between success and failure) and marks linked tasks `force_synthesized` in the task store, distinct from `done` and `canceled`;
- it emits a forced-synthesis continuation prompt (same shared formatter as all supervisor prompts) that requires: answer from existing evidence only with no new tool calls, an explicit confidence level, explicit unresolved gaps, and citations to the evidence it does have;
- the output must be labeled FORCED SYNTHESIS — it is never a normal completion.

`supervisor_tick` surfaces `forceSynthesisAvailable: true` on `attempts_exhausted` and `fallback_exhausted` responses.

## Failover Handoff

When the supervisor fails a task over to another lane (`fallback_applied`), or a session ends mid-task, compose a failover handoff prompt (`compose-supervisor-prompts` skill) so the receiving lane gets a structured handoff:

- Goal / Current State (`DONE`, `PARTIAL`, `NOT STARTED` — state, not instructions) / Key Decisions and why / Traps & Dead Ends (approaches that FAILED) / Relevant Files with line ranges / Open Work with dependencies.
- It ends with the verify-don't-trust preamble: treat every claim as context to verify against the code, not facts to accept.
- Secrets are never echoed: reference where credentials live, never values. The formatter also redacts secret-shaped values defensively.

## Remote Lifecycle Invariants (Self-Enforced Task Leases)

The control plane routes and supervises lanes on other machines but holds **no channel to kill one**. Three invariants make that situation safe without inventing one.

### 1. Presence is status

Silence past a bound is a terminal observation, not a pending state. The supervisor never assumes a kill worked, because it cannot kill. `staleSessionTtlMs` already implements the supervisor's half: when to stop waiting.

**Lease expiry plus silence is a terminal observation, not a retry trigger.** When a leased lane's deadline passes and nothing has been heard from it, the supervisor records that lane as done-by-decision and moves on — it does not re-poke the lane, and it does not hold the task open waiting for a late write-back. If that lane later wakes up, invariant 3 handles it.

### 2. Liveness bounds are enforced by the agent itself

Task registration (`task_create` / `task_update`) accepts an optional lease:

```json
{ "lease": { "expiresAt": "<ISO-8601>", "revoked": false } }
```

- The lease is **optional metadata**. A task registered without one behaves exactly as before — same record, same prompts, same write-back path. This is the guardrail.
- `expiresAt` is compared against **the server's own clock at write-back**. There is deliberately no clock reconciliation across machines: the prompt clause tells the agent to stop _early_, not precisely.
- Continuation prompts for leased tasks carry the self-fencing clause:

  > before writing back any result, re-check this task's lease; if it is expired or revoked, emit your final state and stop — do not write

  The same clause appears in the `task_resume` directive for a leased task.

### 3. At most one live instance per task

After a failover, a returning "dead" lane must detect it lost the claim rather than duplicate work.

- `supervisor_tick` revokes the prior lane's lease on every open task linked to the session at the moment it applies a fallback (`fallback_applied` reports the revoked task ids in `revokedLeases`). Tasks with no lease take a pure no-op path — nothing is written.
- The handoff prompt states the revocation to the receiving lane: the prior lane's claim on those tasks is revoked, only this lane may write results, and the prior lane's silence is terminal rather than work in flight.
- Server-side enforcement is exactly **one** check, on the task-result write-back path. `task_update` against a task whose lease is revoked or expired returns a structured rejection instead of silently accepting:

  ```json
  {
    "status": "rejected",
    "reasonCode": "lease_revoked",
    "taskId": "...",
    "lease": { "expiresAt": "...", "revoked": true },
    "serverTime": "...",
    "selfFencingClause": "..."
  }
  ```

  `reasonCode` is `lease_revoked` for a revoked claim and `lease_expired` for a passed deadline (an unparseable `expiresAt` counts as expired — a lease nobody can evaluate never authorizes a write). Nothing is written when the rejection fires.

- A `task_update` that carries a **replacement** lease is the supervisor re-leasing the task for a new lane, not a lane writing results back, so it is not fenced. That is how a failed-over task is handed to a live lane.

Everything else is prompt-layer: the agent self-fences, and termination by decision is final even if the process lingers.

## Heartbeat Pattern

Recurring supervision runs as one cheap tick, not many timers:

- a single recurring tick (`supervisor_tick`) gates all per-task checks — there is never one timer per task.
- each per-task check keeps a last-run timestamp; the tick compares timestamps against each check's own interval and runs only the checks that are due.
- the tick acts only on what is due and stays silent when nothing is — no output, no escalation, no model invocation.
- never put a model on a tight timer: the tick itself is deterministic bookkeeping. A model is engaged only when a due check surfaces something that needs judgment.

## Tooling Notes

- Compose a continuation prompt (`compose-supervisor-prompts` skill) after a failed completion attempt.
- The continuation payload includes:
  - `completionRecoveryReason`
  - `remediationChecklist`
  - strict loop directive

## Minimal Completion Check Sequence

1. `supervisor_record_completion_check` (`evidence`)
2. `supervisor_record_completion_check` (`judge`, `pass`)
3. `supervisor_complete_session` (`completed`)
