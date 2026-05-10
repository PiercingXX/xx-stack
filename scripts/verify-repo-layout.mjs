#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

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
  addCheck(`Directory ${relPath}`, ok, ok ? 'present' : 'missing');
}

function checkFile(relPath) {
  const abs = path.join(repoRoot, relPath);
  const ok = fs.existsSync(abs) && fs.statSync(abs).isFile();
  addCheck(`File ${relPath}`, ok, ok ? 'present' : 'missing');
}

function checkSymlink(relPath, expectedTarget) {
  const abs = path.join(repoRoot, relPath);
  const expectedAbs = path.join(repoRoot, expectedTarget);

  if (!fs.existsSync(abs)) {
    addCheck(`Symlink ${relPath}`, false, 'missing');
    return;
  }

  const st = fs.lstatSync(abs);
  if (!st.isSymbolicLink()) {
    addCheck(`Symlink ${relPath}`, false, 'path exists but is not a symlink');
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
    addCheck(`Executable ${relPath}`, false, 'missing');
    return;
  }

  const mode = fs.statSync(abs).mode;
  const ok = Boolean(mode & 0o111);
  addCheck(`Executable ${relPath}`, ok, ok ? 'executable bit set' : 'not executable');
}

checkDir('runtime');
checkDir('adapters');
checkDir('mcp-server');
checkDir('evals');
checkDir('scripts');
checkDir('hooks');
checkDir('packs/design');
checkDir('packs/design/design-systems');
checkDir('packs/design/design-skills');
checkDir('packs/design/runtime/skills/design');
checkDir('packs/design/evals/golden-tasks');

checkFile('README.md');
checkFile('REPO-LAYERS.md');
checkFile('.xxignore');
checkFile('packs/design/DESIGN-CATALOG.md');
checkFile('packs/design/scripts/generate-design-catalog.mjs');
checkFile('packs/design/scripts/evaluate-golden-tasks.mjs');
checkFile('packs/design/scripts/quality-gate-html.mjs');

checkSymlink('design-systems', 'packs/design/design-systems');
checkSymlink('design-skills', 'packs/design/design-skills');
checkSymlink('DESIGN-CATALOG.md', 'packs/design/DESIGN-CATALOG.md');
checkSymlink('runtime/skills/design', 'packs/design/runtime/skills/design');
checkSymlink('evals/golden-tasks', 'packs/design/evals/golden-tasks');

checkExecutable('setup-vscode.sh');
checkExecutable('setup-opencode.sh');
checkExecutable('hooks/examples/pre-tool-policy.sh');
checkExecutable('hooks/examples/post-tool-verify.sh');

// Check for dot-alias duplicates in design-systems (e.g. foo.bar alongside foo-bar)
(function checkDesignSystemDuplicates() {
  const absDir = path.join(repoRoot, 'packs/design/design-systems');
  if (!fs.existsSync(absDir)) return;
  const slugs = fs.readdirSync(absDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const normalize = (s) => s.toLowerCase().replace(/[._]/g, '-');
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
        `conflicting dirs: ${variants.join(', ')} — remove dotted aliases and keep only the dashed canonical slug`,
      );
    }
  }
})()

const total = checks.length;
const failed = checks.filter((c) => !c.ok);

console.log('xx-stack layout verification');
console.log('');
for (const c of checks) {
  const status = c.ok ? 'PASS' : 'FAIL';
  console.log(`${status.padEnd(5)} ${c.name} :: ${c.detail}`);
}

console.log('');
console.log(`Summary: ${total - failed.length}/${total} checks passed`);

if (failed.length > 0) {
  process.exitCode = 1;
}
