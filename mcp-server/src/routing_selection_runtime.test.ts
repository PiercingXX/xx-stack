import test from "node:test";
import assert from "node:assert/strict";

import type { Host, Registry } from "./platform_types.js";
import type { ResidentModel } from "./routing_endpoint_runtime.js";
import {
  buildWatchdogRouteCandidates,
  chooseModelForTask,
  hostCapacityScore,
  rankLanesByLiveCapacity,
  residencyRankAdjustment,
  routeParallelTasks,
  routeTask,
  MEMORY_PRESSURE_PENALTY,
  RESIDENCY_ADJUSTMENT_CEILING,
  RESIDENT_MODEL_BONUS,
  type LaneResidency,
  type ParallelTaskInput,
  type WatchdogProbeDeps,
} from "./routing_selection_runtime.js";
import { failureKey } from "./supervisor_session_runtime.js";
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

test("hypothesis cohort attaches qualityDiversity and flags duplicate cells; flat form stays identical", () => {
  const schedule = routeParallelTasks(
    [
      {
        id: "queue-a",
        description: "retry with a queue",
        cohortKind: "hypothesis",
        diversityCell: { mechanismFamily: "queue", surface: "worker", intent: "retry" },
      },
      {
        id: "queue-b",
        description: "retry with the same queue",
        cohortKind: "hypothesis",
        diversityCell: { mechanismFamily: "queue", surface: "worker", intent: "retry" },
      },
      {
        id: "cache",
        description: "cache the lookup",
        cohortKind: "hypothesis",
        diversityCell: { mechanismFamily: "cache", surface: "lookup", intent: "ttl" },
      },
    ],
    registry()
  );

  assert.equal(schedule.qualityDiversity?.ok, false);
  assert.deepEqual(schedule.qualityDiversity?.assigned, ["queue-a", "cache"]);
  const collided = schedule.assignments.find((assignment) => assignment.taskGraphId === "queue-b");
  assert.equal(collided?.diversityCollision, true);
  assert.equal(collided?.diversityReasonCode, "duplicate_cell");

  const ordinary = routeParallelTasks(
    [
      { id: "impl", description: "implement the loader" },
      { id: "docs", description: "document the loader" },
    ],
    registry()
  );
  assert.equal(ordinary.qualityDiversity, undefined);
  for (const assignment of ordinary.assignments) {
    assert.equal(assignment.diversityCollision, undefined);
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

// --- Live residency and memory pressure in the watchdog ranking -------------

/**
 * `hostCapacityScore` is nameplate-only and stays that way. The watchdog path
 * already dials every candidate, so it — and only it — folds two live facts
 * into the ordering: whether the chosen model is already resident, and whether
 * the card is saturated.
 *
 * The whole design constraint is the bound. The live term can move a lane by at
 * most `RESIDENCY_ADJUSTMENT_CEILING` points, which is smaller than the gap
 * between lane classes in the shipped registry (the closest two lanes from
 * different tiers sit 9.1 points apart; the two runtimes sharing one physical
 * box sit 0.25 apart). So it settles near-ties and cannot do anything else.
 */

const GB_MODEL = 6;

function lane(
  id: string,
  slices: number,
  vramGb: number,
  modelName: string,
  extra: Partial<Host> = {}
): Host {
  return {
    id,
    label: id,
    provider: "ollama",
    endpoint: `http://${id}:11434`,
    capabilities: { endpointFamily: "ollama", supportsResidentModelInspection: true },
    executionPolicy: { maxParallelSlices: slices },
    hardware: { detected: { totalGpuVramGb: vramGb } },
    models: [{ name: modelName }],
    ...extra,
  };
}

function watchdogRegistry(tiers: Array<{ id: string; hosts: Host[] }>): Registry {
  return {
    version: 1,
    selectionPolicy: {
      defaultOrder: tiers.map((tier) => tier.id),
      cloudEscalation: { optIn: true },
      rules: [],
    },
    tiers: tiers.map((tier, index) => ({
      id: tier.id,
      label: tier.id,
      priority: index + 1,
      hosts: tier.hosts,
    })),
  } as unknown as Registry;
}

/**
 * Every host answers "healthy, model present"; residency comes from an explicit
 * per-host map so each test states exactly what the fleet reported. A host
 * missing from the map is one that could not be asked at all.
 */
function probes(resident: Record<string, ResidentModel[] | null>): WatchdogProbeDeps {
  return {
    checkHostModelHealth: async (host, modelName) => ({
      hostHealthy: true,
      modelAvailable: true,
      latencyMs: 5,
      checkedModel: modelName,
      source: "live",
      reason: `stub health for ${host.id}`,
    }),
    fetchResidentModels: async (host) => resident[host.id] ?? null,
  };
}

const PRIMARY = lane("primary-lane", 1, 8, "primary-model");

async function candidateOrder(
  registry: Registry,
  resident: Record<string, ResidentModel[] | null>
): Promise<string[]> {
  const result = await buildWatchdogRouteCandidates(
    registry,
    "implement feature",
    PRIMARY.id,
    null,
    4,
    new Set<string>(),
    probes(resident)
  );
  return result.candidates.map((candidate) => candidate.host);
}

test("residency settles a near-tie the nameplate score cannot", async () => {
  // 25.3 vs 25.1: two comparable boxes, 0.2 apart on paper.
  const cool = lane("cool-lane", 2, 24, "shared-model");
  const warm = lane("warm-lane", 2, 23, "shared-model");
  assert.equal(hostCapacityScore(cool), 25.3);
  assert.equal(hostCapacityScore(warm), 25.1);

  const registry = watchdogRegistry([{ id: TIER_IDS.local, hosts: [PRIMARY, cool, warm] }]);

  assert.deepEqual(
    await candidateOrder(registry, {}),
    ["cool-lane", "warm-lane"],
    "with nothing known, today's static order stands"
  );

  assert.deepEqual(
    await candidateOrder(registry, {
      "cool-lane": [],
      "warm-lane": [{ name: "shared-model", vramGb: GB_MODEL }],
    }),
    ["warm-lane", "cool-lane"],
    "the box that already has the model loaded goes first"
  );
});

test("a warm lane never outranks a cold lane the static score puts a class ahead", async () => {
  // The case the bound exists for: a warm cloud lane against a cold lane on the
  // preferred tier, 11.6 points apart — far more than the ceiling of 4.
  const preferred = lane("local-lane", 2, 8, "local-model");
  const cloud = lane("cloud-lane", 1, 0, "cloud-model", {
    provider: "openai",
    capabilities: { endpointFamily: "openai-compatible", supportsResidentModelInspection: true },
  });
  assert.equal(hostCapacityScore(preferred), 22.1);
  assert.equal(hostCapacityScore(cloud), 10.5);
  assert.ok(
    hostCapacityScore(preferred) - hostCapacityScore(cloud) > RESIDENCY_ADJUSTMENT_CEILING,
    "fixture must span more than the live term can move a lane"
  );

  const registry = watchdogRegistry([
    { id: TIER_IDS.local, hosts: [PRIMARY, preferred] },
    { id: TIER_IDS.cloud, hosts: [cloud] },
  ]);

  assert.deepEqual(await candidateOrder(registry, {}), ["local-lane", "cloud-lane"]);

  // Every live signal stacked against the preferred lane at once: the far lane
  // is warm, the near lane is cold *and* saturated (8 GB card, 25% reserve =>
  // 6 GB usable, holding 7 GB of somebody else's model). Still no override.
  assert.deepEqual(
    await candidateOrder(registry, {
      "local-lane": [{ name: "something-else", vramGb: 7 }],
      "cloud-lane": [{ name: "cloud-model", vramGb: GB_MODEL }],
    }),
    ["local-lane", "cloud-lane"],
    "warmth is a tiebreak; it does not promote a lane past a better one"
  );
});

test("overload demotes a lane and never bans it", async () => {
  // tight-lane leads on paper (22.1 vs 21.3) but its 8 GB card, at a 25%
  // reserve, leaves 6 GB usable against 7 GB of somebody else's resident model
  // plus 5 GB of context headroom.
  const tight = lane("tight-lane", 2, 8, "shared-model");
  const roomy = lane("roomy-lane", 2, 4, "shared-model");
  assert.equal(hostCapacityScore(tight), 22.1);
  assert.equal(hostCapacityScore(roomy), 21.3);
  const registry = watchdogRegistry([{ id: TIER_IDS.local, hosts: [PRIMARY, tight, roomy] }]);

  const pressured = {
    "tight-lane": [{ name: "someone-elses-model", vramGb: 7 }],
    "roomy-lane": [],
  };

  assert.deepEqual(
    await candidateOrder(registry, {}),
    ["tight-lane", "roomy-lane"],
    "on nameplate alone the saturated box goes first"
  );

  const result = await buildWatchdogRouteCandidates(
    registry,
    "implement feature",
    PRIMARY.id,
    null,
    4,
    new Set<string>(),
    probes(pressured)
  );
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.host),
    ["roomy-lane", "tight-lane"],
    "a saturated lane is still a lane — demoted, never dropped"
  );

  const tightHealth = result.health.find(
    (entry) => (entry as { host?: string }).host === "tight-lane"
  ) as Record<string, any>;
  assert.equal(tightHealth.residency, "cold");
  assert.equal(tightHealth.memoryPressure.overload, true);
  assert.equal(tightHealth.memoryPressure.usableVramGb, 6);
  assert.equal(tightHealth.memoryPressure.estimatedFreeGb, 0);
});

test("a fleet nobody can inspect ranks exactly as it does today", async () => {
  // No capability flag anywhere, and the real fetchResidentModels — which
  // refuses before touching the network — left in place. The only injected
  // probe is health.
  const hosts = [
    PRIMARY,
    lane("a", 3, 48, "m-a", { capabilities: { endpointFamily: "ollama" } }),
    lane("b", 1, 12, "m-b", {
      capabilities: { endpointFamily: "ollama", supportsResidentModelInspection: false },
    }),
    lane("c", 2, 16, "m-c", { capabilities: undefined }),
  ];
  const registry = watchdogRegistry([{ id: TIER_IDS.local, hosts }]);

  const result = await buildWatchdogRouteCandidates(
    registry,
    "implement feature",
    PRIMARY.id,
    null,
    4,
    new Set<string>(),
    { checkHostModelHealth: probes({}).checkHostModelHealth }
  );

  // "Today's ranking" is not a remembered list: it is recomputed here from the
  // untouched, still-pure hostCapacityScore.
  const todaysOrder = hosts
    .filter((host) => host.id !== PRIMARY.id)
    .sort((left, right) => hostCapacityScore(right) - hostCapacityScore(left))
    .map((host) => host.id);
  assert.deepEqual(todaysOrder, ["a", "c", "b"]);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.host),
    todaysOrder
  );

  const fallbacks = result.health.filter(
    (entry) => (entry as { kind?: string }).kind === "fallback"
  ) as Array<Record<string, unknown>>;
  assert.deepEqual(
    fallbacks.map((entry) => entry.host),
    todaysOrder,
    "the health report is ordered by preference too"
  );
  for (const entry of fallbacks) {
    assert.equal(entry.residency, "unknown", `${entry.host} was never inspected — say so`);
    assert.equal(entry.memoryPressure, "unknown");
  }
});

