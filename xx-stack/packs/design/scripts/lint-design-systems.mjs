#!/usr/bin/env node
/**
 * Design-system lint gate.
 *
 * Reads every `packs/design/design-systems/<slug>/DESIGN.md` and checks three
 * things: that its colour tokens can be parsed at all, that the text/surface
 * pair the file's OWN PROSE tells an agent to use clears WCAG AA, and that its
 * section order matches one of the two schemas this pack actually ships.
 *
 * Authored in this repository. MIT (repo root LICENSE). Zero dependencies.
 *
 *   node xx-stack/packs/design/scripts/lint-design-systems.mjs
 *   node xx-stack/packs/design/scripts/lint-design-systems.mjs --self-test
 *   node xx-stack/packs/design/scripts/lint-design-systems.mjs --report
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT google-labs-code/design.md's LINTER
 *
 * That package was evaluated and rejected as a dependency, not overlooked.
 * It requires YAML front matter; 136 of our 137 files have none, so it returns
 * NO_YAML_FOUND on 136/137 and cannot parse the corpus at all. Only two of its
 * rules transfer conceptually (contrast on declared pairs, canonical section
 * order) and both are reimplemented here against the shape our files have.
 *
 * Its CANONICAL_ORDER is also deliberately NOT adopted: applied to this corpus
 * it flags 79 of 137 files, every one of them for the same systematic lineage
 * difference (`Components` before `Layout`). That is divergence between two
 * upstream generations, not a defect, and a gate that fires on it is noise.
 *
 * ---------------------------------------------------------------------------
 * WHY CONTRAST IS CHECKED ONLY ON DECLARED PAIRS  (measured — do not re-derive)
 *
 * Google's rule works because `components.<x>.{backgroundColor,textColor}` is
 * an explicit declared pair. We have no components map, so the pairing has to
 * come from the prose, and only from the prose.
 *
 * The obvious alternative — bucket tokens into text-role and surface-role by
 * their H3 heading and cross-produce them — WAS MEASURED ON THIS CORPUS and
 * must not be shipped: 3114 pairs, 1633 of them below AA, i.e. **52.4% false
 * positives**. The cause is structural, not fixable by tuning: a dark-mode
 * system legitimately holds light text tokens AND light surface tokens that
 * are never paired with each other, and nothing in the prose says otherwise.
 * MANUAL §11 BUILD-2 records a noisy gate as worse than no gate.
 *
 * What is checked instead: the 57 Schema-B files each carry three prose lines
 * that name a token, its hex, and the pairing —
 *
 *     - Favor Primary (#0077BC) for CTA emphasis.
 *     - Use Surface (#111111) for large backgrounds and cards.
 *     - Keep body copy on Text (#111827) for legibility.
 *
 * That is a declared pair in the same sense Google's is, and it is the only
 * one in the corpus. 57 of 137 files carry it; the other 80 declare no pairing
 * and are correctly not contrast-checked.
 *
 * Thresholds: 4.5:1 for the body-text pair (WCAG 2.1 AA, normal text) and
 * 3:1 for the accent-on-surface pair (AA non-text / large text) — Primary is
 * a CTA fill, not body copy. Measured on this corpus at the time of writing:
 * accent fails 38/57 at 4.5 but 14/57 at 3.0. The 14 are brand primaries
 * whose low contrast is a deliberate upstream design choice on a non-text
 * surface, so accent is reported as a NOTE and does not fail the gate; the
 * body-text pair does fail it.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------------------
// Read-only guarantee.
//
// This gate reads vendored content and must never touch it: `git status` has
// to be clean after a run, because byte-comparability against upstream is the
// only way this pack can tell our edits from upstream's (manifest.json
// `separationMethod`). Asserted rather than asserted-in-prose: every mutating
// fs entry point is replaced with a throwing stub before any file is opened.
// ---------------------------------------------------------------------------
const MUTATORS = [
  'writeFileSync',
  'writeFile',
  'appendFileSync',
  'appendFile',
  'openSync',
  'open',
  'writeSync',
  'write',
  'createWriteStream',
  'mkdirSync',
  'mkdir',
  'rmSync',
  'rm',
  'rmdirSync',
  'rmdir',
  'unlinkSync',
  'unlink',
  'renameSync',
  'rename',
  'copyFileSync',
  'copyFile',
  'truncateSync',
  'truncate',
  'ftruncateSync',
  'chmodSync',
  'chmod',
  'symlinkSync',
  'symlink',
  'linkSync',
  'link',
  'utimesSync',
  'utimes',
];
for (const name of MUTATORS) {
  if (typeof fs[name] === 'function') {
    fs[name] = () => {
      throw new Error(`lint-design-systems is read-only; fs.${name} must never be called`);
    };
  }
  if (fs.promises && typeof fs.promises[name] === 'function') {
    fs.promises[name] = async () => {
      throw new Error(`lint-design-systems is read-only; fs.promises.${name} must never be called`);
    };
  }
}

const packRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const systemsDir = path.join(packRoot, 'design-systems');
const fixturesDir = path.join(packRoot, 'evals', 'design-system-lint');
const manifestPath = path.join(packRoot, 'manifest.json');

const TEXT_AA = 4.5; // WCAG 2.1 AA, normal-size body text
const ACCENT_AA = 3.0; // WCAG 2.1 AA, non-text / large text

// Regression floors. These exist so the extractor cannot rot into a vacuous
// pass: if a pattern breaks, recall collapses and the gate goes red instead of
// quietly reporting "0 problems" over 0 tokens (MANUAL §11 BUILD-6).
// They track the measured baseline exactly rather than sitting loose below it:
// a loose floor cannot tell a pattern breaking from content being edited, which
// is the whole reason they exist. Moving one is a deliberate act — record why.
// Baseline at the time of writing: 137 files, 136 with tokens, 1639 tokens,
// 57 declared pairs, 96.0% mean in-section hex capture, 111/137 files at 100%.
const MIN_FILES_WITH_TOKENS = 136;
const MIN_TOTAL_TOKENS = 1639;
const MIN_DECLARED_PAIRS = 57;

// ---------------------------------------------------------------------------
// WCAG contrast
// ---------------------------------------------------------------------------
function parseHex(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join('');
  if (h.length === 8) h = h.slice(0, 6); // drop the alpha byte; we compare opaque values only
  if (h.length !== 6) return null;
  const n = Number.parseInt(h, 16);
  if (!Number.isFinite(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function relativeLuminance(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb
    .map((v) => v / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const r2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Colour-section scoping
//
// Every token pattern is applied ONLY between the colour H2 and the next H2.
// This is load-bearing: unscoped, Pattern D alone picks up 54 lines from
// component/link/dark-mode sections (`- **Primary Blue**: \`#1b61c9\`, white
// text, 16px 24px padding`) that are component specs, not palette tokens.
// Scoped, Pattern D contributes 0 — which is the correct answer.
// ---------------------------------------------------------------------------
const COLOR_H2 = /^##\s*(?:\d+\.\s*)?(?:Colors?|Color Palette & Roles)\s*$/;
const ANY_H2 = /^##\s+\S/;

function colorSectionRange(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    if (!COLOR_H2.test(lines[i])) continue;
    const start = i + 1;
    let end = lines.length;
    for (let j = start; j < lines.length; j += 1) {
      if (ANY_H2.test(lines[j])) {
        end = j;
        break;
      }
    }
    return { start, end, heading: i };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Token extraction
//
// Two lineages, two shapes, one em-dash variant, plus one fallback:
//   A ("rich"):      - **Absolute Black** (`#000000`): Immersive hero canvases
//   B ("generated"): - **Primary:** `#FF5701` — Token from style foundations.
//   C ("em-dash"):   - **Surface** (`#FFFFFF`) — `--bg`. Cards, modals.
//   D (fallback):    - **Name**: `#hex` ...
//
// The map is keyed on token NAME, never on hex. 192 entries in this corpus are
// a second name for a hex already present in the same file — Apple's #0071e3
// is both "Apple Action Blue" and "Selection/Focus Signal" — and keying on hex
// silently drops one of every such pair.
//
// C is disjoint from the others by its SEPARATOR, not by ordering: A and D both
// require a colon where C requires an em/en dash, and B's colon lives inside the
// bold span before a backticked hex, where C has a parenthesised one. Verified
// on the whole corpus (not just the colour sections): zero lines match C and
// also match A, B or D, so C cannot double-count regardless of where it sits in
// this list. The `C` tag was simply unused by the original A/B/D set — no
// earlier pattern is being revived under the name.
//
// Deliberately NOT widened to a plain hyphen separator (`) - `). No line in the
// corpus uses one, so allowing it buys nothing and only loosens the pattern.
// ---------------------------------------------------------------------------
const TOKEN_PATTERNS = [
  ['A', /^\s*[-*]\s+\*\*([^*]+?)\*\*\s*\(`?(#[0-9a-fA-F]{3,8})`?\)\s*:\s*(.+)$/],
  ['B', /^\s*[-*]\s+\*\*([^*]+?):\*\*\s*`?(#[0-9a-fA-F]{3,8})`?\s*[—–-]?\s*(.*)$/],
  ['C', /^\s*[-*]\s+\*\*([^*]+?)\*\*\s*\(`?(#[0-9a-fA-F]{3,8})`?\)\s*[—–]\s*(.+)$/],
  ['D', /^\s*[-*]\s+\*\*([^*]+?)\*\*\s*:\s*`?(#[0-9a-fA-F]{3,8})`?\s*(.*)$/],
];

// Lines these patterns must REFUSE rather than mis-parse. Each class was
// inspected: a gradient ramp (`- **Red**: #FFE5E5 → #EE0005 → #530300`) has no
// single value; a markdown alpha table row is not a token declaration; a
// "never use" anti-pattern list names colours precisely so they are not used.
// Refusing them is the correct behaviour, not a recall bug.
//
// Four further classes are refused by the PATTERNS rather than by this filter,
// and adding C did not open any of them — each is asserted in the self-test:
//   - dual-value    `- **Coral**: Light \`#ffc6c6\` / Dark \`#600000\``
//                   `- **Granite** (\`#555555\`) and **Graphite** (\`#565656\`): …`
//   - hsl + approx  `- **Raycast Blue** (\`hsl(202,100%,67%)\` / ~\`#55b3ff\`): …`
//   - rgba          `- **Notion Black** (\`rgba(0,0,0,0.95)\` / \`#000000f2\`): …`
//   - bare-hex list `- \`#ffffff\` as a page background`  (a "never use" item)
// The miro pastel block is entirely the dual-value form, so C leaves it at its
// existing 11-of-18 capture — that is the correct answer, not a shortfall.
const REFUSE_LINE = /→|↔|gradient|linear-gradient|radial-gradient|\|/i;

function extractColorTokens(lines, range) {
  const tokens = new Map(); // name -> { hex, pattern, line }
  if (!range) return tokens;
  for (let i = range.start; i < range.end; i += 1) {
    const line = lines[i];
    if (REFUSE_LINE.test(line)) continue;
    for (const [tag, re] of TOKEN_PATTERNS) {
      const m = re.exec(line);
      if (!m) continue;
      const name = m[1].trim();
      if (!tokens.has(name)) tokens.set(name, { hex: m[2].toLowerCase(), pattern: tag, line: i + 1 });
      break;
    }
  }
  return tokens;
}

// Every distinct hex actually present in the colour section, on lines the
// extractor did not refuse. Used only to REPORT recall — never to fail.
function inSectionHexes(lines, range) {
  const seen = new Set();
  if (!range) return seen;
  for (let i = range.start; i < range.end; i += 1) {
    if (REFUSE_LINE.test(lines[i])) continue;
    for (const h of lines[i].match(/#[0-9a-fA-F]{3,8}\b/g) || []) seen.add(h.toLowerCase());
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Declared pairs — read out of the prose, not inferred from token roles.
// ---------------------------------------------------------------------------
const DECLARED = {
  text: /^\s*[-*]\s+Keep body copy on ([^()]+?)\s*\((#[0-9a-fA-F]{3,8})\)/,
  surface: /^\s*[-*]\s+Use ([^()]+?)\s*\((#[0-9a-fA-F]{3,8})\)\s*for large backgrounds/,
  accent: /^\s*[-*]\s+Favor ([^()]+?)\s*\((#[0-9a-fA-F]{3,8})\)\s*for CTA/,
};

function extractDeclaredPair(lines, range) {
  const found = {};
  if (!range) return null;
  for (let i = range.start; i < range.end; i += 1) {
    for (const [role, re] of Object.entries(DECLARED)) {
      if (found[role]) continue;
      const m = re.exec(lines[i]);
      if (m) found[role] = { name: m[1].trim(), hex: m[2], line: i + 1 };
    }
  }
  if (!found.text || !found.surface) return null;
  return found;
}

// ---------------------------------------------------------------------------
// Structure
//
// Both schemas below are the ones this pack ACTUALLY ships, derived by grouping
// all 137 files by their H2 sequence, not copied from an upstream linter.
// Headings that resolve to neither schema (Dark Mode, Attribution, Shapes,
// Accessibility & States, Iteration Guide, Known Gaps, …) are extras and are
// ignored: a file may add sections, it may not reorder the ones it has.
// ---------------------------------------------------------------------------
const SCHEMA_A = [
  'visual',
  'color',
  'typography',
  'components',
  'layout',
  'depth',
  'dos-and-donts',
  'responsive',
  'agent-guide',
];
const SCHEMA_B = [
  'visual',
  'color',
  'typography',
  'spacing',
  'layout',
  'components',
  'motion',
  'voice',
  'anti-patterns',
];
const SCHEMAS = [
  ['A (rich / "Color Palette & Roles")', SCHEMA_A],
  ['B (generated / "Color")', SCHEMA_B],
];

const HEADING_ALIASES = new Map(
  Object.entries({
    'visual theme & atmosphere': 'visual',
    overview: 'visual',
    color: 'color',
    colors: 'color',
    'color palette & roles': 'color',
    'color palette': 'color',
    typography: 'typography',
    'typography rules': 'typography',
    spacing: 'spacing',
    'spacing & grid': 'spacing',
    // A combined heading that occupies the layout slot in the arc lineage.
    'spacing & layout': 'layout',
    layout: 'layout',
    'layout principles': 'layout',
    'layout & composition': 'layout',
    components: 'components',
    'component stylings': 'components',
    depth: 'depth',
    'depth & elevation': 'depth',
    'elevation & depth': 'depth',
    motion: 'motion',
    'motion & interaction': 'motion',
    'interaction & motion': 'motion',
    "do's and don'ts": 'dos-and-donts',
    'dos and donts': 'dos-and-donts',
    responsive: 'responsive',
    'responsive behavior': 'responsive',
    'responsive behaviour': 'responsive',
    'agent prompt guide': 'agent-guide',
    'voice & brand': 'voice',
    'anti-patterns': 'anti-patterns',
    antipatterns: 'anti-patterns',
  })
);

function normalizeHeading(raw) {
  return raw
    .replace(/^\s*#+\s*/, '')
    .replace(/^\d+[.)]\s*/, '') // strip the "N. " numeric prefix
    .replace(/\s*\([^)]*\)\s*$/, '') // "Responsive Behavior (Extended)"
    .split(':')[0] // "Depth: 5-layer cascading shadow system"
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function headings(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!ANY_H2.test(lines[i])) continue;
    const raw = lines[i].replace(/^##\s+/, '').trim();
    out.push({ raw, token: HEADING_ALIASES.get(normalizeHeading(raw)) || null, line: i + 1 });
  }
  return out;
}

