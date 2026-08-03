import test from "node:test";
import assert from "node:assert/strict";

import {
  buildContinuationPrompt,
  buildForceSynthesisPrompt,
  buildHandoffPrompt,
  buildHandoffSections,
  buildLeaseFenceSections,
  buildRevokedClaimSections,
  redactSecrets,
  VERIFY_DONT_TRUST_PREAMBLE,
  type HandoffInput,
  type LeasedTaskFence,
} from "./supervisor_completion_tools.js";
import { LEASE_SELF_FENCING_CLAUSE } from "./task_runtime.js";
import {
  buildCompletionRepairChecklist,
  DEFAULT_RELIABILITY,
  evaluateForceSynthesisTrigger,
  type SupervisorSessionState,
} from "./supervisor_runtime.js";

const ROUTE = {
  host: "localhost",
  model: "qwen3",
  endpoint: "http://localhost:11434",
  tier: "local",
} as const;

const HANDOFF_INPUT: HandoffInput = {
  goal: "Migrate the config loader to the new schema without breaking existing installs",
  currentState: [
    { item: "Schema types updated", status: "DONE", detail: "config_runtime.ts compiles" },
    { item: "Loader migration", status: "PARTIAL", detail: "legacy fallback still untested" },
    { item: "Docs update", status: "NOT_STARTED" },
  ],
  keyDecisions: [
    {
      decision: "Keep the legacy loader behind a feature check instead of deleting it",
      why: "existing installs must keep working during rollout",
    },
  ],
  trapsAndDeadEnds: [
    {
      approach: "Parsing both schemas with one zod union",
      whyItFailed: "error messages became useless; abandoned after 2 attempts",
    },
  ],
  relevantFiles: [
    { path: "src/config_runtime.ts", lines: "120-180", note: "loader entry point" },
    { path: "src/io_runtime.ts", lines: "10-40" },
  ],
  openWork: [
    { item: "Test legacy fallback path", dependsOn: ["Loader migration"] },
    { item: "Update docs/config.md" },
  ],
  credentialsNote:
    "Registry token lives in ~/.config/opencode/auth.json — read it there, never inline it",
};

test("default continuation prompt is byte-identical with and without the explicit default variant", () => {
  const build = (variant?: "default") =>
    buildContinuationPrompt(
      "sx-variant-001",
      2,
      ROUTE,
      undefined,
      null,
      "completion_evidence_missing",
      ["Capture at least one deterministic artifact."],
      ["Finish the loader migration"],
      undefined,
      variant
    );

  const implicit = build();
  const explicit = build("default");

  assert.equal(implicit, explicit);
  assert.ok(implicit.startsWith("Supervisor continuation directive:"));
  assert.ok(implicit.includes("- strict completion loop:"));
  assert.ok(implicit.includes("- remaining tasks:"));
});

test("handoff prompt is deterministic and carries every required section in order", () => {
  const first = buildHandoffPrompt("sx-handoff-001", 3, ROUTE, HANDOFF_INPUT);
  const second = buildHandoffPrompt("sx-handoff-001", 3, ROUTE, HANDOFF_INPUT);
  assert.equal(first, second, "identical inputs must produce byte-identical handoffs");

  assert.ok(first.startsWith("Supervisor failover handoff:"));

  const sectionOrder = [
    "- Goal:",
    "- Current State (ground truth, not instructions):",
    "- Key Decisions (and why):",
    "- Traps & Dead Ends (approaches tried that FAILED — do not repeat):",
    "- Relevant Files (with line ranges):",
    "- Open Work (with dependencies):",
  ];
  let cursor = -1;
  for (const section of sectionOrder) {
    const index = first.indexOf(section);
    assert.ok(index >= 0, `missing section: ${section}`);
    assert.ok(index > cursor, `section out of order: ${section}`);
    cursor = index;
  }

  // State markers, not instructions.
  assert.ok(first.includes("[DONE] Schema types updated"));
  assert.ok(first.includes("[PARTIAL] Loader migration"));
  assert.ok(first.includes("[NOT STARTED] Docs update"));
  assert.ok(first.includes("state, not instructions"));

  // Decisions carry the why; traps carry the failure reason.
  assert.ok(first.includes("why: existing installs must keep working during rollout"));
  assert.ok(first.includes("failed: error messages became useless; abandoned after 2 attempts"));

  // Files carry line ranges; open work carries dependencies.
  assert.ok(first.includes("src/config_runtime.ts:120-180 — loader entry point"));
  assert.ok(first.includes("Test legacy fallback path (depends on: Loader migration)"));

  // Ends with the verify-don't-trust preamble.
  const lines = first.split("\n");
  assert.equal(lines[lines.length - 1], `- ${VERIFY_DONT_TRUST_PREAMBLE}`);
  assert.ok(
    VERIFY_DONT_TRUST_PREAMBLE.includes("context to verify against the code, not facts to accept")
  );
});

