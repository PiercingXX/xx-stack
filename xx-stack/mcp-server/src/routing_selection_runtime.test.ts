import test from "node:test";
import assert from "node:assert/strict";

import type { Registry } from "./platform_types.js";
import { routeParallelTasks, type ParallelTaskInput } from "./routing_selection_runtime.js";
import { TIER_IDS } from "./runtime_constants.js";

/**
 * BORROW A — `route_parallel_tasks` told the caller to declare blocking edges
 * "explicitly rather than discovered mid-run" and then took a flat `string[]`
 * and fanned everything out at once. It asked for the edges and threw them
 * away. These tests pin the two halves of the fix: the edged form is honored,
 * and the flat form is byte-identical to what it always returned.
 */

function registry(): Registry {
  return {
    version: 1,
    selectionPolicy: {
      defaultOrder: [TIER_IDS.local, TIER_IDS.tailscaleOllama, TIER_IDS.cloud],
      rules: [],
    },
    tiers: [
      {
        id: TIER_IDS.local,
        label: "local",
        priority: 1,
        hosts: [
          {
            id: "workstation",
            label: "workstation",
            provider: "ollama",
            endpoint: "http://127.0.0.1:11434",
            enabled: true,
            reachable: true,
            executionPolicy: { maxParallelSlices: 2, maxConcurrentModels: 2 },
            models: [{ name: "qwen2.5-coder:14b", roles: ["build", "review"] }],
          },
        ],
      },
    ],
  } as unknown as Registry;
}

const FLAT_TASKS = ["implement the loader", "review the loader", "document the loader"];

test("flat string[] input returns the exact document it always returned", () => {
  const schedule = routeParallelTasks(FLAT_TASKS, registry());

  // Key-for-key: nothing about the dependency work leaks into the legacy shape.
  assert.deepEqual(Object.keys(schedule), ["assignments", "hostUtilization"]);
  assert.equal(schedule.dependencySchedule, undefined);
  for (const assignment of schedule.assignments) {
    assert.ok(!("dependencyWave" in assignment));
    assert.ok(!("blockedBy" in assignment));
    assert.ok(!("taskGraphId" in assignment));
  }

  // The capacity-wave/slot fields keep their long-standing meaning.
  assert.deepEqual(
    schedule.assignments.map((assignment) => [assignment.wave, assignment.slot]),
    [
      [1, 1],
      [1, 2],
      [2, 1],
    ]
  );
});

test("edged input assigns the same lanes as the flat form — one host-assignment pass, not two", () => {
  const flat = routeParallelTasks(FLAT_TASKS, registry());
  const edged = routeParallelTasks(
    FLAT_TASKS.map((description): ParallelTaskInput => ({ description })),
    registry()
  );
  for (const [index, assignment] of edged.assignments.entries()) {
    const legacy = flat.assignments[index]!;
    for (const key of Object.keys(legacy)) {
      assert.deepEqual(assignment[key], legacy[key], `assignment ${index} drifted on "${key}"`);
    }
  }
});

test("edged input returns dependency waves and stamps each assignment with its wave", () => {
  const schedule = routeParallelTasks(
    [
      { id: "impl", description: "implement the loader" },
      { id: "review", description: "review the loader", blockedBy: ["impl"] },
      { id: "docs", description: "document the loader", blockedBy: ["review"] },
      { id: "chore", description: "tidy unrelated lint" },
    ],
    registry()
  );

  assert.deepEqual(schedule.dependencySchedule?.waves, [["chore", "impl"], ["review"], ["docs"]]);
  assert.deepEqual(
    schedule.assignments.map((assignment) => [assignment.taskGraphId, assignment.dependencyWave]),
    [
      ["impl", 0],
      ["review", 1],
      ["docs", 2],
      ["chore", 0],
    ]
  );
});

test("edged input defaults IDs to the array index, so blockedBy needs no invented ids", () => {
  const schedule = routeParallelTasks(
    [
      { description: "first" },
      { description: "second", blockedBy: ["0"] },
      "third, still a plain string",
    ],
    registry()
  );
  assert.deepEqual(schedule.dependencySchedule?.waves, [["0", "2"], ["1"]]);
});

test("edged input surfaces a dangling edge and a cycle instead of scheduling them", () => {
  const dangling = routeParallelTasks(
    [
      { id: "a", description: "a" },
      { id: "b", description: "b", blockedBy: ["typo"] },
    ],
    registry()
  );
  assert.deepEqual(dangling.dependencySchedule?.waves, [["a"]]);
  assert.deepEqual(
    dangling.dependencySchedule?.unscheduled.map((entry) => [entry.taskId, entry.reason]),
    [["b", "unknown_blocker"]]
  );
  assert.equal(dangling.assignments[1]!.dependencyWave, null);

  const cyclic = routeParallelTasks(
    [
      { id: "x", description: "x", blockedBy: ["y"] },
      { id: "y", description: "y", blockedBy: ["x"] },
    ],
    registry()
  );
  assert.deepEqual(cyclic.dependencySchedule?.waves, []);
  assert.ok(
    cyclic.dependencySchedule?.unscheduled[0]!.detail.includes("x -> y -> x"),
    cyclic.dependencySchedule?.unscheduled[0]!.detail
  );
});

test("the returned wave plan is a plan: it says so, and nothing here executes it", () => {
  // MANUAL §1: xx-stack computes and returns a schedule; it never runs one.
  // The note is part of the payload precisely so a caller does not mistake the
  // waves for something that has been, or will be, dispatched.
  const schedule = routeParallelTasks([{ id: "a", description: "a" }], registry());
  const note = schedule.dependencySchedule!.note;
  assert.ok(note.includes("Plan only"), note);
  assert.ok(note.includes("does not dispatch"), note);
  assert.equal(typeof routeParallelTasks, "function");
  assert.notEqual(
    routeParallelTasks.constructor.name,
    "AsyncFunction",
    "a synchronous pure function cannot wait for a wave to finish"
  );
});