test("a failed probe on an inspectable host is logged unknown, and costs it nothing", async () => {
  const strong = lane("strong-lane", 2, 24, "shared-model");
  const weak = lane("weak-lane", 2, 23, "shared-model");
  const registry = watchdogRegistry([{ id: TIER_IDS.local, hosts: [PRIMARY, strong, weak] }]);

  // strong-lane can be asked and the ask failed (null); weak-lane answered warm.
  // A failure must not be read as "cold" — that would let a probe timeout
  // silently reorder the fleet.
  const result = await buildWatchdogRouteCandidates(
    registry,
    "implement feature",
    PRIMARY.id,
    null,
    4,
    new Set<string>(),
    probes({ "strong-lane": null, "weak-lane": [{ name: "shared-model", vramGb: GB_MODEL }] })
  );

  const byHost = new Map(
    (result.health as Array<Record<string, any>>)
      .filter((entry) => entry.kind === "fallback")
      .map((entry) => [entry.host as string, entry])
  );
  assert.equal(byHost.get("strong-lane")!.residency, "unknown");
  assert.equal(byHost.get("strong-lane")!.memoryPressure, "unknown");
  assert.equal(byHost.get("weak-lane")!.residency, "warm");

  // The warm lane still wins the near-tie — an unknown scores zero, it does not
  // score negative — but the unknown lane is reported honestly.
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.host),
    ["weak-lane", "strong-lane"]
  );
});