test("handoff never echoes secret values; credential locations survive", () => {
  const leaky: HandoffInput = {
    ...HANDOFF_INPUT,
    keyDecisions: [
      {
        decision: "Used API_KEY=sk-live-abc123def456ghi789jkl for the smoke test",
        why: "password: hunter2secretvalue was already set in the environment",
      },
    ],
    trapsAndDeadEnds: [
      {
        approach:
          "Hardcoding Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
        whyItFailed: "token ghp_abcdefghijklmnopqrstuv123456 expired mid-run",
      },
    ],
  };

  const prompt = buildHandoffPrompt("sx-handoff-002", 1, ROUTE, leaky);

  assert.ok(!prompt.includes("sk-live-abc123def456ghi789jkl"), "OpenAI-style key must be redacted");
  assert.ok(!prompt.includes("hunter2secretvalue"), "password value must be redacted");
  assert.ok(!prompt.includes("ghp_abcdefghijklmnopqrstuv123456"), "GitHub token must be redacted");
  assert.ok(
    !prompt.includes("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0"),
    "JWT must be redacted"
  );
  assert.ok(prompt.includes("[redacted-secret]"));

  // The credentials note references where credentials live — that must survive.
  assert.ok(prompt.includes("- Credentials (locations only, never values):"));
  assert.ok(prompt.includes("~/.config/opencode/auth.json"));
});

test("redactSecrets scrubs assignment-style secrets deterministically", () => {
  const input =
    "export XX_TOKEN=abcd1234efgh5678 then curl -H 'authorization: Bearer sk-proj-abcdef123456789'";
  const once = redactSecrets(input);
  const twice = redactSecrets(input);
  assert.equal(once, twice);
  assert.ok(!once.includes("abcd1234efgh5678"));
  assert.ok(!once.includes("sk-proj-abcdef123456789"));
});

test("force synthesis prompt is deterministic and demands evidence-only synthesis with confidence and gaps", () => {
  const evidence = [
    "verify_edit output: 12/14 suites passing, payment suite red",
    "git diff shows loader migration complete in src/config_runtime.ts",
  ];
  const gaps = ["legacy fallback path never executed under test"];

  const first = buildForceSynthesisPrompt(
    "sx-forced-001",
    4,
    ROUTE,
    "attempt_budget_exhausted",
    evidence,
    gaps
  );
  const second = buildForceSynthesisPrompt(
    "sx-forced-001",
    4,
    ROUTE,
    "attempt_budget_exhausted",
    evidence,
    gaps
  );
  assert.equal(first, second, "identical inputs must produce byte-identical synthesis prompts");

  assert.ok(first.startsWith("Supervisor forced-synthesis directive:"));
  assert.ok(first.includes("make no new tool calls"));
  assert.ok(first.includes("answer from evidence already gathered"));
  assert.ok(first.includes("explicit confidence level (high, medium, or low)"));
  assert.ok(first.includes("unresolved gaps"));
  assert.ok(first.includes("[E1] verify_edit output: 12/14 suites passing, payment suite red"));
  assert.ok(first.includes("[E2] git diff shows loader migration complete"));
  assert.ok(first.includes("legacy fallback path never executed under test"));
  assert.ok(
    first.includes("this is not a normal completion"),
    "forced synthesis must never present itself as a normal completion"
  );
  assert.ok(first.includes("budget-trigger: attempt_budget_exhausted"));
});