// A file must place at least this many recognised sections for the order check
// to mean anything. Without it a two-heading file passes trivially.
const MIN_RECOGNIZED_SECTIONS = 5;

function checkStructure(hs) {
  const attempts = [];
  for (const [label, schema] of SCHEMAS) {
    const matched = [];
    for (const h of hs) {
      if (!h.token) continue;
      const idx = schema.indexOf(h.token);
      if (idx === -1) continue; // section belongs to the other lineage: an extra
      matched.push({ ...h, idx });
    }
    if (matched.length < MIN_RECOGNIZED_SECTIONS) {
      attempts.push(`${label}: only ${matched.length} recognised sections (need ${MIN_RECOGNIZED_SECTIONS})`);
      continue;
    }
    if (!matched.some((m) => m.token === 'color')) {
      attempts.push(`${label}: no colour section`);
      continue;
    }
    let bad = null;
    for (let i = 1; i < matched.length; i += 1) {
      if (matched[i].idx < matched[i - 1].idx) {
        bad = `"${matched[i].raw}" (line ${matched[i].line}) comes after "${matched[i - 1].raw}"`;
        break;
      }
    }
    if (bad) {
      attempts.push(`${label}: out of order — ${bad}`);
      continue;
    }
    return { ok: true, schema: label, matched: matched.length };
  }
  return { ok: false, attempts };
}

