import test from "node:test";
import assert from "node:assert/strict";

import {
  ANTI_REWARD_HACKING_CLAUSE,
  applyForceSynthesisOutcome,
  buildResumeDirective,
  evaluateGoalContractCompletion,
  evaluateTaskLease,
  GOAL_CONTRACT_SCHEMA,
  LEASE_SELF_FENCING_CLAUSE,
  revokeTaskLease,
  sanitizeTaskLease,
  sanitizeGoalContract,
  TASK_LEASE_SCHEMA,
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

test("goal contract metric and baseline are additive and never invent a zero", () => {
  const withMetric: GoalContract = {
    ...FULL_CONTRACT,
    metric: { name: "pass-rate", direction: "unknown" },
    baseline: { value: "unknown", provenance: "placeholder", note: "not yet measured" },
    maturity: "smoke",
    parentEligible: false,
    canaryCmd: "npm test -- --filter payment",
  };
  const parsed = GOAL_CONTRACT_SCHEMA.parse(withMetric);
  assert.equal(parsed.metric?.direction, "unknown");
  assert.equal(parsed.baseline?.value, "unknown");
  assert.notEqual(parsed.baseline?.value, 0);

  const oldShape = GOAL_CONTRACT_SCHEMA.parse(FULL_CONTRACT);
  assert.equal(oldShape.metric, undefined);
  assert.equal(oldShape.baseline, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(oldShape)), FULL_CONTRACT);
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

// --- Self-enforced task leases ------------------

test("lease schema keeps expiresAt required and revoked optional", () => {
  assert.deepEqual(TASK_LEASE_SCHEMA.parse({ expiresAt: "2026-08-02T12:00:00.000Z" }), {
    expiresAt: "2026-08-02T12:00:00.000Z",
  });
  assert.deepEqual(
    TASK_LEASE_SCHEMA.parse({ expiresAt: "2026-08-02T12:00:00.000Z", revoked: true }),
    { expiresAt: "2026-08-02T12:00:00.000Z", revoked: true }
  );
  assert.throws(() => TASK_LEASE_SCHEMA.parse({ revoked: true }));
  assert.throws(() => TASK_LEASE_SCHEMA.parse({ expiresAt: "" }));
});

test("sanitizeTaskLease trims, drops empty leases, and normalizes revoked=false away", () => {
  assert.equal(sanitizeTaskLease(undefined), undefined);
  assert.equal(sanitizeTaskLease({ expiresAt: "   " }), undefined);
  assert.deepEqual(sanitizeTaskLease({ expiresAt: "  2026-08-02T12:00:00.000Z  " }), {
    expiresAt: "2026-08-02T12:00:00.000Z",
  });
  assert.deepEqual(sanitizeTaskLease({ expiresAt: "2026-08-02T12:00:00.000Z", revoked: false }), {
    expiresAt: "2026-08-02T12:00:00.000Z",
  });
  assert.deepEqual(sanitizeTaskLease({ expiresAt: "2026-08-02T12:00:00.000Z", revoked: true }), {
    expiresAt: "2026-08-02T12:00:00.000Z",
    revoked: true,
  });
});

test("evaluateTaskLease: absent lease allows the write, revocation beats expiry, garbage is dead", () => {
  const now = Date.parse("2026-08-02T12:00:00.000Z");

  // No lease at all — the default path stays open.
  assert.deepEqual(evaluateTaskLease(undefined, now), { ok: true, reasonCode: "lease_absent" });

  const live = evaluateTaskLease({ expiresAt: "2026-08-02T12:00:01.000Z" }, now);
  assert.equal(live.ok, true);
  assert.equal(live.reasonCode, "lease_valid");

  const expired = evaluateTaskLease({ expiresAt: "2026-08-02T11:59:59.000Z" }, now);
  assert.equal(expired.ok, false);
  assert.equal(expired.reasonCode, "lease_expired");

  // Exactly at the deadline is dead — the deadline is not a grace period.
  assert.equal(
    evaluateTaskLease({ expiresAt: "2026-08-02T12:00:00.000Z" }, now).reasonCode,
    "lease_expired"
  );

  // Revoked wins even when the deadline is still in the future.
  const revoked = evaluateTaskLease({ expiresAt: "2099-01-01T00:00:00.000Z", revoked: true }, now);
  assert.equal(revoked.ok, false);
  assert.equal(revoked.reasonCode, "lease_revoked");

  // An unevaluable deadline must never authorize a write.
  assert.equal(evaluateTaskLease({ expiresAt: "whenever" }, now).reasonCode, "lease_expired");
});

test("revokeTaskLease flips the claim once and is idempotent", () => {
  const unleased = makeTask();
  assert.equal(revokeTaskLease(unleased, "2026-08-02T09:00:00.000Z"), false);
  assert.equal(unleased.lease, undefined);
  assert.equal(unleased.updatedAt, "2026-08-01T00:00:00.000Z", "no lease means no write");

  const leased = makeTask({ lease: { expiresAt: "2099-01-01T00:00:00.000Z" } });
  assert.equal(revokeTaskLease(leased, "2026-08-02T09:00:00.000Z"), true);
  assert.deepEqual(leased.lease, { expiresAt: "2099-01-01T00:00:00.000Z", revoked: true });
  assert.equal(leased.updatedAt, "2026-08-02T09:00:00.000Z");

  assert.equal(revokeTaskLease(leased, "2026-08-02T10:00:00.000Z"), false, "already revoked");
  assert.equal(leased.updatedAt, "2026-08-02T09:00:00.000Z", "idempotent revoke does not re-stamp");
});

test("buildResumeDirective adds the lease and self-fencing clause only when a lease exists", () => {
  const plain = buildResumeDirective(makeTask(), undefined);
  assert.ok(!plain.includes("- lease:"));
  assert.ok(!plain.includes("self-fencing"));

  const leased = buildResumeDirective(
    makeTask({ lease: { expiresAt: "2099-01-01T00:00:00.000Z" } }),
    undefined
  );
  assert.ok(leased.includes("- lease:"));
  assert.ok(leased.includes("  - expires-at: 2099-01-01T00:00:00.000Z"));
  assert.ok(leased.includes("  - revoked: no"));
  assert.ok(leased.includes(`  - self-fencing: ${LEASE_SELF_FENCING_CLAUSE}`));

  const revoked = buildResumeDirective(
    makeTask({ lease: { expiresAt: "2099-01-01T00:00:00.000Z", revoked: true } }),
    undefined
  );
  assert.ok(revoked.includes("  - revoked: yes"));

  assert.ok(
    LEASE_SELF_FENCING_CLAUSE.includes("re-check this task's lease"),
    "the clause tells the agent to re-check before writing"
  );
  assert.ok(LEASE_SELF_FENCING_CLAUSE.includes("do not write"));
});

test("goal contracts carry both directions of the reward-hacking guard", () => {
  // ANTI_REWARD_HACKING_CLAUSE guards degrading the verifier. The inverse —
  // manufacturing a change so a run looks productive — is the failure a
  // prospecting task invites, because "nothing worth changing" leaves a
  // carelessly written stopCondition permanently unmet, and _Stop then objects
  // until the caller's rejection budget is spent. Both clauses must render, or
  // the contract only warns about half the problem.
  const task = makeTask();
  task.goalContract = {
    objective: "find dead code worth deleting",
    constraints: ["do not change behavior"],
    stopCondition: "every candidate is deleted or recorded as load-bearing with the reason",
  };
  const directive = buildResumeDirective(task, undefined);

  assert.match(directive, /anti-reward-hacking: do not delete, skip, weaken/);
  assert.match(directive, /null-result: a null result is a valid completion/);
  assert.ok(
    directive.indexOf("anti-reward-hacking:") < directive.indexOf("null-result:"),
    "both directions should arrive together, guard first then its inverse"
  );
});
