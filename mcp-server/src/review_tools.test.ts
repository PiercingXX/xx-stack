import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  redactDiffSecrets,
  reviewToContinuation,
  REVIEW_DIFF_CAP,
  type DiffDetection,
  type ReviewToolOverrides,
} from "./review_tools.js";
import { buildContinuationPrompt, redactSecrets } from "./supervisor_completion_tools.js";
import {
  DEFAULT_RELIABILITY,
  emptySupervisorStore,
  StoreAccessError,
  type SupervisorSessionState,
  type SupervisorStore,
} from "./supervisor_runtime.js";
import type { SupervisorToolDeps } from "./supervisor_tool_deps.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// MCP-TEST-1: this file used to reimplement `reviewToContinuation`'s logic
// inline and assert against its own reimplementation — it never imported
// review_tools.ts at all, which is how three bugs (MCP-8) survived in a
// formatter that looked covered. Every test below drives the actual function.
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<SupervisorSessionState> = {}): SupervisorSessionState {
  return {
    sessionId: "sx-review-001",
    description: "review fixture",
    status: "running",
    startedAt: 1_000,
    lastProgressAt: 1_000,
    attemptCount: 1,
    failureCount: 0,
    currentRoute: {
      host: "localhost",
      model: "qwen3",
      endpoint: "http://localhost:11434",
      tier: "local",
    },
    fallbackRoutes: [],
    nextFallbackIndex: 0,
    continuationCount: 0,
    events: [],
    ...overrides,
  };
}

function storeOf(sessions: SupervisorSessionState[]): SupervisorStore {
  const store = emptySupervisorStore();
  for (const session of sessions) store.sessions[session.sessionId] = session;
  return store;
}

interface Harness {
  deps: SupervisorToolDeps;
  overrides: ReviewToolOverrides;
  store: SupervisorStore;
  writes: number;
  diffCalls: string[];
  memorySyncCalls: unknown[];
}

interface HarnessOptions {
  sessions?: SupervisorSessionState[];
  readSupervisorStore?: () => Promise<SupervisorStore>;
  diff?: DiffDetection | ((cwd: string) => Promise<DiffDetection>);
  driftDetected?: boolean;
  helperPrompt?: string | null;
}

/**
 * Drive the real reviewToContinuation function. Only the deps it actually
 * reaches are implemented — anything else would be an untested code path.
 */
function harness(options: HarnessOptions = {}): Harness {
  const store = storeOf(options.sessions ?? [makeSession()]);
  const captured: Harness = {
    deps: {} as SupervisorToolDeps,
    overrides: {},
    store,
    writes: 0,
    diffCalls: [],
    memorySyncCalls: [],
  };

  const deps = {
    withSupervisorStoreLock: <T>(work: () => Promise<T>) => work(),
    loadReliabilityConfig: async () => ({ ...DEFAULT_RELIABILITY }),
    readSupervisorStore: options.readSupervisorStore ?? (async () => store),
    writeSupervisorStore: async () => {
      captured.writes += 1;
    },
    pruneSupervisorStore: (given: SupervisorStore) => given,
    pushSessionEvent: (state: SupervisorSessionState, type: string, detail: string) => {
      state.events.push({ at: new Date(0).toISOString(), type, detail });
    },
  } as unknown as SupervisorToolDeps;

  const overrides: ReviewToolOverrides = {
    detectGitDiff: async (cwd) => {
      captured.diffCalls.push(cwd);
      if (typeof options.diff === "function") return options.diff(cwd);
      return options.diff ?? { status: "detected", diff: "" };
    },
    getCompletionMemorySyncStatus: async (guard) => {
      captured.memorySyncCalls.push(guard);
      return {
        driftDetected: options.driftDetected === true,
        helperPrompt: options.helperPrompt ?? null,
      };
    },
  };

  captured.deps = deps;
  captured.overrides = overrides;
  return captured;
}

