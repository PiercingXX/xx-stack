import test from "node:test";
import assert from "node:assert/strict";

import {
  ANTI_REWARD_HACKING_CLAUSE,
  applyForceSynthesisOutcome,
  buildResumeDirective,
  evaluateGoalContractCompletion,
  GOAL_CONTRACT_SCHEMA,
  sanitizeGoalContract,
  TASK_STATUS_VALUES,
  TASK_TERMINAL_STATUSES,
  type GoalContract,
  type PersistentTask,
} from "./task_runtime.js";

function makeTask(overrides: Partial<PersistentTask> = {}): PersistentTask {
  return {
    taskId: "tsk-test-0001",
    title: "Test task",
    status: "in_progress",
    tags: [],
    blockedBy: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

const FULL_CONTRACT: GoalContract = {
  objective: "Make npm test pass on the payment module",
  constraints: ["Do not change the public API of charge()", "Do not touch billing fixtures"],
  validationCmd: "npm test -- --filter payment",
  stopCondition: "npm test exits 0 with all payment suites green",
  docsNote: "Update docs/payments.md when the retry behavior changes",
};

test("goal contract schema round-trips through parse and JSON serialization", () => {
  const parsed = GOAL_CONTRACT_SCHEMA.parse(FULL_CONTRACT);
  assert.deepEqual(parsed, FULL_CONTRACT);

  // Store round-trip: what goes into the task store JSON comes back identical.
  const reparsed = GOAL_CONTRACT_SCHEMA.parse(JSON.parse(JSON.stringify(parsed)));
  assert.deepEqual(reparsed, FULL_CONTRACT);

  // Optional fields stay optional through the round-trip.
  const minimal: GoalContract = {
    objective: "Ship the fix",
    constraints: ["No schema changes"],
    stopCondition: "verify_edit reports test.ok=true",
  };
  const minimalRoundTrip = GOAL_CONTRACT_SCHEMA.parse(JSON.parse(JSON.stringify(minimal)));
  assert.deepEqual(minimalRoundTrip, minimal);
  assert.equal(minimalRoundTrip.validationCmd, undefined);
  assert.equal(minimalRoundTrip.docsNote, undefined);
});

test("goal contract schema rejects missing required parts", () => {
  assert.throws(() => GOAL_CONTRACT_SCHEMA.parse({ constraints: ["x"], stopCondition: "done" }));
  assert.throws(() => GOAL_CONTRACT_SCHEMA.parse({ objective: "x", constraints: ["x"] }));
  assert.throws(() =>
    GOAL_CONTRACT_SCHEMA.parse({ objective: "x", constraints: [], stopCondition: "done" })
  );
});

test("sanitizeGoalContract trims fields and drops empty contracts", () => {
  assert.equal(sanitizeGoalContract(undefined), undefined);

  const sanitized = sanitizeGoalContract({
    objective: "  Ship it  ",
    constraints: ["  keep API stable ", "   "],
    validationCmd: "  npm test  ",
    stopCondition: " tests green ",
    docsNote: "  ",
  });
  assert.deepEqual(sanitized, {
    objective: "Ship it",
    constraints: ["keep API stable"],
    validationCmd: "npm test",
    stopCondition: "tests green",
    docsNote: undefined,
  });

  // A contract that collapses to nothing is dropped entirely.
  assert.equal(
    sanitizeGoalContract({ objective: "  ", constraints: [" "], stopCondition: " " }),
    undefined
  );
});

test("evaluateGoalContractCompletion cites the stop condition and gates on verify_edit evidence", () => {
  // No validationCmd: contract is satisfiable on citation alone.
  const noCmd = evaluateGoalContractCompletion(
    { objective: "o", constraints: ["c"], stopCondition: "all TODO items checked" },
    undefined
  );
  assert.equal(noCmd.ok, true);
  assert.equal(noCmd.reasonCode, "goal_contract_ready");
  assert.equal(noCmd.stopConditionCitation, "stop-condition: all TODO items checked");

  // validationCmd present but evidence missing → not ok, expects a verify_edit result.
  const missing = evaluateGoalContractCompletion(FULL_CONTRACT, undefined);
  assert.equal(missing.ok, false);
  assert.equal(missing.reasonCode, "goal_contract_validation_evidence_missing");
  assert.equal(missing.expectedValidationCmd, FULL_CONTRACT.validationCmd);
  assert.equal(missing.stopConditionCitation, `stop-condition: ${FULL_CONTRACT.stopCondition}`);

  // Evidence that does not reference the command still fails.
  const unrelated = evaluateGoalContractCompletion(FULL_CONTRACT, "ran the linter, all clean");
  assert.equal(unrelated.ok, false);

  // Evidence citing a verify_edit run of the exact command passes.
  const cited = evaluateGoalContractCompletion(
    FULL_CONTRACT,
    "verify_edit result for `npm test -- --filter payment`: test.ok=true, 42 passing"
  );
  assert.equal(cited.ok, true);
  assert.equal(cited.reasonCode, "goal_contract_ready");
});

test("buildResumeDirective is unchanged when no goal contract is present", () => {
  const task = makeTask();
  const directive = buildResumeDirective(task, undefined);

  const expected = [
    "Resume directive:",
    "- task-id: tsk-test-0001",
    "- title: Test task",
    "- attempt: 0",
    "- resumes: 0",
    "- worktree-note: No isolated worktree path is recorded for this task. Re-open files from the current workspace before resuming.",
    "- requirements:",
    "  - continue from existing artifacts, do not restart from scratch",
    "  - produce deterministic evidence (diff, command output, or explicit blocker)",
    "  - if blocked, include next fallback action",
  ].join("\n");

  assert.equal(directive, expected, "default path must stay byte-identical without a contract");
  assert.ok(!directive.includes("goal-contract"));
});

test("buildResumeDirective cites the goal contract and the anti-reward-hacking clause", () => {
  const task = makeTask({ goalContract: FULL_CONTRACT });
  const directive = buildResumeDirective(task, undefined);

  assert.ok(directive.includes("- goal-contract:"));
  assert.ok(directive.includes(`  - objective: ${FULL_CONTRACT.objective}`));
  assert.ok(directive.includes("  - constraints (must NOT change):"));
  assert.ok(directive.includes(`    - ${FULL_CONTRACT.constraints[0]}`));
  assert.ok(
    directive.includes(`  - validation-cmd (run via verify_edit): ${FULL_CONTRACT.validationCmd}`)
  );
  assert.ok(directive.includes(`  - stop-condition: ${FULL_CONTRACT.stopCondition}`));
  assert.ok(directive.includes(`  - docs-note: ${FULL_CONTRACT.docsNote}`));
  assert.ok(directive.includes(`  - anti-reward-hacking: ${ANTI_REWARD_HACKING_CLAUSE}`));
  assert.equal(
    ANTI_REWARD_HACKING_CLAUSE,
    "do not delete, skip, weaken, or narrow tests to make the goal pass"
  );
});

test("force_synthesized is a distinct terminal task status, never a normal completion", () => {
  assert.ok((TASK_STATUS_VALUES as readonly string[]).includes("force_synthesized"));
  assert.ok(TASK_TERMINAL_STATUSES.has("force_synthesized"));

  const task = makeTask();
  applyForceSynthesisOutcome(
    task,
    "forced synthesis (attempt_budget_exhausted); best-effort answer from partial evidence",
    "2026-08-02T00:00:00.000Z"
  );

  assert.equal(task.status, "force_synthesized");
  assert.notEqual(task.status, "done");
  assert.notEqual(task.status, "canceled");
  assert.equal(task.updatedAt, "2026-08-02T00:00:00.000Z");
  assert.ok(task.lastCheckpoint?.includes("forced synthesis"));
});
