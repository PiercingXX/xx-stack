import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildRepoMap,
  BINARY_SNIFF_BYTES,
  MAX_FILE_BYTES,
  OMISSION_EXAMPLE_LIMIT,
} from "./repo_map_runtime.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTempRepo(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "repo-map-test-"));
  try {
    // Init a git repo so git timestamps work
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: dir, stdio: "ignore" });
    execSync('git config user.email "test@test"', { cwd: dir, stdio: "ignore" });
    execSync('git config user.name "Test"', { cwd: dir, stdio: "ignore" });
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeAndCommit(root: string, relPath: string, content: string): Promise<void> {
  const fullPath = join(root, relPath);
  // Ensure parent directory exists
  const parent = fullPath.split("/").slice(0, -1).join("/");
  await mkdir(parent, { recursive: true });
  await writeFile(fullPath, content, "utf8");
  const { execSync } = await import("node:child_process");
  execSync(`git add "${relPath}"`, { cwd: root, stdio: "ignore" });
  execSync(`git commit -m "add ${relPath}"`, { cwd: root, stdio: "ignore" });
}

// ---------------------------------------------------------------------------
// Budget truncation
// ---------------------------------------------------------------------------

test("buildRepoMap respects token budget", async () => {
  await withTempRepo(async (root) => {
    // Create 5 files of roughly 200 chars each (~50 tokens each)
    for (let i = 0; i < 5; i++) {
      const content =
        `// file ${i}\nconst x${i} = ${i};\nexport function fn${i}() { return ${i}; }\n`.repeat(10);
      await writeAndCommit(root, `src/file${i}.ts`, content);
    }

    const result = await buildRepoMap({ root, tokenBudget: 80 });
    assert.ok(result.files.length > 0, "should return at least one file");
    assert.ok(result.files.length < 5, "should truncate before including all files");
    assert.ok(
      result.tokensEstimated <= 80,
      `tokensEstimated ${result.tokensEstimated} should be within budget of 80`
    );
    assert.equal(result.method, "heuristic");
  });
});

// ---------------------------------------------------------------------------
// Ignore-file filtering
// ---------------------------------------------------------------------------

test("buildRepoMap respects .xxignore patterns", async () => {
  await withTempRepo(async (root) => {
    // Create .xxignore that excludes node_modules
    await writeAndCommit(root, ".xxignore", "node_modules/\n");
    // Create a tracked file
    await writeAndCommit(root, "src/index.ts", "export const a = 1;\n");
    // Create an ignored file
    await mkdir(join(root, "node_modules"), { recursive: true });
    await writeFile(join(root, "node_modules/ignored.ts"), "should be ignored\n");

    const result = await buildRepoMap({ root, tokenBudget: 8000 });
    const paths = result.files.map((f) => f.path);
    assert.ok(paths.includes("src/index.ts"), "should include tracked file");
    assert.ok(
      !paths.some((p) => p.startsWith("node_modules/")),
      "should exclude node_modules files"
    );
  });
});

test("buildRepoMap respects .gitignore patterns", async () => {
  await withTempRepo(async (root) => {
    await writeAndCommit(root, ".gitignore", "dist/\n");
    await writeAndCommit(root, "src/index.ts", "export const a = 1;\n");
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist/bundle.js"), "bundled content\n");

    const result = await buildRepoMap({ root, tokenBudget: 8000 });
    const paths = result.files.map((f) => f.path);
    assert.ok(paths.includes("src/index.ts"), "should include tracked file");
    assert.ok(!paths.some((p) => p.startsWith("dist/")), "should exclude dist files");
  });
});

// ---------------------------------------------------------------------------
// Focus reordering
// ---------------------------------------------------------------------------

