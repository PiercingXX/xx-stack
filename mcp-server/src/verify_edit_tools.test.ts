import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { guardedExecFile } from "./execution_policy.js";
import {
  getVerifyEditScratchDir,
  listFullOutputArtifacts,
  registerVerifyEditTools,
  resetFullOutputArtifacts,
  writeFullOutputArtifact,
} from "./verify_edit_tools.js";

// Artifacts must never land in the repo: pin the scratch base at a temp dir
// for the whole file. (Default is <os tmpdir>/xx-stack-scratch/verify-edit-<pid>.)
process.env.XX_STACK_SCRATCH_DIR = join(tmpdir(), `xx-stack-verify-edit-scratch-${process.pid}`);

/** Same constant as verify_edit_tools.ts — the inline view budget. */
const VIEW_CAP = 4096;

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

test("guardedExecFile captures oversized real output in full", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-verify-edit-"));
  try {
    const bigFile = join(dir, "big.txt");
    const lineCount = 6000;
    const lines: string[] = [];
    for (let i = 0; i < lineCount; i++) {
      lines.push(`line ${i} of oversized output for truncation test`);
    }
    const contents = lines.join("\n") + "\n";
    await writeFile(bigFile, contents);

    const { stdout } = await guardedExecFile(
      "cat",
      [bigFile],
      { timeout: 5000 },
      { context: "hook", allowedHookCommands: ["cat"] }
    );

    assert.ok(stdout.length > VIEW_CAP, `expected output > ${VIEW_CAP}, got ${stdout.length}`);
    assert.equal(stdout, contents, "capture-then-truncate means the gate keeps the full capture");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- scratch artifact ring --------------------------------------------------

test("the artifact ring keeps the newest 8 captures and evicts the oldest", () => {
  resetFullOutputArtifacts();
  try {
    const written: string[] = [];
    for (let i = 0; i < 9; i++) {
      const path = writeFullOutputArtifact("test", `capture ${i}`);
      assert.ok(path, "artifact write should succeed in the scratch dir");
      written.push(path!);
    }

    const held = listFullOutputArtifacts();
    assert.equal(held.length, 8, "the ring holds at most 8 artifacts");
    assert.equal(existsSync(written[0]!), false, "the oldest artifact must be evicted from disk");
    for (const path of written.slice(1)) {
      assert.equal(existsSync(path), true, `newer artifact ${path} must survive`);
    }
    assert.deepEqual(held, written.slice(1), "the ring holds the newest 8, oldest first");
  } finally {
    resetFullOutputArtifacts();
  }
});

test("artifacts live under the per-session scratch dir, never the repo", () => {
  resetFullOutputArtifacts();
  try {
    const path = writeFullOutputArtifact("lint", "scratch-location-probe");
    assert.ok(path);
    assert.ok(
      path!.startsWith(getVerifyEditScratchDir()),
      "artifact path must be inside the session scratch dir"
    );
    assert.ok(
      !path!.includes("/mcp-server/src"),
      "artifacts must never be written into the repo tree"
    );
  } finally {
    resetFullOutputArtifacts();
  }
});

// --- verify_edit closed loop: drive the REGISTERED tool, not the helpers ---

type VerifyEditArgs = {
  cwd: string;
  lintCmd?: string;
  testCmd?: string;
  compactOptions?: { cap?: number; stripAnsi?: boolean; collapseRepeats?: boolean };
};

type CmdResult = {
  ok: boolean;
  outcome: "pass" | "fail" | "could_not_run" | "denied";
  reasonCode?: string;
  remediation?: string;
  output: string;
  truncated: boolean;
  fullOutputPath?: string;
} | null;
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
    registerTool: (...toolArgs: unknown[]) => {
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
    assert.equal(payload.test!.truncated, false, "small output is not truncated");
    assert.equal(payload.test!.fullOutputPath, undefined, "no artifact when nothing was dropped");
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

test("verify_edit returns a head+tail view and keeps the full capture on disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-verify-edit-tool-"));
  resetFullOutputArtifacts();
  try {
    await writeFile(
      join(dir, "fail-big.js"),
      'console.error("HEAD-MARKER");\n' +
        'for (let i = 0; i < 300; i++) console.error("noise line " + i + " " + "x".repeat(40));\n' +
        'console.error("FINAL-TAIL-MARKER");\n' +
        "process.exit(1);\n"
    );

    const verifyEdit = captureVerifyEditTool(["node"]);
    const payload = await verifyEdit({ cwd: dir, testCmd: "node fail-big.js" });

    assert.equal(payload.test!.ok, false);
    assert.equal(payload.test!.truncated, true, "oversized output must be flagged as truncated");
    assert.ok(
      payload.test!.output.length <= VIEW_CAP + 64,
      `view must stay within the cap, got ${payload.test!.output.length}`
    );
    assert.ok(
      payload.test!.output.includes("... [truncated"),
      "the view must carry an explicit truncation marker"
    );
    assert.ok(payload.test!.output.includes("HEAD-MARKER"), "the head must survive truncation");
    assert.ok(
      payload.test!.output.includes("FINAL-TAIL-MARKER"),
      "the failing tail — what a continuation prompt needs — must survive truncation"
    );
    assert.ok(
      !payload.test!.output.includes("noise line 150 "),
      "the middle of the oversized output should be dropped from the view"
    );

    const fullPath = payload.test!.fullOutputPath;
    assert.ok(fullPath, "a truncated result must point at the full capture");
    assert.ok(
      fullPath!.startsWith(getVerifyEditScratchDir()),
      "the artifact must live in the session scratch dir"
    );
    const full = await readFile(fullPath!, "utf8");
    assert.ok(
      full.includes("noise line 150 "),
      "the full capture must contain what the view dropped"
    );
    assert.ok(full.includes("HEAD-MARKER") && full.includes("FINAL-TAIL-MARKER"));
    assert.ok(full.length > payload.test!.output.length, "the capture must exceed the view");
  } finally {
    resetFullOutputArtifacts();
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify_edit reports lint pass and test fail independently in one payload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-verify-edit-tool-"));
  try {
    await writeFile(join(dir, "pass.js"), 'console.log("lint clean");\n');
    await writeFile(join(dir, "fail.js"), 'console.error("1 test failed");\nprocess.exit(1);\n');

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
  resetFullOutputArtifacts();
  try {
    const verifyEdit = captureVerifyEditTool([]);
    const payload = await verifyEdit({ cwd: tmpdir(), testCmd: "forbidden-tool --flag" });

    assert.equal(payload.test!.ok, false, "a policy-denied command must report ok: false");
    assert.ok(
      payload.test!.output.startsWith("execution_policy_denied:"),
      "denial reason should be the payload, verbatim"
    );
    assert.equal(payload.test!.truncated, false, "a denial is not a truncated capture");
    assert.equal(payload.test!.fullOutputPath, undefined, "a denial writes no artifact");
    assert.deepEqual(listFullOutputArtifacts(), [], "a denial must not touch the artifact ring");
  } finally {
    resetFullOutputArtifacts();
  }
});

test("caller-supplied compaction still reports what it dropped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-verify-edit-tool-"));
  resetFullOutputArtifacts();
  try {
    await writeFile(
      join(dir, "repeat.js"),
      'for (let i = 0; i < 12; i++) console.log("identical line");\n'
    );

    const verifyEdit = captureVerifyEditTool(["node"]);
    const payload = await verifyEdit({
      cwd: dir,
      testCmd: "node repeat.js",
      compactOptions: { collapseRepeats: true },
    });

    // 12 copies of "identical line", newline-joined, is 179 bytes.
    const rawBytes = 12 * "identical line".length + 11;
    assert.equal(payload.test!.ok, true);
    assert.ok(payload.test!.output.includes("identical lines collapsed"));
    assert.ok(payload.compacted && payload.compacted.length > 0, "dropped notes must be reported");
    assert.equal(payload.test!.truncated, false, "collapsing is not truncation");
    // `truncated === false` was the only size assertion here, and it is true
    // whether the view shrank or quadrupled. A reported collapse has to be a
    // real saving in BYTES.
    assert.ok(
      payload.test!.output.length < rawBytes,
      `collapsed view must be smaller than the ${rawBytes}-byte capture, got ${payload.test!.output.length}`
    );
  } finally {
    resetFullOutputArtifacts();
    await rm(dir, { recursive: true, force: true });
  }
});

