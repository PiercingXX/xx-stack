/**
 * Structured JSONL telemetry for xx-stack MCP server.
 *
 * Two log streams:
 *   server       → ~/.config/xx-stack/xx-stack-logs/mcp-server.jsonl
 *   per-session  → ~/.config/xx-stack/xx-stack-logs/sessions/<sessionId>.jsonl
 *
 * Telemetry is append-only JSONL (one JSON object per line).
 * The server log rotates to mcp-server.jsonl.1 when it exceeds 5 MB.
 * All write errors are silently swallowed — telemetry must never crash the server.
 */

import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export const LOG_DIR = resolve(homedir(), ".config/xx-stack/xx-stack-logs");
const SESSIONS_DIR = join(LOG_DIR, "sessions");
const SERVER_LOG = join(LOG_DIR, "mcp-server.jsonl");
const MAX_SERVER_LOG_BYTES = 5 * 1024 * 1024; // 5 MB

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
      const sessionLog = join(SESSIONS_DIR, `${stream.session}.jsonl`);
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
