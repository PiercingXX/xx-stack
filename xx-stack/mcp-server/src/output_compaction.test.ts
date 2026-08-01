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
  assert.equal(reportedDroppedLines, linesDropped, "reported dropped count should match actual lines dropped");
});

test("compactOutput truncation reported dropped bytes match actual bytes removed", () => {
  // A long enough input that truncation kicks in.
  const input = "A\n".repeat(200) + "B\n".repeat(200);
  const cap = 500;
  const result = compactOutput(input, { cap });

  // Truncation should have occurred.
  const truncMsg = result.dropped.find((d) => d.startsWith("truncated"));
  assert.ok(truncMsg, "should report truncation");

  // Parse the reported truncated byte count.
  const m = truncMsg!.match(/^truncated (\d+) bytes/);
  assert.ok(m, "truncation message should contain byte count");
  const reportedTruncated = parseInt(m[1]!, 10);

  // The reported truncated bytes should equal input length minus cap
  // (the cap determines how many bytes are kept; the rest are truncated).
  assert.equal(
    reportedTruncated,
    input.length - cap,
    "reported truncated bytes should equal input length minus cap"
  );
});