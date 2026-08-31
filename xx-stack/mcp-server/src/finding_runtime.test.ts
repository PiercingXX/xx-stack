import test from "node:test";
import assert from "node:assert/strict";

import type { GoalContract } from "./task_runtime.js";
import {
  allocateHypothesisCohort,
  assignLane,
  closeGeneration,
  diversityCellKey,
  draftForceSynthesisFinding,
  emptyFindingStore,
  evaluateGenerationCanary,
  ingestFinding,
  isForbiddenMechanismSurface,
  listFindings,
  materializeFinding,
  MECHANISM_FORBIDDEN_SURFACES,
  openGeneration,
  type Finding,
} from "./finding_runtime.js";

const NOW = "2026-08-30T12:00:00.000Z";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    findingId: "fnd-test",
    kind: "finding",
    lane: "incubator",
    role: "canonical_state",
    title: "test",
    summary: "summary",
    parentEligible: false,
    laneReasonCode: "lane_incubator",
    caveats: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

test("force_synthesized cannot be marked confirmed — it lands in incubator as partial_output", () => {
  const assignment = assignLane({
    kind: "finding",
    requestedLane: "confirmed",
    sourceStatus: "force_synthesized",
  });
  assert.equal(assignment.lane, "incubator");
  assert.equal(assignment.role, "partial_output");
  assert.equal(assignment.parentEligible, false);
  assert.equal(assignment.reasonCode, "forced_to_incubator");

  const materialized = materializeFinding(
    draftForceSynthesisFinding({
      sessionId: "ses-1",
      taskId: "tsk-1",
      trigger: "attempts_exhausted",
      nowIso: NOW,
    }),
    NOW
  );
  assert.equal(materialized.lane, "incubator");
  assert.equal(materialized.parentEligible, false);
  assert.equal(materialized.requestedLane, "confirmed");
  assert.equal(materialized.sourceStatus, "force_synthesized");
});

test("a failed experiment cannot be marked completed-as-confirmed", () => {
  for (const status of ["blocked", "interrupted", "exhausted", "canceled", "failed"] as const) {
    const assignment = assignLane({
      kind: "result",
      requestedLane: "confirmed",
      sourceStatus: status,
    });
    assert.equal(assignment.lane, "diagnostic", status);
    assert.equal(assignment.parentEligible, false, status);
    assert.equal(assignment.reasonCode, "forced_to_diagnostic", status);
  }
});

test("unknown metric direction never becomes maximize and never confirms", () => {
  const assignment = assignLane({
    kind: "result",
    requestedLane: "confirmed",
    metric: { name: "score", direction: "unknown" },
    metricValue: 12,
  });
  assert.equal(assignment.lane, "incubator");
  assert.equal(assignment.parentEligible, false);
  assert.equal(assignment.reasonCode, "metric_direction_unknown");
});

test("a missing metric value is unknown, never stored as zero, and cannot confirm", () => {
  const assignment = assignLane({
    kind: "result",
    requestedLane: "confirmed",
    metric: { name: "score", direction: "maximize" },
    metricValue: "unknown",
  });
  assert.equal(assignment.lane, "incubator");
  assert.equal(assignment.reasonCode, "metric_value_unknown");

  const stored = materializeFinding(
    {
      kind: "result",
      title: "measured nothing",
      summary: "no reading",
      requestedLane: "confirmed",
      metric: { name: "score", direction: "maximize" },
      metricValue: "unknown",
    },
    NOW
  );
  assert.equal(stored.metricValue, "unknown");
  assert.notEqual(stored.metricValue, 0);
});

test("placeholder baseline cannot parent a confirmed finding", () => {
  const assignment = assignLane({
    kind: "result",
    requestedLane: "confirmed",
    metric: { name: "score", direction: "maximize" },
    metricValue: 4,
    baseline: { value: "unknown", provenance: "placeholder" },
  });
  assert.equal(assignment.lane, "incubator");
  assert.equal(assignment.reasonCode, "baseline_placeholder");
});

