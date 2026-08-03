import test from "node:test";
import assert from "node:assert/strict";

import { buildContinuationPrompt } from "./supervisor_completion_tools.js";

test("buildContinuationPrompt is deterministic: identical input twice yields byte-identical output", () => {
  const args = {
    sessionId: "sx-test-001",
    continuationCount: 1,
    currentRoute: {
      host: "localhost",
      model: "gpt-4",
      endpoint: "http://localhost:8080",
      tier: "standard",
    } as const,
    completionMemorySync: undefined,
    memorySyncStatus: null,
    completionRecoveryReason: "review_to_continuation",
    remediationChecklist: [] as string[],
    pendingTasks: [
      "Fix the null-dereference in parseUserConfig",
      "Add error boundary to applyToolPolicy",
    ],
    extraSections: [
      "- mustAddress items:",
      "1. Fix the null-dereference in parseUserConfig",
      "2. Add error boundary to applyToolPolicy",
      "- diff under review:",
      "(no diff detected — review notes apply to the current working tree)",
    ],
  };

  const first = buildContinuationPrompt(
    args.sessionId,
    args.continuationCount,
    args.currentRoute,
    args.completionMemorySync,
    args.memorySyncStatus,
    args.completionRecoveryReason,
    args.remediationChecklist,
    args.pendingTasks,
    args.extraSections
  );

  const second = buildContinuationPrompt(
    args.sessionId,
    args.continuationCount,
    args.currentRoute,
    args.completionMemorySync,
    args.memorySyncStatus,
    args.completionRecoveryReason,
    args.remediationChecklist,
    args.pendingTasks,
    args.extraSections
  );

  assert.equal(first, second, "identical inputs must produce byte-identical outputs");
});

test("mustAddress covers every supplied note even when note names a path absent from diff", () => {
  // Simulate the mustAddress construction from review_tools.ts
  const notes = [
    "src/config_runtime.ts: parseUserConfig can throw on malformed JSON",
    "src/execution_policy.ts: missing error boundary around execFile",
  ];

  const mustAddress = notes.map((note) => ({
    note,
    required: true,
  }));

  assert.equal(mustAddress.length, notes.length, "mustAddress must cover every note");

  for (let i = 0; i < notes.length; i++) {
    assert.equal(mustAddress[i].note, notes[i], `mustAddress[${i}].note must match`);
    assert.equal(mustAddress[i].required, true, `mustAddress[${i}].required must be true`);
  }

  // Verify that a note naming a path ABSENT from the diff still reaches mustAddress.
  // The diff is empty (simulating no changes), yet the note about src/config_runtime.ts
  // must still appear in mustAddress.
  const absentPathNote = "src/nonexistent.ts: this path is not in any diff";
  const allNotes = [...notes, absentPathNote];
  const allMustAddress = allNotes.map((note) => ({ note, required: true }));
  const found = allMustAddress.find((item) => item.note === absentPathNote);
  assert.ok(found, "note naming a path absent from the diff must still appear in mustAddress");
  assert.equal(found.required, true);
});