test("the live term is bounded: it cannot invert a pair the static score separates", () => {
  assert.equal(
    residencyRankAdjustment({ residency: "warm", overload: false }),
    RESIDENT_MODEL_BONUS
  );
  assert.equal(residencyRankAdjustment({ residency: "cold", overload: false }), 0);
  assert.equal(residencyRankAdjustment({ residency: "unknown", overload: false }), 0);
  assert.equal(
    residencyRankAdjustment({ residency: "cold", overload: true }),
    -MEMORY_PRESSURE_PENALTY
  );
  assert.equal(
    residencyRankAdjustment({ residency: "warm", overload: true }),
    RESIDENT_MODEL_BONUS - MEMORY_PRESSURE_PENALTY
  );

  // Exhaustive over every residency/pressure combination a pair of lanes can
  // present, across a spread of nameplate scores: any two lanes further apart
  // than the ceiling keep their order, whatever the probes said.
  const states: Array<{ residency: LaneResidency; overload: boolean }> = [
    { residency: "warm", overload: false },
    { residency: "warm", overload: true },
    { residency: "cold", overload: false },
    { residency: "cold", overload: true },
    { residency: "unknown", overload: false },
  ];
  // Two slices and one model on every lane, so VRAM is the only thing moving
  // the score: 20.5, 21.3, 22.1, 25.1, 25.3, 28.5, 40.5. That spread contains
  // pairs 0.2 apart, pairs 3.2 apart, and pairs 12 apart — both sides of the
  // ceiling.
  const vramSizes = [0, 4, 8, 23, 24, 40, 100];
  let inversionsWithinCeiling = 0;

  for (const leftVram of vramSizes) {
    for (const rightVram of vramSizes) {
      for (const leftState of states) {
        for (const rightState of states) {
          const left = { host: lane("left", 2, leftVram, "m"), ...leftState };
          const right = { host: lane("right", 2, rightVram, "m"), ...rightState };
          const gap = hostCapacityScore(left.host) - hostCapacityScore(right.host);
          const ranked = rankLanesByLiveCapacity([left, right]);
          const inverted = ranked[0]!.host.id === "right" && gap > 0;
          if (gap > RESIDENCY_ADJUSTMENT_CEILING) {
            assert.equal(
              inverted,
              false,
              `a ${gap.toFixed(1)}-point lead was overturned by ${JSON.stringify(rightState)}`
            );
          } else if (inverted) {
            inversionsWithinCeiling += 1;
          }
        }
      }
    }
  }
  assert.ok(
    inversionsWithinCeiling > 0,
    "the term must actually reorder near-ties, or it is decoration"
  );
});

