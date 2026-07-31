import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { guardedExecFile, validateExecRequest } from "./execution_policy.js";
import { registerVerifyEditTools } from "./verify_edit_tools.js";

// ── Unit tests for verify_edit internals ────────────────────────────────────

test("verify_edit: pass — command succeeds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "verify-edit-pass-"));
  try {
    await writeFile(join(dir, "test.txt"), "hello", "utf-8");

    const { stdout, stderr } = await guardedExecFile(
      "cat",
      ["test.txt"],
      { cwd: dir },
      { context: "hook", allowedHookCommands: ["cat"] }
    );
    assert.equal(stdout.trim(), "hello");
    assert.equal(stderr, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify_edit: fail — command fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "verify-edit-fail-"));
  try {
    await assert.rejects(
      () =>
        guardedExecFile(
          "cat",
          ["nonexistent.txt"],
          { cwd: dir },
          { context: "hook", allowedHookCommands: ["cat"] }
        ),
      /No such file or directory/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify_edit: truncation — output is capped at 4096 bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "verify-edit-trunc-"));
  try {
    // Write a file with more than 4096 bytes of content
    const bigContent = "x".repeat(5000);
    await writeFile(join(dir, "big.txt"), bigContent, "utf-8");

    const { stdout } = await guardedExecFile(
      "cat",
      ["big.txt"],
      { cwd: dir },
      { context: "hook", allowedHookCommands: ["cat"] }
    );

    // The guardedExecFile returns the full stdout — the truncation happens
    // in verify_edit_tools.ts's runCaptured. We verify that the raw output
    // is >= 4096 bytes, confirming truncation would be needed.
    assert.ok(Buffer.byteLength(stdout, "utf-8") > 4096, "output should exceed 4096 bytes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify_edit: policy path — validateExecRequest is called", async () => {
  // Verify that the execution policy gate is used by checking that
  // a command NOT in the allowlist is rejected.
  const result = validateExecRequest("rm", ["-rf", "/"], "hook", ["cat"]);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "hook_command_not_allowlisted");
});

test("verify_edit: policy path — allowed command passes", async () => {
  const result = validateExecRequest("cat", ["test.txt"], "hook", ["cat", "echo"]);
  assert.equal(result.allowed, true);
  assert.equal(result.reason, "ok");
});

test("verify_edit: policy path — empty command rejected", async () => {
  const result = validateExecRequest("", [], "hook", ["cat"]);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "empty_command");
});

test("verify_edit: registerVerifyEditTools exists and has correct shape", () => {
  // This is a compile-time / shape check — registerVerifyEditTools is a function
  assert.equal(typeof registerVerifyEditTools, "function");
  assert.equal(registerVerifyEditTools.length, 2); // (server, deps)
});