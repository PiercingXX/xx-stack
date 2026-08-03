import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { CompletionMemorySyncGuard } from "./memory_runtime.js";
import type { SupervisorToolDeps } from "./supervisor_tool_deps.js";

import { jsonContent } from "./agent_tool_helpers.js";
import { getCompletionMemorySyncStatus } from "./memory_runtime.js";
import { compactOutput } from "./output_compaction.js";
import { guardStoreAccess } from "./supervisor_store_runtime.js";
import {
  buildContinuationPrompt,
  isDotenvPath,
  redactDotenvAssignments,
  redactSecrets,
} from "./supervisor_completion_tools.js";

const execFileAsync = promisify(execFile);

/**
 * Characters of diff embedded in the continuation prompt. The prompt is fed to
 * small local models where the context window is the scarce resource, so the
 * diff goes through the same head+tail compaction as verify_edit output rather
 * than being pasted whole (MCP-8).
 */
export const REVIEW_DIFF_CAP = 8000;

/**
 * A diff read attempt. A failed `git diff` is never collapsed into "" — an
 * empty working tree and an unreadable repo are different facts and the
 * reviewer must be able to tell them apart (MCP-8).
 */
export type DiffDetection =
  { status: "detected"; diff: string } | { status: "unavailable"; detail: string };

/**
 * Read the uncommitted diff of a specific repo.
 *
 * The `cwd` is mandatory: without it `git diff` runs in whatever directory the
 * MCP server process happened to be launched in, which is almost never the
 * session's repo, and the resulting diff (or lack of one) describes the wrong
 * tree entirely.
 */
