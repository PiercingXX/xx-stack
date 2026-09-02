#!/usr/bin/env node
/**
 * Drift check between the two stack sources.
 *
 * `runtime/` and `opencode-orchestration/opencode/` are DELIBERATELY
 * different in a small, enumerable set of ways: runtime/ is host-agnostic (no
 * pinned models, `compatibility: host-agnostic`), while opencode/ is the
 * OpenCode-specialized instantiation (pinned `model:` fields,
 * `compatibility: opencode`, OpenCode permission syntax, opencode/ paths).
 *
 * This script runs two checks:
 *
 *   names   — an agent or skill added to one side and forgotten on the other.
 *   content — the file bodies differ by anything OTHER than the deliberate
 *             deltas below. This is the check that was missing for a long
 *             time; every content-drift defect in MANUAL §11 passed the name
 *             check untouched (an agent mirror short ~120 lines of behavioral
 *             guardrails, a runbook short ~90 lines documenting shipped code).
 *
 * Deliberate deltas normalized before diffing (MANUAL §2):
 *   1. the `compatibility:` frontmatter line
 *   2. `model:` pins
 *   3. `runtime/` -> `opencode/` path rewrites
 *   4. `skill: allow` -> `skill: {"*": allow}`
 *   5. the `description:` frontmatter line, but ONLY on files where the mirror
 *      carries a `model:` pin the canonical side does not. This is a de facto
 *      fifth delta and a direct consequence of delta 2: a pinned lane describes
 *      itself by the lane it pins ("using the sglang-backed ... alias") where
 *      the host-agnostic side says "uses the caller's current host model".
 *      Every description divergence in the tree today coincides with a model
 *      pin. It is waived rather than ignored, and the waiver is scoped three
 *      ways: the pair is PRINTED as a NOTE on every run; a description that
 *      diverges on an UNPINNED file is a failure; and the first
 *      DESCRIPTION_ROLE_WORDS words must still match on both sides, so the
 *      waiver covers the lane wording at the tail of the sentence and not a
 *      wholesale rewrite of what the agent is. See KNOWN_DELTAS for the handful
 *      of other prose divergences, each of which must match exactly to be
 *      waived.
 *
 * Exit 0 = aligned. Exit 1 = drift found.
 *   --names-only / --content-only   run one check
 *   --json                          machine-readable output
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SOURCES = [
  { name: "runtime", dir: path.join(repoRoot, "runtime") },
  {
    name: "opencode-orchestration/opencode",
    dir: path.join(repoRoot, "opencode-orchestration", "opencode"),
  },
];

// Entries that legitimately exist on only one side. Each entry is a decision,
// not a shrug — if you add one, say why.
const EXPECTED_ONLY = {
  runtime: new Set([
    "AUTONOMOUS_TODO_LOOP.md",
    "AUTONOMOUS_TODO_LOOP_PROMPT.md",
    "config.md",
    "runtime-constants.json",
  ]),
  "opencode-orchestration/opencode": new Set(["package-lock.json", "runtime-constants.json"]),
};

// Two empty sets compare equal, so an emptied tree would otherwise report
// "structurally aligned". Every subdirectory this script compares must contain
// at least this many entries on each side or the run is treated as broken
// input, not as a pass.
const MIN_ENTRIES_PER_SIDE = 1;

/**
 * Mirror pairs the content check reads. `minFiles` is the vacuous-pass floor:
 * an emptied or unreadable subtree compares equal to nothing and would
 * otherwise report PASS, so each pair declares how many file pairs it must
 * find. Raise these when the surface grows; never lower them to make a run go
 * green.
 */
const CONTENT_PAIRS = [
  {
    label: "agents",
    canonicalDir: "runtime/agents",
    mirrorDir: "opencode-orchestration/opencode/agents",
    match: (name) => name.endsWith(".md"),
    minFiles: 18,
    // Canonical-only agents (see EXPECTED_ONLY above).
    skip: EXPECTED_ONLY["runtime"],
  },
  {
    label: "skills",
    canonicalDir: "runtime/skills",
    mirrorDir: "opencode-orchestration/opencode/skills",
    match: (name) => name.endsWith(".md"),
    minFiles: 29,
    skip: new Set(),
  },
];