// --- "could not run" is not "failed" ---------------------------------------
//
// xx-stack dispatches to heterogeneous machines, so the lane that got the task
// is exactly the one most likely to be missing the toolchain. Before this
// classification existed, `toResult` mapped every non-zero path to `ok: false`:
// a denied command, a binary that is not installed here, a missing
// `node_modules`, and a genuinely red test suite were byte-indistinguishable,
// and the completion gate read all four as "the code is broken".

test("verify_edit classifies a passing command as pass with ok true", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-verify-outcome-"));
  try {
    await writeFile(join(dir, "ok.js"), 'console.log("all good");\n');
    const verifyEdit = captureVerifyEditTool(["node"]);
    const payload = await verifyEdit({ cwd: dir, testCmd: "node ok.js" });

    assert.equal(payload.test!.outcome, "pass");
    assert.equal(payload.test!.ok, true, "ok must stay derivable from outcome");
    assert.equal(payload.test!.reasonCode, undefined, "a pass needs no cause");
    assert.equal(payload.test!.remediation, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify_edit classifies a non-zero exit with captured output as fail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-verify-outcome-"));
  try {
    await writeFile(join(dir, "red.js"), 'console.error("2 tests failed");\nprocess.exit(1);\n');
    const verifyEdit = captureVerifyEditTool(["node"]);
    const payload = await verifyEdit({ cwd: dir, testCmd: "node red.js" });

    assert.equal(payload.test!.outcome, "fail", "a suite that ran and went red is a code failure");
    assert.equal(payload.test!.ok, false);
    assert.equal(payload.test!.remediation, undefined, "a real failure gets no lane remediation");
    assert.ok(payload.test!.output.includes("2 tests failed"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify_edit classifies a nonexistent binary as could_not_run, not fail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-verify-outcome-"));
  try {
    const missing = "xx-stack-definitely-not-installed";
    const verifyEdit = captureVerifyEditTool([missing]);
    const payload = await verifyEdit({ cwd: dir, testCmd: `${missing} --version` });

    assert.equal(
      payload.test!.outcome,
      "could_not_run",
      "a missing toolchain is a fact about the LANE, not about the code"
    );
    assert.equal(payload.test!.ok, false);
    assert.equal(payload.test!.reasonCode, "command_not_found");
    assert.ok(
      typeof payload.test!.remediation === "string" && payload.test!.remediation.includes(missing),
      "could_not_run must name the fix"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify_edit classifies a denylisted command as denied, machine-readably", async () => {
  const verifyEdit = captureVerifyEditTool([]);
  const payload = await verifyEdit({ cwd: tmpdir(), testCmd: "forbidden-tool --flag" });

  // The whole point: a caller learns this was a policy refusal WITHOUT
  // substring-matching `output` for "execution_policy_denied:".
  assert.equal(payload.test!.outcome, "denied");
  assert.equal(payload.test!.ok, false);
  assert.ok(
    typeof payload.test!.reasonCode === "string" && payload.test!.reasonCode.length > 0,
    "the denial reason must be a structured field"
  );
  assert.ok(
    !payload.test!.reasonCode!.includes("execution_policy_denied"),
    "reasonCode carries the reason, not the wrapper prefix"
  );
  // The verbatim reason is still in the payload for a human reader.
  assert.ok(payload.test!.output.startsWith("execution_policy_denied:"));
});

test("a missing cwd is bad_cwd, not a missing command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-verify-outcome-"));
  const gone = join(dir, "no-such-dir");
  try {
    const verifyEdit = captureVerifyEditTool(["node"]);
    const payload = await verifyEdit({ cwd: gone, testCmd: "node --version" });

    assert.equal(payload.test!.outcome, "could_not_run");
    assert.equal(
      payload.test!.reasonCode,
      "bad_cwd",
      "spawn reports ENOENT for both causes; blaming the binary would send the agent to install node"
    );
    assert.ok(payload.test!.remediation!.includes(gone));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an npm failure with package.json but no node_modules is deps_not_installed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-verify-outcome-"));
  try {
    await writeFile(join(dir, "package.json"), '{"name":"probe","version":"0.0.0"}\n');
    // `npm test` in a project with no install and no test script exits non-zero
    // with output — historically indistinguishable from a red suite.
    const verifyEdit = captureVerifyEditTool(["npm"]);
    const payload = await verifyEdit({ cwd: dir, testCmd: "npm test" });

    assert.equal(payload.test!.outcome, "could_not_run");
    assert.equal(payload.test!.reasonCode, "deps_not_installed");
    assert.ok(payload.test!.remediation!.includes("node_modules"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- D2 through the tool: compaction must not inflate the view -------------
//
// This suite's compaction coverage asserted `truncated === false`, which is
// true of a view four times the size of its capture. Blank-line runs are the
// most common repeated-line pattern in real lint and test output, so this is
// the shape the tool actually meets.

test("caller-supplied collapse never returns more bytes than the capture", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-verify-edit-tool-"));
  resetFullOutputArtifacts();
  try {
    // Exactly "PASS\n\n\n\nPASS\n\n\n\nPASS" — 20 bytes, no trailing newline
    // for `.trim()` to remove. Pre-fix the view came back at 80 bytes with two
    // phantom "collapsed 3 consecutive identical lines" savings reported.
    await writeFile(
      join(dir, "blanks.js"),
      'process.stdout.write("PASS\\n\\n\\n\\nPASS\\n\\n\\n\\nPASS");\n'
    );

    const verifyEdit = captureVerifyEditTool(["node"]);
    const payload = await verifyEdit({
      cwd: dir,
      testCmd: "node blanks.js",
      compactOptions: { collapseRepeats: true },
    });

    assert.equal(payload.test!.ok, true);
    assert.equal(
      payload.test!.output.length,
      20,
      `the view must not exceed the 20-byte capture, got ${payload.test!.output.length}`
    );
    assert.equal(payload.test!.output, "PASS\n\n\n\nPASS\n\n\n\nPASS");
    assert.equal(payload.compacted, undefined, "no saving happened, so none may be reported");
  } finally {
    resetFullOutputArtifacts();
    await rm(dir, { recursive: true, force: true });
  }
});

// --- D3: the returned view is redacted, the on-disk capture is not ---------
//
// MANUAL §5 — secrets are redacted from rendered lines, credential locations
// survive, values never do. It was enforced on supervisor prompts and on the
// review diff but not on verify_edit, whose output is arbitrary lint and
// test-runner stdout and is embedded in continuation prompts that travel to
// other lanes. A failing DB test printing its DSN is the ordinary case.

/** A realistic jest failure with a DSN printed by the failing test. */
const JEST_FAILURE_WITH_DSN = [
  "FAIL  src/db/pool.test.ts",
  "  ● PoolManager › connects with the configured DSN",
  "",
  "    expect(received).toEqual(expected) // deep equality",
  "",
  "    - Expected  - 1",
  "    + Received  + 1",
  "",
  "      Object {",
  '    -   "database": "app_prod",',
  '    +   "database": "app_dev",',
  '        "host": "db.internal",',
  "      }",
  "",
  "      at Object.<anonymous> (src/db/pool.test.ts:42:31)",
  "",
  "    console.error",
  "      connection failed: postgres://user:pw@host/db",
  "",
  "Tests:       1 failed, 12 passed, 13 total",
].join("\n");

test("verify_edit redacts secrets from the view without damaging the failure diff", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-verify-redact-"));
  try {
    await writeFile(
      join(dir, "jest-like.js"),
      `console.error(${JSON.stringify(JEST_FAILURE_WITH_DSN)});\nprocess.exit(1);\n`
    );

    const verifyEdit = captureVerifyEditTool(["node"]);
    const payload = await verifyEdit({ cwd: dir, testCmd: "node jest-like.js" });
    const view = payload.test!.output;

    assert.equal(payload.test!.outcome, "fail");
    assert.ok(!view.includes("user:pw@host"), "the DSN password must not travel");
    assert.ok(
      view.includes("postgres://user:[redacted-secret]@host/db"),
      "the credential LOCATION survives — scheme, user, host — the value does not"
    );

    // The repair-critical half: everything the agent needs to fix the test is
    // byte-intact. Redacting a test failure into uselessness would be its own
    // defect, which is why the raw capture also stays on disk.
    for (const fragment of [
      "● PoolManager › connects with the configured DSN",
      "expect(received).toEqual(expected)",
      '-   "database": "app_prod",',
      '+   "database": "app_dev",',
      "at Object.<anonymous> (src/db/pool.test.ts:42:31)",
      "Tests:       1 failed, 12 passed, 13 total",
    ]) {
      assert.ok(view.includes(fragment), `redaction must not touch: ${fragment}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the on-disk full capture stays raw while the travelling view is redacted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-verify-redact-"));
  resetFullOutputArtifacts();
  try {
    await writeFile(
      join(dir, "big-secret.js"),
      `console.error(${JSON.stringify(JEST_FAILURE_WITH_DSN)});\n` +
        'for (let i = 0; i < 300; i++) console.error("noise " + i + " " + "z".repeat(40));\n' +
        "process.exit(1);\n"
    );

    const verifyEdit = captureVerifyEditTool(["node"]);
    const payload = await verifyEdit({ cwd: dir, testCmd: "node big-secret.js" });

    assert.equal(payload.test!.truncated, true);
    assert.ok(!payload.test!.output.includes("user:pw@host"), "the view never carries the value");

    const fullPath = payload.test!.fullOutputPath!;
    assert.ok(fullPath, "a truncated result must point at the full capture");
    const full = await readFile(fullPath, "utf8");
    assert.ok(
      full.includes("postgres://user:pw@host/db"),
      "the local capture stays raw — it is the same trust level as the working tree, and the agent needs it greppable"
    );
  } finally {
    resetFullOutputArtifacts();
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "the scratch dir and its captures are owner-only on disk",
  { skip: process.platform === "win32" },
  () => {
    // The capture is raw by design, so the predictable world-readable path under
    // os.tmpdir() was the whole exposure: any other user on a shared machine
    // could read the last 8 full captures.
    resetFullOutputArtifacts();
    try {
      const path = writeFullOutputArtifact("lint", "postgres://user:pw@host/db");
      assert.ok(path);

      assert.equal(
        statSync(path!).mode & 0o777,
        0o600,
        "a raw capture must be readable only by its owner"
      );
      assert.equal(
        statSync(getVerifyEditScratchDir()).mode & 0o777,
        0o700,
        "the scratch dir must not be listable by other users"
      );
    } finally {
      resetFullOutputArtifacts();
    }
  }
);

// --- D5: a quoted argument cannot be expressed, and now says so -------------

test("an argv-pattern denial names quoting as the limitation", async () => {
  // `npx jest -t "my test"` splits on whitespace into -t, "my, test" — and the
  // leading quote fails SAFE_HOOK_ARG_PATTERN. The denial was correct and loud
  // but anonymous: the caller got `hook_arg_pattern_blocked` and no hint.
  // goalContract.validationCmd flows through here, so that cost a whole cycle.
  const verifyEdit = captureVerifyEditTool(["node"]);
  const payload = await verifyEdit({ cwd: tmpdir(), testCmd: 'node -t "my test"' });

  assert.equal(payload.test!.outcome, "denied");
  assert.equal(payload.test!.reasonCode, "hook_arg_pattern_blocked");
  assert.ok(
    typeof payload.test!.remediation === "string" && payload.test!.remediation.length > 0,
    "an argv-charset denial must explain itself"
  );
  const remediation = payload.test!.remediation!;
  assert.ok(remediation.includes("quot"), "the remediation must name quoting as the cause");
  assert.ok(
    remediation.includes("no shell"),
    "and must say why — argv-only is deliberate, not a missing feature"
  );
  assert.ok(remediation.includes('"my'), "naming the rejected fragment saves a guess");
});

test("a non-argv denial still carries no remediation", async () => {
  // The remediation is specific to the argv charset. A command the allowlist
  // simply does not carry is a policy judgement, not a caller-side limitation.
  const verifyEdit = captureVerifyEditTool([]);
  const payload = await verifyEdit({ cwd: tmpdir(), testCmd: "forbidden-tool --flag" });

  assert.equal(payload.test!.reasonCode, "hook_command_not_allowlisted");
  assert.equal(payload.test!.remediation, undefined);
});

test("ok is exactly outcome === pass on every path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-verify-outcome-"));
  try {
    await writeFile(join(dir, "ok.js"), 'console.log("fine");\n');
    await writeFile(join(dir, "red.js"), "process.exit(3);\n");
    const verifyEdit = captureVerifyEditTool(["node"]);
    const payload = await verifyEdit({ cwd: dir, lintCmd: "node ok.js", testCmd: "node red.js" });

    for (const result of [payload.lint!, payload.test!]) {
      assert.equal(result.ok, result.outcome === "pass", "ok must never disagree with outcome");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