// ---------------------------------------------------------------------------
// Per-file lint
// ---------------------------------------------------------------------------
function lintText(slug, text) {
  const lines = text.split('\n');
  const range = colorSectionRange(lines);
  const hs = headings(lines);
  const tokens = extractColorTokens(lines, range);
  const declared = extractDeclaredPair(lines, range);
  const structure = checkStructure(hs);

  const failures = [];
  const notes = [];

  if (!range) failures.push(`${slug}: no colour section — expected an H2 matching ${COLOR_H2}`);
  if (!structure.ok) {
    failures.push(
      `${slug}: section order matches neither shipped schema.\n` +
        structure.attempts.map((a) => `           ${a}`).join('\n')
    );
  }

  let textRatio = null;
  let accentRatio = null;
  if (declared) {
    textRatio = contrastRatio(declared.text.hex, declared.surface.hex);
    if (textRatio === null) {
      failures.push(`${slug}: declared pair has an unparseable hex.`);
    } else if (textRatio < TEXT_AA) {
      failures.push(
        `${slug}: declared body-text pair fails WCAG AA — ${declared.text.name} ${declared.text.hex} ` +
          `on ${declared.surface.name} ${declared.surface.hex} = ${r2(textRatio)}:1 (need ${TEXT_AA}:1). ` +
          `Line ${declared.text.line} instructs "Keep body copy on ${declared.text.name}".`
      );
    }
    if (declared.accent) {
      accentRatio = contrastRatio(declared.accent.hex, declared.surface.hex);
      if (accentRatio !== null && accentRatio < ACCENT_AA) {
        notes.push(
          `${slug}: accent-on-surface ${declared.accent.name} ${declared.accent.hex} on ` +
            `${declared.surface.hex} = ${r2(accentRatio)}:1 (below ${ACCENT_AA}:1 non-text AA).`
        );
      }
    }
  }

  return {
    slug,
    range,
    tokens,
    declared,
    structure,
    textRatio,
    accentRatio,
    failures,
    notes,
    hexesInSection: inSectionHexes(lines, range),
  };
}

