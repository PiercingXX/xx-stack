#!/usr/bin/env node
/**
 * Craft-reference drift check.
 *
 * Contract (upstream's, reimplemented here — see craft/XX-STACK-NOTES.md):
 * every slug named by an `od.craft.requires` list in a SKILL.md must resolve to
 * `packs/design/craft/<slug>.md`, or be listed in `craft/FUTURE_SECTIONS.md` as
 * a deliberate forward reference. A typo must not silently drop a craft section
 * from a skill's context — that is the whole reason the check exists.
 *
 * It also reports craft files no skill requires. That is NOT a failure: several
 * rulebooks are reference material an agent can pull in ad hoc, and this pack
 * deliberately vendors all 11 so the axis is complete rather than partial.
 *
 * Modelled on scripts/check-rules-coverage.mjs.
 *
 * Authored in this repository. MIT (repo root LICENSE).
 *
 *   node packs/design/scripts/check-craft-references.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const packRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const craftDir = path.join(packRoot, 'craft');
const skillsDir = path.join(packRoot, 'workflow-skills');

const problems = [];
const notes = [];

if (!fs.existsSync(craftDir)) {
  console.error('FAIL packs/design/craft/ is missing.');
  process.exit(1);
}

// Shipped slugs = every craft/<slug>.md that is a rulebook. README.md,
// FUTURE_SECTIONS.md and XX-STACK-NOTES.md are documentation, not sections.
const NON_SECTION = new Set(['README', 'FUTURE_SECTIONS', 'XX-STACK-NOTES']);
const shipped = new Set(
  fs
    .readdirSync(craftDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3))
    .filter((s) => !NON_SECTION.has(s))
);

// Forward references: bullet list in FUTURE_SECTIONS.md.
const futurePath = path.join(craftDir, 'FUTURE_SECTIONS.md');
const future = new Set();
if (fs.existsSync(futurePath)) {
  for (const line of fs.readFileSync(futurePath, 'utf8').split('\n')) {
    const m = /^[-*]\s+`?([a-z0-9][a-z0-9-]*)`?\s*$/.exec(line.trim());
    if (m) future.add(m[1]);
  }
} else {
  problems.push('craft/FUTURE_SECTIONS.md is missing; forward references cannot be declared.');
}

// Every `od.craft.requires: [...]` in a workflow skill.
const required = new Map(); // slug -> [skill, ...]
const bound = [];
for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!entry.isDirectory()) continue;
  const file = path.join(skillsDir, entry.name, 'SKILL.md');
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  const m = /^\s*craft:\s*\n\s*requires:\s*\[([^\]]*)\]/m.exec(text);
  if (!m) continue;
  const slugs = m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (slugs.length === 0) {
    problems.push(`${entry.name}: od.craft.requires is present but empty — omit the block instead.`);
    continue;
  }
  bound.push(entry.name);
  for (const slug of slugs) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      problems.push(`${entry.name}: malformed craft slug "${slug}".`);
      continue;
    }
    if (!required.has(slug)) required.set(slug, []);
    required.get(slug).push(entry.name);
  }
}

for (const [slug, skills] of [...required.entries()].sort()) {
  if (shipped.has(slug)) continue;
  if (future.has(slug)) {
    notes.push(`forward reference "${slug}" (declared in FUTURE_SECTIONS.md), required by: ${skills.join(', ')}`);
    continue;
  }
  problems.push(
    `unresolved craft slug "${slug}" required by ${skills.join(', ')} — expected packs/design/craft/${slug}.md, or a FUTURE_SECTIONS.md entry.`
  );
}

const unrequired = [...shipped].filter((s) => !required.has(s)).sort();

console.log('Craft reference check');
console.log(`  craft sections shipped: ${shipped.size}`);
console.log(`  workflow skills with od.craft.requires: ${bound.length} of 31`);
console.log(`  distinct slugs required: ${required.size}`);
for (const n of notes) console.log(`  NOTE ${n}`);
if (unrequired.length > 0) {
  console.log(`  NOTE shipped but required by no skill (reference material, not a failure): ${unrequired.join(', ')}`);
}

if (problems.length > 0) {
  console.error('');
  for (const p of problems) console.error(`FAIL ${p}`);
  process.exit(1);
}

console.log('OK every craft reference resolves.');
