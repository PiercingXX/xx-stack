import test from "node:test";
import assert from "node:assert/strict";

import {
  buildContinuationPrompt,
  buildForceSynthesisPrompt,
  buildForceSynthesisSections,
  buildHandoffPrompt,
  buildHandoffSections,
  buildLeaseFenceSections,
  buildRevokedClaimSections,
  collectForceSynthesisRecordedFacts,
  isDotenvPath,
  redactDotenvAssignments,
  redactSecrets,
  VERIFY_DONT_TRUST_PREAMBLE,
  type ForceSynthesisRecordedFacts,
  type HandoffInput,
  type LeasedTaskFence,
} from "./supervisor_completion_tools.js";
import { LEASE_SELF_FENCING_CLAUSE, type GoalContract } from "./task_runtime.js";
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

/** A recorded-fact block with something in every field, for prompt shape tests. */
const RECORDED_FACTS: ForceSynthesisRecordedFacts = {
  continuationCount: 4,
  elapsedMs: 121_000,
  recordedEventCount: 17,
  checks: [
    {
      label: "completion evidence recorded via supervisor_record_completion_check",
      command: null,
      outcome: "not_recorded",
    },
    { label: "completion judge verdict", command: null, outcome: "fail" },
    {
      label: "goal-contract validation for task tsk-0001",
      command: "npm test",
      outcome: "fail",
    },
  ],
};

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
    gaps,
    RECORDED_FACTS
  );
  const second = buildForceSynthesisPrompt(
    "sx-forced-001",
    4,
    ROUTE,
    "attempt_budget_exhausted",
    evidence,
    gaps,
    RECORDED_FACTS
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

// ---------------------------------------------------------------------------
// Forced synthesis ran on agent-authored evidence only.
//
// `supervisor_force_synthesis` takes `evidence: z.array(z.string())` straight
// from the caller and the prompt then said "cite only these items" and "cite the
// specific evidence item supporting every claim" — so an agent that invents its
// evidence list cites it perfectly and the citation requirement proves nothing.
// This is the salvage path, reached exactly when the budget is exhausted and the
// incentive to inflate is at its peak. The strict path is grounded (it checks
// the store for a real verify_edit result matching the contract's validationCmd
// and refuses with goal_contract_validation_evidence_missing); this one was not.
// ---------------------------------------------------------------------------

const CONTRACT_WITH_CMD: GoalContract = {
  objective: "Migrate the loader",
  constraints: ["existing installs keep working"],
  validationCmd: "npm test",
  stopCondition: "loader suite green",
};

test("forced synthesis grounds the prompt in facts the agent did not author", () => {
  const sections = buildForceSynthesisSections(
    "attempt_budget_exhausted",
    ["all 14 suites pass and the migration is complete"], // the inflated claim
    [],
    RECORDED_FACTS
  );
  const text = sections.join("\n");

  // The grounded block exists, is labelled as harness-recorded, and precedes
  // the agent's list so the claims are read against it.
  const factsIndex = text.indexOf("- harness-recorded facts");
  const claimIndex = text.indexOf("- evidence claimed by the agent");
  assert.ok(factsIndex >= 0, "the recorded-fact block must be rendered");
  assert.ok(claimIndex >= 0, "the caller's evidence must be under its own heading");
  assert.ok(factsIndex < claimIndex, "recorded facts must precede the agent's claims");
  assert.ok(text.includes("not authored by the agent"));

  // Every fact named in the fix, from state the server already persists.
  assert.ok(text.includes("  - continuation-attempts: 4"));
  assert.ok(text.includes("  - session-elapsed-ms: 121000"));
  assert.ok(text.includes("  - recorded-events: 17"));

  // Completion checks carry their command and their pass/fail.
  assert.ok(text.includes("completion judge verdict: fail"));
  assert.ok(text.includes("goal-contract validation for task tsk-0001 [command: npm test]: fail"));
  // The single most useful contradiction of an inflated list.
  assert.ok(text.includes("completion evidence recorded via"));
  assert.ok(text.includes(": not_recorded"));

  // The caller's items are still cited as [E#], but marked unverified.
  assert.ok(text.includes("(UNVERIFIED"));
  assert.ok(text.includes("[E1] all 14 suites pass and the migration is complete"));

  // And the tie-break rule: the recorded fact wins, and the conflict is a gap.
  assert.ok(
    text.includes(
      "  5) where a claim conflicts with a harness-recorded fact above, the recorded fact wins; name the conflict in the unresolved gaps list"
    )
  );
});

test("the recorded-fact block is deterministic for identical store state", () => {
  const state = makeSessionState({
    sessionId: "sx-facts-001",
    startedAt: 1_000,
    lastProgressAt: 9_000,
    forceSynthesisAt: 121_000,
    continuationCount: 3,
    completionJudgeVerdict: "fail",
    events: [
      { at: "2026-08-02T00:00:00.000Z", type: "session.started", detail: "" },
      { at: "2026-08-02T00:00:01.000Z", type: "continuation.injected", detail: "attempt 1" },
    ],
  });
  // Deliberately reversed so a store-iteration-order leak would show up.
  const contractTasks = [
    { taskId: "tsk-b", goalContract: CONTRACT_WITH_CMD },
    { taskId: "tsk-a", goalContract: CONTRACT_WITH_CMD },
  ];

  const first = collectForceSynthesisRecordedFacts(state, contractTasks);
  const second = collectForceSynthesisRecordedFacts(state, [...contractTasks].reverse());
  assert.deepEqual(first, second, "task order in the store must not reach the block");

  // Elapsed time is derived from persisted stamps, not a live clock read: it is
  // the same on every call, which is what makes the block byte-stable.
  assert.equal(first.elapsedMs, 120_000);
  assert.equal(first.continuationCount, 3);
  assert.equal(first.recordedEventCount, 2);
  assert.equal(first.checks[2]!.label, "goal-contract validation for task tsk-a");
  assert.equal(first.checks[3]!.label, "goal-contract validation for task tsk-b");

  const render = (facts: ForceSynthesisRecordedFacts): string =>
    buildForceSynthesisSections("stall_threshold_tripped", ["claim"], ["gap"], facts).join("\n");
  assert.equal(render(first), render(second));
  assert.equal(render(first), render(collectForceSynthesisRecordedFacts(state, contractTasks)));
  // The collected facts must actually reach the rendered prompt — a block that
  // is computed and then dropped is deterministic and useless.
  assert.ok(render(first).includes("  - session-elapsed-ms: 120000"));
  assert.ok(render(first).includes("goal-contract validation for task tsk-a [command: npm test]"));
});

test("a session with no recorded checks says so instead of rendering an empty list", () => {
  const empty: ForceSynthesisRecordedFacts = {
    continuationCount: 0,
    elapsedMs: 0,
    recordedEventCount: 0,
    checks: [],
  };
  const text = buildForceSynthesisSections("session_blocked", [], [], empty).join("\n");
  assert.ok(text.includes("    - none: no completion check was recorded in this session"));
  assert.ok(!/recorded completion checks:\n\s*- (?!none)/.test(text));

  // The pre-existing no-evidence behavior is untouched.
  assert.ok(
    text.includes("(no evidence recorded — state this explicitly and mark confidence low)")
  );
});

test("a contract whose validation evidence is missing is recorded as a failing check", () => {
  // The exact condition `supervisor_complete_session` refuses on. Forced
  // synthesis cannot refuse — the budget is gone — so it states the fact.
  const missing = collectForceSynthesisRecordedFacts(
    makeSessionState({ completionEvidenceSummary: undefined }),
    [{ taskId: "tsk-0001", goalContract: CONTRACT_WITH_CMD }]
  );
  assert.deepEqual(missing.checks[2], {
    label: "goal-contract validation for task tsk-0001",
    command: "npm test",
    outcome: "fail",
  });

  // Recorded evidence that actually names the command passes the same check.
  const present = collectForceSynthesisRecordedFacts(
    makeSessionState({
      completionEvidenceAt: 5_000,
      completionEvidenceSummary: "verify_edit ran `npm test`: 14/14 green",
      completionJudgeVerdict: "pass",
    }),
    [{ taskId: "tsk-0001", goalContract: CONTRACT_WITH_CMD }]
  );
  assert.equal(present.checks[0]!.outcome, "recorded");
  assert.equal(present.checks[1]!.outcome, "pass");
  assert.equal(present.checks[2]!.outcome, "pass");
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

// --- Self-enforced task leases ------------------

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

test("redactSecrets scrubs auth-scheme tokens that the assignment pass would strand", () => {
  // Regression: SECRET_ASSIGNMENT_PATTERN treats `authorization` as a secret
  // key and its value capture stops at the first space, so it consumed only
  // the word "Bearer" and left the token in the clear. Anything not separately
  // matched by SECRET_VALUE_PATTERNS (a JWT, an opaque vendor token) leaked
  // into handoff and continuation prompts verbatim.
  const leaky = [
    "Authorization: Bearer eyJhbGciOiJI.eyJzdWIiOiIxMjM.SflKxwRJSMeKKF2QT4",
    "authorization: bearer short1234567890abcdef",
    "Proxy-Authorization: Bearer tok_live_9999abcd",
    "Authorization: Basic dXNlcjpwYXNzd29yZA==",
  ];
  for (const line of leaky) {
    const out = redactSecrets(line);
    assert.ok(
      !/eyJ|short1234567890|tok_live_9999|dXNlcjpwYXNz/.test(out),
      `token survived redaction: ${out}`
    );
    assert.match(out, /\[redacted-secret\]/);
  }

  // A credential LOCATION must still survive — a handoff has to be able to say
  // where the secret lives without carrying its value.
  const location = "token lives in ~/.hermes/config.yaml";
  assert.equal(redactSecrets(location), location);
});

test("the auth-scheme pass does not mangle ordinary prose after a scheme word", () => {
  // The credential alphabet includes every lowercase letter, so `{8,}` accepted
  // an English word: a tsc diagnostic came back corrupted, which is the
  // redactor's own failure mode inverted. `verify_edit` now routes compiler and
  // test-runner output through this pass, so a damaged message is a damaged
  // repair loop.
  const diagnostics = [
    "error TS2304: Cannot find name 'token expected here'",
    "Expected token identifier but found something",
    "digest computed over payload contents",
    "basic auth is required",
    "bearer required for this endpoint",
  ];
  for (const line of diagnostics) {
    assert.equal(redactSecrets(line), line, `diagnostic must survive byte-intact: ${line}`);
  }
});

test("tightening the auth-scheme pass did not narrow what it redacts", () => {
  // Every credential shape the pass covered before still goes. The rule is
  // deliberately weak — one digit, one uppercase letter, one of `._~+/=-`, or
  // 16+ characters — because real credentials always clear that bar.
  const credentials = [
    ["Authorization: Bearer eyJhbGciOiJI.eyJzdWIiOiIxMjM.SflKxwRJSMeKKF2QT4", "eyJhbGciOiJI"],
    ["authorization: bearer short1234567890abcdef", "short1234567890abcdef"],
    ["Proxy-Authorization: Bearer tok_live_9999abcd", "tok_live_9999abcd"],
    ["Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA=="],
    ["authorization: bearer abcdefghijklmnopqrst", "abcdefghijklmnopqrst"],
    ["Authorization: Bearer sk-proj-abcdef123456789", "sk-proj-abcdef123456789"],
  ] as const;
  for (const [line, secret] of credentials) {
    const out = redactSecrets(line);
    assert.ok(!out.includes(secret), `credential survived redaction: ${out}`);
    assert.match(out, /\[redacted-secret\]/);
  }
});

test("redacting an assignment value keeps the quote that closes the line around it", () => {
  // `\S+` swallowed a quote opened before the key, so an assert diff line lost
  // its closing delimiter. The value still goes; the punctuation stays.
  assert.equal(redactSecrets("+ 'password: hunter2'"), "+ 'password: [redacted-secret]'");
  assert.equal(redactSecrets('- "token: abc12345"'), '- "token: [redacted-secret]"');
  // A value that carries its own quotes is unchanged — the quotes are inside
  // the redacted span, not around it.
  assert.equal(redactSecrets('password: "hunter2"'), "password: [redacted-secret]");
  // An apostrophe that is part of the value is not a delimiter.
  assert.equal(redactSecrets("password: hunter2"), "password: [redacted-secret]");
});

// --- Redaction by file shape (dotenv) --------------------------------------
//
// The value-pattern and key-name passes are unbounded-by-construction. These
// three lines survived them VERBATIM and were confirmed leaking through
// `review_to_continuation` into a continuation prompt bound for another lane.

/** The exact lines confirmed leaking before the structural pass existed. */
const CONFIRMED_LEAKS = [
  "DATABASE_URL=postgres://admin:hunter2@db.internal:5432/prod",
  "STRIPE_KEY=sk_live_51ABCdefGHI",
  "SMTP_PASS=hunter2",
];

test("isDotenvPath matches dotenv basenames and nothing else", () => {
  for (const path of [
    ".env",
    ".envrc",
    ".env.production",
    ".env.test.local",
    "config/.env",
    "/srv/app/.env.production",
    "C:\\srv\\app\\.env",
    ".ENV.Production",
    // Suffixed dotenv names match too. Over-redacting `.env.example.md` is the
    // safe side of the line; the file is dotenv-shaped by name.
    "docs/.env.example.md",
  ]) {
    assert.equal(isDotenvPath(path), true, `${path} should be dotenv-shaped`);
  }
  for (const path of [
    "src/env.ts",
    "env",
    ".environment",
    ".env.production/notes.md",
    ".envrc.bak",
    "package.json",
  ]) {
    assert.equal(isDotenvPath(path), false, `${path} must not be treated as dotenv`);
  }
});

test("redactSecrets with no path is byte-identical to the value-pattern behavior", () => {
  // Prompt-shape tests and drift checks pin this: adding a file-shape pass must
  // not move a single byte on the default (pathless) call.
  const samples = [
    CONFIRMED_LEAKS.join("\n"),
    "export XX_TOKEN=abcd1234efgh5678",
    "Authorization: Bearer eyJhbGciOiJI.eyJzdWIiOiIxMjM.SflKxwRJSMeKKF2QT4",
    "token lives in ~/.hermes/config.yaml",
    "- session: sx-001\n- continuation-attempt: 2\n",
  ];
  for (const sample of samples) {
    assert.equal(
      redactSecrets(sample),
      redactSecrets(sample, {}),
      "an empty opts object must behave exactly like no opts"
    );
    assert.equal(
      redactSecrets(sample, { path: "src/app.ts" }),
      redactSecrets(sample),
      "a non-dotenv path must not engage the structural pass"
    );
  }
  // This assertion used to pin that the pathless call left ALL THREE confirmed
  // leaks alone, which encoded a limitation as if it were intended behavior.
  // The URL-userinfo pass since closed one of them on the pathless path — the
  // production callers (handoff/continuation lines, reviewed diffs) pass no
  // path, so a connection URL was reaching another lane with its password
  // intact. What the pathless call still cannot do is redact a value whose key
  // carries no secret-ish noun and whose value matches no vendor format; that
  // is what the file-shape pass is for, and it is pinned precisely below.
  const pathless = redactSecrets(CONFIRMED_LEAKS.join("\n"));
  assert.ok(!pathless.includes("hunter2@"), "a URL password must not survive the pathless call");
  assert.match(pathless, /postgres:\/\/admin:\[redacted-secret\]@db\.internal/);
  // Still opaque without the file-shape pass: STRIPE_KEY's value is not a
  // recognised vendor format (sk_ with an underscore), and SMTP_PASS's key is
  // `pass`, not `password`.
  assert.ok(pathless.includes("sk_live_51ABCdefGHI"), "value-pattern gap is still real");
  assert.ok(pathless.includes("SMTP_PASS=hunter2"), "key-name gap is still real");
});

test("redactSecrets redacts every dotenv value when the path is dotenv-shaped", () => {
  const out = redactSecrets(CONFIRMED_LEAKS.join("\n"), { path: ".env.production" });
  for (const secret of ["hunter2", "sk_live_51ABCdefGHI", "postgres://admin"]) {
    assert.ok(!out.includes(secret), `secret survived redaction: ${out}`);
  }
  // Key names MUST survive: a handoff has to be able to say "DATABASE_URL is
  // set in .env.production" without carrying the value.
  for (const key of ["DATABASE_URL", "STRIPE_KEY", "SMTP_PASS"]) {
    assert.ok(out.includes(key), `key name ${key} must survive redaction`);
  }
  assert.equal(out.split("\n").length, CONFIRMED_LEAKS.length, "line count must be preserved");
});

test("redactDotenvAssignments preserves keys, comments, blanks, and line count", () => {
  const input = [
    "# production credentials",
    "export FOO=bar",
    "BAR: baz",
    'QUOTED="a b"  # note',
    "SINGLE='it\\'s fine' # trailing",
    "EMPTY=",
    "BLANKISH=   ",
    "",
    "PLAIN=value # tail comment",
  ].join("\n");
  const out = redactDotenvAssignments(input);
  const lines = out.split("\n");

  assert.equal(lines.length, input.split("\n").length, "line count must be preserved");
  assert.equal(lines[0], "# production credentials", "comment lines are untouched");
  assert.equal(lines[1], "export FOO=[redacted-secret]", "export prefixes survive");
  assert.equal(lines[2], "BAR: [redacted-secret]", "colon separators are handled");
  assert.equal(lines[3], "QUOTED=[redacted-secret]  # note", "trailing comments survive");
  assert.ok(lines[4]!.startsWith("SINGLE=[redacted-secret]"), "escaped quotes are handled");
  assert.ok(lines[4]!.endsWith("# trailing"));
  assert.equal(lines[5], "EMPTY=", "an already-empty value is left alone");
  assert.equal(lines[6], "BLANKISH=   ", "a whitespace-only value is left alone");
  assert.equal(lines[7], "", "blank lines survive");
  assert.equal(lines[8], "PLAIN=[redacted-secret] # tail comment");
  assert.ok(!out.includes("bar"), "no value may survive");
  assert.ok(!out.includes("value"), "no value may survive");
  // FOO, BAR, QUOTED, SINGLE, PLAIN — the two empty values gain no marker.
  assert.equal(out.match(/\[redacted-secret\]/g)?.length, 5, "one marker per redacted value");
});

test("a multi-line quoted value collapses to one redaction per line", () => {
  const input = [
    'CERT="-----BEGIN KEY-----',
    "MIIEowIBAAKCAQEAsecretmaterial",
    'MIIEowIBAAKCAQEAmoresecret-----END KEY-----"  # pem',
    "NEXT=after",
  ].join("\n");
  const out = redactDotenvAssignments(input);
  const lines = out.split("\n");

  assert.equal(lines.length, 4, "line count must be preserved so line reads keep coordinates");
  assert.equal(lines[0], "CERT=[redacted-secret]");
  assert.equal(lines[1], "[redacted-secret]", "a continuation line must not leak");
  assert.equal(lines[2], "[redacted-secret]  # pem", "the closing line re-attaches its comment");
  assert.equal(lines[3], "NEXT=[redacted-secret]", "quote state closes so the next key is normal");
  assert.ok(!out.includes("secretmaterial"));
  assert.ok(!out.includes("moresecret"));
  assert.ok(!out.includes("after"));
});

test("redactSecrets scrubs credentials embedded in a URL's userinfo", () => {
  // Found by reviewing an external repo, not by a test: none of the value,
  // key-name or auth-scheme passes match `postgres://admin:hunter2@host`.
  // DATABASE_URL carries no secret-ish noun, so even the key-name pass skips
  // it. The structural dotenv pass does catch it — but only when the caller
  // names a dotenv path, and the production callers (handoff/continuation
  // lines, reviewed diffs) pass no path at all. So this leaked verbatim into
  // prompts the supervisor sends to another lane.
  const leaky = [
    "DATABASE_URL=postgres://admin:hunter2@db.internal:5432/prod",
    "connect to https://user:s3cr3t@api.internal/v1",
    "mongodb://root:let@me@in@10.0.0.5/db", // password containing '@'
    "https://ghp_TOKENLIKEVALUE123456@github.com/org/repo",
  ];
  for (const line of leaky) {
    const out = redactSecrets(line);
    assert.ok(
      !/hunter2|s3cr3t|let@me@in|TOKENLIKEVALUE/.test(out),
      `credential survived redaction: ${out}`
    );
    assert.match(out, /\[redacted-secret\]/);
  }

  // Where a user is named, it survives — a handoff must still be able to say
  // which user on which host, exactly as key names survive the dotenv pass.
  assert.match(redactSecrets(leaky[0]!), /postgres:\/\/admin:\[redacted-secret\]@db\.internal/);

  // A URL carrying no credentials is left completely alone.
  for (const clean of ["https://example.com/no-creds", "http://localhost:3000/health"]) {
    assert.equal(redactSecrets(clean), clean);
  }
});