// ---------------------------------------------------------------------------
// Self-test against deliberately-malformed fixtures.
//
// Calibrated to this corpus the structural check passes 137/137 on day one.
// That is exactly the vacuous-pass shape MANUAL §11 BUILD-6 warns about, so
// the checks are proven against fixtures authored to break them — never merely
// against the corpus they were derived from. This runs on every invocation.
// ---------------------------------------------------------------------------
const FIXTURE_EXPECTATIONS = [
  { dir: 'clean', expect: 'pass' },
  { dir: 'low-contrast', expect: 'declared body-text pair fails WCAG AA' },
  { dir: 'malformed-order', expect: 'section order matches neither shipped schema' },
  { dir: 'no-color-section', expect: 'no colour section' },
];

// Pattern-level cases, kept inline rather than as fixture files because they
// assert properties of the regex set itself (disjointness, refusal classes)
// rather than end-to-end file behaviour. `expect` is the pattern tag that must
// win, or null when every pattern must refuse the line.
const PATTERN_CASES = [
  ['- **Absolute Black** (`#000000`): Immersive hero canvases', 'A'],
  ['- **Primary:** `#FF5701` — Token from style foundations.', 'B'],
  ['- **Surface** (`#FFFFFF`) — `--bg`. Cards, modals.', 'C'],
  ['- **Canvas** (`#0E0E11`) — deepest layer.', 'C'],
  ['- **Primary Blue**: `#1b61c9` white text', 'D'],
  // Names containing an em-dash must still resolve by their own separator.
  ['- **Brand Red — Token** (`#FF2442`): `--primary` and `--color-red`.', 'A'],
  // Refusal classes. Each is a real corpus line; see the REFUSE_LINE comment.
  ['- **Coral**: Light `#ffc6c6` / Dark `#600000`', null],
  ['- **Granite** (`#555555`) and **Graphite** (`#565656`): Deeper gray.', null],
  ['- **Raycast Blue** (`hsl(202, 100%, 67%)` / ~`#55b3ff`): Interactive accent', null],
  ['- **Notion Black** (`rgba(0,0,0,0.95)` / `#000000f2`): Primary text', null],
  ['- `#ffffff` as a page background', null],
];