test("canary and mechanism contracts are never parents", () => {
  assert.equal(assignLane({ kind: "canary", requestedLane: "confirmed" }).lane, "diagnostic");
  assert.equal(assignLane({ kind: "canary" }).parentEligible, false);
  assert.equal(assignLane({ kind: "mechanism_contract" }).role, "audit_snapshot");
  assert.equal(assignLane({ kind: "mechanism_contract" }).parentEligible, false);
});

test("a completed result with a known metric can confirm", () => {
  const assignment = assignLane({
    kind: "result",
    requestedLane: "confirmed",
    sourceStatus: "done",
    metric: { name: "pass-rate", direction: "maximize" },
    metricValue: 1,
    baseline: { value: 0.8, provenance: "measured" },
  });
  assert.equal(assignment.lane, "confirmed");
  assert.equal(assignment.parentEligible, true);
  assert.equal(assignment.reasonCode, "lane_confirmed");
});

test("late findings after generation close cannot rewrite committed membership", () => {
  const store = emptyFindingStore();
  const generation = openGeneration(store, {
    index: 0,
    cohortTaskIds: ["tsk-a"],
    openedAt: NOW,
    generationId: "gen-0",
  });
  const first = ingestFinding(
    store,
    {
      kind: "result",
      title: "on time",
      summary: "committed",
      generationId: generation.generationId,
      requestedLane: "confirmed",
    },
    NOW
  );
  assert.equal(first.late, false);
  assert.deepEqual(generation.findingIds, [first.finding.findingId]);

  const closed = closeGeneration(store, generation.generationId, "2026-08-30T13:00:00.000Z");
  assert.equal(closed.ok, true);
  assert.equal(closed.generation?.status, "closed");
  const committed = [...generation.findingIds];

  const late = ingestFinding(
    store,
    {
      kind: "result",
      title: "too late",
      summary: "arrived after cutoff",
      generationId: generation.generationId,
      requestedLane: "confirmed",
    },
    "2026-08-30T13:01:00.000Z"
  );
  assert.equal(late.late, true);
  assert.equal(late.finding.laneReasonCode, "late_after_generation_boundary");
  assert.equal(late.finding.parentEligible, false);
  assert.deepEqual(generation.findingIds, committed);
  assert.deepEqual(generation.lateFindingIds, [late.finding.findingId]);
  assert.ok(store.findings[late.finding.findingId], "late evidence stays visible");
});

test("closing a missing or already-closed generation is rejected without mutation", () => {
  const store = emptyFindingStore();
  assert.equal(closeGeneration(store, "nope", NOW).reasonCode, "generation_missing");
  openGeneration(store, { index: 0, cohortTaskIds: [], openedAt: NOW, generationId: "gen-0" });
  assert.equal(closeGeneration(store, "gen-0", NOW).ok, true);
  const second = closeGeneration(store, "gen-0", "2026-08-30T14:00:00.000Z", "should not stick");
  assert.equal(second.ok, false);
  assert.equal(second.reasonCode, "generation_already_closed");
  assert.equal(store.generations["gen-0"]!.agenda, undefined);
});

test("canary fail on the unchanged tree is a measured baseline; could_not_run blocks fan-out", () => {
  const contract: GoalContract = {
    objective: "Improve the parser",
    constraints: ["Do not weaken tests"],
    validationCmd: "npm test",
    stopCondition: "tests green",
  };
  const contracts = [{ taskId: "tsk-a", contract }];

  const none = evaluateGenerationCanary(contracts, []);
  assert.equal(none.ok, false);
  assert.equal(none.reasonCode, "canary_required");

  const failed = evaluateGenerationCanary(contracts, [
    finding({
      kind: "canary",
      taskId: "tsk-a",
      canaryOutcome: "fail",
      lane: "diagnostic",
      role: "validation_signal",
    }),
  ]);
  assert.equal(failed.ok, true);
  assert.equal(failed.reasonCode, "canary_ready");

  const broken = evaluateGenerationCanary(contracts, [
    finding({
      kind: "canary",
      taskId: "tsk-a",
      canaryOutcome: "could_not_run",
      lane: "diagnostic",
      role: "validation_signal",
    }),
  ]);
  assert.equal(broken.ok, false);
  assert.equal(broken.reasonCode, "canary_could_not_run");
  assert.deepEqual(broken.blockedTaskIds, ["tsk-a"]);
});

