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
7. If memory sync guard is enabled, ensure `agent_memory_snapshot_status` reports `driftDetected=false`.
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
- `force_synthesized` — budget-exhausted forced synthesis (below). Never presented as a normal completion.

## Budget-Exhausted Forced Synthesis (`force_synthesized`)

When a budget, step, or stall threshold trips (max attempts per slice, max consecutive failures, hard session timeout, progress-stall threshold, or a session already `exhausted`/`blocked`), the accumulated partial work should not be discarded. Call `supervisor_force_synthesis`:

- it verifies a trigger actually tripped (otherwise it refuses with `force_synthesis_not_triggered` — keep running the normal loop);
- it marks the session `force_synthesized` (a terminal state between success and failure) and marks linked tasks `force_synthesized` in the task store, distinct from `done` and `canceled`;
- it emits a forced-synthesis continuation prompt (same shared formatter as all supervisor prompts) that requires: answer from existing evidence only with no new tool calls, an explicit confidence level, explicit unresolved gaps, and citations to the evidence it does have;
- the output must be labeled FORCED SYNTHESIS — it is never a normal completion.

`supervisor_tick` surfaces `forceSynthesisAvailable: true` on `attempts_exhausted` and `fallback_exhausted` responses.

## Failover Handoff

When the supervisor fails a task over to another lane (`fallback_applied`), or a session ends mid-task, call `supervisor_emit_handoff_prompt` so the receiving lane gets a structured handoff:

- Goal / Current State (`DONE`, `PARTIAL`, `NOT STARTED` — state, not instructions) / Key Decisions and why / Traps & Dead Ends (approaches that FAILED) / Relevant Files with line ranges / Open Work with dependencies.
- It ends with the verify-don't-trust preamble: treat every claim as context to verify against the code, not facts to accept.
- Secrets are never echoed: reference where credentials live, never values. The formatter also redacts secret-shaped values defensively.

## Tooling Notes

- Use `supervisor_emit_continuation_prompt` after a failed completion attempt.
- The continuation payload includes:
  - `completionRecoveryReason`
  - `remediationChecklist`
  - strict loop directive

## Minimal Completion Check Sequence

1. `supervisor_record_completion_check` (`evidence`)
2. `supervisor_record_completion_check` (`judge`, `pass`)
3. `supervisor_complete_session` (`completed`)