test("focusPaths reorders results toward the focus", async () => {
  await withTempRepo(async (root) => {
    // Create files in different directories
    await writeAndCommit(root, "lib/util.ts", "export function util() { return 1; }\n");
    await writeAndCommit(root, "src/app.ts", "export function app() { return 2; }\n");
    await writeAndCommit(root, "src/routes.ts", "export function routes() { return 3; }\n");
    await writeAndCommit(root, "tests/test.ts", "import { app } from '../src/app';\n");

    // Without focus, all files are roughly equal — but with focus on src/,
    // files under src/ should rank higher than tests/
    const result = await buildRepoMap({
      root,
      tokenBudget: 8000,
      focusPaths: ["src"],
    });

    const srcIndex = result.files.findIndex((f) => f.path.startsWith("src/"));
    const testIndex = result.files.findIndex((f) => f.path.startsWith("tests/"));

    assert.ok(srcIndex >= 0, "should include src files");
    assert.ok(testIndex >= 0, "should include test files");
    assert.ok(
      srcIndex < testIndex,
      `src file (index ${srcIndex}) should rank higher than test file (index ${testIndex})`
    );
  });
});

// ---------------------------------------------------------------------------
// Empty repo
// ---------------------------------------------------------------------------

test("buildRepoMap returns empty result for empty repo", async () => {
  await withTempRepo(async (root) => {
    const result = await buildRepoMap({ root, tokenBudget: 8000 });
    assert.deepEqual(result.files, []);
    assert.equal(result.tokensEstimated, 0);
    assert.equal(result.method, "heuristic");
  });
});

// ---------------------------------------------------------------------------
// Non-existent root
// ---------------------------------------------------------------------------

test("buildRepoMap throws for non-existent root", async () => {
  await assert.rejects(() => buildRepoMap({ root: "/nonexistent/path" }), /Repo root not found/);
});

// ---------------------------------------------------------------------------
// Acceptance test: runs against the real repo root
// ---------------------------------------------------------------------------

test("acceptance: buildRepoMap on real repo root returns under 2 seconds", async () => {
  // The real repo root is the xx-stack directory itself
  const repoRoot = new URL("..", import.meta.url).pathname;

  const start = performance.now();
  const result = await buildRepoMap({ root: repoRoot, tokenBudget: 4000 });
  const elapsed = performance.now() - start;

  assert.ok(elapsed < 2000, `buildRepoMap took ${elapsed}ms, expected < 2000ms`);
  assert.ok(result.files.length > 0, "should return files from the real repo");
  assert.equal(result.method, "heuristic");
  assert.ok(result.tokensEstimated > 0, "should have non-zero token estimate");
  assert.ok(
    result.tokensEstimated <= 4000,
    `tokensEstimated ${result.tokensEstimated} should be within budget of 4000`
  );
});

test("acceptance: focusPaths measurably reorders results on real repo", async () => {
  const repoRoot = new URL("..", import.meta.url).pathname;

  // Run without focus first
  const resultNoFocus = await buildRepoMap({ root: repoRoot, tokenBudget: 4000 });
  const noFocusOrder = resultNoFocus.files.map((f) => f.path);

  // Run with focus on a specific subdirectory
  const resultFocus = await buildRepoMap({
    root: repoRoot,
    tokenBudget: 4000,
    focusPaths: ["src"],
  });
  const focusOrder = resultFocus.files.map((f) => f.path);

  // Find a file under src/ in both results
  const srcFileNoFocus = noFocusOrder.findIndex((p) => p.startsWith("src/"));
  const srcFileFocus = focusOrder.findIndex((p) => p.startsWith("src/"));

  assert.ok(srcFileNoFocus >= 0, "should have src/ files in unfocused result");
  assert.ok(srcFileFocus >= 0, "should have src/ files in focused result");

  // The src/ file should be earlier (higher ranked) in the focused result
  // than in the unfocused result
  assert.ok(
    srcFileFocus <= srcFileNoFocus,
    `src file ranked at ${srcFileFocus} with focus vs ${srcFileNoFocus} without focus`
  );
});

// ---------------------------------------------------------------------------
// MCP-14: getGitTimestamp interpolated a repo-controlled filename into an
// execSync shell string. A tracked file named with a quote or `$( )` executed
// arbitrary shell during a repo map.
// ---------------------------------------------------------------------------