test("a contract without a validation or canary command does not require a canary", () => {
  const check = evaluateGenerationCanary(
    [
      {
        taskId: "tsk-a",
        contract: {
          objective: "Decide the storage backend",
          constraints: ["No implementation"],
          stopCondition: "ADR written",
        },
      },
    ],
    []
  );
  assert.equal(check.ok, true);
  assert.equal(check.required, false);
  assert.equal(check.reasonCode, "canary_not_required");
});

test("QD-lite caps duplicate cells and same-family overconcentration", () => {
  const slices = [
    {
      id: "a",
      cell: { mechanismFamily: "queue", surface: "worker", intent: "retry" },
    },
    {
      id: "b",
      cell: { mechanismFamily: "queue", surface: "worker", intent: "retry" },
    },
    {
      id: "c",
      cell: { mechanismFamily: "queue", surface: "scheduler", intent: "backoff" },
    },
    {
      id: "d",
      cell: { mechanismFamily: "cache", surface: "lookup", intent: "ttl" },
    },
  ];
  const allocation = allocateHypothesisCohort(slices);
  assert.equal(allocation.ok, false);
  assert.deepEqual(allocation.assigned, ["a", "c", "d"]);
  assert.equal(allocation.collisions[0]?.id, "b");
  assert.equal(allocation.collisions[0]?.reasonCode, "duplicate_cell");
  assert.equal(
    diversityCellKey({ mechanismFamily: "Queue", surface: " Worker", intent: "RETRY" }),
    "queue|worker|retry"
  );
});

test("QD family cap keeps at least one occupant and never reassigns another peer's cell", () => {
  const slices = [
    { id: "a", cell: { mechanismFamily: "queue", surface: "a", intent: "a" } },
    { id: "b", cell: { mechanismFamily: "queue", surface: "b", intent: "b" } },
    { id: "c", cell: { mechanismFamily: "queue", surface: "c", intent: "c" } },
  ];
  // 3 peers, 0.34 → ceil(1.02) = 2, so the third same-family slice collides.
  const allocation = allocateHypothesisCohort(slices);
  assert.equal(allocation.caps.maxSameFamily, 2);
  assert.deepEqual(allocation.assigned, ["a", "b"]);
  assert.equal(allocation.collisions[0]?.id, "c");
  assert.equal(allocation.collisions[0]?.reasonCode, "family_cap");
});

test("mechanism contracts forbid editing the verifier", () => {
  for (const surface of MECHANISM_FORBIDDEN_SURFACES) {
    assert.equal(isForbiddenMechanismSurface(surface), true, surface);
  }
  assert.equal(isForbiddenMechanismSurface("src/parser.ts"), false);
});

test("listFindings filters without mutating the store", () => {
  const store = emptyFindingStore();
  ingestFinding(
    store,
    { kind: "result", title: "one", summary: "a", requestedLane: "confirmed", taskId: "t1" },
    NOW
  );
  ingestFinding(
    store,
    {
      kind: "finding",
      title: "two",
      summary: "b",
      requestedLane: "diagnostic",
      taskId: "t2",
      sourceStatus: "blocked",
    },
    NOW
  );
  const diagnostic = listFindings(store, { lane: "diagnostic" });
  assert.equal(diagnostic.length, 1);
  assert.equal(diagnostic[0]!.taskId, "t2");
  assert.equal(Object.keys(store.findings).length, 2);
});