/**
 * Top-level prose documents that are true mirrors of each other. Only files
 * listed here are content-gated; see NOT_CONTENT_GATED for the ones that are
 * deliberately not, and why.
 */
const CONTENT_FILES = [
  "COMPLETION_CONTRACT_TEMPLATE.md",
  "SUPERVISOR_COMPLETION_LOOP_RUNBOOK.md",
  "TELEMETRY-POLICY.md",
];

/**
 * Top-level documents present on both sides that are NOT content-gated. These
 * are host-specific rewrites, not mirrors — gating them would mean either a
 * permanent failure or a normalizer so loose it stops catching anything. Each
 * entry is a decision; if one of these ever becomes a true mirror, move it into
 * CONTENT_FILES.
 */
const NOT_CONTENT_GATED = new Map([
  ["SKILLS.md", "OpenCode index is an independently condensed rewrite, not a mirror."],
  ["FILE-STRUCTURE.md", "Describes each component's own on-disk layout; they differ by design."],
  [
    "shared_instructions.md",
    "Host preamble: the canonical side carries host-agnostic model strategy the OpenCode side deliberately omits.",
  ],
  ["config.json", "Per-host agent registration and permissions."],
  ["platforms.json", "Generated registry; gated by `npm run inventory:check`."],
  ["platforms.schema.json", "Schema travels with its generated registry."],
  [
    "model-recommendations.json",
    "Canonical matches on providers, mirror on VRAM (MANUAL §11 CONTENT-6).",
  ],
  ["telemetry.json", "Host telemetry sink configuration."],
]);

/**
 * Path vocabulary. Both sides are rewritten to the same placeholder so a
 * mirror line may spell the shared source dir either way (the nano mirrors are
 * byte-identical copies by design — see check-nano-tiers.mjs — and cite
 * `runtime/...` paths verbatim). The lookbehind keeps `~/.config/opencode/`
 * and `.opencode/` out of it: those are real runtime paths, not the repo's
 * source dir, and must still compare literally.
 */
