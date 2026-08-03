import test from "node:test";
import assert from "node:assert/strict";
import { join, sep } from "node:path";

import {
  LOG_DIR,
  __logIo,
  logEvent,
  resetTelemetryHealth,
  resolveSessionLogPath,
  sanitizeSessionIdForPath,
  telemetryHealth,
} from "./log_worker.js";

const SESSIONS_DIR = join(LOG_DIR, "sessions");

// ---------------------------------------------------------------------------
// MCP-7: a session id reaches logEvent verbatim from supervisor_start_session,
// where the schema is a bare z.string(). Joined unsanitized it escapes the log
// directory — and logEvent swallows every error, so the escape is invisible.
// ---------------------------------------------------------------------------

test("a traversal session id cannot append outside the sessions directory", () => {
  const hostile = [
    "../../../../tmp/x",
    "..%2f..%2fetc/passwd",
    "/etc/cron.d/xx",
    "sub/dir/session",
    "..",
    ".",
    "....",
    "",
  ];

  for (const sessionId of hostile) {
    const resolved = resolveSessionLogPath(sessionId);
    assert.ok(resolved !== null, `${JSON.stringify(sessionId)} should still resolve to a log file`);
    assert.ok(
      resolved!.startsWith(SESSIONS_DIR + sep),
      `${JSON.stringify(sessionId)} escaped the sessions dir: ${resolved}`
    );
    const relative = resolved!.slice(SESSIONS_DIR.length + 1);
    assert.ok(
      !relative.includes(sep),
      `${JSON.stringify(sessionId)} produced a nested path: ${relative}`
    );
    assert.ok(resolved!.endsWith(".jsonl"));
  }

  // The specific defect: this used to land in /tmp/x.jsonl.
  assert.equal(
    resolveSessionLogPath("../../../../tmp/x"),
    join(SESSIONS_DIR, "..-..-..-..-tmp-x.jsonl")
  );
  // ...because the old, unsanitized join walked straight out of the log dir.
  const preFix = join(SESSIONS_DIR, `${"../../../../tmp/x"}.jsonl`);
  assert.ok(!preFix.startsWith(SESSIONS_DIR + sep), `pre-fix join stayed inside: ${preFix}`);
});

test("dot-only session ids never name a directory", () => {
  assert.equal(sanitizeSessionIdForPath(".."), "invalid-session-id");
  assert.equal(sanitizeSessionIdForPath("."), "invalid-session-id");
  assert.equal(sanitizeSessionIdForPath("..."), "invalid-session-id");
  assert.equal(sanitizeSessionIdForPath(""), "invalid-session-id");
  // Separators collapse to a plain "-", which is a perfectly ordinary filename.
  assert.equal(sanitizeSessionIdForPath("///"), "-");
});

test("ordinary session ids are passed through unchanged", () => {
  for (const id of ["sx-0001", "session_42", "run.2026-08-02", "abcDEF123"]) {
    assert.equal(sanitizeSessionIdForPath(id), id);
    assert.equal(resolveSessionLogPath(id), join(SESSIONS_DIR, `${id}.jsonl`));
  }
});

test("a session id is capped so it cannot produce an unwritable filename", () => {
  const long = "a".repeat(4096);
  const safe = sanitizeSessionIdForPath(long);
  assert.ok(safe.length <= 128);
  assert.equal(safe, "a".repeat(128));
});

// ---------------------------------------------------------------------------
// MCP-16 / §11.1: a telemetry write failure must never fail the caller's
// operation — and must never be invisible either. Every filesystem call is
// stubbed here: the failure paths are the contract, and they are unreachable
// from a test that is not allowed to break the real log directory.
// ---------------------------------------------------------------------------

interface IoHarness {
  mkdirCalls: number;
  appends: Array<{ path: string; line: string }>;
  stderr: string[];
  appendError: string | null;
  mkdirError: string | null;
}

function withFakeIo(body: (io: IoHarness) => Promise<void>): () => Promise<void> {
  return async () => {
    const realIo = { ...__logIo };
    const realConsoleError = console.error;
    const io: IoHarness = {
      mkdirCalls: 0,
      appends: [],
      stderr: [],
      appendError: null,
      mkdirError: null,
    };

    __logIo.mkdir = (async () => {
      io.mkdirCalls += 1;
      if (io.mkdirError !== null) throw new Error(io.mkdirError);
      return undefined;
    }) as unknown as typeof __logIo.mkdir;
    __logIo.appendFile = (async (path: unknown, line: unknown) => {
      if (io.appendError !== null) throw new Error(io.appendError);
      io.appends.push({ path: String(path), line: String(line) });
    }) as unknown as typeof __logIo.appendFile;
    // No server log exists in the harness, so rotation is a no-op — the same
    // path a fresh install takes.
    __logIo.stat = (async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }) as unknown as typeof __logIo.stat;
    __logIo.rename = (async () => undefined) as unknown as typeof __logIo.rename;
    console.error = (...args: unknown[]): void => {
      io.stderr.push(args.map(String).join(" "));
    };
    resetTelemetryHealth();

    try {
      await body(io);
    } finally {
      Object.assign(__logIo, realIo);
      console.error = realConsoleError;
      resetTelemetryHealth();
    }
  };
}