test("a hostile tracked filename cannot execute shell during a repo map", async () => {
  await withTempRepo(async (root) => {
    const marker = join(root, "PWNED");
    // Every one of these is a legal POSIX filename and a shell metacharacter
    // soup. The first one survives the old `-- "<rel>"` quoting (command
    // substitution runs inside double quotes) and creates PWNED in cwd=root.
    const hostileNames = [
      "evil$(touch PWNED).ts",
      'quote".ts',
      "semi;colon.ts",
      "back`tick`.ts",
      "amp&and.ts",
      "pipe|d.ts",
    ];

    for (const name of hostileNames) {
      await writeFile(join(root, name), "export const x = 1;\n", "utf8");
    }
    await writeFile(join(root, "ordinary.ts"), "export const y = 2;\n", "utf8");

    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "hostile filenames"], { cwd: root, stdio: "ignore" });

    const result = await buildRepoMap({ root, tokenBudget: 4000 });

    assert.equal(existsSync(marker), false, "a repo-controlled filename must never reach a shell");
    // The map still works: hostile names are ordinary files, not skipped.
    const mapped = new Set(result.files.map((f) => f.path));
    assert.ok(mapped.has("ordinary.ts"));
    for (const name of hostileNames) {
      assert.ok(mapped.has(name), `${name} should still appear in the repo map`);
    }
  });
});

// ---------------------------------------------------------------------------
// `git ls-files` applies C quoting to any path containing a double quote, a
// backslash, or a non-ASCII byte — `quote".ts` came back as `"quote\".ts"`,
// a string naming no real file. Every such path was then dropped from the map
// with nothing reported. `-z` with NUL splitting closes it.
// ---------------------------------------------------------------------------

test("filenames git would C-quote are still discovered, not silently dropped", async () => {
  await withTempRepo(async (root) => {
    const quotedNames = [
      'quote".ts', // literal double quote
      "back\\slash.ts", // literal backslash
      "café.ts", // non-ASCII, Latin-1 range
      "日本語.ts", // non-ASCII, multi-byte
      "emoji-🚀.ts", // non-ASCII, astral plane
      "tab\tchar.ts", // control character
    ];

    for (const name of quotedNames) {
      await writeFile(join(root, name), "export const x = 1;\n", "utf8");
    }
    await writeFile(join(root, "plain.ts"), "export const y = 2;\n", "utf8");

    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "quotable filenames"], { cwd: root, stdio: "ignore" });

    // Prove the premise: git really does quote these on the default output.
    const quotedListing = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
    assert.ok(
      quotedListing.includes('\\"') || quotedListing.includes("\\3"),
      "fixture must actually trigger git's C quoting"
    );

    const result = await buildRepoMap({ root, tokenBudget: 8000 });
    const mapped = new Set(result.files.map((f) => f.path));

    assert.ok(mapped.has("plain.ts"), "the ordinary file is the control");
    for (const name of quotedNames) {
      assert.ok(mapped.has(name), `${name} must appear in the repo map, not be quoted away`);
    }
  });
});

test("git timestamps still rank a recently touched file above an older one", async () => {
  await withTempRepo(async (root) => {
    await writeAndCommit(root, "old.ts", "export const old = 1;\n");
    await new Promise((r) => setTimeout(r, 1100));
    await writeAndCommit(root, "new.ts", "export const fresh = 1;\n");

    const result = await buildRepoMap({ root, tokenBudget: 4000 });
    const byPath = new Map(result.files.map((f) => [f.path, f.score]));
    assert.ok(byPath.has("old.ts") && byPath.has("new.ts"));
    assert.ok(
      byPath.get("new.ts")! >= byPath.get("old.ts")!,
      "argv-style git log must still produce a usable recency signal"
    );
  });
});

// ---------------------------------------------------------------------------
// Shared helper for the fixtures below, which stage many files at once.
// ---------------------------------------------------------------------------

async function commitAll(root: string, message: string): Promise<void> {
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", message], { cwd: root, stdio: "ignore" });
}

// ---------------------------------------------------------------------------
// D2: every path from `git ls-files` went straight into
// `readFileSync(fullPath, "utf8")` with no `stat` and no binary sniff. On a
// 2-file repo holding a 20 MB random binary the measured result was:
//
//     files returned: ["main.ts","blob.bin"]     RSS 77 MB -> 131 MB
//
// The blob was not merely read — it was ranked, selected, and returned as code
// context, so an agent asking for a repo map received random bytes presented
// as source.
// ---------------------------------------------------------------------------