// --- the breaker set governs the primary lane too ----------------------------

test("a banned host::model pair is demoted from primary to candidates-only", async () => {
  const spare = lane("spare-lane", 2, 24, "shared-model");
  const registry = watchdogRegistry([{ id: TIER_IDS.local, hosts: [PRIMARY, spare] }]);
  // Pin the model override so the pair under test is exactly what a primary
  // route would carry, independent of what routeTask scores first.
  const preferredModel = "primary-model";

  // Control: with a clean breaker set, the preferred lane comes back as primary.
  const clean = await buildWatchdogRouteCandidates(
    registry,
    "implement feature",
    PRIMARY.id,
    preferredModel,
    4,
    new Set<string>(),
    probes({})
  );
  assert.equal(clean.primary?.host, PRIMARY.id);
  assert.equal(clean.primary?.model, preferredModel);
  assert.equal(clean.healthyPrimary, true);

  // Ban exactly the pair the primary route would use.
  const banned = new Set([failureKey(PRIMARY.id, preferredModel)]);
  const result = await buildWatchdogRouteCandidates(
    registry,
    "implement feature",
    PRIMARY.id,
    preferredModel,
    4,
    banned,
    probes({})
  );

  assert.equal(
    result.primary,
    null,
    "a pair that tripped its breaker must not be handed back as primary"
  );
  assert.equal(result.healthyPrimary, false);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.host),
    ["spare-lane"],
    "the healthy spare is still offered"
  );

  // The demoted lane stays visible and honestly labeled in the health report:
  // once as the demoted primary entry, once as its own evaluated candidate.
  const demotedPrimary = result.health.find((entry) => entry.kind === "primary") as Record<
    string,
    any
  >;
  assert.equal(demotedPrimary.host, PRIMARY.id);
  assert.ok(
    String(demotedPrimary.health.reason).includes("circuit breaker"),
    JSON.stringify(demotedPrimary.health)
  );
  const demotedCandidate = (result.health as Array<Record<string, any>>).find(
    (entry) => entry.kind === "fallback" && entry.host === PRIMARY.id
  );
  assert.ok(demotedCandidate, "the banned primary competes as an ordinary candidate");
  assert.ok(String(demotedCandidate.health.reason).includes("circuit breaker"));
  assert.equal(
    result.candidates.some((c) => c.host === PRIMARY.id),
    false
  );
});

