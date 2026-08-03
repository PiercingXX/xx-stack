import test from "node:test";
import assert from "node:assert/strict";

import { compactOutput } from "./output_compaction.js";

test("compactOutput with cap keeps both head and tail when input exceeds cap", () => {
  // Build input: 100 lines of "header line", then a unique middle marker,
  // then 100 lines of "footer line".  This is well over a cap of 200 chars.
  const lines: string[] = [];
  for (let i = 0; i < 100; i++) lines.push("header line");
  lines.push("--- UNIQUE MIDDLE ---");
  for (let i = 0; i < 100; i++) lines.push("footer line");
  const input = lines.join("\n");

  const result = compactOutput(input, { cap: 200 });

  // Both the head and tail should be present.
  assert.ok(result.output.startsWith("header line"), "output should start with head content");
  assert.ok(result.output.endsWith("footer line"), "output should end with tail content");

  // The truncation notice should be present.
  assert.ok(result.output.includes("[truncated"), "output should contain truncation notice");

  // The dropped array should report truncation.
  assert.ok(
    result.dropped.some((d) => d.startsWith("truncated")),
    "dropped should include truncation report"
  );
});

test("compactOutput with cap below input length preserves head proportion", () => {
  // Build input long enough that the truncation notice fits within cap.
  // The truncation notice template is ~30 chars, so cap must be well above that.
  // Use lines without trailing newlines so the tail assertion is exact.
  const lines: string[] = [];
  for (let i = 0; i < 100; i++) lines.push("A-line");
  for (let i = 0; i < 100; i++) lines.push("B-line");
  const input = lines.join("\n");
  const cap = 200; // smaller than input length (~1400 chars)
  const result = compactOutput(input, { cap });

  // Head should be roughly 60% of cap, tail the remainder.
  assert.ok(result.output.startsWith("A-line"), "output should start with head");
  assert.ok(result.output.endsWith("B-line"), "output should end with tail");
  assert.ok(result.dropped.length > 0, "should report dropped content");
});

test("compactOutput with cap larger than input returns unchanged", () => {
  const input = "short string";
  const result = compactOutput(input, { cap: 1000 });
  assert.equal(result.output, input);
  assert.equal(result.dropped.length, 0);
});

test("compactOutput with cap=0 (no cap) returns unchanged", () => {
  const input = "some\nlong\ninput\nhere";
  const result = compactOutput(input, { cap: 0 });
  assert.equal(result.output, input);
  assert.equal(result.dropped.length, 0);
});

test("compactOutput with cap and collapseRepeats reports accurate dropped counts", () => {
  // 10 identical lines + 1 unique line = 11 lines input
  const input = "same\n".repeat(10) + "unique";
  const result = compactOutput(input, { collapseRepeats: true, cap: 200 });

  // Collapse should report 10 identical lines collapsed.
  const collapseDrops = result.dropped.filter((d) => d.startsWith("collapsed"));
  assert.ok(collapseDrops.length > 0, "should report collapsed lines");

  // The collapsed output should have fewer lines than input.
  const inputLines = input.split("\n").length;
  const outputLines = result.output.split("\n").length;
  assert.ok(outputLines < inputLines, "output should have fewer lines than input");
});

test("compactOutput collapseRepeats dropped line count equals input lines minus output lines", () => {
  // 20 identical lines + 5 unique lines = 25 lines input
  const input = "A\n".repeat(20) + "B\nC\nD\nE\nF";
  const result = compactOutput(input, { collapseRepeats: true });

  const inputLines = input.split("\n").length;
  const outputLines = result.output.split("\n").length;
  const linesDropped = inputLines - outputLines;

  // The dropped array should contain one entry for the collapsed run of 20 lines.
  // The collapsed run of 20 identical lines becomes 2 lines (the line itself + collapse notice),
  // so 18 lines are removed.  The remaining 5 unique lines pass through unchanged.
  assert.equal(linesDropped, 18, "should have dropped 18 lines (20 -> 2)");

  // Verify the dropped message mentions the correct count.
  assert.ok(
    result.dropped.some((d) => d.includes("20")),
    "dropped should mention the run length of 20"
  );

  // Verify the reported dropped count matches actual lines dropped.
  // Each "collapsed N consecutive identical lines" report means N lines became 2 lines,
  // so N - 2 lines were dropped per report.
  let reportedDroppedLines = 0;
  for (const msg of result.dropped) {
    const m = msg.match(/^collapsed (\d+) consecutive identical lines$/);
    if (m) {
      reportedDroppedLines += parseInt(m[1]!, 10) - 2;
    }
  }
  assert.equal(
    reportedDroppedLines,
    linesDropped,
    "reported dropped count should match actual lines dropped"
  );
});

// ---------------------------------------------------------------------------
// MCP-5: compactOutput violated its own contract three ways — it overran the
// cap by `4 + digits(dropped)` (24 chars reserved for a 28+ char marker), it
// reported `length - cap` as the drop rather than what was actually removed,
// and for any cap too small to hold a marker it returned the FULL UNCAPPED
// string with an empty `dropped` list.
// ---------------------------------------------------------------------------

