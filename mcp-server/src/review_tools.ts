import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
// `reviewToContinuation` embeds this diff in a continuation prompt that may
// be handed to ANOTHER LANE, possibly a cloud one — so a credential in the diff
// is a credential leaving this machine. Value-pattern redaction alone missed
// every one of `DATABASE_URL=postgres://user:pw@host/db`, `STRIPE_KEY=sk_live_…`
// and `SMTP_PASS=…`, so hunk bodies are additionally attributed to a file and
// dotenv-shaped files get the structural pass.
//
// Attribution needs hunk headers (`--- a/<path>`), which real `git diff` always
// emits — but a caller-supplied diff is free-form text that may carry none at
// all (a pasted `.env` body, a partial patch). For that source the structural
// pass therefore runs over the whole payload instead of per-hunk.

/** Where the reviewed diff came from; mirrors the tool's `diffSource` output. */
export type DiffSource = "argument" | "git" | "unavailable";

export interface RedactDiffOptions {
  /** Caller-supplied diffs without any parseable hunk header get the structural dotenv pass over the whole payload. */
  source?: DiffSource;
}

/** `+++ b/path` / `--- a/path`: strip the marker, the `a/`|`b/` prefix, tab suffix. */
function parseDiffHeaderPath(line: string): string | null {
  const raw = line.slice(4).split("\t")[0]!.trim();
  if (raw.length === 0 || raw === "/dev/null") return null;
  return raw.replace(/^[ab]\//, "");
}

/**
 * The dotenv shape test for diff attribution. Deliberately wider than
 * `isDotenvPath`'s dotted basenames: files like `secrets.env` or `prod.env`
 * carry exactly the same "every value is a credential" contract, so both the
 * `.env*` prefix family and any basename ENDING in `.env` qualify.
 */
function isDotenvAttributionPath(path: string): boolean {
  if (isDotenvPath(path)) return true;
  const basename = (path.split(/[/\\]/).pop() ?? "").toLowerCase();
  return basename.startsWith(".env") || basename.endsWith(".env");
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
export function redactDiffSecrets(diff: string, options: RedactDiffOptions = {}): string {
  const lines = redactSecrets(diff).split("\n");
  const out: string[] = [];

  let dotenvHunk = false;
  let inHunk = false;
  let sawHunkHeader = false;
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
      sawHunkHeader = true;
      dotenvHunk =
        (newPath !== null && isDotenvAttributionPath(newPath)) ||
        (oldPath !== null && isDotenvAttributionPath(oldPath));
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

  // A caller-supplied diff with no hunk header gives attribution nothing to
  // work with — every dotenv-shaped assignment in it would survive the walk.
  // Structural redaction over the whole payload is safe there: the payload was
  // handed to us AS diff content, not as source code, so treating each
  // `KEY=value` line's value as a credential cannot damage attributed hunks
  // (there are none). Git-sourced diffs keep the per-hunk behavior unchanged.
  const walked = out.join("\n");
  if (options.source === "argument" && !sawHunkHeader) {
    return redactDotenvAssignments(walked);
  }
  return walked;
}

/** Seams for deterministic tests; both default to the real implementations. */
export interface ReviewToolOverrides {
  detectGitDiff?: (cwd: string) => Promise<DiffDetection>;
  getCompletionMemorySyncStatus?: (
    guard: CompletionMemorySyncGuard
  ) => Promise<{ driftDetected: boolean; helperPrompt?: string | null }>;
}

export interface ReviewToContinuationArgs {
  sessionId: string;
  cwd?: string;
  diff?: string;
  notes: string[];
}

/**
 * Review notes + (redacted) diff → continuation prompt. Not an MCP tool;
 * compose via the compose-supervisor-prompts skill.
 */
export async function reviewToContinuation(
  deps: SupervisorToolDeps,
  { sessionId, cwd, diff, notes }: ReviewToContinuationArgs,
  overrides: ReviewToolOverrides = {}
): Promise<ReturnType<typeof jsonContent>> {
  const readDiff = overrides.detectGitDiff ?? detectGitDiff;
  const readMemorySyncStatus =
    overrides.getCompletionMemorySyncStatus ?? getCompletionMemorySyncStatus;

  return guardStoreAccess(() =>
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
      const compacted = compactOutput(redactDiffSecrets(rawDiff, { source: diffSource }), {
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
  );
}
