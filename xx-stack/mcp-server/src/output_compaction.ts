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
   * into a summary line like `  [42 identical lines collapsed]`.
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
      if (runLen >= 3) {
        collapsed.push(current);
        collapsed.push(`  [${runLen} identical lines collapsed]`);
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

  return { output: working, dropped };
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
