import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { runCaptured, registerVerifyEditTools } from "./verify_edit_tools.js";
import { validateExecRequest } from "./execution_policy.js";

const execFileAsync = promisify(execFile);

test("runCaptured returns ok=true with output for a successful command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "verify-edit-"));
  try {
    const result = await runCaptured("echo hello world", dir, "test");
    assert.equal(result.ok, true);
    assert.ok(result.output.includes("hello world"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCaptured returns ok=false with failing tail for a failing command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "verify-edit-"));
  try {
    const result = await runCaptured("false", dir, "test");
    assert.equal(result.ok, false);
    assert.ok(typeof result.output === "string");
    assert.ok(result.output.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCaptured returns ok=false with error message for nonexistent command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "verify-edit-"));
  try {
    const result = await runCaptured("nonexistent-command-12345", dir, "test");
    assert.equal(result.ok, false);
    assert.ok(typeof result.output === "string");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCaptured truncates output beyond 10000 chars from a real oversized output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "verify-edit-"));
  try {
    // Generate a script that prints 15000 lines of 10 chars each = 150k+ chars
    const script = join(dir, "bigprint.sh");
    await writeFile(
      script,
      `#!/bin/sh\nfor i in $(seq 1 15000); do printf 'line-%05d\\n' "$i"; done\n`,
      "utf-8"
    );
    await execFileAsync("chmod", ["+x", script]);

    const result = await runCaptured(script, dir, "bigprint");
    assert.equal(result.ok, true);
    // Output should be truncated — 15000 lines * ~11 chars > 10000
    assert.ok(result.output.length <= 11000, `output length ${result.output.length} exceeds truncation bound`);
    assert.ok(result.output.includes("... [truncated at 10000 chars]"), "output should contain truncation marker");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCaptured empty command returns ok=true with no-command message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "verify-edit-"));
  try {
    const result = await runCaptured("   ", dir, "lint");
    assert.equal(result.ok, true);
    assert.ok(result.output.includes("no command configured"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCaptured goes through validateExecRequest (execution policy path)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "verify-edit-"));
  try {
    // An arg with a backtick fails SAFE_HOOK_ARG_PATTERN and triggers policy denial
    const result = await runCaptured("echo `id`", dir, "unsafe");
    assert.equal(result.ok, false);
    assert.ok(result.output.includes("execution_policy_denied"), `output should mention policy denial, got: ${result.output}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registerVerifyEditTools registers verify_edit tool on a server", async () => {
  // Create a minimal fake server to verify registration doesn't throw
  const tools: string[] = [];
  const fakeServer = {
    tool: (name: string, _desc: string, _schema: unknown, _handler: unknown) => {
      tools.push(name);
    },
  } as Parameters<typeof registerVerifyEditTools>[0];

  registerVerifyEditTools(fakeServer);
  assert.ok(tools.includes("verify_edit"), "verify_edit tool should be registered");
});

test("verify_edit handler returns structured pass/fail with lint and test sections", async () => {
  const dir = await mkdtemp(join(tmpdir(), "verify-edit-"));
  try {
    // Build a real McpServer to test the handler through
    // We use the handler directly by constructing it from the registration
    const captured: Array<{ name: string; handler: Function }> = [];
    const fakeServer = {
      tool: (name: string, _desc: string, _schema: unknown, handler: unknown) => {
        captured.push({ name, handler: handler as Function });
      },
    } as Parameters<typeof registerVerifyEditTools>[0];

    registerVerifyEditTools(fakeServer);
    const handler = captured.find((c) => c.name === "verify_edit")?.handler;
    assert.ok(handler, "handler should exist");

    // Call the handler with a known-good command
    const result = await handler({ cwd: dir, lintCmd: "echo lint-ok", testCmd: "echo test-ok" });
    const payload = JSON.parse(result.content[0].text);

    assert.equal(payload.lint.ok, true);
    assert.ok(payload.lint.output.includes("lint-ok"));
    assert.equal(payload.test.ok, true);
    assert.ok(payload.test.output.includes("test-ok"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify_edit handler returns ok=false for failing commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "verify-edit-"));
  try {
    const captured: Array<{ name: string; handler: Function }> = [];
    const fakeServer = {
      tool: (name: string, _desc: string, _schema: unknown, handler: unknown) => {
        captured.push({ name, handler: handler as Function });
      },
    } as Parameters<typeof registerVerifyEditTools>[0];

    registerVerifyEditTools(fakeServer);
    const handler = captured.find((c) => c.name === "verify_edit")?.handler;
    assert.ok(handler);

    const result = await handler({ cwd: dir, lintCmd: "false", testCmd: "false" });
    const payload = JSON.parse(result.content[0].text);

    assert.equal(payload.lint.ok, false);
    assert.equal(payload.test.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify_edit handler handles missing optional commands gracefully", async () => {
  const dir = await mkdtemp(join(tmpdir(), "verify-edit-"));
  try {
    const captured: Array<{ name: string; handler: Function }> = [];
    const fakeServer = {
      tool: (name: string, _desc: string, _schema: unknown, handler: unknown) => {
        captured.push({ name, handler: handler as Function });
      },
    } as Parameters<typeof registerVerifyEditTools>[0];

    registerVerifyEditTools(fakeServer);
    const handler = captured.find((c) => c.name === "verify_edit")?.handler;
    assert.ok(handler);

    // Only lintCmd, no testCmd
    const result = await handler({ cwd: dir, lintCmd: "echo only-lint" });
    const payload = JSON.parse(result.content[0].text);

    assert.equal(payload.lint.ok, true);
    assert.ok(payload.lint.output.includes("only-lint"));
    assert.equal(payload.test.ok, true);
    assert.ok(payload.test.output.includes("no command configured"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});