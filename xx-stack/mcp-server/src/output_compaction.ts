/**
 * Output compaction utilities.
 *
 * Designed for tool outputs that may be large, contain ANSI escapes,
 * or have repetitive content.  All functions are pure — no I/O, no
 * side effects.
 */

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
 * in the `dropped` array.
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
      let runStart = i;
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
    const headBytes = Math.floor(cap * 0.6);
    const tailBytes = cap - headBytes - "... [truncated ...] ...\n".length;
    if (tailBytes > 0) {
      const head = working.slice(0, headBytes);
      const tail = working.slice(-tailBytes);
      const truncated = working.length - cap;
      dropped.push(`truncated ${truncated} bytes (kept ${headBytes} head + ${tailBytes} tail)`);
      working = head + "\n... [truncated " + truncated + " bytes] ...\n" + tail;
    }
  }

  return { output: working, dropped };
}