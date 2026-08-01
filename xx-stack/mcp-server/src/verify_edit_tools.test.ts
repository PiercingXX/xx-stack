import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { guardedExecFile } from "./execution_policy.js";
import { registerVerifyEditTools } from "./verify_edit_tools.js";

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

// --- verify_edit closed loop: drive the REGISTERED tool, not the helpers ---

type VerifyEditArgs = {
  cwd: string;
  lintCmd?: string;
  testCmd?: string;
  compactOptions?: { cap?: number; stripAnsi?: boolean; collapseRepeats?: boolean };
};

type CmdResult = { ok: boolean; output: string } | null;
type VerifyEditPayload = { lint: CmdResult; test: CmdResult; compacted?: string[] };

/** Register verify_edit on a capture-only server stub and return a driver
 * that invokes the registered handler and parses the structured payload. */
function captureVerifyEditTool(
  allowedCommands: string[]
): (args: VerifyEditArgs) => Promise<VerifyEditPayload> {
  let handler:
    | ((args: VerifyEditArgs) => Promise<{ content: Array<{ type: string; text: string }> }>)
    | undefined;
  const fakeServer = {
    tool: (...toolArgs: unknown[]) => {
      handler = toolArgs[toolArgs.length - 1] as typeof handler;
    },
  } as unknown as McpServer;

  registerVerifyEditTools(fakeServer, { allowedCommands });
  assert.ok(handler, "registerVerifyEditTools should register a tool handler");

  return async (args: VerifyEditArgs) => {
    const result = await handler!(args);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0]!.type, "text");
    return JSON.parse(result.content[0]!.text) as VerifyEditPayload;
  };
}

test("verify_edit returns a structured failure payload on a failing test command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-verify-edit-tool-"));
  try {
    await writeFile(
      join(dir, "fail.js"),
      'console.log("stdout before failure");\n' +
        'console.error("AssertionError: intentional failure marker");\n' +
        "process.exit(1);\n"
    );

    const verifyEdit = captureVerifyEditTool(["node"]);
    const payload = await verifyEdit({ cwd: dir, testCmd: "node fail.js" });

    assert.equal(payload.lint, null, "no lintCmd given, lint should be null");
    assert.ok(payload.test, "test result should be present");
    assert.equal(payload.test!.ok, false, "failing command must report ok: false");
    assert.ok(
      payload.test!.output.includes("AssertionError: intentional failure marker"),
      "failure payload should carry the command's stderr"
    );
    assert.ok(
      payload.test!.output.includes("stdout before failure"),
      "failure payload should carry the command's stdout"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify_edit truncates an oversized failure payload to the failing tail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-verify-edit-tool-"));
  try {
    await writeFile(
      join(dir, "fail-big.js"),
      'for (let i = 0; i < 300; i++) console.error("noise line " + i + " " + "x".repeat(40));\n' +
        'console.error("FINAL-TAIL-MARKER");\n' +
        "process.exit(1);\n"
    );

    const verifyEdit = captureVerifyEditTool(["node"]);
    const payload = await verifyEdit({ cwd: dir, testCmd: "node fail-big.js" });

    assert.equal(payload.test!.ok, false);
    assert.ok(
      payload.test!.output.startsWith("... [truncated"),
      "oversized failure output should be truncated with the notice prefix"
    );
    assert.ok(
      payload.test!.output.includes("FINAL-TAIL-MARKER"),
      "the failing tail — what a continuation prompt needs — must survive truncation"
    );
    assert.ok(
      !payload.test!.output.includes("noise line 0 "),
      "the head of the oversized output should be dropped"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify_edit reports lint pass and test fail independently in one payload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-verify-edit-tool-"));
  try {
    await writeFile(join(dir, "pass.js"), 'console.log("lint clean");\n');
    await writeFile(
      join(dir, "fail.js"),
      'console.error("1 test failed");\nprocess.exit(1);\n'
    );

    const verifyEdit = captureVerifyEditTool(["node"]);
    const payload = await verifyEdit({
      cwd: dir,
      lintCmd: "node pass.js",
      testCmd: "node fail.js",
    });

    assert.equal(payload.lint!.ok, true, "passing lint must report ok: true");
    assert.ok(payload.lint!.output.includes("lint clean"));
    assert.equal(payload.test!.ok, false, "failing test must report ok: false");
    assert.ok(payload.test!.output.includes("1 test failed"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify_edit surfaces an execution-policy denial as a structured failure", async () => {
  const verifyEdit = captureVerifyEditTool([]);
  const payload = await verifyEdit({ cwd: tmpdir(), testCmd: "forbidden-tool --flag" });

  assert.equal(payload.test!.ok, false, "a policy-denied command must report ok: false");
  assert.ok(
    payload.test!.output.startsWith("execution_policy_denied:"),
    "denial reason should be the payload, verbatim"
  );
});