test("a random binary is never returned as code context", async () => {
  await withTempRepo(async (root) => {
    await writeFile(join(root, "main.ts"), "export const main = 1;\n", "utf8");
    await writeFile(join(root, "blob.bin"), randomBytes(20 * 1024 * 1024));
    await commitAll(root, "binary blob");

    const result = await buildRepoMap({ root, tokenBudget: 8000 });
    const paths = result.files.map((f) => f.path);

    assert.deepEqual(paths, ["main.ts"], "the binary must not be presented as source");
    // At 20 MB the size cap fires before the sniff ever runs, which is the
    // point: the guard that protects the process is the one in front of the
    // read. The sniff's own job is the next test.
    assert.equal(result.omissions.oversized.count, 1);
    assert.deepEqual(result.omissions.oversized.examples, ["blob.bin"]);
    assert.equal(result.omissions.binary.count, 0);
  });
});

test("the binary sniff reads a bounded prefix, matching git's 8000-byte rule", async () => {
  await withTempRepo(async (root) => {
    // NUL inside the sniff window: binary, same verdict as `git diff`.
    const early = Buffer.alloc(BINARY_SNIFF_BYTES + 100, 0x61);
    early[BINARY_SNIFF_BYTES - 1] = 0x00;
    await writeFile(join(root, "early-nul.txt"), early);

    // NUL past the sniff window: git calls this text, and so do we. This is
    // the assertion that proves the guard is a prefix sniff and not a full
    // scan of the file.
    const late = Buffer.alloc(BINARY_SNIFF_BYTES + 100, 0x61);
    late[BINARY_SNIFF_BYTES + 50] = 0x00;
    await writeFile(join(root, "late-nul.txt"), late);

    await writeFile(join(root, "main.ts"), "export const main = 1;\n", "utf8");
    await commitAll(root, "nul placement");

    const result = await buildRepoMap({ root, tokenBudget: 8000 });
    const paths = new Set(result.files.map((f) => f.path));

    assert.equal(paths.has("early-nul.txt"), false, "NUL within 8000 bytes is binary");
    assert.deepEqual(result.omissions.binary.examples, ["early-nul.txt"]);
    assert.ok(paths.has("late-nul.txt"), "NUL past 8000 bytes is text, as git has it");
  });
});

test("a file over the size cap is excluded before it is read", async () => {
  await withTempRepo(async (root) => {
    // Over the cap, pure ASCII so nothing but the size guard can reject it,
    // and line-broken so that before the fix its head really was returned as
    // the budget-remainder entry rather than being skipped by accident.
    const line = "a".repeat(79) + "\n";
    const huge = line.repeat(Math.ceil((MAX_FILE_BYTES + 1) / line.length));
    assert.ok(Buffer.byteLength(huge) > MAX_FILE_BYTES, "fixture must exceed the cap");
    await writeFile(join(root, "huge.txt"), huge, "utf8");
    await writeFile(join(root, "main.ts"), "export const main = 1;\n", "utf8");
    await commitAll(root, "oversized");

    const result = await buildRepoMap({ root, tokenBudget: 8000 });
    const paths = result.files.map((f) => f.path);

    assert.deepEqual(paths, ["main.ts"]);
    assert.equal(result.omissions.oversized.count, 1);
    assert.deepEqual(result.omissions.oversized.examples, ["huge.txt"]);
  });
});

test("a file just under the size cap is still read", async () => {
  await withTempRepo(async (root) => {
    // Boundary guard in the other direction: the cap must never cost the
    // caller real code. This file is one byte under it and is read normally;
    // only the token budget decides how much of it comes back.
    const line = "// x\n";
    const body = line.repeat(Math.floor((MAX_FILE_BYTES - 1) / line.length));
    assert.ok(Buffer.byteLength(body) <= MAX_FILE_BYTES - 1, "fixture must sit under the cap");
    await writeFile(join(root, "big.ts"), body, "utf8");
    await commitAll(root, "under cap");

    const result = await buildRepoMap({ root, tokenBudget: 8000 });
    assert.deepEqual(
      result.files.map((f) => f.path),
      ["big.ts"],
      "a file under the cap is read, and here comes back as the truncated head"
    );
    assert.equal(result.omissions.oversized.count, 0);
    assert.deepEqual(result.omissions.truncated.examples, ["big.ts"]);
  });
});

