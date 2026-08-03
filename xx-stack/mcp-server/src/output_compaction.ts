/**
 * Output compaction utilities.
 *
 * Designed for tool outputs that may be large, contain ANSI escapes,
 * or have repetitive content.  All functions are pure — no I/O, no
 * side effects.
 */

// eslint-disable-next-line no-control-regex -- ANSI escape stripping needs the literal ESC/CSI control chars
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

/**
 * Strip ANSI escape sequences from a string.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * Options for {@link compactOutput}.
 */
export interface CompactOptions {
  /** Maximum output length in characters.  0 or undefined means no cap. */
  cap?: number;
  /** If true, strip ANSI escape sequences before processing. */
  stripAnsi?: boolean;
  /**
   * If true, collapse runs of three or more identical consecutive lines
   * into a summary line like `  [42 identical lines collapsed]` — but only
   * when the summary is shorter than the run it replaces (see D2 below).
   */
  collapseRepeats?: boolean;
}

/**
 * Result of {@link compactOutput}.
 */
export interface CompactResult {
  /** The compacted text. */
  output: string;
  /** Human-readable description of what was dropped and why. */
  dropped: string[];
}

/**
 * Compact an output string: strip ANSI, collapse repeated lines, and/or
 * cap length while preserving both head and tail.
 *
 * Never truncates silently — every truncation and collapse is reported
 * in the `dropped` array, and the reported byte count is the number of
 * characters actually removed.
 *
 * `cap` is a hard bound: `output.length <= cap` for every cap, including caps
 * too small to hold the truncation marker (those hard-truncate to the cap and
 * still report the drop).
 *
 * Compaction is also a hard bound in the other direction: `output.length <=
 * text.length` for every option combination. Compaction that grows its input
 * is not compaction, and reporting the growth as a saving is worse than the
 * growth.
 */
export function compactOutput(text: string, opts: CompactOptions = {}): CompactResult {
  const dropped: string[] = [];

  let working = text;

  // 1. Strip ANSI
  if (opts.stripAnsi) {
    const before = working.length;
    working = stripAnsi(working);
    const stripped = before - working.length;
    if (stripped > 0) {
      dropped.push(`stripped ${stripped} bytes of ANSI escape sequences`);
    }
  }

  // 2. Collapse repeated consecutive lines
  if (opts.collapseRepeats) {
    const lines = working.split("\n");
    const collapsed: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const current = lines[i]!;
      const runStart = i;
      while (i + 1 < lines.length && lines[i + 1] === current) {
        i++;
      }
      const runLen = i - runStart + 1;
      // D2: the decision is per-run and measured in BYTES, not lines. The
      // marker is 31 characters wide, so a run of 3-4 short lines — blank
      // lines being by far the most common repeated-line pattern in real lint
      // and test output — was replaced by something several times its own
      // size, and the inflation was then reported in `dropped` as a saving.
      //
      // The guard idea (a compaction step must decline itself when it would
      // not shrink its input) is borrowed from rtk-ai/rtk, `src/core/guard.rs`
      // (Apache-2.0). No code was copied; only the invariant.
      //
      // A run that would inflate passes through VERBATIM and contributes no
      // `dropped` entry: claiming a saving that did not happen is the half of
      // the defect that survives any purely line-counting test.
      if (runLen >= 3 && collapseSavesBytes(current, runLen)) {
        collapsed.push(current);
        collapsed.push(collapseMarker(runLen));
        dropped.push(`collapsed ${runLen} consecutive identical lines`);
      } else {
        for (let j = runStart; j <= i; j++) {
          collapsed.push(lines[j]!);
        }
      }
      i++;
    }
    working = collapsed.join("\n");
  }

  // 3. Cap length — keep head and tail
  //
  // Ordering note: step 2 feeds this one. Before the D2 fix, a 4-byte input of
  // blank lines grew to 32 bytes here and then ENTERED this branch under
  // `cap: 10`, reporting "truncated 22 bytes" against a 4-byte input and
  // severing the collapse marker mid-word. With step 2 conditional, the
  // working string is never longer than the input, so a cap above the input
  // length can no longer be reached from below.
  const cap = opts.cap ?? 0;
  if (cap > 0 && working.length > cap) {
    const original = working.length;
    const retained = largestRetainedWithinCap(original, cap);

    if (retained < 1) {
      // The cap is too small to carry the marker at all. The contract is
      // "never truncate silently", not "never truncate": hard-truncate to the
      // cap and still report the drop. Callers pass small caps deliberately
      // (verify_edit forwards caller-supplied caps straight through), so the
      // cap is honored rather than quietly ignored — the old guard returned
      // the full uncapped string with an empty `dropped` list.
      dropped.push(
        `truncated ${original - cap} bytes (kept ${cap} head + 0 tail; cap too small for a truncation marker)`
      );
      working = working.slice(0, cap);
    } else {
      const headBytes = Math.floor(retained * 0.6);
      const tailBytes = retained - headBytes;
      const truncated = original - retained;
      dropped.push(`truncated ${truncated} bytes (kept ${headBytes} head + ${tailBytes} tail)`);
      working =
        working.slice(0, headBytes) +
        truncationMarker(truncated) +
        (tailBytes > 0 ? working.slice(original - tailBytes) : "");
    }
  }

  // 4. Whole-function postcondition.
  //
  // Every step above can only remove bytes: ANSI stripping deletes, the
  // collapse declines itself unless it shrinks the run, and the cap branch
  // bounds the result at `cap`, which it only enters when `cap < working`. So
  // this is unreachable, and `inflationGuardTrips()` lets a test prove it
  // stays that way across the whole option sweep rather than assuming it.
  //
  // It stays as a backstop because the failure it catches is silent by nature:
  // a caller that is handed more bytes than it passed in, together with a
  // `dropped` list telling it bytes were saved, has no way to notice.
  if (working.length > text.length) {
    inflationGuardTripCount += 1;
    return { output: text, dropped: [] };
  }

  return { output: working, dropped };
}

