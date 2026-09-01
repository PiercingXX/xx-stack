import test from "node:test";
import assert from "node:assert/strict";
import { basename, dirname, join, resolve } from "node:path";

import {
  ALLOW_ANY_CWD_ENV,
  confineCwdToLaunchDir,
  envFlagEnabled,
  isPathWithinRoot,
} from "./agent_tool_helpers.js";

// ---------------------------------------------------------------------------
// The path-confinement primitives underpinning the memory tools and
// build_repo_map: lexical containment, the shared flag parser, and the cwd
// boundary against the server launch directory.
// ---------------------------------------------------------------------------

/** Save/delete/set/restore around a body so one test cannot leak into another. */
function withEnv(name: string, value: string | undefined, body: () => void): void {
  const saved = process.env[name];
  try {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    body();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

test("envFlagEnabled mirrors the XX_STACK_ALLOW_CLOUD opt-in parsing", () => {
  withEnv("XX_TEST_FLAG", undefined, () => {
    assert.equal(envFlagEnabled("XX_TEST_FLAG"), false, "unset means off");
  });
  withEnv("XX_TEST_FLAG", "1", () => {
    assert.equal(envFlagEnabled("XX_TEST_FLAG"), true);
  });
  withEnv("XX_TEST_FLAG", "true", () => {
    assert.equal(envFlagEnabled("XX_TEST_FLAG"), true);
  });
  withEnv("XX_TEST_FLAG", "TRUE", () => {
    assert.equal(envFlagEnabled("XX_TEST_FLAG"), true, "the check is case-insensitive");
  });
  for (const off of ["0", "false", "yes", "", "on"]) {
    withEnv("XX_TEST_FLAG", off, () => {
      assert.equal(envFlagEnabled("XX_TEST_FLAG"), false, `"${off}" must not enable the flag`);
    });
  }
});

test("isPathWithinRoot is lexical containment, not a string prefix", () => {
  const root = resolve("/launch/dir");
  assert.equal(isPathWithinRoot("/launch/dir", root), true, "the root itself is inside");
  assert.equal(isPathWithinRoot("/launch/dir/src/app.ts", root), true);
  assert.equal(isPathWithinRoot("/launch/dir/..", root), false, "traversal escapes");
  assert.equal(
    isPathWithinRoot("/launch/dir-evil/x", root),
    false,
    "a sibling sharing the prefix is not inside"
  );
  assert.equal(isPathWithinRoot("/etc/passwd", root), false);
});

test("confineCwdToLaunchDir admits relative paths and launch-dir descendants", () => {
  withEnv(ALLOW_ANY_CWD_ENV, undefined, () => {
    const relative = confineCwdToLaunchDir("./src");
    assert.ok(relative.ok);
    assert.equal(relative.ok && relative.cwd, resolve(process.cwd(), "src"));

    const inside = confineCwdToLaunchDir(join(process.cwd(), "some", "repo"));
    assert.deepEqual(inside, { ok: true, cwd: join(process.cwd(), "some", "repo") });

    const exact = confineCwdToLaunchDir(process.cwd());
    assert.ok(exact.ok, "the launch directory itself is admissible");
  });
});

test("confineCwdToLaunchDir rejects escaping cwds with a structured verdict", () => {
  withEnv(ALLOW_ANY_CWD_ENV, undefined, () => {
    const outside = tmpOutsideLaunchDir();
    const verdict = confineCwdToLaunchDir(outside);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.equal(verdict.reasonCode, "cwd_out_of_bounds");
      assert.equal(verdict.cwd, resolve(outside));
      assert.equal(verdict.boundaryRoot, process.cwd());
      assert.equal(verdict.envOptOut, ALLOW_ANY_CWD_ENV);
    }

    const traversal = confineCwdToLaunchDir(join(process.cwd(), "..", "elsewhere"));
    assert.equal(traversal.ok, false, "a `..` escape must not pass");

    const sibling = confineCwdToLaunchDir(
      resolve(dirname(process.cwd()), `${basename(process.cwd())}-evil`)
    );
    assert.equal(sibling.ok, false, "a sibling directory sharing the name prefix must not pass");
  });
});

test("XX_STACK_ALLOW_ANY_CWD=1 lifts the boundary", () => {
  withEnv(ALLOW_ANY_CWD_ENV, undefined, () => {
    assert.equal(confineCwdToLaunchDir("/anywhere/at/all").ok, false);
  });
  for (const value of ["1", "true"]) {
    withEnv(ALLOW_ANY_CWD_ENV, value, () => {
      const verdict = confineCwdToLaunchDir("/anywhere/at/all");
      assert.deepEqual(
        verdict,
        { ok: true, cwd: "/anywhere/at/all" },
        `opt-out "${value}" admits it`
      );
    });
  }
});

/** A path guaranteed outside the launch directory without touching the disk. */
function tmpOutsideLaunchDir(): string {
  const launch = process.cwd();
  const parent = dirname(launch);
  // For a root launch directory nothing is outside; irrelevant for this suite
  // but kept total so the helper never lies.
  return parent === launch
    ? `${launch}outside-boundary-check`
    : join(parent, "outside-boundary-check");
}