export async function detectGitDiff(cwd: string): Promise<DiffDetection> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--no-color"], {
      cwd,
      maxBuffer: 1024 * 1024,
    });
    return { status: "detected", diff: stdout };
  } catch (error) {
    return {
      status: "unavailable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

// --- Diff redaction --------------------------------------------------------
//
// `review_to_continuation` embeds this diff in a continuation prompt that may
// be handed to ANOTHER LANE, possibly a cloud one — so a credential in the diff
// is a credential leaving this machine. Value-pattern redaction alone missed
// every one of `DATABASE_URL=postgres://user:pw@host/db`, `STRIPE_KEY=sk_live_…`
// and `SMTP_PASS=…`, so hunk bodies are additionally attributed to a file and
// dotenv-shaped files get the structural pass.

/** `+++ b/path` / `--- a/path`: strip the marker, the `a/`|`b/` prefix, tab suffix. */
function parseDiffHeaderPath(line: string): string | null {
  const raw = line.slice(4).split("\t")[0]!.trim();
  if (raw.length === 0 || raw === "/dev/null") return null;
  return raw.replace(/^[ab]\//, "");
}

/** Diff hunk-body lines carry a one-char marker that must survive redaction. */
const HUNK_BODY_MARKERS = new Set(["+", "-", " "]);

/**
 * Redact a unified diff.
 *
 * The generic pass runs over the whole diff first (byte-identical to the
 * historical behavior, and it never changes line count or line markers, so
 * attribution still holds afterwards). Then the diff is walked tracking the
 * current `--- a/<path>` / `+++ b/<path>` pair, and hunk bodies belonging to a
 * dotenv-shaped file get `redactDotenvAssignments`. A deletion diff is
 * attributed from the `---` side too: deleting a `.env` leaks exactly as hard
 * as adding one.
 */
export function redactDiffSecrets(diff: string): string {
  const lines = redactSecrets(diff).split("\n");
  const out: string[] = [];

  let dotenvHunk = false;
  let inHunk = false;
  let oldPath: string | null = null;
  let newPath: string | null = null;

  // Consecutive same-marker body lines are redacted as one block so a
  // multi-line quoted value keeps its continuation-line state.
  let blockMarker: string | null = null;
  let block: string[] = [];

  const flush = (): void => {
    if (blockMarker === null) return;
    const redacted = redactDotenvAssignments(block.join("\n")).split("\n");
    for (const line of redacted) out.push(`${blockMarker}${line}`);
    blockMarker = null;
    block = [];
  };

  const emit = (line: string): void => {
    flush();
    out.push(line);
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      oldPath = null;
      newPath = null;
      inHunk = false;
      dotenvHunk = false;
      emit(line);
      continue;
    }
    if (line.startsWith("--- ")) {
      oldPath = parseDiffHeaderPath(line);
      inHunk = false;
      emit(line);
      continue;
    }
    if (line.startsWith("+++ ")) {
      newPath = parseDiffHeaderPath(line);
      inHunk = false;
      emit(line);
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      dotenvHunk =
        (newPath !== null && isDotenvPath(newPath)) || (oldPath !== null && isDotenvPath(oldPath));
      emit(line);
      continue;
    }

    const marker = line.slice(0, 1);
    if (!inHunk || !dotenvHunk || !HUNK_BODY_MARKERS.has(marker)) {
      emit(line);
      continue;
    }

    if (blockMarker !== marker) flush();
    blockMarker = marker;
    block.push(line.slice(1));
  }

  flush();
  return out.join("\n");
}

/** Seams for deterministic tests; both default to the real implementations. */
export interface ReviewToolOverrides {
  detectGitDiff?: (cwd: string) => Promise<DiffDetection>;
  getCompletionMemorySyncStatus?: (
    guard: CompletionMemorySyncGuard
  ) => Promise<{ driftDetected: boolean; helperPrompt?: string | null }>;
}

export function registerReviewTools(
  server: McpServer,
  deps: SupervisorToolDeps,
  overrides: ReviewToolOverrides = {}
): void {
  const readDiff = overrides.detectGitDiff ?? detectGitDiff;
  const readMemorySyncStatus =
    overrides.getCompletionMemorySyncStatus ?? getCompletionMemorySyncStatus;

  server.tool(
    "review_to_continuation",
    "Review uncommitted changes and emit a bounded continuation prompt with mustAddress items for every review note. " +
      "The diff is read from the session's repo (cwd argument, else the session's memory-sync cwd), redacted, and " +
      "compacted before it is embedded; a failed read is reported as unavailable, never as an empty diff",
    {
      sessionId: z.string().describe("Supervisor session ID"),
      cwd: z
        .string()
        .optional()
        .describe(
          "Repo root the diff is read from; defaults to the session's memory-sync cwd, then the server cwd"
        ),
      diff: z
        .string()
        .optional()
        .describe("Optional diff content; auto-detected from git in the resolved cwd if omitted"),
      notes: z
        .array(z.string().min(1).max(4000))
        .min(1)
        .max(50)
        .describe("Review notes, each describing a finding that must be addressed"),
    },
    async ({ sessionId, cwd, diff, notes }) =>
      guardStoreAccess(() =>
        deps.withSupervisorStoreLock(async () => {
          const reliability = await deps.loadReliabilityConfig();
          const store = deps.pruneSupervisorStore(await deps.readSupervisorStore(), reliability);
          const state = store.sessions[sessionId];
          if (!state) {
            return jsonContent({ status: "missing", sessionId });
          }

          // The session's repo, not the server's launch directory (MCP-8).
          const diffCwd = cwd?.trim() || state.completionMemorySync?.cwd || process.cwd();

          let diffSource: "argument" | "git" | "unavailable";
          let diffError: string | null = null;
          let rawDiff = "";
          if (diff !== undefined) {
            rawDiff = diff;
            diffSource = "argument";
          } else {
            const detection = await readDiff(diffCwd);
            if (detection.status === "detected") {
              rawDiff = detection.diff;
              diffSource = "git";
            } else {
              diffSource = "unavailable";
              diffError = detection.detail;
            }
          }

          // Redact first, then compact: redacting the retained text after a cut
          // could leave half a credential intact on the truncation boundary.
          // The redaction is diff-aware so hunk bodies can be attributed to a
          // file — dotenv-shaped files get every value redacted by shape, not
          // by hoping the value matches an enumerated vendor format.
          const compacted = compactOutput(redactDiffSecrets(rawDiff), {
            cap: REVIEW_DIFF_CAP,
            stripAnsi: true,
          });

          const now = Date.now();
          state.continuationCount += 1;
          state.lastContinuationAt = now;
          deps.pushSessionEvent(state, "review.injected", `review with ${notes.length} notes`);
          await deps.writeSupervisorStore(store);

          const mustAddress = notes.map((note) => ({
            note,
            required: true,
          }));

          // The status has to be computed, not assumed: passing a truthy guard
          // with a hardcoded null status made the prompt report
          // "memory-sync-drift: not-detected" unconditionally (MCP-8).
          const memorySyncStatus = state.completionMemorySync
            ? await readMemorySyncStatus(state.completionMemorySync)
            : null;

          const diffSection =
            diffSource === "unavailable"
              ? `(diff unavailable — git diff failed in ${diffCwd}: ${diffError}; the review notes below still apply to the current working tree)`
              : compacted.output.length > 0
                ? compacted.output
                : "(no diff detected — review notes apply to the current working tree)";

          const prompt = buildContinuationPrompt(
            sessionId,
            state.continuationCount,
            state.currentRoute,
            state.completionMemorySync,
            memorySyncStatus,
            /* completionRecoveryReason */ "review_to_continuation",
            /* remediationChecklist */ [],
            notes,
            [
              // The notes are already numbered under "remaining tasks" above;
              // re-rendering them here printed every note twice (MCP-8).
              "- mustAddress: every item under remaining tasks above is a review finding and is required; none may be deferred",
              `- diff source: ${diffSource} (cwd ${diffCwd})`,
              ...(compacted.dropped.length > 0
                ? [`- diff compaction: ${compacted.dropped.join("; ")}`]
                : []),
              "- diff under review:",
              diffSection,
            ]
          );

          return jsonContent({
            status: "ready",
            reasonCode: "review_to_continuation_emitted",
            sessionId,
            continuationCount: state.continuationCount,
            mustAddress,
            diffSource,
            diffCwd,
            diffError,
            diffDropped: compacted.dropped,
            memorySyncDrift: memorySyncStatus?.driftDetected ?? null,
            prompt,
          });
        })
      )
  );
}
