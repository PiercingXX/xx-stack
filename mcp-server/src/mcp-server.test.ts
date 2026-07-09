import test from "node:test";
import assert from "node:assert/strict";
import {
  __testExports,
  applySupervisorEventTransition,
  computeBackoffMs,
  emptySupervisorStore,
  pruneSupervisorStore,
  type ReliabilityConfig,
} from "./index.js";

// ── Routing Tests (real routeTask against a fixture registry) ───────────────

function makeRegistry() {
  return {
    version: 1,
    selectionPolicy: {
      defaultOrder: ["primary", "overflow", "cloud"],
      rules: [],
    },
    tiers: [
      {
        id: "primary",
        label: "Primary",
        priority: 1,
        hosts: [
          {
            id: "primary-host",
            label: "Primary Host",
            provider: "self-hosted-runtime",
            endpoint: "http://primary.local:3000",
            reachable: true,
          },
        ],
      },
      {
        id: "overflow",
        label: "Overflow",
        priority: 2,
        hosts: [
          {
            id: "overflow-host",
            label: "Overflow Host",
            provider: "self-hosted-runtime",
            endpoint: "http://overflow.local:3000",
            reachable: true,
          },
        ],
      },
      {
        id: "cloud",
        label: "Cloud",
        priority: 3,
        hosts: [
          {
            id: "cloud-host",
            label: "Cloud Host",
            provider: "cloud-api",
            endpoint: "https://cloud.example.com",
            reachable: true,
          },
        ],
      },
    ],
  };
}

test("routeTask routes keyword-matched tasks to the matching tier", () => {
  const recommendation = __testExports.routeTask("implement and fix the build", makeRegistry());

  assert.equal(recommendation.recommendedTier, "primary");
  assert.equal(recommendation.recommendedHost, "primary-host");
  assert.ok(recommendation.reasoning, "Recommendation should include reasoning");
});

test("routeTask falls back to the next tier when the matched tier has no reachable hosts", () => {
  const registry = makeRegistry();
  const primaryTier = registry.tiers.find((tier) => tier.id === "primary");
  assert.ok(primaryTier);
  for (const host of primaryTier.hosts) {
    host.reachable = false;
  }

  const recommendation = __testExports.routeTask("implement and fix the build", registry);

  assert.equal(recommendation.recommendedTier, "overflow");
  assert.equal(recommendation.recommendedHost, "overflow-host");
  assert.match(recommendation.reasoning, /fell back/);
});

test("routeTask names an alternate tier with reachable hosts as fallback", () => {
  const recommendation = __testExports.routeTask("implement and fix the build", makeRegistry());

  assert.ok(recommendation.fallback, "Recommendation should name a fallback tier");
  assert.notEqual(recommendation.fallback, recommendation.recommendedTier);
});

test("routeTask denies self-hosted lanes for multimodal tasks", () => {
  const registry = makeRegistry();

  const recommendation = __testExports.routeTask("implement image processing pipeline", registry);

  assert.equal(recommendation.recommendedTier, "cloud");
  assert.equal(recommendation.recommendedHost, "cloud-host");
  assert.match(recommendation.reasoning, /denied self-hosted/);
});

// ── Agent Tool Policy Tests (real applyToolPolicy incl. wildcard rules) ─────

test("applyToolPolicy respects allow and deny rules including wildcards", () => {
  const profile = {
    toolPolicy: {
      allow: ["*"],
      deny: ["supervisor_*"],
    },
  };
  const candidateTools = ["editFiles", "runCommands", "readFile", "supervisor_abort_session"];

  const policy = __testExports.applyToolPolicy(profile as never, candidateTools);

  assert.ok(policy.allowedTools.includes("editFiles"), "Allowed tool should be included");
  assert.ok(policy.allowedTools.includes("runCommands"), "Allowed tool should be included");
  assert.ok(!policy.allowedTools.includes("supervisor_abort_session"), "Wildcard-denied tool should be excluded");
  assert.ok(policy.deniedTools.includes("supervisor_abort_session"), "Denied tool should be reported");
});

test("applyToolPolicy treats an empty allow list as allow-all", () => {
  const profile = { toolPolicy: { allow: [], deny: [] } };

  const policy = __testExports.applyToolPolicy(profile as never, ["route_task", "list_platforms"]);

  assert.deepEqual(policy.allowedTools, ["route_task", "list_platforms"]);
  assert.deepEqual(policy.deniedTools, []);
});

// ── Supervisor Tests ─────────────────────────────────────────────────────────

function makeSessionState(sessionId: string): Parameters<typeof applySupervisorEventTransition>[0] {
  return {
    sessionId,
    description: "test session",
    status: "running",
    startedAt: Date.now(),
    lastProgressAt: Date.now(),
    attemptCount: 0,
    failureCount: 0,
    currentRoute: null,
    fallbackRoutes: [],
    nextFallbackIndex: 0,
    continuationCount: 0,
    events: [],
  };
}

test("applySupervisorEventTransition records assistant output as progress", () => {
  const state = makeSessionState("test-session-456");
  const now = Date.now();

  const transition = applySupervisorEventTransition(
    state,
    "message.updated.assistant",
    now,
    __testExports.DEFAULT_RELIABILITY,
    "Test output"
  );

  assert.ok(transition.reasonCode, "Transition should have a reason code");
  assert.equal(state.lastOutputAt, now);
});

// ── Utility Tests ──────────────────────────────────────────────────────────────

test("computeBackoffMs implements exponential backoff", () => {
  const reliability: ReliabilityConfig = {
    ...__testExports.DEFAULT_RELIABILITY,
    backoffInitialMs: 1000,
    backoffMaxMs: 5000,
  };

  assert.equal(computeBackoffMs(reliability, 1), 1000);
  assert.equal(computeBackoffMs(reliability, 2), 2000);
  assert.equal(computeBackoffMs(reliability, 3), 4000);
  assert.equal(computeBackoffMs(reliability, 4), 5000); // Capped
});

test("computeBackoffMs uses production defaults", () => {
  const r = __testExports.DEFAULT_RELIABILITY;

  assert.equal(computeBackoffMs(r, 1), 2000);
  assert.equal(computeBackoffMs(r, 2), 4000);
  assert.equal(computeBackoffMs(r, 6), 60000); // Capped at 60s
});

test("pruneSupervisorStore removes stale sessions", () => {
  const now = Date.now();
  const reliability: ReliabilityConfig = {
    ...__testExports.DEFAULT_RELIABILITY,
    staleSessionTtlMs: 10_000,
  };

  const store = emptySupervisorStore();

  // Add fresh session
  store.sessions["fresh"] = {
    sessionId: "fresh",
    description: "Fresh session",
    status: "completed" as const,
    startedAt: now - 5_000,
    lastProgressAt: now - 5_000,
    attemptCount: 1,
    failureCount: 0,
    currentRoute: null,
    fallbackRoutes: [],
    nextFallbackIndex: 0,
    continuationCount: 0,
    events: [],
  };

  // Add stale session
  store.sessions["stale"] = {
    sessionId: "stale",
    description: "Stale session",
    status: "completed" as const,
    startedAt: now - 20_000,
    lastProgressAt: now - 20_000,
    attemptCount: 1,
    failureCount: 0,
    currentRoute: null,
    fallbackRoutes: [],
    nextFallbackIndex: 0,
    continuationCount: 0,
    events: [],
  };

  const pruned = pruneSupervisorStore(store, reliability);

  assert.ok(pruned.sessions["fresh"], "Fresh session should be kept");
  assert.ok(!pruned.sessions["stale"], "Stale session should be removed");
});
