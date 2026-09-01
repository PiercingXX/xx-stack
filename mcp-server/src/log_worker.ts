/**
 * Structured JSONL telemetry for xx-stack MCP server.
 *
 * Two log streams:
 *   server       → ~/.config/xx-stack/logs/mcp-server.jsonl
 *   per-session  → ~/.config/xx-stack/logs/sessions/<sessionId>.jsonl
 *
 * If the new directory does not exist yet and the pre-1.66 path
 * `~/.config/opencode/xx-stack-logs` does, that legacy directory is used so an
 * upgrade does not split an existing stream.
 *
 * Telemetry is append-only JSONL (one JSON object per line).
 * The server log rotates to mcp-server.jsonl.1 when it exceeds 5 MB.
 *
 * A write failure never propagates to the caller — telemetry is an observability
 * sink, and a full disk must not take down routing. It is no longer *silent*
 * either: every failure is returned to the caller as a `LogEventResult`, counted
 * in `telemetryHealth()`, and announced once on stderr (MCP-16/§11.1). Silence
 * was the actual defect: `record_telemetry` reported "accepted / best-effort"
 * while ENOSPC threw the line away, and nothing anywhere recorded it.
 */

import { existsSync } from "node:fs";
import { appendFile, mkdir, open, rename, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";

const NEXT_LOG_DIR = resolve(homedir(), ".config/xx-stack/logs");
const LEGACY_LOG_DIR = resolve(homedir(), ".config/opencode/xx-stack-logs");

export function resolveLogDir(): string {
  if (existsSync(NEXT_LOG_DIR)) return NEXT_LOG_DIR;
  if (existsSync(LEGACY_LOG_DIR)) return LEGACY_LOG_DIR;
  return NEXT_LOG_DIR;
}

export const LOG_DIR = resolveLogDir();
const SESSIONS_DIR = join(LOG_DIR, "sessions");
const SERVER_LOG = join(LOG_DIR, "mcp-server.jsonl");
const MAX_SERVER_LOG_BYTES = 5 * 1024 * 1024; // 5 MB
/** A session log filename is capped so a long id cannot trip ENAMETOOLONG. */
const MAX_SESSION_FILENAME_LENGTH = 128;

/**
 * Test seam for the five filesystem calls telemetry makes.
 *
 * The failure paths below are the whole point of this module's contract, and
 * they are unreachable from a test that is not allowed to break the user's real
 * log directory. Swapped only by `log_worker.test.ts`; production never
 * reassigns it.
 *
 * `open` is a member for the same reason `stat` is: `needsLeadingNewline` reads
 * the file's last byte, and a check that bypasses the seam is a check no test
 * with the existing doubles can reach.
 */
export const __logIo = { mkdir, appendFile, open, rename, stat };

let dirEnsured = false;

let failureCount = 0;
let lastError: string | null = null;
let lastFailureAt: string | null = null;
/** The message already announced on stderr, so a wedged disk cannot flood it. */
let announcedError: string | null = null;

/** The outcome of one `logEvent` call. `ok` is false only for `"failed"`. */
export interface LogEventResult {
  ok: boolean;
  /**
   * "written" — the append call completed.
   * "skipped" — nothing was attempted (the session id resolved outside the log
   *             directory), which is a rejection, not an I/O failure.
   * "failed"  — the append was attempted and threw.
   */
  outcome: "written" | "skipped" | "failed";
  /** Present only on "failed". */
  error?: string;
}

/** Process-lifetime telemetry write health, for callers that want to report it. */
export interface TelemetryHealth {
  failures: number;
  lastError: string | null;
  lastFailureAt: string | null;
}

export function telemetryHealth(): TelemetryHealth {
  return { failures: failureCount, lastError, lastFailureAt };
}

/** Test-only: forget the recorded failures and the stderr announcement latch. */
export function resetTelemetryHealth(): void {
  failureCount = 0;
  lastError = null;
  lastFailureAt = null;
  announcedError = null;
  dirEnsured = false;
}

function noteFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  failureCount += 1;
  lastError = message;
  lastFailureAt = new Date().toISOString();

  // The log directory may have been removed under us. `dirEnsured` used to latch
  // for the process lifetime, so telemetry then died silently forever; clearing
  // it makes the next call re-create the directory and recover.
  dirEnsured = false;

  // stderr only — stdout carries the MCP protocol (same rule as
  // execution_policy's denylist warning). Announce once per distinct message:
  // a full disk fails every event, and one line per event would bury the log,
  // but a *new* failure mode is never hidden behind an old one.
  if (announcedError !== message) {
    announcedError = message;
    console.error(
      `xx-stack log_worker: telemetry write failed (${failureCount} total, non-fatal): ${message}`
    );
  }
  return message;
}

async function ensureLogDir(): Promise<void> {
  if (dirEnsured) return;
  await __logIo.mkdir(SESSIONS_DIR, { recursive: true });
  dirEnsured = true;
}

async function rotateLargeLog(logPath: string): Promise<void> {
  try {
    const s = await __logIo.stat(logPath);
    if (s.size > MAX_SERVER_LOG_BYTES) {
      await __logIo.rename(logPath, `${logPath}.1`);
    }
  } catch {
    // file does not exist yet — nothing to rotate
  }
}

