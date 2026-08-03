/**
 * Structured JSONL telemetry for xx-stack MCP server.
 *
 * Two log streams:
 *   server       → ~/.config/opencode/xx-stack-logs/mcp-server.jsonl
 *   per-session  → ~/.config/opencode/xx-stack-logs/sessions/<sessionId>.jsonl
 *
 * Telemetry is append-only JSONL (one JSON object per line).
 * The server log rotates to mcp-server.jsonl.1 when it exceeds 5 MB.
 * All write errors are silently swallowed — telemetry must never crash the server.
 */

import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";

export const LOG_DIR = resolve(homedir(), ".config/opencode/xx-stack-logs");
const SESSIONS_DIR = join(LOG_DIR, "sessions");
const SERVER_LOG = join(LOG_DIR, "mcp-server.jsonl");
const MAX_SERVER_LOG_BYTES = 5 * 1024 * 1024; // 5 MB
/** A session log filename is capped so a long id cannot trip ENAMETOOLONG. */
const MAX_SESSION_FILENAME_LENGTH = 128;

let dirEnsured = false;

async function ensureLogDir(): Promise<void> {
  if (dirEnsured) return;
  await mkdir(SESSIONS_DIR, { recursive: true });
  dirEnsured = true;
}

async function rotateLargeLog(logPath: string): Promise<void> {
  try {
    const s = await stat(logPath);
    if (s.size > MAX_SERVER_LOG_BYTES) {
      await rename(logPath, `${logPath}.1`);
    }
  } catch {
    // file does not exist yet — nothing to rotate
  }
}

/**
 * Reduce a caller-supplied session id to a single safe path segment.
 *
 * The id reaches here verbatim from `supervisor_start_session`, where the
 * schema is a bare `z.string()`. Joined unsanitized, an id of
 * `../../../../tmp/x` appends outside the log directory entirely — and because
 * `logEvent` swallows every error, the escape is invisible. Everything outside
 * `[A-Za-z0-9._-]` becomes `-`, and a dot-only result (`.`, `..`) is replaced
 * outright because those name directories rather than files.
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
 * @param stream  "server" for the shared server log, or { session: "<id>" } for a session trace.
 * @param type    Event type string (e.g. "tick.result", "fallback.applied").
 * @param payload Extra fields merged into the log line.
 */
export async function logEvent(
  stream: "server" | { session: string },
  type: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await ensureLogDir();
    const line = JSON.stringify({ at: new Date().toISOString(), type, ...payload }) + "\n";

    if (stream === "server") {
      await rotateLargeLog(SERVER_LOG);
      await appendFile(SERVER_LOG, line, "utf-8");
    } else {
      const sessionLog = resolveSessionLogPath(stream.session);
      if (sessionLog === null) return;
      await appendFile(sessionLog, line, "utf-8");
    }
  } catch {
    // telemetry must never crash the server
  }
}

/**
 * Called once at server startup to ensure the log directory exists and rotate
 * the server log if it is already oversized.
 */
export async function initServerLog(): Promise<void> {
  try {
    await ensureLogDir();
    await rotateLargeLog(SERVER_LOG);
  } catch {
    // non-fatal
  }
}
