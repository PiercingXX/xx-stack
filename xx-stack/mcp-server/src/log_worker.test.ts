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

// ---------------------------------------------------------------------------
// A torn write concatenates with the next record.
//
// JSONL is only parseable while every record ends in a newline. Both append
// sites wrote a `\n`-terminated line without ever checking that the file
// already ended in one, so a write torn by ENOSPC, a killed process, or an
// external truncation left the file mid-record and the NEXT event glued itself
// onto it — producing one line that fails to parse and silently losing two
// events instead of one.
//
// A separate harness from `withFakeIo` on purpose: these tests need `stat` and
// `open` to reflect real bytes, while the failure-path tests above need `stat`
// to report a fresh install.
// ---------------------------------------------------------------------------

interface FileIoHarness {
  files: Map<string, Buffer>;
  appendCalls: Array<{ path: string; payload: string }>;
  renames: Array<{ from: string; to: string }>;
}

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
}

/**
 * An in-memory filesystem behind `__logIo`. `appendFile` really concatenates,
 * `stat` really reports the resulting size, and `open(...).read` really returns
 * the byte at the requested position — so the last-byte check is exercised
 * rather than mocked into agreeing with itself.
 */
function withFileIo(
  seed: Record<string, string>,
  body: (io: FileIoHarness) => Promise<void>
): () => Promise<void> {
  return async () => {
    const realIo = { ...__logIo };
    const io: FileIoHarness = {
      files: new Map(
        Object.entries(seed).map(([path, text]) => [path, Buffer.from(text, "utf-8")])
      ),
      appendCalls: [],
      renames: [],
    };

    __logIo.mkdir = (async () => undefined) as unknown as typeof __logIo.mkdir;
    __logIo.stat = (async (path: unknown) => {
      const buf = io.files.get(String(path));
      if (buf === undefined) throw enoent();
      return { size: buf.length };
    }) as unknown as typeof __logIo.stat;
    __logIo.open = (async (path: unknown) => {
      const buf = io.files.get(String(path));
      if (buf === undefined) throw enoent();
      return {
        read: async (target: Buffer, offset: number, length: number, position: number) => {
          const bytesRead = buf.copy(target, offset, position, position + length);
          return { bytesRead, buffer: target };
        },
        close: async () => undefined,
      };
    }) as unknown as typeof __logIo.open;
    __logIo.appendFile = (async (path: unknown, payload: unknown) => {
      const key = String(path);
      io.appendCalls.push({ path: key, payload: String(payload) });
      const existing = io.files.get(key) ?? Buffer.alloc(0);
      io.files.set(key, Buffer.concat([existing, Buffer.from(String(payload), "utf-8")]));
    }) as unknown as typeof __logIo.appendFile;
    __logIo.rename = (async (from: unknown, to: unknown) => {
      io.renames.push({ from: String(from), to: String(to) });
      const buf = io.files.get(String(from));
      if (buf !== undefined) {
        io.files.set(String(to), buf);
        io.files.delete(String(from));
      }
    }) as unknown as typeof __logIo.rename;
    resetTelemetryHealth();

    try {
      await body(io);
    } finally {
      Object.assign(__logIo, realIo);
      resetTelemetryHealth();
    }
  };
}

const SERVER_LOG = join(LOG_DIR, "mcp-server.jsonl");
/** A record cut off mid-write — the shape ENOSPC or a kill -9 leaves behind. */
const TORN = '{"at":"2026-08-02T00:00:00.000Z","type":"tick.start"}\n{"at":"2026-08-02T00:00';

function parsedLines(text: string): unknown[] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

test(
  "an append onto a torn server log does not concatenate into an unparseable record",
  withFileIo({ [SERVER_LOG]: TORN }, async (io) => {
    const result = await logEvent("server", "telemetry.record", { skill: "demo" });
    assert.equal(result.ok, true);

    const text = io.files.get(SERVER_LOG)!.toString("utf-8");
    const lines = text.split("\n").filter((line) => line.length > 0);
    assert.equal(lines.length, 3, "the torn record stays its own line; the new event is its own");
    // Pre-fix this was `...{"at":"2026-08-02T00:00{"at":"...","type":"telemetry.record"...}`.
    assert.equal(
      lines[1],
      '{"at":"2026-08-02T00:00',
      "the torn record must not absorb the new one"
    );
    assert.equal(JSON.parse(lines[2]!).type, "telemetry.record");
  })
);