test(
  "a failed append is reported to the caller instead of being swallowed",
  withFakeIo(async (io) => {
    io.appendError = "ENOSPC: no space left on device";

    const result = await logEvent("server", "telemetry.record", { skill: "demo" });

    assert.equal(result.ok, false, "a failed write must not report success");
    assert.equal(result.outcome, "failed");
    assert.match(result.error ?? "", /ENOSPC/);
    assert.equal(io.appends.length, 0);
  })
);

test(
  "a successful append reports the outcome and writes exactly one JSONL line",
  withFakeIo(async (io) => {
    const result = await logEvent("server", "telemetry.record", { skill: "demo" });

    assert.deepEqual(result, { ok: true, outcome: "written" });
    assert.equal(io.appends.length, 1);
    const parsed = JSON.parse(io.appends[0]!.line);
    assert.equal(parsed.type, "telemetry.record");
    assert.equal(parsed.skill, "demo");
    assert.ok(io.appends[0]!.line.endsWith("\n"));
    assert.equal(io.stderr.length, 0, "a healthy write says nothing on stderr");
  })
);

test(
  "logEvent never rejects, so `void logEvent(...)` cannot become an unhandled rejection",
  withFakeIo(async (io) => {
    io.mkdirError = "EACCES: permission denied";
    io.appendError = "EACCES: permission denied";

    // The shape used by routing_tools / supervisor_session_tools.
    await assert.doesNotReject(async () => {
      void logEvent("server", "route_task.result", { tier: "local" });
      await logEvent({ session: "sx-1" }, "tick.start", {});
    });
  })
);

test(
  "the first failure reaches stderr, and a stuck disk does not flood it",
  withFakeIo(async (io) => {
    io.appendError = "ENOSPC: no space left on device";
    for (let i = 0; i < 3; i += 1) await logEvent("server", "telemetry.record", {});
    assert.equal(io.stderr.length, 1, "one line per distinct failure, not one per event");
    assert.match(io.stderr[0]!, /log_worker/);
    assert.match(io.stderr[0]!, /ENOSPC/);
    assert.match(io.stderr[0]!, /non-fatal/);

    // A different failure mode is never hidden behind the old one.
    io.appendError = "EACCES: permission denied";
    await logEvent("server", "telemetry.record", {});
    assert.equal(io.stderr.length, 2);
    assert.match(io.stderr[1]!, /EACCES/);

    // ...and a failure that recurs after a recovery is announced again.
    io.appendError = null;
    await logEvent("server", "telemetry.record", {});
    io.appendError = "EACCES: permission denied";
    await logEvent("server", "telemetry.record", {});
    assert.equal(io.stderr.length, 3);
  })
);

test(
  "telemetryHealth is the only trace of a fire-and-forget write that failed",
  withFakeIo(async (io) => {
    assert.deepEqual(
      telemetryHealth(),
      { failures: 0, lastError: null, lastFailureAt: null },
      "a healthy writer reports nothing"
    );
    await logEvent("server", "telemetry.record", {});
    assert.equal(telemetryHealth().failures, 0, "successful writes are not counted");

    io.appendError = "ENOSPC: no space left on device";
    // `void logEvent(...)` throws its result away; the counter is what remains.
    await logEvent("server", "route_task.result", {});
    await logEvent("server", "route_task.result", {});

    const health = telemetryHealth();
    assert.equal(health.failures, 2);
    assert.match(health.lastError ?? "", /ENOSPC/);
    assert.ok(
      health.lastFailureAt !== null && !Number.isNaN(Date.parse(health.lastFailureAt)),
      `lastFailureAt should be an ISO timestamp, got ${health.lastFailureAt}`
    );
  })
);

test(
  "a removed log directory is re-created rather than killing telemetry forever",
  withFakeIo(async (io) => {
    assert.equal((await logEvent("server", "a", {})).ok, true);
    assert.equal(io.mkdirCalls, 1);

    // The latch is a real optimization: a healthy process mkdirs once.
    assert.equal((await logEvent("server", "b", {})).ok, true);
    assert.equal(io.mkdirCalls, 1, "the directory check should stay latched while writes succeed");

    // Somebody deletes ~/.config/opencode/xx-stack-logs.
    io.appendError = "ENOENT: no such file or directory, open 'mcp-server.jsonl'";
    assert.equal((await logEvent("server", "c", {})).ok, false);

    // Pre-fix, `dirEnsured` stayed true for the life of the process and every
    // later event was lost in silence. It must recover instead.
    io.appendError = null;
    const recovered = await logEvent("server", "d", {});
    assert.equal(recovered.ok, true);
    assert.equal(io.mkdirCalls, 2, "the failure should have cleared the directory latch");
    assert.deepEqual(
      io.appends.map((entry) => JSON.parse(entry.line).type),
      ["a", "b", "d"]
    );
  })
);
