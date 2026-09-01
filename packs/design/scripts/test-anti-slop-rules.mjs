#!/usr/bin/env node
/**
 * End-to-end coverage for the anti-AI-slop rule table.
 *
 * Drives the real gate as a subprocess (not its internals) against two
 * fixtures: one deliberately slop-ridden, one clean. Asserts that every rule in
 * craft/anti-ai-slop-rules.json fires on the slop fixture at its declared
 * severity, that none fire on the clean one, and that only P0 changes the exit
 * code.
 *
 * Fixtures are written to a temp dir and held INLINE here on purpose: the gate's
 * default sweep collects every *.html under the repo, so a slop fixture
 * committed as a .html file inside the pack would be swept and would turn the
 * gate red on itself.
 *
 * Authored in this repository. MIT (repo root LICENSE).
 *
 *   node packs/design/scripts/test-anti-slop-rules.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const gate = path.join(scriptDir, 'quality-gate-html.mjs');
const rules = JSON.parse(fs.readFileSync(path.join(scriptDir, '..', 'craft', 'anti-ai-slop-rules.json'), 'utf8'));

const SHELL_HEAD = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fixture Page</title>`;

// Trips every rule in the table. Ordered so the reader can see one rule per
// construct; the ids are the ones asserted below.
const SLOP = `${SHELL_HEAD}
<style>
  :root { --bg: #ffffff; --fg: #101010; --accent: #d94f2b; --font-display: Georgia, serif; }
  .hero { background: linear-gradient(90deg, #6366f1, #ec4899); }
  .band { background: linear-gradient(90deg, #3b82f6, #06b6d4); }
  .cta  { --cta-bg: #4f46e5; color: #4f46e5; }
  h1 { font-family: 'Inter', sans-serif; }
  .a{color:#111111}.b{color:#222222}.c{color:#333333}.d{color:#444444}
  .e{color:#555555}.f{color:#666666}.g{color:#777777}.h{color:#888888}
  .i{color:#999999}.j{color:#aaaaaa}.k{color:#bbbbbb}.l{color:#cccccc}
  .m{color:#dddddd}.n{color:#eeeeee}
  .bar { transition: width 0.2s ease; }
  .pointer { cursor: url(cursor.png), auto; }
  @media (min-width: 40rem) { .hero { padding: 4rem; } }
</style></head>
<body><main>
<section class="hero"><h1>🚀 Ship faster</h1>
<p>Teams move 10× faster with zero-downtime deploys and 99.98% uptime SLA at 124ms avg.</p>
<p>Lorem ipsum dolor sit amet — placeholder text goes here.</p>
<p>Elevate your workflow — a truly next-gen platform that seamlessly integrates.</p>
<p>Scroll to explore</p></section>
<section><h2>SYSTEM // 2026</h2><h2>By the numbers</h2>
<ul><li>✨ Feature one</li><li>🎯 Feature two</li></ul>
<span class="icon">🔥</span>
<p>Reviewed by John Doe at Acme Co.</p>
<img src="https://images.unsplash.com/photo-1" alt="stock">
<p style="color: var(--accent)">a</p><p style="color: var(--accent)">b</p>
<p style="color: var(--accent)">c</p><p style="color: var(--accent)">d</p>
<p style="color: var(--accent)">e</p><p style="color: var(--accent)">f</p>
<p style="color: var(--accent)">g</p></section>
</main></body></html>
`;

// Second slop fixture, purple-free. `trust-gradient` and `ai-default-indigo`
// declare `suppressedBy: [purple-gradient]` so the agent gets one corrective
// signal per artifact rather than three for the same mistake — which means
// they can only be observed in a fixture that has no purple gradient.
const SLOP_B = `${SHELL_HEAD}
<style>
  :root { --bg: #ffffff; --fg: #101010; --accent: #d94f2b; }
  .band { background: linear-gradient(90deg, #3b82f6, #06b6d4); }
  .cta  { background: #6366f1; }
  @media (min-width: 40rem) { .band { padding: 4rem; } }
</style></head>
<body><main><section><h1>Plans</h1><p>Real copy about the product.</p>
<button type="button" class="cta">Start</button></section></main></body></html>
`;

// Structurally sound and rule-clean: tokens in :root, one accent use, a real
// SVG icon, no gradients, no invented numbers.
const CLEAN = `${SHELL_HEAD}
<style>
  :root { --bg: #fdfcfa; --surface: #f2efe9; --fg: #1b1a17; --muted: #6f6a61;
          --border: #ddd8cf; --accent: #b4552d; --font-display: 'Iowan Old Style', Georgia, serif; }
  body { background: var(--bg); color: var(--fg); }
  h1 { font-family: var(--font-display); }
  .rail { border: 1px solid var(--border); background: var(--surface); }
  @media (min-width: 40rem) { .rail { padding: 2rem; } }
</style></head>
<body><main>
<header><h1>Quarterly operating review</h1></header>
<section aria-labelledby="s1"><h2 id="s1">Where the quarter landed</h2>
<p>Revenue closed at the figure finance published on the 14th; the two open
variances are itemised in the appendix.</p>
<button type="button" style="color: var(--accent)">
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
       stroke-width="1.7" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4"/></svg>
  Open the appendix
</button></section>
<section class="rail"><h2>Owners</h2>
<ul><li>Platform — reliability review</li><li>Finance — variance write-up</li></ul>
</section></main></body></html>
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xx-antislop-'));
const slopFile = path.join(tmp, 'slop.html');
const slopBFile = path.join(tmp, 'slop-b.html');
const cleanFile = path.join(tmp, 'clean.html');
fs.writeFileSync(slopFile, SLOP);
fs.writeFileSync(slopBFile, SLOP_B);
fs.writeFileSync(cleanFile, CLEAN);

const run = (file) => spawnSync(process.execPath, [gate, file], { encoding: 'utf8' });

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

const slopRun = run(slopFile);
const slopOut = `${slopRun.stdout}${slopRun.stderr}`;
const slopBRun = run(slopBFile);
const slopBOut = `${slopBRun.stdout}${slopBRun.stderr}`;
const cleanRun = run(cleanFile);
const cleanOut = `${cleanRun.stdout}${cleanRun.stderr}`;

console.log('Anti-slop rule table — fixture coverage\n');

const slopCombined = `${slopOut}\n${slopBOut}`;
for (const rule of rules.rules) {
  const hit = new RegExp(`\\[${rule.severity}\\] ${rule.id}\\b`).test(slopCombined);
  check(hit, `slop fixtures trip ${rule.id} at ${rule.severity}`);
}

// Suppression works: the purple-gradient fixture must NOT also report the two
// rules that declare it as their suppressor.
for (const rule of rules.rules.filter((r) => (r.suppressedBy ?? []).includes('purple-gradient'))) {
  check(!new RegExp(`\\b${rule.id}\\b`).test(slopOut), `${rule.id} is suppressed when purple-gradient fires`);
}

const p0Ids = rules.rules.filter((r) => r.severity === 'P0').map((r) => r.id);
check(slopRun.status === 1, `slop fixture fails the gate (P0 rules defined: ${p0Ids.length})`, `exit ${slopRun.status}`);
check(slopBRun.status === 1, 'purple-free slop fixture fails the gate', `exit ${slopBRun.status}`);

for (const rule of rules.rules) {
  check(!new RegExp(`\\b${rule.id}\\b`).test(cleanOut), `clean fixture does not trip ${rule.id}`);
}
check(cleanRun.status === 0, 'clean fixture passes the gate', `exit ${cleanRun.status}\n${cleanOut}`);

// Severity is not exit code: a file with only P1/P2 findings must still pass.
const p1Only = CLEAN.replace(
  '<h2>Owners</h2>',
  '<h2>Owners</h2>\n<img src="https://placehold.co/600x400" alt="placeholder">'
);
const p1File = path.join(tmp, 'p1-only.html');
fs.writeFileSync(p1File, p1Only);
const p1Run = run(p1File);
const p1Out = `${p1Run.stdout}${p1Run.stderr}`;
check(/\[P1\] external-image/.test(p1Out), 'P1-only fixture reports the finding');
check(p1Run.status === 0, 'P1-only fixture still passes the gate', `exit ${p1Run.status}`);

fs.rmSync(tmp, { recursive: true, force: true });

console.log('');
if (failed > 0) {
  console.error(`${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log('All anti-slop rule assertions passed.');
