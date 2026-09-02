#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the component being verified, NOT where this script physically lives.
// Components share one canonical copy of this script via a symlinked scripts/
// directory, so import.meta.url always points into xx-stack/ and cannot be used
// to identify the caller. Walk up from an explicit argument, then the working
// directory, looking for a component root (a directory holding a stack source
// dir plus packs/).
const LAYOUTS = [{ sourceDir: "runtime" }, { sourceDir: "opencode" }];

function detectLayout(dir) {
  return LAYOUTS.find(
    (l) => fs.existsSync(path.join(dir, l.sourceDir)) && fs.existsSync(path.join(dir, "packs"))
  );
}

function findComponentRoot(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (detectLayout(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const startFrom = process.argv[2] ?? process.cwd();
const repoRoot =
  findComponentRoot(startFrom) ??
  findComponentRoot(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));

if (!repoRoot) {
  console.error(
    `xx-stack layout verification: no component root found from ${startFrom}.\n` +
      `Expected an ancestor directory containing one of ` +
      `${LAYOUTS.map((l) => `${l.sourceDir}/`).join(", ")} alongside packs/.`
  );
  process.exit(2);
}

const checks = [];

function addCheck(name, ok, detail) {
  checks.push({ name, ok, detail });
}

function existsAt(relPath) {
  return fs.existsSync(path.join(repoRoot, relPath));
}

function checkDir(relPath) {
  const abs = path.join(repoRoot, relPath);
  const ok = fs.existsSync(abs) && fs.statSync(abs).isDirectory();
  addCheck(`Directory ${relPath}`, ok, ok ? "present" : "missing");
}

function checkFile(relPath) {
  const abs = path.join(repoRoot, relPath);
  const ok = fs.existsSync(abs) && fs.statSync(abs).isFile();
  addCheck(`File ${relPath}`, ok, ok ? "present" : "missing");
}

function checkSymlink(relPath, expectedTarget) {
  const abs = path.join(repoRoot, relPath);
  const expectedAbs = path.join(repoRoot, expectedTarget);

  if (!fs.existsSync(abs)) {
    addCheck(`Symlink ${relPath}`, false, "missing");
    return;
  }

  const st = fs.lstatSync(abs);
  if (!st.isSymbolicLink()) {
    addCheck(`Symlink ${relPath}`, false, "path exists but is not a symlink");
    return;
  }

  const linkTarget = fs.readlinkSync(abs);
  const resolved = path.resolve(path.dirname(abs), linkTarget);
  const ok = resolved === expectedAbs;
  const detail = ok
    ? `points to ${expectedTarget}`
    : `points to ${path.relative(repoRoot, resolved)} (expected ${expectedTarget})`;
  addCheck(`Symlink ${relPath}`, ok, detail);
}

function checkExecutable(relPath) {
  const abs = path.join(repoRoot, relPath);
  if (!fs.existsSync(abs)) {
    addCheck(`Executable ${relPath}`, false, "missing");
    return;
  }

  const mode = fs.statSync(abs).mode;
  const ok = Boolean(mode & 0o111);
  addCheck(`Executable ${relPath}`, ok, ok ? "executable bit set" : "not executable");
}

// Components differ in which directory holds the canonical stack source:
//
//   xx-stack/                 runtime/
//   opencode-orchestration/   opencode/
//
const { sourceDir } = detectLayout(repoRoot);

checkDir(sourceDir);
if (sourceDir === "opencode") {
  checkDir("opencode/command");
  for (const command of [
    "review.md",
    "plan.md",
    "debug.md",
    "ship.md",
    "explore.md",
    "route.md",
    "judge.md",
  ]) {
    checkFile(`opencode/command/${command}`);
  }
}
checkDir("mcp-server");
checkDir("evals");
checkDir("scripts");
checkDir("hooks");
checkDir("packs/design");
checkDir("packs/design/design-systems");
checkDir("packs/design/design-skills");
checkDir("packs/design/workflow-skills");
checkDir("packs/design/craft");
checkDir("packs/design/licenses");
checkDir("packs/design/evals/golden-tasks");

checkFile("README.md");
checkFile("REPO-LAYERS.md");
checkFile(".xxignore");
checkFile("packs/design/DESIGN-CATALOG.md");
checkFile("packs/design/scripts/generate-design-catalog.mjs");
checkFile("packs/design/scripts/evaluate-golden-tasks.mjs");
checkFile("packs/design/scripts/quality-gate-html.mjs");

// craft/ and licenses/ are vendored subtrees. A directory check alone would not
// catch a rulebook or a license text being deleted or renamed — which is the
// failure mode this gate exists for, and the reason an unmapped directory is
// worse than no directory. Each file is named so the layout gate has to notice.
// Rulebook slugs are also the `od.craft.requires` vocabulary; renaming one here
// silently breaks every skill that binds to it.
for (const rulebook of [
  "accessibility-baseline",
  "animation-discipline",
  "anti-ai-slop",
  "color",
  "form-validation",
  "laws-of-ux",
  "rtl-and-bidi",
  "state-coverage",
  "typography",
  "typography-hierarchy",
  "typography-hierarchy-editorial",
]) {
  checkFile(`packs/design/craft/${rulebook}.md`);
}

checkFile("packs/design/craft/README.md");
checkFile("packs/design/craft/FUTURE_SECTIONS.md");
checkFile("packs/design/craft/XX-STACK-NOTES.md");
checkFile("packs/design/craft/anti-ai-slop-rules.json");
checkFile("packs/design/craft/design-intent.md");

for (const license of [
  "bergside-awesome-design-skills-MIT",
  "google-labs-code-design-md-Apache-2.0",
  "google-labs-code-stitch-skills-Apache-2.0",
  "nexu-io-open-design-Apache-2.0",
  "referodesign-refero_skill-MIT",
  "voltagent-awesome-design-md-MIT",
]) {
  checkFile(`packs/design/licenses/${license}.txt`);
}

checkSymlink("design-systems", "packs/design/design-systems");
checkSymlink("design-skills", "packs/design/design-skills");
checkSymlink("DESIGN-CATALOG.md", "packs/design/DESIGN-CATALOG.md");
checkSymlink(`${sourceDir}/skills/design`, "packs/design/workflow-skills");
checkSymlink("evals/golden-tasks", "packs/design/evals/golden-tasks");

checkExecutable("setup-opencode.sh");
checkExecutable("hooks/examples/pre-tool-policy.sh");
checkExecutable("hooks/examples/post-tool-verify.sh");

function checkAbsent(relPath) {
  const present = existsAt(relPath);
  addCheck(
    `Absent ${relPath}`,
    !present,
    present ? "must not exist (VS Code product surface was removed)" : "removed"
  );
}
checkAbsent("adapters");
checkAbsent("vscode");
checkAbsent("setup-vscode.sh");
checkAbsent(".vscode");

// Check for dot-alias duplicates in design-systems (e.g. foo.bar alongside foo-bar)
(function checkDesignSystemDuplicates() {
  const absDir = path.join(repoRoot, "packs/design/design-systems");
  if (!fs.existsSync(absDir)) return;
  const slugs = fs
    .readdirSync(absDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const normalize = (s) => s.toLowerCase().replace(/[._]/g, "-");
  const seen = new Map();
  for (const slug of slugs) {
    const key = normalize(slug);
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(slug);
  }
  for (const [key, variants] of seen.entries()) {
    if (variants.length > 1) {
      addCheck(
        `No duplicate design-system slug (${key})`,
        false,
        `conflicting dirs: ${variants.join(", ")} — remove dotted aliases and keep only the dashed canonical slug`
      );
    }
  }
})();

const total = checks.length;
const failed = checks.filter((c) => !c.ok);

console.log(`xx-stack layout verification — ${path.basename(repoRoot)}/ (${sourceDir}/)`);
console.log("");
for (const c of checks) {
  const status = c.ok ? "PASS" : "FAIL";
  console.log(`${status.padEnd(5)} ${c.name} :: ${c.detail}`);
}

console.log("");
console.log(`Summary: ${total - failed.length}/${total} checks passed`);

if (failed.length > 0) {
  process.exitCode = 1;
}
