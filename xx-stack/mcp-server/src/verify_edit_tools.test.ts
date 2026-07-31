import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { guardedExecFile } from "./execution_policy.js";

// Replicate the truncation logic to test it in isolation (same as in verify_edit_tools.ts).
const OUTPUT_CAP = 4096;

function truncateFailingTail(full: string): string {
  if (full.length <= OUTPUT_CAP) return full;
  return "... [truncated " + (full.length - OUTPUT_CAP) + " bytes] ...\n" + full.slice(-OUTPUT_CAP);
}

test("truncateFailingTail keeps short output unchanged", () => {
  const short = "hello world";
  assert.equal(truncateFailingTail(short), short);
});

test("truncateFailingTail truncates long output to last 4096 bytes with prefix", () => {
  // Build a string that is exactly 5000 bytes (well over the cap).
  const long = "A".repeat(5000);
  const result = truncateFailingTail(long);
  assert.ok(result.startsWith("... [truncated"), "should start with truncation notice");
  assert.ok(result.endsWith("A".repeat(OUTPUT_CAP)), "should end with last 4096 bytes");
  assert.equal(result.length, "... [truncated 904 bytes] ...\n".length + OUTPUT_CAP);
});

test("guardedExecFile rejects blocked commands through validateExecRequest", async () => {
  // guardedExecFile with context "hook" and no allowed commands should block
  // anything that isn't on the allowlist.
  await assert.rejects(
    () =>
      guardedExecFile(
        "nonexistent-blocked-tool",
        [],
        { timeout: 1000 },
        { context: "hook", allowedHookCommands: [] }
      ),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      return msg.startsWith("execution_policy_denied:");
    }
  );
});

test("guardedExecFile allows commands on the allowlist", async () => {
  // "echo" is a safe command that should be on the allowlist.
  // We test with it explicitly allowed.
  const { stdout } = await guardedExecFile(
    "echo",
    ["hello-verify"],
    { timeout: 5000 },
    { context: "hook", allowedHookCommands: ["echo"] }
  );
  assert.equal(stdout.trim(), "hello-verify");
});

test("truncateFailingTail on real oversized output", async () => {
  // Generate a real oversized output by running a command that produces
  // more than 4096 bytes, then verify truncation.
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-verify-edit-"));
  try {
    // Write a file with 6000 lines to trigger large output from a real command.
    const bigFile = join(dir, "big.txt");
    const lineCount = 6000;
    const lines: string[] = [];
    for (let i = 0; i < lineCount; i++) {
      lines.push(`line ${i} of oversized output for truncation test`);
    }
    await writeFile(bigFile, lines.join("\n") + "\n");

    const { stdout } = await guardedExecFile(
      "cat",
      [bigFile],
      { timeout: 5000 },
      { context: "hook", allowedHookCommands: ["cat"] }
    );

    // The output should be well over 4096 bytes.
    assert.ok(stdout.length > OUTPUT_CAP, `expected output > ${OUTPUT_CAP}, got ${stdout.length}`);

    // Now apply truncation to the real output.
    const truncated = truncateFailingTail(stdout);
    assert.ok(truncated.startsWith("... [truncated"), "real oversized output should be truncated");
    assert.ok(truncated.endsWith(stdout.slice(-OUTPUT_CAP)), "should end with real tail");
    assert.ok(
      truncated.length <= "... [truncated ...] ...\n".length + OUTPUT_CAP + 20,
      `truncated length ${truncated.length} should be near cap + prefix`
    );
  } finally {
    // Cleanup handled by OS temp dir policy.
  }
});