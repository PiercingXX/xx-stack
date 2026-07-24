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

## Failure Reasons and Repair Focus

- `completion_validation_failed`: produce fresh output first.
- `completion_evidence_missing`: capture deterministic artifacts (tests, command output, diff proof).
- `completion_evidence_stale`: rerun verification after latest output.
- `completion_judge_missing_or_failed`: treat judge feedback as blocking.
- `completion_judge_before_evidence`: record evidence first, then re-run judge.
- `completion_memory_drift_detected`: run snapshot status, sync using capture/apply direction, then re-check until drift is cleared.

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