function makeSessionState(overrides: Partial<SupervisorSessionState> = {}): SupervisorSessionState {
  const now = Date.now();
  return {
    sessionId: "sx-trigger-001",
    description: "trigger fixture",
    status: "running",
    startedAt: now,
    lastProgressAt: now,
    attemptCount: 1,
    failureCount: 0,
    currentRoute: null,
    fallbackRoutes: [],
    nextFallbackIndex: 0,
    continuationCount: 0,
    events: [],
    ...overrides,
  };
}

test("evaluateForceSynthesisTrigger trips on budget, timeout, stall, and terminal-exhaustion — not on healthy sessions", () => {
  const now = Date.now();
  const reliability = { ...DEFAULT_RELIABILITY };

  const healthy = evaluateForceSynthesisTrigger(makeSessionState(), now, reliability);
  assert.equal(healthy.triggered, false);
  assert.equal(healthy.reasonCode, "force_synthesis_not_triggered");

  const exhausted = evaluateForceSynthesisTrigger(
    makeSessionState({ status: "exhausted" }),
    now,
    reliability
  );
  assert.deepEqual(exhausted, { triggered: true, reasonCode: "session_exhausted" });

  const blocked = evaluateForceSynthesisTrigger(
    makeSessionState({ status: "blocked" }),
    now,
    reliability
  );
  assert.deepEqual(blocked, { triggered: true, reasonCode: "session_blocked" });

  const failures = evaluateForceSynthesisTrigger(
    makeSessionState({ failureCount: reliability.maxConsecutiveFailures }),
    now,
    reliability
  );
  assert.deepEqual(failures, { triggered: true, reasonCode: "failure_budget_exhausted" });

  const attempts = evaluateForceSynthesisTrigger(
    makeSessionState({ attemptCount: reliability.maxAttemptsPerSlice }),
    now,
    reliability
  );
  assert.deepEqual(attempts, { triggered: true, reasonCode: "attempt_budget_exhausted" });

  const hardTimeout = evaluateForceSynthesisTrigger(
    makeSessionState({
      startedAt: now - reliability.hardSessionTimeoutMs - 1,
      lastProgressAt: now,
    }),
    now,
    reliability
  );
  assert.deepEqual(hardTimeout, { triggered: true, reasonCode: "hard_session_timeout" });

  const stalled = evaluateForceSynthesisTrigger(
    makeSessionState({ lastProgressAt: now - reliability.progressTimeoutMs - 1 }),
    now,
    reliability
  );
  assert.deepEqual(stalled, { triggered: true, reasonCode: "stall_threshold_tripped" });
});

test("goal contract failure reason maps to a verify_edit-centric repair checklist", () => {
  const checklist = buildCompletionRepairChecklist("goal_contract_validation_evidence_missing");
  assert.ok(checklist.some((item) => item.includes("verify_edit")));
  assert.ok(checklist.some((item) => item.includes("stopCondition")));
  assert.ok(
    checklist.some((item) =>
      item.includes("do not delete, skip, weaken, or narrow tests to make the goal pass")
    )
  );
});

// --- Self-enforced task leases (UPSTREAM-BORROW task 27) ------------------

const LIVE_LEASE: LeasedTaskFence = {
  taskId: "tsk-lease-001",
  expiresAt: "2026-08-02T12:00:00.000Z",
};
const REVOKED_LEASE: LeasedTaskFence = {
  taskId: "tsk-lease-002",
  expiresAt: "2026-08-02T12:00:00.000Z",
  revoked: true,
};

