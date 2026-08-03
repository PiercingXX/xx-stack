import test from "node:test";
import assert from "node:assert/strict";
import { join, sep } from "node:path";

import { LOG_DIR, resolveSessionLogPath, sanitizeSessionIdForPath } from "./log_worker.js";

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
