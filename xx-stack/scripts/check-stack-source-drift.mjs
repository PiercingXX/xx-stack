#!/usr/bin/env node
/**
 * Structural drift check between the two stack sources.
 *
 * `xx-stack/runtime/` and `opencode-orchestration/opencode/` are DELIBERATELY
 * different in content: runtime/ is host-agnostic (no pinned models,
 * `compatibility: host-agnostic`), while opencode/ is the OpenCode-specialized
 * instantiation (pinned `model:` fields, `compatibility: opencode`).
 *
 * They are NOT meant to be identical, so this does not diff file contents.
 * What it does check is that they have not drifted STRUCTURALLY — an agent or
 * skill added to one side and silently forgotten on the other.
 *
 * Exit 0 = structurally aligned. Exit 1 = drift found.
 * Pass --json for machine-readable output.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SOURCES = [
  { name: "xx-stack/runtime", dir: path.join(repoRoot, "xx-stack", "runtime") },
  {
    name: "opencode-orchestration/opencode",
    dir: path.join(repoRoot, "opencode-orchestration", "opencode"),
  },
];

// Entries that legitimately exist on only one side. Each entry is a decision,
// not a shrug — if you add one, say why.
const EXPECTED_ONLY = {
  "xx-stack/runtime": new Set([
    "AUTONOMOUS_TODO_LOOP.md",
    "AUTONOMOUS_TODO_LOOP_PROMPT.md",
    "config.md",
    "runtime-constants.json",
    // Compatibility aliases that map legacy task names onto plan/research.
    // The OpenCode source registers the canonical names directly.
    "planning.md",
    "researcher.md",
    // Minimal runner health probe used by the host-agnostic loop preflight.
    "ping.md",
  ]),
  "opencode-orchestration/opencode": new Set(["package-lock.json", "runtime-constants.json"]),
};

// Two empty sets compare equal, so an emptied tree would otherwise report
// "structurally aligned". Every subdirectory this script compares must contain
// at least this many entries on each side or the run is treated as broken
// input, not as a pass.
const MIN_ENTRIES_PER_SIDE = 1;

function listNames(dir) {
  if (!fs.existsSync(dir)) return null;
  try {
    return new Set(
      fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => !e.name.startsWith("."))
        .map((e) => e.name)
    );
  } catch {
    return null;
  }
}

const findings = [];

function compareSubdir(sub) {
  const [a, b] = SOURCES;
  const aNames = listNames(path.join(a.dir, sub));
  const bNames = listNames(path.join(b.dir, sub));

  if (aNames === null || bNames === null) {
    const missing = aNames === null ? a.name : b.name;
    findings.push({ kind: "missing-dir", where: `${missing}/${sub}`, detail: "directory absent" });
    return;
  }

  for (const [source, names] of [
    [a, aNames],
    [b, bNames],
  ]) {
    if (names.size < MIN_ENTRIES_PER_SIDE) {
      findings.push({
        kind: "empty-dir",
        where: `${source.name}/${sub}`,
        detail: `contains ${names.size} entr(ies); at least ${MIN_ENTRIES_PER_SIDE} expected — an empty set trivially matches, so this is not a pass`,
      });
    }
  }

  for (const name of aNames) {
    if (!bNames.has(name) && !EXPECTED_ONLY[a.name].has(name)) {
      findings.push({ kind: "only-in", where: `${a.name}/${sub}`, detail: name });
    }
  }
  for (const name of bNames) {
    if (!aNames.has(name) && !EXPECTED_ONLY[b.name].has(name)) {
      findings.push({ kind: "only-in", where: `${b.name}/${sub}`, detail: name });
    }
  }
}

compareSubdir("agents");
compareSubdir("skills");

const asJson = process.argv.includes("--json");

if (asJson) {
  console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2));
} else {
  console.log("stack source drift check");
  console.log("");
  console.log(`  ${SOURCES[0].name}  (host-agnostic canonical)`);
  console.log(`  ${SOURCES[1].name}  (OpenCode-specialized)`);
  console.log("");
  if (findings.length === 0) {
    console.log("PASS  agents/ and skills/ are structurally aligned.");
  } else {
    for (const f of findings) {
      if (f.kind === "only-in") {
        console.log(`FAIL  ${f.detail} :: present only in ${f.where}`);
      } else {
        console.log(`FAIL  ${f.where} :: ${f.detail}`);
      }
    }
    console.log("");
    console.log(`${findings.length} structural difference(s).`);
    console.log("Add the missing agent/skill to the other source, or add it to");
    console.log("EXPECTED_ONLY in this script if the asymmetry is intentional.");
  }
}

process.exitCode = findings.length === 0 ? 0 : 1;