test(
  "the healing newline rides in the same append call that writes the record",
  withFileIo({ [SERVER_LOG]: TORN }, async (io) => {
    await logEvent("server", "telemetry.record", {});

    // A second append would re-open the exact tear window it is closing.
    assert.equal(io.appendCalls.length, 1, "one append call, not two");
    assert.ok(
      io.appendCalls[0]!.payload.startsWith("\n"),
      `the newline must be part of the record write: ${JSON.stringify(io.appendCalls[0]!.payload)}`
    );
    assert.ok(io.appendCalls[0]!.payload.endsWith("\n"));
  })
);

test(
  "a well-formed log gains no spurious blank line",
  withFileIo({ [SERVER_LOG]: '{"type":"a"}\n' }, async (io) => {
    await logEvent("server", "b", {});
    await logEvent("server", "c", {});

    const text = io.files.get(SERVER_LOG)!.toString("utf-8");
    assert.ok(!text.includes("\n\n"), `no blank line may appear: ${JSON.stringify(text)}`);
    assert.deepEqual(
      parsedLines(text).map((entry) => (entry as { type: string }).type),
      ["a", "b", "c"]
    );
    for (const call of io.appendCalls) {
      assert.ok(!call.payload.startsWith("\n"), "a healthy file needs no healing newline");
    }
  })
);

test(
  "an absent or empty log file is appended to unchanged",
  withFileIo({ [SERVER_LOG]: "" }, async (io) => {
    await logEvent("server", "first", {});
    assert.ok(!io.appendCalls[0]!.payload.startsWith("\n"), "size 0 needs no healing newline");

    // And a session log that does not exist at all.
    await logEvent({ session: "sx-fresh" }, "tick.start", {});
    const sessionCall = io.appendCalls[1]!;
    assert.ok(sessionCall.path.endsWith("sx-fresh.jsonl"));
    assert.ok(!sessionCall.payload.startsWith("\n"), "an absent file needs no healing newline");
  })
);

test(
  "the session log gets the same protection as the server log",
  withFileIo({ [join(SESSIONS_DIR, "sx-torn.jsonl")]: TORN }, async (io) => {
    await logEvent({ session: "sx-torn" }, "tick.result", { ok: true });

    const text = io.files.get(join(SESSIONS_DIR, "sx-torn.jsonl"))!.toString("utf-8");
    const lines = text.split("\n").filter((line) => line.length > 0);
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[2]!).type, "tick.result");
    assert.equal(io.appendCalls.length, 1);
    assert.ok(io.appendCalls[0]!.payload.startsWith("\n"));
  })
);

test(
  "the check runs after rotation, so a rotated-away file is not measured",
  withFileIo({ [SERVER_LOG]: "x".repeat(5 * 1024 * 1024 + 1) }, async (io) => {
    // The oversized file has no trailing newline. Hoisting the check above
    // `rotateLargeLog` would measure it and prepend a newline to the FIRST line
    // of the brand-new, empty post-rotation file.
    await logEvent("server", "after.rotation", {});

    assert.deepEqual(io.renames, [{ from: SERVER_LOG, to: `${SERVER_LOG}.1` }]);
    assert.equal(io.appendCalls.length, 1);
    assert.ok(
      !io.appendCalls[0]!.payload.startsWith("\n"),
      "the post-rotation file is size 0 — the check must look at it, not at the rotated file"
    );
    assert.equal(io.files.get(SERVER_LOG)!.toString("utf-8"), io.appendCalls[0]!.payload);
  })
);

test(
  "a stat failure falls back to the plain append instead of failing the caller",
  withFileIo({ [SERVER_LOG]: TORN }, async (io) => {
    __logIo.stat = (async () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    }) as unknown as typeof __logIo.stat;

    // Telemetry never fails a caller's operation, so an unreadable file takes
    // the unhealed append rather than throwing out of the check.
    const result = await logEvent("server", "telemetry.record", {});
    assert.deepEqual(result, { ok: true, outcome: "written" });
    assert.equal(io.appendCalls.length, 1);
    assert.ok(!io.appendCalls[0]!.payload.startsWith("\n"));
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