const SOURCE_TOKEN = "<<source>>/";
const MIRROR_TOKEN = "<<mirror>>/";
const PATH_ALIASES = [
  { re: /(?<![\w./-])xx-stack\/runtime\//g, to: SOURCE_TOKEN },
  { re: /(?<![\w./-])runtime\//g, to: SOURCE_TOKEN },
  { re: /(?<![\w./-])opencode\//g, to: SOURCE_TOKEN },
  { re: /(?<![\w./-])adapters\//g, to: MIRROR_TOKEN },
  { re: /(?<![\w./-])vscode\//g, to: MIRROR_TOKEN },
];

/**
 * Prose divergences that are deliberate and must match EXACTLY to be waived.
 * This is the escape hatch that keeps the normalizer honest: widening a regex
 * to swallow one of these would also swallow real drift, which is precisely the
 * bug this check exists to catch. `file` is the canonical-side path, or "*" for
 * a divergence that recurs across a surface. Text is compared AFTER
 * normalization, so repo path prefixes appear as `<<source>>/` and
 * `<<mirror>>/`.
 *
 * `open: true` marks a divergence that has NOT been adjudicated — it is waived
 * so the gate is usable, but it is printed as OPEN on every run instead of
 * being silently absorbed. Resolve it or downgrade it; do not let it rot.
 */
const KNOWN_DELTAS = [
  {
    file: "runtime/skills/research-deep/SKILL.md",
    why: "Cross-component citation: the runbook ships only on the canonical side, so the mirror carries the `xx-stack/` prefix, which re-wraps the paragraph.",
    canonical: [" `<<source>>/READER-SERVICE-RUNBOOK.md`): it returns LLM-friendly markdown."],
    mirror: [" `<<source>>/READER-SERVICE-RUNBOOK.md`): it returns LLM-friendly", "  markdown."],
  },
  {
    file: "runtime/skills/review-code/SKILL.md",
    why: "Host file conventions: AGENTS.md and `.opencode/` are OpenCode surfaces with no host-agnostic equivalent.",
    canonical: ["- file-consistency review across README.md and .xx-stack docs/prompts"],
    mirror: ["- file-consistency review across README, AGENTS.md, and .opencode docs/prompts"],
  },
  {
    file: "runtime/agents/parallel-execution-orchestrator.md",
    why: "Delta 2 in the body: the OpenCode lane pins a local llama.cpp model, so it also names it as a deterministic fallback. The host-agnostic side must not name any local model.",
    canonical: [],
    mirror: ["- `llama-cpp-local/qwen3-coder:30b-a3b-tq2_0`"],
  },
  {
    file: "runtime/TELEMETRY-POLICY.md",
    why: "The OpenCode install has a workspace-level `.opencode/` compatibility shim the host-agnostic side has no equivalent for.",
    canonical: ["- Config file: `<<source>>/telemetry.json`"],
    mirror: [
      "- Config file: `<<source>>/telemetry.json` in the repo, with `.opencode/telemetry.json` only as a workspace compatibility shim",
    ],
  },
  // The one `open: true` entry this list carried — the design-system-pick
  // prompts disagreeing about `ollama` / `opencode` — was adjudicated rather
  // than waived. `git log --follow -p` showed d458c02 edited both copies in the
 / same commit: it removed `` from both (that was the de-branding) and
  // added `ollama`/`opencode` to the OpenCode copy only. The xx-stack copy was
  // simply missed, so it was a rotted list, not a deliberate omission — and
  // since both components resolve `packs/design` to the same directory, there
  // was no per-component brand subset to justify the divergence. Both copies now
  // list the pack's real slugs (`opencode-ai`, plus four other ids that never
  // resolved), so there is nothing left to waive.
];

/** The content check must compare at least this many file pairs in total. */
const MIN_CONTENT_FILE_PAIRS = 48;

const findings = [];
const notes = [];

function fail(kind, where, detail, extra = {}) {
  findings.push({ kind, where, detail, ...extra });
}

// ---------------------------------------------------------------- name check

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

function compareSubdir(sub) {
  const [a, b] = SOURCES;
  const aNames = listNames(path.join(a.dir, sub));
  const bNames = listNames(path.join(b.dir, sub));

  if (aNames === null || bNames === null) {
    const missing = aNames === null ? a.name : b.name;
    fail("missing-dir", `${missing}/${sub}`, "directory absent");
    return;
  }

  for (const [source, names] of [
    [a, aNames],
    [b, bNames],
  ]) {
    if (names.size < MIN_ENTRIES_PER_SIDE) {
      fail(
        "empty-dir",
        `${source.name}/${sub}`,
        `contains ${names.size} entr(ies); at least ${MIN_ENTRIES_PER_SIDE} expected — an empty set trivially matches, so this is not a pass`
      );
    }
  }

  for (const name of aNames) {
    if (!bNames.has(name) && !EXPECTED_ONLY[a.name].has(name)) {
      fail("only-in", `${a.name}/${sub}`, name);
    }
  }
  for (const name of bNames) {
    if (!aNames.has(name) && !EXPECTED_ONLY[b.name].has(name)) {
      fail("only-in", `${b.name}/${sub}`, name);
    }
  }
}

function runNameCheck() {
  compareSubdir("agents");
  compareSubdir("skills");
}

// ------------------------------------------------------------- content check

function collapseSpaces(line) {
  return line.replace(/[ \t]{2,}/g, " ").trimEnd();
}

function rewritePaths(line) {
  let out = line;
  for (const alias of PATH_ALIASES) {
    out = out.replace(alias.re, alias.to);
  }
  // A rewrite changes token length, which breaks hand-aligned ASCII columns
  // ("runtime/skills/design/    <- shim" vs "opencode/skills/design/   <- shim").
  // Collapse whitespace runs only on lines the rewrite actually touched, so the
  // leniency cannot spread to untouched content.
  return out === line ? line : collapseSpaces(out);
}

/**
 * Normalize one side of a mirror pair into comparable lines, recording which
 * deliberate deltas were applied so the diff stage can reason about them.
 */
function normalize(text) {
  // Delta 4: OpenCode's nested permission syntax for the same grant.
  const collapsed = text.replace(
    /^([ \t]*)skill:\n[ \t]+"\*":[ \t]*allow[ \t]*$/gm,
    "$1skill: allow"
  );

  const lines = [];
  let hasModelPin = false;
  for (const raw of collapsed.split("\n")) {
    if (/^compatibility:\s/.test(raw)) continue; // delta 1
    if (/^model:\s/.test(raw)) {
      hasModelPin = true; // delta 2
      continue;
    }
    lines.push(rewritePaths(raw));
  }

  // Trailing blank lines carry no meaning in markdown and are not drift.
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();

  return { lines, hasModelPin };
}

/** Longest-common-subsequence diff over normalized lines. */
function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: "=", a: i, b: j });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ op: "-", a: i, b: j });
      i += 1;
    } else {
      ops.push({ op: "+", a: i, b: j });
      j += 1;
    }
  }
  while (i < n) ops.push({ op: "-", a: i++, b: j });
  while (j < m) ops.push({ op: "+", a: i, b: j++ });

  // Group consecutive non-equal ops into hunks.
  const hunks = [];
  let current = null;
  for (const op of ops) {
    if (op.op === "=") {
      if (current) hunks.push(current);
      current = null;
      continue;
    }
    if (!current) {
      current = { canonicalLine: op.a + 1, mirrorLine: op.b + 1, canonical: [], mirror: [] };
    }
    if (op.op === "-") current.canonical.push(a[op.a]);
    else current.mirror.push(b[op.b]);
  }
  if (current) hunks.push(current);
  return hunks;
}