// ---------------------------------------------------------------------------
// D3: `loadIgnorePatterns` pushed `!keep.log` verbatim as a POSITIVE pattern
// and `isIgnored` had no negation handling and no last-match-wins ordering.
// Because we re-applied `.gitignore` on top of git's already-correct output, a
// file git deliberately re-included was re-excluded by our second pass:
//
//     .gitignore = "*.log\n!keep.log"
//     git ls-files --exclude-standard  -> [.gitignore, keep.log, main.ts]
//     build_repo_map                   -> [.gitignore, main.ts]
//
// keep.log was gone, and nothing said so.
// ---------------------------------------------------------------------------

test("a file .gitignore re-includes with ! is not re-excluded by the repo map", async () => {
  await withTempRepo(async (root) => {
    await writeFile(join(root, ".gitignore"), "*.log\n!keep.log\n", "utf8");
    await writeFile(join(root, "keep.log"), "keep me\n", "utf8");
    await writeFile(join(root, "drop.log"), "drop me\n", "utf8");
    await writeFile(join(root, "main.ts"), "export const main = 1;\n", "utf8");
    await commitAll(root, "negated gitignore");

    // Prove the premise: git itself re-includes keep.log and excludes drop.log.
    const { execFileSync } = await import("node:child_process");
    const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
      .sort();
    assert.deepEqual(listed, [".gitignore", "keep.log", "main.ts"]);

    const result = await buildRepoMap({ root, tokenBudget: 8000 });
    const paths = new Set(result.files.map((f) => f.path));

    assert.ok(paths.has("keep.log"), "git re-included keep.log; we must not take it back out");
    assert.ok(paths.has("main.ts"));
    assert.equal(paths.has("drop.log"), false, "drop.log was never in git's output");
    assert.equal(result.omissions.ignored.count, 0, "nothing here is ours to ignore");
  });
});

test(".xxignore honours ! negation, with no git safety net behind it", async () => {
  await withTempRepo(async (root) => {
    // git knows nothing about .xxignore, so this matcher is the only thing
    // standing between `!README.md` and a silently missing file.
    await writeFile(join(root, ".xxignore"), "*.md\n!README.md\n", "utf8");
    await writeFile(join(root, "README.md"), "# readme\n", "utf8");
    await writeFile(join(root, "NOTES.md"), "# notes\n", "utf8");
    await writeFile(join(root, "main.ts"), "export const main = 1;\n", "utf8");
    await commitAll(root, "negated xxignore");

    const result = await buildRepoMap({ root, tokenBudget: 8000 });
    const paths = new Set(result.files.map((f) => f.path));

    assert.ok(paths.has("README.md"), "!README.md must re-include it");
    assert.ok(paths.has("main.ts"));
    assert.equal(paths.has("NOTES.md"), false);
    assert.deepEqual(result.omissions.ignored.examples, ["NOTES.md"]);
  });
});

test("ignore rules resolve last-match-wins in both directions", async () => {
  await withTempRepo(async (root) => {
    // Exclude, re-include, exclude again — the third line must win over the
    // second for the one file it names, and only that file.
    await writeFile(join(root, ".xxignore"), "*.md\n!docs/*.md\ndocs/secret.md\n", "utf8");
    await writeFile(join(root, "top.md"), "top\n", "utf8");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs/keep.md"), "keep\n", "utf8");
    await writeFile(join(root, "docs/secret.md"), "secret\n", "utf8");
    await writeFile(join(root, "main.ts"), "export const main = 1;\n", "utf8");
    await commitAll(root, "layered rules");

    const result = await buildRepoMap({ root, tokenBudget: 8000 });
    const paths = new Set(result.files.map((f) => f.path));

    assert.ok(paths.has("docs/keep.md"), "re-included by the later negation");
    assert.ok(paths.has("main.ts"));
    assert.equal(paths.has("top.md"), false, "never re-included");
    assert.equal(paths.has("docs/secret.md"), false, "re-excluded by the last rule");
    assert.deepEqual(result.omissions.ignored.examples, ["docs/secret.md", "top.md"]);
  });
});