/**
 * Does this file need a healing `\n` in front of the next record?
 *
 * JSONL is only parseable while every record ends in a newline. A torn write —
 * ENOSPC mid-line, a killed process, a truncation by an external tool — leaves
 * the file ending mid-record, and the next append concatenates onto it and
 * produces one line that fails to parse. Reading the last byte answers the
 * question the append is about to depend on.
 *
 * An absent or empty file needs nothing, and a `stat` that fails for any reason
 * yields `false`: telemetry never fails a caller's operation, so an unreadable
 * file falls back to the plain append (which will surface its own error through
 * the normal channel) rather than throwing from the check.
 *
 * There is deliberately NO in-process "last byte I wrote" cache. It would be
 * wrong across processes — several MCP servers share one log — and wrong across
 * an external truncation, which is one of the tears this exists to heal. The
 * cost is one `stat` plus a one-byte read per event, which is what correctness
 * costs here.
 */
async function needsLeadingNewline(path: string): Promise<boolean> {
  let size: number;
  try {
    size = (await __logIo.stat(path)).size;
  } catch {
    return false;
  }
  if (size === 0) return false;
  const handle = await __logIo.open(path, "r");
  try {
    const buf = Buffer.alloc(1);
    const { bytesRead } = await handle.read(buf, 0, 1, size - 1);
    return bytesRead === 1 && buf[0] !== 0x0a;
  } finally {
    await handle.close();
  }
}

/**
 * Reduce a caller-supplied session id to a single safe path segment.
 *
 * The id reaches here verbatim from `supervisor_start_session`, where the
 * schema is a bare `z.string()`. Joined unsanitized, an id of
 * `../../../../tmp/x` appends outside the log directory entirely — and because
 * `logEvent` used to swallow every error, the escape was invisible. Everything
 * outside `[A-Za-z0-9._-]` becomes `-`, and a dot-only result (`.`, `..`) is
 * replaced outright because those name directories rather than files.
 */
export function sanitizeSessionIdForPath(sessionId: string): string {
  const collapsed = sessionId.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-");
  const trimmed = collapsed.slice(0, MAX_SESSION_FILENAME_LENGTH);
  if (trimmed.length === 0 || /^\.+$/.test(trimmed)) return "invalid-session-id";
  return trimmed;
}

/**
 * Resolve the log file for a session, or null when the result would not sit
 * directly inside SESSIONS_DIR. Sanitizing already removes every separator;
 * the containment check is the second belt, so a future change to the
 * character class cannot silently reopen the traversal.
 */
export function resolveSessionLogPath(sessionId: string): string | null {
  const safe = sanitizeSessionIdForPath(sessionId);
  const candidate = resolve(SESSIONS_DIR, `${safe}.jsonl`);
  if (!candidate.startsWith(SESSIONS_DIR + sep)) return null;
  if (candidate.slice(SESSIONS_DIR.length + 1).includes(sep)) return null;
  return candidate;
}

/**
 * Append one event line to the chosen stream.
 *
 * Never throws and never rejects: callers may `void logEvent(...)` without
 * risking an unhandled rejection, which several routing and supervisor tools
 * do. Callers that care about durability read the returned result instead.
 *
 * @param stream  "server" for the shared server log, or { session: "<id>" } for a session trace.
 * @param type    Event type string (e.g. "tick.result", "fallback.applied").
 * @param payload Extra fields merged into the log line.
 */
export async function logEvent(
  stream: "server" | { session: string },
  type: string,
  payload: Record<string, unknown>
): Promise<LogEventResult> {
  try {
    await ensureLogDir();
    const line = JSON.stringify({ at: new Date().toISOString(), type, ...payload }) + "\n";

    if (stream === "server") {
      // The check sits AFTER rotation on purpose: `rotateLargeLog` renames the
      // oversized file away, so the file this append lands in is size 0 and a
      // hoisted check would have measured the wrong file.
      await rotateLargeLog(SERVER_LOG);
      const heal = (await needsLeadingNewline(SERVER_LOG)) ? "\n" : "";
      // The healing newline rides in the SAME append call. A separate append
      // re-opens the exact tear window it is closing.
      await __logIo.appendFile(SERVER_LOG, heal + line, "utf-8");
    } else {
      const sessionLog = resolveSessionLogPath(stream.session);
      if (sessionLog === null) return { ok: false, outcome: "skipped" };
      const heal = (await needsLeadingNewline(sessionLog)) ? "\n" : "";
      await __logIo.appendFile(sessionLog, heal + line, "utf-8");
    }
  } catch (error) {
    // Telemetry must never fail a caller's operation. It must also never be
    // silent about failing: the reason goes back to the caller, into the
    // counter, and (once) onto stderr.
    return { ok: false, outcome: "failed", error: noteFailure(error) };
  }

  // A write that lands clears the announcement latch, so a failure that recurs
  // after a recovery is reported again rather than being deduped forever.
  announcedError = null;
  return { ok: true, outcome: "written" };
}

/**
 * Called once at server startup to ensure the log directory exists and rotate
 * the server log if it is already oversized.
 */
export async function initServerLog(): Promise<LogEventResult> {
  try {
    await ensureLogDir();
    await rotateLargeLog(SERVER_LOG);
  } catch (error) {
    // Non-fatal, but recorded and announced — a log directory that cannot be
    // created at startup used to be completely invisible.
    return { ok: false, outcome: "failed", error: noteFailure(error) };
  }
  return { ok: true, outcome: "written" };
}