/** The summary line a collapsed run of `runLen` identical lines becomes. */
function collapseMarker(runLen: number): string {
  return `  [${runLen} identical lines collapsed]`;
}

/**
 * Would collapsing `runLen` copies of `line` actually remove bytes?
 *
 * The run occupies `runLen` copies plus the `runLen - 1` newlines between
 * them; the replacement is one copy, one newline, and the marker. Strictly
 * fewer bytes or it is not worth doing — an equal-length swap trades honest
 * output for a marker and saves nothing.
 */
function collapseSavesBytes(line: string, runLen: number): boolean {
  const runBytes = runLen * line.length + (runLen - 1);
  const replacementBytes = line.length + 1 + collapseMarker(runLen).length;
  return replacementBytes < runBytes;
}

/** How many times the step-4 postcondition has fired this process. */
let inflationGuardTripCount = 0;

/**
 * Test-only diagnostic: the number of times {@link compactOutput}'s
 * inflation postcondition has had to fire. The property sweep asserts this
 * never moves — a backstop that is actually load-bearing means step 2 regressed.
 */
export function inflationGuardTrips(): number {
  return inflationGuardTripCount;
}

/**
 * The marker embedded between the retained head and tail. Its own length
 * depends on the number it reports, which is why the retained budget cannot be
 * a fixed subtraction (MCP-5: 24 chars were reserved for a 28+ char marker, so
 * every capped output overran the cap by `4 + digits(dropped)`).
 */
function truncationMarker(droppedBytes: number): string {
  return `\n... [truncated ${droppedBytes} bytes] ...\n`;
}

/**
 * The largest number of original characters that can be kept such that
 * `retained + marker.length <= cap`.
 *
 * `f(retained) = retained + truncationMarker(original - retained).length` is
 * monotonically non-decreasing — keeping one more character drops one fewer,
 * which can only shrink the marker by at most one digit — so a binary search
 * finds the exact boundary. Returns 0 when no marker fits at all.
 */
function largestRetainedWithinCap(original: number, cap: number): number {
  let low = 0;
  let high = original;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (mid + truncationMarker(original - mid).length <= cap) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}