test("character classes and mid-pattern ** are honoured in ignore rules", async () => {
  await withTempRepo(async (root) => {
    await writeFile(join(root, ".xxignore"), "*.[oa]\nsrc/**/gen.ts\n", "utf8");
    await writeFile(join(root, "obj.o"), "o\n", "utf8");
    await writeFile(join(root, "lib.a"), "a\n", "utf8");
    await writeFile(join(root, "keep.c"), "int main(void){return 0;}\n", "utf8");
    await mkdir(join(root, "src/deep/nest"), { recursive: true });
    await writeFile(join(root, "src/gen.ts"), "export const gen = 0;\n", "utf8");
    await writeFile(join(root, "src/deep/nest/gen.ts"), "export const gen = 1;\n", "utf8");
    await writeFile(join(root, "src/keep.ts"), "export const keep = 1;\n", "utf8");
    await commitAll(root, "classes and globstars");

    const result = await buildRepoMap({ root, tokenBudget: 8000 });
    const paths = new Set(result.files.map((f) => f.path));

    assert.equal(paths.has("obj.o"), false, "[oa] class");
    assert.equal(paths.has("lib.a"), false, "[oa] class");
    assert.ok(paths.has("keep.c"), "outside the class");
    assert.equal(paths.has("src/gen.ts"), false, "mid-pattern ** matches zero segments");
    assert.equal(paths.has("src/deep/nest/gen.ts"), false, "mid-pattern ** matches many");
    assert.ok(paths.has("src/keep.ts"));
  });
});

test("a bare directory name in .xxignore excludes everything beneath it", async () => {
  await withTempRepo(async (root) => {
    // `vendor` with no trailing slash: the old basename-only matcher compared
    // it against `lib.ts` and let the whole tree through.
    await writeFile(join(root, ".xxignore"), "vendor\n", "utf8");
    await mkdir(join(root, "vendor/sub"), { recursive: true });
    await writeFile(join(root, "vendor/lib.ts"), "export const v = 1;\n", "utf8");
    await writeFile(join(root, "vendor/sub/deep.ts"), "export const d = 1;\n", "utf8");
    await writeFile(join(root, "main.ts"), "export const main = 1;\n", "utf8");
    await commitAll(root, "bare dir name");

    const result = await buildRepoMap({ root, tokenBudget: 8000 });
    const paths = new Set(result.files.map((f) => f.path));

    assert.ok(paths.has("main.ts"));
    assert.equal(paths.has("vendor/lib.ts"), false);
    assert.equal(paths.has("vendor/sub/deep.ts"), false);
    assert.deepEqual(result.omissions.ignored.examples, ["vendor/lib.ts", "vendor/sub/deep.ts"]);
  });
});

// ---------------------------------------------------------------------------
// D-report: `repo_map_runtime.ts` had a bare `catch { continue; }` and reported
// nothing, which is why two separate causes of "files missing from the map"
// both shipped invisibly. `output_compaction.ts` already states the contract
// this now meets: never drop anything without saying so.
// ---------------------------------------------------------------------------

test("omissions report an unreadable path rather than dropping it in silence", async () => {
  await withTempRepo(async (root) => {
    const { symlink } = await import("node:fs/promises");
    // git tracks a dangling symlink; `statSync` on it throws ENOENT. Before
    // the fix this hit `catch { continue; }` and left no trace anywhere.
    await symlink("nowhere-at-all", join(root, "dangling.ts"));
    await writeFile(join(root, "main.ts"), "export const main = 1;\n", "utf8");
    await commitAll(root, "dangling symlink");

    const result = await buildRepoMap({ root, tokenBudget: 8000 });

    assert.deepEqual(
      result.files.map((f) => f.path),
      ["main.ts"]
    );
    assert.equal(result.omissions.unreadable.count, 1);
    assert.deepEqual(result.omissions.unreadable.examples, ["dangling.ts"]);
  });
});

