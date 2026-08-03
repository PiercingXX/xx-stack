import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  registerReviewTools,
  REVIEW_DIFF_CAP,
  type DiffDetection,
  type ReviewToolOverrides,
} from "./review_tools.js";
import { buildContinuationPrompt } from "./supervisor_completion_tools.js";
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
// MCP-TEST-1: this file used to reimplement `review_to_continuation`'s logic
// inline and assert against its own reimplementation — it never imported
// review_tools.ts at all, which is how three bugs (MCP-8) survived in a tool
// that looked covered. Every test below drives the ACTUAL registered tool
// through a fake MCP server, the same pattern hook_tools.test.ts uses.
// ---------------------------------------------------------------------------

type ToolResult = { content: Array<{ type: string; text: string }> };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

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
  handler: Handler;
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
 * Register the real tool against a fake server and return its handler.
 * Only the deps `review_to_continuation` actually reaches are implemented —
 * anything else would be an untested code path reaching into this harness.
 */
function harness(options: HarnessOptions = {}): Harness {
  const store = storeOf(options.sessions ?? [makeSession()]);
  const captured: Harness = {
    handler: async () => ({ content: [] }),
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

  const fakeServer = {
    tool: (...args: unknown[]) => {
      captured.handler = args[args.length - 1] as Handler;
    },
  } as unknown as McpServer;

  registerReviewTools(fakeServer, deps, overrides);
  return captured;
}

async function callReview(h: Harness, args: Record<string, unknown>): Promise<Record<string, any>> {
  const result = await h.handler(args);
  assert.equal(result.content.length, 1, "the tool must return exactly one content block");
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
    helperPrompt: "Run agent_memory_snapshot_status and resolve drift.",
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

    let handler: Handler = async () => ({ content: [] });
    const fakeServer = {
      tool: (...args: unknown[]) => {
        handler = args[args.length - 1] as Handler;
      },
    } as unknown as McpServer;
    registerReviewTools(fakeServer, deps);

    const result = await handler({
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

    let handler: Handler = async () => ({ content: [] });
    registerReviewTools(
      {
        tool: (...args: unknown[]) => {
          handler = args[args.length - 1] as Handler;
        },
      } as unknown as McpServer,
      deps
    );

    const result = await handler({
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