function sameBlock(actual, expected) {
  return actual.length === expected.length && actual.every((line, idx) => line === expected[idx]);
}

function matchKnownDelta(hunk, canonicalRel) {
  return KNOWN_DELTAS.find(
    (entry) =>
      (entry.file === "*" || entry.file === canonicalRel) &&
      sameBlock(hunk.canonical, entry.canonical) &&
      sameBlock(hunk.mirror, entry.mirror)
  );
}

/**
 * How much of a description both sides must still agree on. The waiver covers
 * the lane wording at the TAIL of the sentence ("...using the caller's current
 * host model" vs "...using the sglang-backed alias"); it must not cover a
 * wholesale rewrite. Requiring the leading words to match keeps the agent's
 * role identity gated while the pinned-lane tail is free.
 */
const DESCRIPTION_ROLE_WORDS = 3;

function roleWords(descriptionLine) {
  return descriptionLine
    .replace(/^description:\s*/, "")
    .replace(/^["']|["']$/g, "")
    .split(/\s+/)
    .slice(0, DESCRIPTION_ROLE_WORDS)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase())
    .join(" ");
}

function isDescriptionWaiver(hunk, mirrorHasModelPin) {
  return (
    mirrorHasModelPin &&
    hunk.canonical.length === 1 &&
    hunk.mirror.length === 1 &&
    /^description:\s/.test(hunk.canonical[0]) &&
    /^description:\s/.test(hunk.mirror[0]) &&
    roleWords(hunk.canonical[0]) === roleWords(hunk.mirror[0])
  );
}

function clip(line, max = 160) {
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function renderHunk(hunk, maxLines = 6) {
  const out = [];
  const push = (prefix, lines) => {
    for (const line of lines.slice(0, maxLines)) out.push(`      ${prefix} ${clip(line)}`);
    if (lines.length > maxLines) {
      out.push(`      ${prefix} … ${lines.length - maxLines} more line(s)`);
    }
  };
  push("-", hunk.canonical);
  push("+", hunk.mirror);
  return out;
}

function compareFilePair(canonicalRel, mirrorRel) {
  const canonicalText = fs.readFileSync(path.join(repoRoot, canonicalRel), "utf8");
  const mirrorText = fs.readFileSync(path.join(repoRoot, mirrorRel), "utf8");

  const canonical = normalize(canonicalText);
  const mirror = normalize(mirrorText);

  for (const hunk of diffLines(canonical.lines, mirror.lines)) {
    if (isDescriptionWaiver(hunk, mirror.hasModelPin && !canonical.hasModelPin)) {
      notes.push({
        kind: "pinned-description",
        where: `${canonicalRel} ↔ ${mirrorRel}`,
        canonical: hunk.canonical[0],
        mirror: hunk.mirror[0],
      });
      continue;
    }

    const known = matchKnownDelta(hunk, canonicalRel);
    if (known) {
      notes.push({
        kind: "known-delta",
        open: Boolean(known.open),
        where: `${canonicalRel} ↔ ${mirrorRel}`,
        canonical: hunk.canonical.join(" / "),
        mirror: hunk.mirror.join(" / "),
        why: known.why,
      });
      continue;
    }

    fail("content", `${canonicalRel} ↔ ${mirrorRel}`, "content drift", {
      canonicalLine: hunk.canonicalLine,
      mirrorLine: hunk.mirrorLine,
      canonical: hunk.canonical,
      mirror: hunk.mirror,
    });
  }
}

/** Files under `dir`, relative to it, skipping dotfiles and symlinked dirs. */
function walkFiles(dir, match, prefix = "") {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    // Symlinked skill dirs (runtime/skills/design -> packs/design/workflow-skills)
    // are the SAME files on both sides; walking them compares a tree to itself.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) out.push(...walkFiles(path.join(dir, entry.name), match, rel));
    else if (entry.isFile() && match(entry.name)) out.push(rel);
  }
  return out;
}

function runContentCheck() {
  let comparedPairs = 0;

  for (const pair of CONTENT_PAIRS) {
    const canonicalAbs = path.join(repoRoot, pair.canonicalDir);
    const mirrorAbs = path.join(repoRoot, pair.mirrorDir);

    if (!fs.existsSync(canonicalAbs) || !fs.existsSync(mirrorAbs)) {
      fail(
        "missing-dir",
        !fs.existsSync(canonicalAbs) ? pair.canonicalDir : pair.mirrorDir,
        "directory absent; cannot compare content"
      );
      continue;
    }

    const canonicalFiles = walkFiles(canonicalAbs, pair.match).filter(
      (rel) => !pair.skip.has(path.basename(rel))
    );
    const mirrorFiles = new Set(walkFiles(mirrorAbs, pair.match));

    for (const rel of canonicalFiles) {
      if (!mirrorFiles.has(rel)) {
        fail(
          "missing-file",
          `${pair.mirrorDir}/${rel}`,
          `no mirror for ${pair.canonicalDir}/${rel}`
        );
        continue;
      }
      compareFilePair(`${pair.canonicalDir}/${rel}`, `${pair.mirrorDir}/${rel}`);
      comparedPairs += 1;
    }

    for (const rel of mirrorFiles) {
      if (!canonicalFiles.includes(rel) && !pair.skip.has(path.basename(rel))) {
        fail(
          "orphan-file",
          `${pair.mirrorDir}/${rel}`,
          `no canonical source at ${pair.canonicalDir}/${rel}`
        );
      }
    }

    // Vacuous-pass floor, per pair: an emptied subtree matches nothing and
    // would otherwise report PASS.
    if (canonicalFiles.length < pair.minFiles) {
      fail(
        "too-few-files",
        pair.canonicalDir,
        `found ${canonicalFiles.length} comparable file(s); at least ${pair.minFiles} expected — refusing to report a content pass on a shrunken tree`
      );
    }
  }

  // Every top-level document that exists on BOTH sides must be classified:
  // either content-gated or explicitly excluded with a reason. Without this,
  // adding a new mirrored runbook silently escapes the content check — the
  // exact failure mode this script exists to close.
  for (const entry of fs.readdirSync(SOURCES[0].dir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    const mirrorPath = path.join(SOURCES[1].dir, entry.name);
    if (!fs.existsSync(mirrorPath) || fs.lstatSync(mirrorPath).isSymbolicLink()) continue;
    if (CONTENT_FILES.includes(entry.name) || NOT_CONTENT_GATED.has(entry.name)) continue;
    fail(
      "unclassified-file",
      `${SOURCES[0].name}/${entry.name}`,
      "exists on both sides but is neither in CONTENT_FILES nor NOT_CONTENT_GATED — classify it (gate it, or exclude it with a reason)"
    );
  }

  for (const name of CONTENT_FILES) {
    const canonicalRel = `${path.relative(repoRoot, SOURCES[0].dir)}/${name}`.replace(/\\/g, "/");
    const mirrorRel = `${path.relative(repoRoot, SOURCES[1].dir)}/${name}`.replace(/\\/g, "/");
    if (!fs.existsSync(path.join(repoRoot, canonicalRel))) {
      fail("missing-file", canonicalRel, "content-gated document is absent");
      continue;
    }
    if (!fs.existsSync(path.join(repoRoot, mirrorRel))) {
      fail("missing-file", mirrorRel, `no mirror for ${canonicalRel}`);
      continue;
    }
    compareFilePair(canonicalRel, mirrorRel);
    comparedPairs += 1;
  }

  if (comparedPairs < MIN_CONTENT_FILE_PAIRS) {
    fail(
      "too-few-pairs",
      "content check",
      `compared ${comparedPairs} file pair(s); at least ${MIN_CONTENT_FILE_PAIRS} expected — an empty comparison is not a pass`
    );
  }

  return comparedPairs;
}

// ----------------------------------------------------------------- execution

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const namesOnly = argv.includes("--names-only");
const contentOnly = argv.includes("--content-only");

if (!contentOnly) runNameCheck();
const comparedPairs = namesOnly ? 0 : runContentCheck();

if (asJson) {
  console.log(
    JSON.stringify({ ok: findings.length === 0, comparedPairs, findings, notes }, null, 2)
  );
} else {
  console.log("stack source drift check");
  console.log("");
  console.log(`  ${SOURCES[0].name}  (host-agnostic canonical)`);
  console.log(`  ${SOURCES[1].name}  (OpenCode-specialized)`);
  console.log("");

  const pinned = notes.filter((n) => n.kind === "pinned-description");
  const knownDeltas = notes.filter((n) => n.kind === "known-delta");

  for (const finding of findings) {
    if (finding.kind === "only-in") {
      console.log(`FAIL  ${finding.detail} :: present only in ${finding.where}`);
    } else if (finding.kind === "content") {
      console.log(
        `FAIL  ${finding.where} :: content drift at canonical line ${finding.canonicalLine}, mirror line ${finding.mirrorLine}`
      );
      for (const line of renderHunk(finding)) console.log(line);
    } else {
      console.log(`FAIL  ${finding.where} :: ${finding.detail}`);
    }
  }

  if (findings.length > 0) console.log("");

  if (!namesOnly) {
    console.log(`Content: compared ${comparedPairs} mirrored file pair(s).`);
    console.log(
      `  ${pinned.length} pinned-lane description(s) waived, ${knownDeltas.length} known prose delta(s) waived.`
    );
    for (const note of pinned) {
      console.log(`  NOTE  ${note.where}`);
      console.log(`        - ${clip(note.canonical, 120)}`);
      console.log(`        + ${clip(note.mirror, 120)}`);
    }
    for (const note of knownDeltas.filter((n) => n.open)) {
      console.log(`  OPEN  ${note.where}`);
      console.log(`        - ${clip(note.canonical, 120)}`);
      console.log(`        + ${clip(note.mirror, 120)}`);
      console.log(`        ${clip(note.why, 300)}`);
    }
    console.log("");
  }

  if (findings.length === 0) {
    console.log(
      namesOnly
        ? "PASS  agents/ and skills/ are structurally aligned."
        : "PASS  names aligned; mirrored content differs only by the deliberate deltas."
    );
  } else {
    console.log(`${findings.length} difference(s).`);
    console.log("Names: add the missing agent/skill to the other source, or add it to");
    console.log("EXPECTED_ONLY in this script if the asymmetry is intentional.");
    console.log("Content: canonical wins — resync the mirror. Only add a KNOWN_DELTAS entry");
    console.log("if the divergence is deliberate, and say why.");
  }
}

process.exitCode = findings.length === 0 ? 0 : 1;