async function callReview(
  h: Harness,
  args: { sessionId: string; cwd?: string; diff?: string; notes: string[] }
): Promise<Record<string, any>> {
  const result = await reviewToContinuation(h.deps, args, h.overrides);
  assert.equal(result.content.length, 1, "the formatter must return exactly one content block");
  return JSON.parse(result.content[0]!.text);
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return count;
    count += 1;
    from = index + needle.length;
  }
}

/** A real git repo with one uncommitted edit carrying a unique marker. */
async function withDirtyRepo(marker: string, work: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "xx-stack-review-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "review@test.local"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "review test"], { cwd: root });
    await writeFile(join(root, "tracked.ts"), "export const before = 1;\n", "utf8");
    await execFileAsync("git", ["add", "-A"], { cwd: root });
    await execFileAsync("git", ["commit", "-q", "-m", "seed"], { cwd: root });
    await writeFile(join(root, "tracked.ts"), `export const ${marker} = 2;\n`, "utf8");
    await work(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// --- shared formatter determinism (kept from the original file) ------------

test("buildContinuationPrompt is deterministic: identical input twice yields byte-identical output", () => {
  const args: Parameters<typeof buildContinuationPrompt> = [
    "sx-test-001",
    1,
    { host: "localhost", model: "gpt-4", endpoint: "http://localhost:8080", tier: "standard" },
    undefined,
    null,
    "review_to_continuation",
    [],
    ["Fix the null-dereference in parseUserConfig", "Add error boundary to applyToolPolicy"],
    ["- diff under review:", "(no diff detected — review notes apply to the current working tree)"],
  ];

  const first = buildContinuationPrompt(...args);
  const second = buildContinuationPrompt(...args);
  assert.equal(first, second, "identical inputs must produce byte-identical outputs");
});

// --- existing behavior, now asserted against the real tool -----------------

test("review_to_continuation reports a session it does not have", async () => {
  const h = harness();
  const payload = await callReview(h, { sessionId: "sx-nope", notes: ["something"] });
  assert.equal(payload.status, "missing");
  assert.equal(payload.sessionId, "sx-nope");
  assert.equal(h.writes, 0, "a missing session must not write the store");
});

test("mustAddress covers every supplied note even when a note names a path absent from the diff", async () => {
  const notes = [
    "src/config_runtime.ts: parseUserConfig can throw on malformed JSON",
    "src/execution_policy.ts: missing error boundary around execFile",
    "src/nonexistent.ts: this path is not in any diff",
  ];
  const h = harness({ diff: { status: "detected", diff: "" } });
  const payload = await callReview(h, { sessionId: "sx-review-001", notes });

  assert.equal(payload.status, "ready");
  assert.equal(payload.reasonCode, "review_to_continuation_emitted");
  assert.equal(payload.mustAddress.length, notes.length, "mustAddress must cover every note");
  for (let i = 0; i < notes.length; i++) {
    assert.equal(payload.mustAddress[i].note, notes[i]);
    assert.equal(payload.mustAddress[i].required, true);
  }
  assert.equal(payload.continuationCount, 1, "the continuation counter advances");
  assert.equal(h.writes, 1, "the advanced counter is persisted exactly once");
});

// --- MCP-8a: the memory-sync status was hardcoded to null ------------------

test("memory-sync drift is computed, not assumed absent", async () => {
  const guard = { agentId: "reviewer", scope: "project" as const, cwd: "/repo" };

  const drifting = harness({
    sessions: [makeSession({ completionMemorySync: guard })],
    driftDetected: true,
    helperPrompt: "Run agent_memory_get and resolve snapshot drift.",
  });
  const drifted = await callReview(drifting, {
    sessionId: "sx-review-001",
    notes: ["a finding"],
    diff: "",
  });

  assert.deepEqual(drifting.memorySyncCalls, [guard], "the guard's real status must be read");
  assert.equal(drifted.memorySyncDrift, true);
  assert.ok(
    drifted.prompt.includes("- memory-sync-drift: detected"),
    "a guarded session with real drift must not report not-detected"
  );
  assert.ok(!drifted.prompt.includes("- memory-sync-drift: not-detected"));

  // The clean case still reports not-detected — the fix is a computation, not
  // an inversion.
  const clean = harness({ sessions: [makeSession({ completionMemorySync: guard })] });
  const settled = await callReview(clean, {
    sessionId: "sx-review-001",
    notes: ["a finding"],
    diff: "",
  });
  assert.equal(settled.memorySyncDrift, false);
  assert.ok(settled.prompt.includes("- memory-sync-drift: not-detected"));

  // An unguarded session asks nothing and claims nothing.
  const unguarded = harness();
  const none = await callReview(unguarded, {
    sessionId: "sx-review-001",
    notes: ["a finding"],
    diff: "",
  });
  assert.deepEqual(unguarded.memorySyncCalls, []);
  assert.equal(none.memorySyncDrift, null);
  assert.ok(!none.prompt.includes("memory-sync-drift"));
});

// --- MCP-8b: every note was rendered twice ---------------------------------

test("each review note appears exactly once in the emitted prompt", async () => {
  const notes = [
    "src/config_runtime.ts: parseUserConfig can throw on malformed JSON",
    "src/execution_policy.ts: missing error boundary around execFile",
  ];
  const h = harness();
  const payload = await callReview(h, { sessionId: "sx-review-001", notes, diff: "" });

  for (const note of notes) {
    assert.equal(
      countOccurrences(payload.prompt, note),
      1,
      `"${note}" must be rendered once, not once as a pending task and again as a mustAddress item`
    );
  }
  // The mustAddress requirement itself is still stated, just not per-note.
  assert.ok(payload.prompt.includes("- mustAddress:"));
});

// --- MCP-8c: git diff ran with no cwd, unredacted and uncompacted ----------

test("the diff is read from the session's repo, not the server's launch directory", async () => {
  await withDirtyRepo("MARKER_FROM_SESSION_REPO", async (root) => {
    // The real detectGitDiff, not the stub: the point is the cwd it uses.
    const store = storeOf([makeSession()]);
    const deps = {
      withSupervisorStoreLock: <T>(work: () => Promise<T>) => work(),
      loadReliabilityConfig: async () => ({ ...DEFAULT_RELIABILITY }),
      readSupervisorStore: async () => store,
      writeSupervisorStore: async () => {},
      pruneSupervisorStore: (given: SupervisorStore) => given,
      pushSessionEvent: () => {},
    } as unknown as SupervisorToolDeps;

    const result = await reviewToContinuation(deps, {
      sessionId: "sx-review-001",
      cwd: root,
      notes: ["check the tracked file"],
    });
    const payload = JSON.parse(result.content[0]!.text);

    assert.equal(payload.diffSource, "git");
    assert.equal(payload.diffCwd, root);
    assert.ok(
      payload.prompt.includes("MARKER_FROM_SESSION_REPO"),
      "the diff must come from the session's repo"
    );
  });
});

test("the session's memory-sync cwd is the fallback repo when no cwd is supplied", async () => {
  const h = harness({
    sessions: [
      makeSession({
        completionMemorySync: { agentId: "reviewer", scope: "project", cwd: "/repo/from/session" },
      }),
    ],
  });
  const payload = await callReview(h, { sessionId: "sx-review-001", notes: ["n"] });

  assert.deepEqual(h.diffCalls, ["/repo/from/session"], "git diff must run in the session's repo");
  assert.equal(payload.diffCwd, "/repo/from/session");
});

test("a failed diff read is reported as unavailable, never as an empty diff", async () => {
  const h = harness({
    diff: { status: "unavailable", detail: "fatal: not a git repository" },
  });
  const payload = await callReview(h, { sessionId: "sx-review-001", notes: ["n"] });

  assert.equal(payload.diffSource, "unavailable");
  assert.equal(payload.diffError, "fatal: not a git repository");
  assert.ok(payload.prompt.includes("diff unavailable"));
  assert.ok(payload.prompt.includes("fatal: not a git repository"));
  assert.ok(
    !payload.prompt.includes("(no diff detected"),
    "a failed read must not masquerade as a clean tree"
  );

  // A genuinely empty diff is still reported as an empty diff.
  const cleanTree = harness({ diff: { status: "detected", diff: "" } });
  const clean = await callReview(cleanTree, { sessionId: "sx-review-001", notes: ["n"] });
  assert.equal(clean.diffSource, "git");
  assert.equal(clean.diffError, null);
  assert.ok(clean.prompt.includes("(no diff detected"));
});

test("a real unreadable repo surfaces as unavailable rather than a clean tree", async () => {
  const notARepo = await mkdtemp(join(tmpdir(), "xx-stack-review-nogit-"));
  try {
    const store = storeOf([makeSession()]);
    const deps = {
      withSupervisorStoreLock: <T>(work: () => Promise<T>) => work(),
      loadReliabilityConfig: async () => ({ ...DEFAULT_RELIABILITY }),
      readSupervisorStore: async () => store,
      writeSupervisorStore: async () => {},
      pruneSupervisorStore: (given: SupervisorStore) => given,
      pushSessionEvent: () => {},
    } as unknown as SupervisorToolDeps;

    const result = await reviewToContinuation(deps, {
      sessionId: "sx-review-001",
      cwd: join(notARepo, "does-not-exist"),
      notes: ["n"],
    });
    const payload = JSON.parse(result.content[0]!.text);
    assert.equal(payload.diffSource, "unavailable");
    assert.ok(typeof payload.diffError === "string" && payload.diffError.length > 0);
  } finally {
    await rm(notARepo, { recursive: true, force: true });
  }
});

test("secrets in the diff are redacted before the diff reaches the prompt", async () => {
  const secretDiff = [
    "diff --git a/.env b/.env",
    '+api_key = "sk-livekeyabcdefghijklmnop"',
    "+  proxyHeader = Bearer abcdefghijklmnopqrstuvwxyz",
  ].join("\n");

  const h = harness({ diff: { status: "detected", diff: secretDiff } });
  const payload = await callReview(h, { sessionId: "sx-review-001", notes: ["rotate this"] });

  assert.ok(!payload.prompt.includes("sk-livekeyabcdefghijklmnop"), "raw key must not be echoed");
  assert.ok(
    !payload.prompt.includes("abcdefghijklmnopqrstuvwxyz"),
    "raw bearer token must not be echoed"
  );
  assert.ok(payload.prompt.includes("[redacted-secret]"));
  assert.ok(payload.prompt.includes("diff --git a/.env"), "the diff is redacted, not discarded");
});

test("an oversized diff is compacted to the cap and the drop is reported", async () => {
  const huge = "+ a line of changed source code\n".repeat(4000);
  assert.ok(huge.length > REVIEW_DIFF_CAP * 4, "fixture must exceed the cap by a wide margin");

  const h = harness({ diff: { status: "detected", diff: huge } });
  const payload = await callReview(h, { sessionId: "sx-review-001", notes: ["too big"] });

  assert.ok(payload.diffDropped.length > 0, "compaction must be reported, never silent");
  assert.ok(
    payload.prompt.length < huge.length,
    `the raw ${huge.length}-char diff must not be embedded whole`
  );
  assert.ok(
    payload.prompt.includes("[truncated"),
    "the embedded diff carries the truncation marker"
  );
  assert.ok(payload.prompt.includes("- diff compaction:"));
});

// --- FOLLOW-UP 1: the store readers now throw on a corrupt store ------------

test("an unreadable supervisor store is reported as a structured error, not an escaping throw", async () => {
  const h = harness({
    readSupervisorStore: async () => {
      throw new StoreAccessError("supervisor", "/tmp/state.json", new Error("unexpected token"));
    },
  });

  const payload = await callReview(h, { sessionId: "sx-review-001", notes: ["n"] });
  assert.equal(payload.status, "error");
  assert.equal(payload.reasonCode, "store_unavailable");
  assert.equal(payload.store, "supervisor");
  assert.equal(payload.path, "/tmp/state.json");
  assert.equal(h.writes, 0, "nothing is written when the store could not be read");
});

// --- SECURITY: dotenv values leaked across lanes through the diff -----------
//
// `review_to_continuation` embeds the diff in a continuation prompt that may be
// sent to ANOTHER LANE, possibly a cloud one. Value-pattern redaction only ever
// catches formats somebody enumerated, and these three survived it verbatim —
// confirmed against the shipped `redactSecrets` before the fix:
//
//   +DATABASE_URL=postgres://admin:hunter2@db.internal:5432/prod
//   +STRIPE_KEY=sk_live_51ABCdefGHI      (`sk_`, the pattern wants `sk-`)
//   +SMTP_PASS=hunter2                   (the key list has `password`, not `pass`)

const LEAKY_ENV_DIFF = [
  "diff --git a/.env.production b/.env.production",
  "index e69de29..1a2b3c4 100644",
  "--- a/.env.production",
  "+++ b/.env.production",
  "@@ -0,0 +1,3 @@",
  "+DATABASE_URL=postgres://admin:hunter2@db.internal:5432/prod",
  "+STRIPE_KEY=sk_live_51ABCdefGHI",
  "+SMTP_PASS=hunter2",
].join("\n");

test("dotenv values in the diff never reach the continuation prompt", async () => {
  const h = harness({ diff: { status: "detected", diff: LEAKY_ENV_DIFF } });
  const payload = await callReview(h, {
    sessionId: "sx-review-001",
    notes: ["rotate these before merging"],
  });

  for (const value of ["hunter2", "sk_live_51ABCdefGHI", "postgres://admin", "db.internal:5432"]) {
    assert.ok(!payload.prompt.includes(value), `value leaked into the prompt: ${value}`);
  }

  // Key names and the file path survive: the handoff must still be able to say
  // "DATABASE_URL is set in .env.production" without carrying the value.
  for (const kept of ["DATABASE_URL", "STRIPE_KEY", "SMTP_PASS", ".env.production"]) {
    assert.ok(payload.prompt.includes(kept), `${kept} must survive redaction`);
  }
  assert.ok(payload.prompt.includes("+DATABASE_URL=[redacted-secret]"), "diff markers survive");
});

test("redactDiffSecrets redacts dotenv hunks by shape and leaves other files alone", () => {
  const diff = [
    LEAKY_ENV_DIFF,
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,1 +1,2 @@",
    " const port = 8080;",
    "+const greeting = hunter2;",
  ].join("\n");

  const out = redactDiffSecrets(diff);
  const lines = out.split("\n");

  assert.equal(lines.length, diff.split("\n").length, "line count must be preserved");
  assert.equal(lines[5], "+DATABASE_URL=[redacted-secret]");
  assert.equal(lines[6], "+STRIPE_KEY=[redacted-secret]");
  assert.equal(lines[7], "+SMTP_PASS=[redacted-secret]");
  // A non-dotenv file is untouched: `hunter2` there is a source identifier, and
  // structural redaction is scoped to files whose shape says "every value is a
  // credential".
  assert.equal(lines[lines.length - 1], "+const greeting = hunter2;");
  assert.equal(lines[lines.length - 2], " const port = 8080;");
});

test("a deleted dotenv file is attributed from the --- side and still redacted", () => {
  const diff = [
    "diff --git a/.env b/.env",
    "deleted file mode 100644",
    "--- a/.env",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-SMTP_PASS=hunter2",
    "-DATABASE_URL=postgres://admin:hunter2@db.internal:5432/prod",
  ].join("\n");

  const out = redactDiffSecrets(diff);
  assert.ok(!out.includes("hunter2"), "deleting a .env leaks exactly as hard as adding one");
  assert.ok(out.includes("-SMTP_PASS=[redacted-secret]"));
  assert.ok(out.includes("-DATABASE_URL=[redacted-secret]"));
});

test("a multi-line quoted dotenv value in a diff leaks no continuation line", () => {
  const diff = [
    "diff --git a/.env b/.env",
    "--- a/.env",
    "+++ b/.env",
    "@@ -0,0 +1,3 @@",
    '+PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----',
    "+MIIEowIBAAKCAQEAsecretkeymaterialhere",
    '+-----END RSA PRIVATE KEY-----"',
  ].join("\n");

  const out = redactDiffSecrets(diff);
  assert.ok(!out.includes("secretkeymaterialhere"), "the continuation line must not leak");
  assert.ok(!out.includes("BEGIN RSA PRIVATE KEY"));
  assert.equal(out.split("\n").length, diff.split("\n").length, "line count preserved");
  assert.ok(out.includes("+PRIVATE_KEY=[redacted-secret]"));
});

test("a diff with no dotenv file is byte-identical to the pathless redaction", () => {
  const diff = [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,2 +1,3 @@",
    " const port = 8080;",
    "+const apiKey = process.env.API_KEY;",
    '+const token = "ghp_abcdefghijklmnopqrstuv123456";',
  ].join("\n");

  assert.equal(
    redactDiffSecrets(diff),
    redactSecrets(diff),
    "with no dotenv file the walker must change nothing the generic pass would not"
  );
});

// --- SECURITY: caller-supplied diffs carry no hunk headers to attribute -----
//
// A diff passed as the tool's `diff` argument is free-form text. Real `git
// diff` output always has `--- / +++ / @@` headers, but pasted env bodies and
// partial patches may have none — attribution then has nothing to work with
// and every dotenv assignment survived verbatim. For that source the
// structural pass now runs over the whole payload.

const HEADERLESS_CALLER_DIFF = [
  "# production environment",
  "DATABASE_URL=postgres://u:p@h/db",
  "STRIPE_KEY=sk_live_51ABCdefGHI",
].join("\n");

test("a caller-supplied diff without hunk headers gets structural dotenv redaction", async () => {
  const h = harness();
  const payload = await callReview(h, {
    sessionId: "sx-review-001",
    notes: ["rotate these"],
    diff: HEADERLESS_CALLER_DIFF,
  });

  assert.equal(payload.diffSource, "argument");
  assert.ok(!payload.prompt.includes("postgres://u:p@h/db"), "the URL credential must not leak");
  assert.ok(!payload.prompt.includes("sk_live_51ABCdefGHI"), "the live key must not leak");
  assert.ok(
    payload.prompt.includes("DATABASE_URL=[redacted-secret]") &&
      payload.prompt.includes("STRIPE_KEY=[redacted-secret]"),
    "key names survive so the handoff can still say what was where"
  );
});

test("structural whole-payload redaction preserves keys, comments, and line count", () => {
  const out = redactDiffSecrets(HEADERLESS_CALLER_DIFF, { source: "argument" });
  const lines = out.split("\n");

  assert.equal(lines.length, HEADERLESS_CALLER_DIFF.split("\n").length);
  assert.equal(lines[0], "# production environment", "comments survive");
  assert.equal(lines[1], "DATABASE_URL=[redacted-secret]");
  assert.equal(lines[2], "STRIPE_KEY=[redacted-secret]");
});

test("a git-sourced diff without hunk headers keeps the per-hunk behavior", () => {
  // Only caller-supplied content gets the fallback: a header-less GIT diff is
  // ordinary prose-like output where `KEY=value` lines are not credentials.
  const diff = "+const greeting = hunter2;\n";
  assert.equal(redactDiffSecrets(diff, { source: "git" }), diff);
});

test("dotless basenames ending in .env are attributed as dotenv-shaped", () => {
  const diff = [
    "diff --git a/config/secrets.env b/config/secrets.env",
    "--- a/config/secrets.env",
    "+++ b/config/secrets.env",
    "@@ -0,0 +1,1 @@",
    "+SMTP_PASS=hunter2",
  ].join("\n");

  const out = redactDiffSecrets(diff);
  assert.ok(!out.includes("hunter2"), "`secrets.env` fails the dotted pattern but ends in .env");
  assert.ok(out.includes("+SMTP_PASS=[redacted-secret]"));
});