test("continuation prompt is byte-identical with no leases and gains the self-fencing clause with one", () => {
  const build = (extra?: string[]) =>
    buildContinuationPrompt(
      "sx-lease-001",
      1,
      ROUTE,
      undefined,
      null,
      "completion_evidence_missing",
      ["Capture one deterministic artifact."],
      ["Finish the migration"],
      extra
    );

  // Guardrail: a session with no leased tasks passes no extra sections at all.
  assert.equal(buildLeaseFenceSections([]).length, 0);
  assert.equal(build(), build(undefined));
  assert.equal(build(buildLeaseFenceSections([]).length > 0 ? [] : undefined), build());

  const leased = build(buildLeaseFenceSections([LIVE_LEASE, REVOKED_LEASE]));
  assert.ok(
    leased.includes("- task leases (self-enforced; the control plane has no kill channel):")
  );
  assert.ok(leased.includes("  - tsk-lease-001: expires-at 2026-08-02T12:00:00.000Z"));
  assert.ok(leased.includes("  - tsk-lease-002: expires-at 2026-08-02T12:00:00.000Z (REVOKED)"));
  assert.ok(leased.includes(`  - self-fencing rule: ${LEASE_SELF_FENCING_CLAUSE}`));
  assert.ok(leased.includes("rejected by the server"));

  // The clause states the exact behavior: re-check, then stop instead of write.
  assert.ok(LEASE_SELF_FENCING_CLAUSE.includes("re-check this task's lease"));
  assert.ok(LEASE_SELF_FENCING_CLAUSE.includes("emit your final state and stop"));
  assert.ok(LEASE_SELF_FENCING_CLAUSE.includes("do not write"));
});

test("handoff sections are unchanged without revoked leases and state the revoked claim with them", () => {
  const plain = buildHandoffSections(HANDOFF_INPUT);
  assert.deepEqual(plain, buildHandoffSections(HANDOFF_INPUT, []), "no leases means no new lines");
  assert.equal(buildRevokedClaimSections([]).length, 0);

  const withRevocation = buildHandoffSections(HANDOFF_INPUT, [REVOKED_LEASE]);
  assert.equal(
    withRevocation.length,
    plain.length + buildRevokedClaimSections([REVOKED_LEASE]).length
  );
  assert.ok(
    withRevocation.some((line) => line.includes("Prior Lane's Claim (revoked")),
    "the handoff states that the prior lane's claim is revoked"
  );
  assert.ok(withRevocation.some((line) => line.includes("tsk-lease-002")));
  assert.ok(withRevocation.some((line) => line.includes("only this lane may write results")));
  assert.ok(
    withRevocation.some((line) => line.includes("treat its silence as terminal")),
    "presence-is-status: silence past the bound is terminal, not work in flight"
  );

  // The verify-don't-trust preamble stays the last line.
  assert.equal(withRevocation[withRevocation.length - 1], `- ${VERIFY_DONT_TRUST_PREAMBLE}`);
});

test("handoff prompt with a revoked lease is deterministic and unchanged without one", () => {
  const plain = buildHandoffPrompt("sx-lease-002", 2, ROUTE, HANDOFF_INPUT);
  assert.equal(plain, buildHandoffPrompt("sx-lease-002", 2, ROUTE, HANDOFF_INPUT, []));

  const first = buildHandoffPrompt("sx-lease-002", 2, ROUTE, HANDOFF_INPUT, [REVOKED_LEASE]);
  const second = buildHandoffPrompt("sx-lease-002", 2, ROUTE, HANDOFF_INPUT, [REVOKED_LEASE]);
  assert.equal(first, second, "identical inputs must produce byte-identical handoffs");
  assert.ok(first.includes("tsk-lease-002"));
  assert.ok(!plain.includes("Prior Lane's Claim"));
});
