import test from "node:test";
import assert from "node:assert/strict";
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