// --- embedding intent outranks overlapping code keywords ---------------------

test("an embedding task gets the embedder even when the description also says 'code'", () => {
  const host: Host = {
    id: "embed-box",
    label: "embed-box",
    provider: "ollama",
    endpoint: "http://embed-box:11434",
    models: [
      { name: "qwen2.5-coder:14b", roles: ["build", "review"] },
      { name: "nomic-embed-text:v1.5", roles: ["embed"] },
    ],
  };

  // "embed code snippets" used to match wantsCode on "code" and return the
  // chat/coder model for an embedding job.
  assert.equal(chooseModelForTask(host, "embed code snippets"), "nomic-embed-text:v1.5");
  assert.equal(
    chooseModelForTask(host, "generate embeddings for retrieval"),
    "nomic-embed-text:v1.5"
  );

  // Non-embedding tasks keep today's selection untouched.
  assert.equal(chooseModelForTask(host, "implement the loader"), "qwen2.5-coder:14b");
});

// --- both tier selectors agree when the cloud gate is closed -----------------

test("route_parallel_tasks excludes a blocked cloud tier from preference, matching route_task", async (t) => {
  const savedAllowCloud = process.env.XX_STACK_ALLOW_CLOUD;
  delete process.env.XX_STACK_ALLOW_CLOUD;
  t.after(() => {
    if (savedAllowCloud === undefined) delete process.env.XX_STACK_ALLOW_CLOUD;
    else process.env.XX_STACK_ALLOW_CLOUD = savedAllowCloud;
  });

  const localHost = lane("local-lane", 2, 8, "local-model");
  const cloudHost = lane("cloud-big-lane", 8, 0, "cloud-model", {
    provider: "openai",
    capabilities: { endpointFamily: "openai-compatible" },
  });
  const optedIn = watchdogRegistry([
    { id: TIER_IDS.local, hosts: [localHost] },
    { id: TIER_IDS.cloud, hosts: [cloudHost] },
  ]);
  const gated: Registry = {
    ...optedIn,
    selectionPolicy: { ...optedIn.selectionPolicy, cloudEscalation: { optIn: false } },
  };
  const description = "multimodal image vision burst capability-gap";

  // The fixture genuinely prefers cloud on keyword score — under opt-in it wins.
  assert.equal(routeParallelTasks([description], optedIn).assignments[0]!.tier, TIER_IDS.cloud);

  // Gated: neither selector may hand the task to cloud.
  const assignment = routeParallelTasks([description], gated).assignments[0]!;
  assert.notEqual(assignment.tier, TIER_IDS.cloud);
  assert.notEqual(routeTask(description, gated).recommendedTier, TIER_IDS.cloud);
  assert.equal(assignment.tier, routeTask(description, gated).recommendedTier);
});