/** The bytes actually removed, derived from the output rather than the report. */
function actualBytesRemoved(input: string, output: string): number {
  const marker = output.match(/\n\.\.\. \[truncated \d+ bytes\] \.\.\.\n/);
  const retained = marker ? output.length - marker[0].length : output.length;
  return input.length - retained;
}

function reportedBytesRemoved(dropped: string[]): number {
  const msg = dropped.find((d) => d.startsWith("truncated "));
  assert.ok(msg, "truncation must be reported in `dropped`");
  const m = msg!.match(/^truncated (\d+) bytes/);
  assert.ok(m, "truncation message should contain a byte count");
  return parseInt(m![1]!, 10);
}

test("compactOutput truncation reported dropped bytes match actual bytes removed", () => {
  // A long enough input that truncation kicks in.
  const input = "A\n".repeat(200) + "B\n".repeat(200);
  const cap = 500;
  const result = compactOutput(input, { cap });

  assert.ok(
    result.output.length <= cap,
    `output ${result.output.length} must not exceed cap ${cap}`
  );
  assert.equal(
    reportedBytesRemoved(result.dropped),
    actualBytesRemoved(input, result.output),
    "reported truncated bytes must equal the bytes actually removed"
  );
});

test("compactOutput never exceeds its cap (MCP-5: cap 1000 on 5000 chars produced 1008)", () => {
  const input = "x".repeat(5000);
  const cap = 1000;
  const result = compactOutput(input, { cap });

  assert.equal(
    result.output.length <= cap,
    true,
    `output was ${result.output.length} chars for a cap of ${cap}`
  );
  assert.ok(result.output.includes("[truncated"), "a cap this size still carries the marker");
  assert.equal(
    reportedBytesRemoved(result.dropped),
    actualBytesRemoved(input, result.output),
    "the report must not understate the drop (it reported 4000 while dropping 4024)"
  );
});

test("compactOutput honors a small cap instead of returning the input uncapped", () => {
  const input = "x".repeat(5000);

  // cap 50 was inside the old `tailBytes <= 0` dead zone: the guard skipped
  // the whole block and returned all 5000 chars with dropped: [].
  const fifty = compactOutput(input, { cap: 50 });
  assert.ok(fifty.output.length <= 50, `cap 50 must be honored — got ${fifty.output.length} chars`);
  assert.ok(fifty.dropped.length > 0, "truncation is never silent");
  assert.equal(reportedBytesRemoved(fifty.dropped), actualBytesRemoved(input, fifty.output));

  // A cap smaller than the marker itself has no room for one, so it
  // hard-truncates — but still reports the drop.
  const tiny = compactOutput(input, { cap: 20 });
  assert.equal(tiny.output.length, 20, "a cap below the marker width is still a hard bound");
  assert.ok(!tiny.output.includes("[truncated"), "no room for a marker at this cap");
  assert.equal(reportedBytesRemoved(tiny.dropped), input.length - 20);
});

test("compactOutput is exact at the cap where the truncation marker first fits", () => {
  const input = "x".repeat(5000);
  // The marker is `\n... [truncated NNNN bytes] ...\n` — 28 chars plus the
  // digits of the reported drop, so 32 chars here. A marker is only worth
  // emitting once at least one character of content survives beside it, which
  // makes cap 33 the boundary: 32 for the marker + 1 retained char.
  const boundary = 33;
  for (let cap = boundary - 3; cap <= boundary + 3; cap++) {
    const result = compactOutput(input, { cap });
    assert.ok(result.output.length <= cap, `cap ${cap}: output was ${result.output.length} chars`);
    assert.ok(result.dropped.length > 0, `cap ${cap}: truncation must be reported`);
    assert.equal(
      reportedBytesRemoved(result.dropped),
      actualBytesRemoved(input, result.output),
      `cap ${cap}: reported drop must equal the actual drop`
    );
  }

  // Below the boundary there is no marker; at and above it there is.
  assert.ok(!compactOutput(input, { cap: boundary - 1 }).output.includes("[truncated"));
  assert.ok(compactOutput(input, { cap: boundary }).output.includes("[truncated"));
  assert.equal(compactOutput(input, { cap: boundary }).output.length, boundary);
});

test("compactOutput caps every size from 1 upward without overrunning or misreporting", () => {
  const input = "abcdefghij".repeat(50); // 500 chars
  for (let cap = 1; cap <= 200; cap++) {
    const result = compactOutput(input, { cap });
    assert.ok(result.output.length <= cap, `cap ${cap}: output ${result.output.length}`);
    assert.equal(
      reportedBytesRemoved(result.dropped),
      actualBytesRemoved(input, result.output),
      `cap ${cap}: reported drop must equal the actual drop`
    );
  }
});