test("omissions report an empty file rather than dropping it in silence", async () => {
  await withTempRepo(async (root) => {
    await writeFile(join(root, "blank.ts"), "", "utf8");
    await writeFile(join(root, "main.ts"), "export const main = 1;\n", "utf8");
    await commitAll(root, "empty file");

    const result = await buildRepoMap({ root, tokenBudget: 8000 });

    assert.deepEqual(
      result.files.map((f) => f.path),
      ["main.ts"]
    );
    assert.equal(result.omissions.empty.count, 1);
    assert.deepEqual(result.omissions.empty.examples, ["blank.ts"]);
  });
});

test("omissions report files dropped for budget, and the head-truncated file", async () => {
  await withTempRepo(async (root) => {
    for (let i = 0; i < 5; i++) {
      const content =
        `// file ${i}\nconst x${i} = ${i};\nexport function fn${i}() { return ${i}; }\n`.repeat(10);
      await writeAndCommit(root, `src/file${i}.ts`, content);
    }

    const result = await buildRepoMap({ root, tokenBudget: 80 });
    const returned = new Set(result.files.map((f) => f.path));
    const { droppedForBudget, truncated } = result.omissions;

    assert.ok(result.files.length < 5, "premise: the budget must actually bite");
    assert.ok(droppedForBudget.count > 0, "the files that did not fit must be named");
    // Every discovered file is either returned or accounted for as dropped.
    assert.equal(returned.size + droppedForBudget.count, 5);
    for (const path of droppedForBudget.examples) {
      assert.equal(returned.has(path), false, `${path} is reported dropped but was returned`);
    }
    // The head-truncated entry is in `files` AND in `truncated`: `ranges` alone
    // cannot tell the caller how much of the file is missing.
    for (const path of truncated.examples) {
      assert.ok(returned.has(path));
    }
  });
});

test("omission examples are bounded and deterministic", async () => {
  await withTempRepo(async (root) => {
    await writeFile(join(root, ".xxignore"), "junk/\n", "utf8");
    await mkdir(join(root, "junk"), { recursive: true });
    const names: string[] = [];
    for (let i = 0; i < 25; i++) {
      const name = `junk/f${String(i).padStart(2, "0")}.ts`;
      names.push(name);
      await writeFile(join(root, name), `export const n${i} = ${i};\n`, "utf8");
    }
    await writeFile(join(root, "main.ts"), "export const main = 1;\n", "utf8");
    await commitAll(root, "many ignored");

    const first = await buildRepoMap({ root, tokenBudget: 8000 });
    const second = await buildRepoMap({ root, tokenBudget: 8000 });

    assert.equal(first.omissions.ignored.count, 25, "the count is never truncated");
    assert.equal(first.omissions.ignored.examples.length, OMISSION_EXAMPLE_LIMIT);
    assert.deepEqual(
      first.omissions.ignored.examples,
      names.sort().slice(0, OMISSION_EXAMPLE_LIMIT),
      "the sample is the lexicographically first N, not whatever discovery emitted first"
    );
    assert.deepEqual(first.omissions.ignored.examples, second.omissions.ignored.examples);
    assert.equal(first.omissions.considered, 27, ".xxignore + main.ts + 25 junk files");
  });
});

test("an empty repo still reports the shape of what it considered", async () => {
  await withTempRepo(async (root) => {
    const result = await buildRepoMap({ root, tokenBudget: 8000 });
    assert.deepEqual(result.files, []);
    assert.equal(result.omissions.considered, 0);
    assert.deepEqual(result.omissions.ignored, { count: 0, examples: [] });
    assert.deepEqual(result.omissions.binary, { count: 0, examples: [] });
    assert.deepEqual(result.omissions.oversized, { count: 0, examples: [] });
    assert.deepEqual(result.omissions.unreadable, { count: 0, examples: [] });
    assert.deepEqual(result.omissions.empty, { count: 0, examples: [] });
    assert.deepEqual(result.omissions.droppedForBudget, { count: 0, examples: [] });
    assert.deepEqual(result.omissions.truncated, { count: 0, examples: [] });
  });
});