function runPatternSelfTest() {
  const problems = [];
  const match = (line) => {
    if (REFUSE_LINE.test(line)) return null;
    for (const [tag, re] of TOKEN_PATTERNS) if (re.test(line)) return tag;
    return null;
  };
  for (const [line, expect] of PATTERN_CASES) {
    const got = match(line);
    if (got !== expect) {
      problems.push(`pattern case expected ${expect || '(refusal)'} but got ${got || '(refusal)'}: ${line}`);
    }
  }
  // Disjointness: no line may satisfy two patterns. Ordering must not be what
  // keeps a token from being counted twice.
  for (const [line] of PATTERN_CASES) {
    const hits = TOKEN_PATTERNS.filter(([, re]) => re.test(line)).map(([t]) => t);
    if (hits.length > 1) problems.push(`patterns ${hits.join('+')} both match, so ordering is load-bearing: ${line}`);
  }
  return problems;
}

function runSelfTest() {
  const problems = runPatternSelfTest();
  if (!fs.existsSync(fixturesDir)) {
    return [`fixtures missing: ${path.relative(packRoot, fixturesDir)}`];
  }
  const onDisk = fs
    .readdirSync(fixturesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const expected = FIXTURE_EXPECTATIONS.map((f) => f.dir).sort();
  if (onDisk.join(',') !== expected.join(',')) {
    problems.push(`fixture set drifted: on disk [${onDisk.join(', ')}], expected [${expected.join(', ')}]`);
  }
  for (const { dir, expect } of FIXTURE_EXPECTATIONS) {
    const file = path.join(fixturesDir, dir, 'DESIGN.md');
    if (!fs.existsSync(file)) {
      problems.push(`fixture ${dir}/DESIGN.md is missing`);
      continue;
    }
    const res = lintText(`fixture:${dir}`, fs.readFileSync(file, 'utf8'));
    const joined = res.failures.join('\n');
    if (expect === 'pass') {
      if (res.failures.length > 0) problems.push(`fixture ${dir} should pass but reported:\n${joined}`);
      if (res.tokens.size === 0) problems.push(`fixture ${dir} should yield colour tokens but yielded none`);
      if (!res.declared) problems.push(`fixture ${dir} should declare a text/surface pair but does not`);
    } else if (!joined.includes(expect)) {
      problems.push(`fixture ${dir} should have been rejected for "${expect}" but reported: ${joined || '(nothing)'}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const argv = new Set(process.argv.slice(2));
const wantReport = argv.has('--report');

const selfTestProblems = runSelfTest();

if (argv.has('--self-test')) {
  for (const p of selfTestProblems) console.error(`FAIL self-test ${p}`);
  console.log(
    `self-test: ${FIXTURE_EXPECTATIONS.length} fixtures + ${PATTERN_CASES.length} pattern cases, ` +
      `${selfTestProblems.length} problems`
  );
  process.exit(selfTestProblems.length > 0 ? 1 : 0);
}

if (!fs.existsSync(systemsDir)) {
  console.error(`FAIL packs/design/design-systems/ is missing.`);
  process.exit(1);
}

// The expected file count comes from manifest.json's own accounting rather
// than a literal, so this doubles as a cross-check that the manifest and the
// tree still agree (MANUAL §11 CONTENT-12: hardcoded counts in prose rot).
let expectedCount = null;
try {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const sub = manifest.subtrees.find((s) => s.path === 'design-systems/');
  expectedCount = sub.detail.fromOpenDesign + sub.detail.fromAwesomeDesignMd;
} catch (err) {
  console.error(`FAIL could not read the expected design-system count from manifest.json: ${err.message}`);
  process.exit(1);
}

const slugs = fs
  .readdirSync(systemsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

const failures = [];
const notes = [];
const results = [];

for (const slug of slugs) {
  const file = path.join(systemsDir, slug, 'DESIGN.md');
  if (!fs.existsSync(file)) {
    failures.push(`${slug}: no DESIGN.md`);
    continue;
  }
  const res = lintText(slug, fs.readFileSync(file, 'utf8'));
  results.push(res);
  failures.push(...res.failures);
  notes.push(...res.notes);
}

const iterated = results.length;
const withSection = results.filter((r) => r.range).length;
const totalTokens = results.reduce((n, r) => n + r.tokens.size, 0);
const withTokens = results.filter((r) => r.tokens.size > 0).length;
const zeroTokens = results.filter((r) => r.tokens.size === 0).map((r) => r.slug);
const pairs = results.filter((r) => r.declared);
const schemaCounts = results.reduce((acc, r) => {
  if (r.structure.ok) acc[r.structure.schema] = (acc[r.structure.schema] || 0) + 1;
  return acc;
}, {});

// Recall, measured every run rather than asserted once in a comment.
const denom = results.filter((r) => r.hexesInSection.size > 0);
let captureSum = 0;
let perfect = 0;
for (const r of denom) {
  const got = new Set([...r.tokens.values()].map((t) => t.hex));
  const hit = [...r.hexesInSection].filter((h) => got.has(h)).length;
  captureSum += hit / r.hexesInSection.size;
  if (hit === r.hexesInSection.size) perfect += 1;
}
const meanCapture = denom.length ? (captureSum / denom.length) * 100 : 0;

if (iterated !== expectedCount) {
  failures.push(
    `iterated ${iterated} design systems, manifest.json accounts for ${expectedCount}. ` +
      `A gate that silently iterates the wrong set is worse than no gate; fix the tree or the manifest.`
  );
}
if (withSection !== iterated) {
  failures.push(`${iterated - withSection} file(s) have no colour section.`);
}
if (withTokens < MIN_FILES_WITH_TOKENS) {
  failures.push(
    `extractor recall regressed: ${withTokens} files yielded a colour token, floor is ${MIN_FILES_WITH_TOKENS}.`
  );
}
if (totalTokens < MIN_TOTAL_TOKENS) {
  failures.push(`extractor recall regressed: ${totalTokens} tokens extracted, floor is ${MIN_TOTAL_TOKENS}.`);
}
if (pairs.length < MIN_DECLARED_PAIRS) {
  failures.push(
    `declared-pair recall regressed: ${pairs.length} files yielded a text/surface pair, floor is ${MIN_DECLARED_PAIRS}. ` +
      `The contrast check is only as good as this number.`
  );
}

console.log('Design-system lint');
console.log(
  `  self-test: ${FIXTURE_EXPECTATIONS.length} fixtures (1 clean, 3 deliberately malformed), ` +
    `${PATTERN_CASES.length} pattern cases`
);
console.log(`  design systems iterated: ${iterated} (manifest.json accounts for ${expectedCount})`);
console.log(`  colour section located: ${withSection}/${iterated}`);
console.log(`  colour tokens extracted: ${totalTokens} across ${withTokens} files`);
console.log(`  in-section hex capture: ${meanCapture.toFixed(1)}% mean, ${perfect}/${denom.length} files at 100%`);
console.log(`  declared text/surface pairs checked at ${TEXT_AA}:1: ${pairs.length}`);
console.log(`  section schema: ${Object.entries(schemaCounts).map(([k, v]) => `${v} × ${k}`).join(', ')}`);
if (zeroTokens.length > 0) {
  console.log(
    `  NOTE ${zeroTokens.length} file(s) yield no colour token: ${zeroTokens.join(', ')} — ` +
      `expected for files whose palette is expressed as {colors.x} references rather than literal hexes.`
  );
}
for (const n of notes) console.log(`  NOTE ${n}`);
if (notes.length > 0) {
  console.log(
    `  NOTE ${notes.length} accent-on-surface pair(s) below ${ACCENT_AA}:1. Reported, NOT failed: a brand ` +
      `primary used as a CTA fill is non-text, and these are upstream design choices, not defects.`
  );
}

if (selfTestProblems.length > 0 || failures.length > 0) {
  console.error('');
  for (const p of selfTestProblems) console.error(`FAIL self-test ${p}`);
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}

if (wantReport) {
  console.log('');
  console.log('  slug                      text  accent  pair');
  for (const r of pairs.sort((a, b) => a.textRatio - b.textRatio)) {
    console.log(
      `  ${r.slug.padEnd(24)} ${String(r2(r.textRatio)).padStart(5)} ` +
        `${String(r.accentRatio === null ? '-' : r2(r.accentRatio)).padStart(6)}  ` +
        `${r.declared.text.hex} on ${r.declared.surface.hex}`
    );
  }
}

console.log('OK every design system parses, orders its sections, and pairs text with surface at AA.');
