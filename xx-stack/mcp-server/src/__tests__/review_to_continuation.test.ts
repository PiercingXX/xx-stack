import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { reviewToContinuation } from "../review_to_continuation.js";
import type { ReviewNote, ReviewToContinuationInput } from "../review_to_continuation.js";

const SAMPLE_DIFF = [
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,3 +1,4 @@",
  " line1",
  "-line2",
  "+line2_updated",
  " line3",
].join("\n");

const SAMPLE_NOTES: ReviewNote[] = [
  { path: "src/foo.ts", line: 2, comment: "typo in function name" },
  { path: "src/bar.ts", line: 10, comment: "missing null check" },
  { path: "src/foo.ts", comment: "add docstring" },
];

describe("reviewToContinuation", () => {
  it("happy path — builds mustAddress with all notes sorted by path then line", () => {
    const input: ReviewToContinuationInput = { diff: SAMPLE_DIFF, notes: SAMPLE_NOTES };
    const result = reviewToContinuation(input);

    assert.equal(result.mustAddress.length, 3);
    // src/bar.ts line 10 comes first (bar < foo)
    assert.equal(result.mustAddress[0].path, "src/bar.ts");
    assert.equal(result.mustAddress[0].line, 10);
    // src/foo.ts without line sorts before src/foo.ts:2
    assert.equal(result.mustAddress[1].path, "src/foo.ts");
    assert.equal(result.mustAddress[1].line, undefined);
    assert.equal(result.mustAddress[2].path, "src/foo.ts");
    assert.equal(result.mustAddress[2].line, 2);

    // continuationPrompt is a non-empty string
    assert.ok(typeof result.continuationPrompt === "string");
    assert.ok(result.continuationPrompt.length > 0);

    // Prompt contains the diff and all note references
    assert.ok(result.continuationPrompt.includes(SAMPLE_DIFF));
    assert.ok(result.continuationPrompt.includes("[src/bar.ts:10] missing null check"));
    assert.ok(result.continuationPrompt.includes("[src/foo.ts] add docstring"));
    assert.ok(result.continuationPrompt.includes("[src/foo.ts:2] typo in function name"));
  });

  it("note with path not in diff still appears in mustAddress", () => {
    const notes: ReviewNote[] = [
      { path: "src/never_touched.ts", line: 5, comment: "this file was never changed" },
    ];
    const input: ReviewToContinuationInput = { diff: SAMPLE_DIFF, notes };
    const result = reviewToContinuation(input);

    assert.equal(result.mustAddress.length, 1);
    assert.equal(result.mustAddress[0].path, "src/never_touched.ts");
    assert.equal(result.mustAddress[0].line, 5);
    assert.equal(result.mustAddress[0].comment, "this file was never changed");

    // The note reference appears in the prompt
    assert.ok(result.continuationPrompt.includes("[src/never_touched.ts:5] this file was never changed"));
  });

  it("byte-identical output for identical inputs", () => {
    const input: ReviewToContinuationInput = { diff: SAMPLE_DIFF, notes: SAMPLE_NOTES };
    const first = reviewToContinuation(input);
    const second = reviewToContinuation(input);

    assert.equal(first.continuationPrompt, second.continuationPrompt);
    assert.deepEqual(first.mustAddress, second.mustAddress);

    // Verify the entire output object is identical
    assert.deepEqual(first, second);
  });

  it("empty notes array is accepted and produces empty mustAddress", () => {
    const input: ReviewToContinuationInput = { diff: SAMPLE_DIFF, notes: [] };
    const result = reviewToContinuation(input);
    assert.deepEqual(result.mustAddress, []);
    assert.ok(typeof result.continuationPrompt === "string");
    assert.ok(result.continuationPrompt.length > 0);
  });

  it("notes sort deterministically with same path/line — comment tiebreaker", () => {
    const notes: ReviewNote[] = [
      { path: "a.ts", line: 1, comment: "z comment" },
      { path: "a.ts", line: 1, comment: "a comment" },
    ];
    const input: ReviewToContinuationInput = { diff: "", notes };
    const result = reviewToContinuation(input);
    assert.equal(result.mustAddress[0].comment, "a comment");
    assert.equal(result.mustAddress[1].comment, "z comment");
  });

  it("diff-line count is computed from diff text", () => {
    const input: ReviewToContinuationInput = { diff: "a\nb\nc", notes: [{ path: "x.ts", comment: "n" }] };
    const result = reviewToContinuation(input);
    // "a\nb\nc" split by \n = 3 lines
    assert.ok(result.continuationPrompt.includes("diff-lines: 3"));
  });
});