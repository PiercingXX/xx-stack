import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRepoMap } from "./repo_map_runtime.js";

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
