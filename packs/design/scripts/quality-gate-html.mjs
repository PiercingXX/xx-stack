#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const gatesPath = path.join(root, 'packs', 'design', 'workflow-skills', 'quality-gates.json');
const slopRulesPath = path.join(root, 'packs', 'design', 'craft', 'anti-ai-slop-rules.json');

function parseArgs(argv) {
  const args = {
    skill: '',
    files: []
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--skill' && i + 1 < argv.length) {
      args.skill = argv[i + 1];
      i += 1;
      continue;
    }
    args.files.push(token);
  }

  return args;
}

function collectHtmlFiles(inputs) {
  const files = [];
  for (const input of inputs) {
    const cwdPath = path.resolve(process.cwd(), input);
    const rootPath = path.resolve(root, input);
    const p = fs.existsSync(cwdPath) ? cwdPath : rootPath;
    if (!fs.existsSync(p)) continue;

    const stat = fs.statSync(p);
    if (stat.isFile() && p.toLowerCase().endsWith('.html')) {
      files.push(p);
      continue;
    }

    if (stat.isDirectory()) {
      const stack = [p];
      while (stack.length > 0) {
        const dir = stack.pop();
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          const child = path.join(dir, e.name);
          if (e.isDirectory()) {
            stack.push(child);
          } else if (e.isFile() && child.toLowerCase().endsWith('.html')) {
            files.push(child);
          }
        }
      }
    }
  }
  return [...new Set(files)].sort();
}

function hasRegex(text, regex) {
  return regex.test(text);
}

// Which skill does a swept file belong to? Files live at
// workflow-skills/<skill>/{example.html,assets/*.html,examples/*.html}.
// Without this, a directory sweep has no --skill and every profile gate below
// silently no-ops — which is how this gate came to run only its generic half.
function inferSkillFromPath(file) {
  const parts = file.split(path.sep);
  const i = parts.lastIndexOf('workflow-skills');
  if (i === -1 || i + 1 >= parts.length) return '';
  return parts[i + 1];
}

// Hosts that serve webfonts, not application CSS/JS. A <link> to one of these
// is typography, not a code dependency: several skills instruct it explicitly
// (see workflow-skills/wireframe-sketch/SKILL.md, which requires the Caveat /
// Patrick Hand handwriting faces). The "self-contained artifact" rule exists to
// stop templates depending on someone else's CODE, and font CDNs are not that.
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'fonts.bunny.net'];

const isFontHost = (url) => FONT_HOSTS.some((h) => url.includes(h));

// `rel` values that are hints, not stylesheets. Flagging <link rel="preconnect">
// as an "external stylesheet" was simply wrong.
const NON_STYLESHEET_RELS = ['preconnect', 'dns-prefetch', 'prefetch', 'preload', 'icon'];

function externalStylesheets(content) {
  const links = content.match(/<link\b[^>]*>/gi) || [];
  return links.filter((tag) => {
    const href = (tag.match(/href=["'](https?:\/\/[^"']+)["']/i) || [])[1];
    if (!href) return false;
    const rel = ((tag.match(/rel=["']([^"']+)["']/i) || [])[1] || '').toLowerCase();
    if (NON_STYLESHEET_RELS.some((r) => rel.split(/\s+/).includes(r))) return false;
    return !isFontHost(href);
  });
}

function externalScripts(content) {
  const tags = content.match(/<script\b[^>]*\bsrc=["']https?:\/\/[^"']+["'][^>]*>/gi) || [];
  return tags.filter((tag) => !isFontHost(tag));
}

// A file with no <html> and no <body> is an HTML FRAGMENT — a block of markup
// meant to be included in a document, not a document itself (see
// workflow-skills/guizang-ppt/assets/example-slides.html, a run of <section
// class="slide"> blocks that powers the Examples preview). Document-shell
// rules — doctype, viewport, <title>, :root token block — are meaningless for a
// fragment; its host document owns them. The content rules below still apply.
function isFragment(content) {
  return !hasRegex(content, /<html\b/i) && !hasRegex(content, /<body\b/i);
}

const DOCUMENT_SHELL_CHECKS = new Set(['doctype', 'viewport', 'title', 'rootTokens']);

function checkGenericGates(content, profile) {
  const failures = [];
  const warnings = [];
  const fragment = isFragment(content);

  // Fixed-canvas artifacts (sprite sheets, device-frame screens, wireframe
  // canvases) are not documents; <main>/<section>/<nav> do not describe them.
  // Profiles opt out via requireSemanticLayout:false, the same way they already
  // opt out of mustHaveH1/mustHaveCta. Absent a profile, the rule applies.
  const requireSemantic = profile ? profile.requireSemanticLayout !== false : true;

  const checks = [
    {
      name: 'doctype',
      pass: hasRegex(content, /<!doctype html>/i),
      message: 'Missing <!doctype html>.'
    },
    {
      name: 'viewport',
      pass: hasRegex(content, /<meta[^>]*name=["']viewport["'][^>]*>/i),
      message: 'Missing viewport meta tag.'
    },
    {
      name: 'title',
      pass: hasRegex(content, /<title>[^<]{3,}<\/title>/i),
      message: 'Missing or weak <title> tag.'
    },
    {
      name: 'rootTokens',
      pass: hasRegex(content, /:root\s*{[^}]*--[a-z0-9-]+\s*:/is),
      message: 'Missing CSS custom properties in :root.'
    },
    {
      name: 'semantic',
      pass: !requireSemantic || hasRegex(content, /<(main|section|header|footer|article|nav)\b/i),
      message: 'No semantic layout tags found.'
    },
    {
      name: 'noExternalStyles',
      pass: externalStylesheets(content).length === 0,
      message: `External stylesheet detected; expected self-contained artifact (webfont CDNs are allowed): ${externalStylesheets(content).join(' ')}`
    },
    {
      name: 'noExternalScripts',
      pass: externalScripts(content).length === 0,
      message: `External script detected; expected self-contained artifact: ${externalScripts(content).join(' ')}`
    }
  ];

  for (const c of checks) {
    if (fragment && DOCUMENT_SHELL_CHECKS.has(c.name)) continue;
    if (!c.pass) failures.push(c.message);
  }
  if (fragment) {
    warnings.push('Treated as an HTML fragment (no <html>/<body>); document-shell gates skipped.');
  }

  // The two taste heuristics that used to live here — a purple-gradient regex
  // naming two hexes no model actually emits, and a document-wide emoji match —
  // are gone. Both were guesses. They are replaced by the rule table in
  // craft/anti-ai-slop-rules.json, evaluated by evaluateSlopRules() below,
  // which carries concrete values and a P0/P1/P2 severity ladder.

  if (!hasRegex(content, /@media\s*\(/i)) {
    warnings.push('No @media query found; verify responsive behavior.');
  }

  return { failures, warnings };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Anti-AI-slop rules: a generic engine over an external rule table.
 *
 * The rule VALUES live in craft/anti-ai-slop-rules.json, derived from
 * nexu-io/open-design (Apache-2.0) and attributed there and in manifest.json.
 * This script — the engine — is ours under the repo-root MIT LICENSE and
 * contains no rule values of its own. That is the licensing boundary, and it
 * also means the rule set is reviewable and editable without touching code.
 *
 * Severity is not exit code. P0 fails alongside the pre-existing structural
 * checks; P1/P2 report only. Upstream's own linter does not hard-block on P0
 * either — these are a quality signal for the agent, not a merge gate on
 * generated content.
 * ──────────────────────────────────────────────────────────────────────────── */

let slopRules = { rules: [] };
if (fs.existsSync(slopRulesPath)) {
  slopRules = JSON.parse(fs.readFileSync(slopRulesPath, 'utf8'));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clip = (s, n = 80) => {
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};

// Comments often carry pedagogical examples ("paste <section class=...> here")
// that would fire rules against markup the browser never renders.
const stripComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

// Global theme scopes where declaring a color IS the design system speaking:
// `:root`, `html`, and bare `[data-theme="..."]`. A component-local
// `.cta { --cta-bg: #6366f1 }` stays in scope, so indigo laundered through a
// local custom property is still caught.
const stripGlobalTokenBlocks = (html) =>
  html.replace(/(?::root|(?<![\w.#-])html|\[data-theme[^\]]*\])[^{}]*\{[^}]*\}/gi, '');

function gradientBodies(html) {
  return [...html.matchAll(/linear-gradient\(([^)]*)\)/gi)];
}

function sideMatch(body, hexes, keywords) {
  const lower = body.toLowerCase();
  for (const hex of hexes ?? []) {
    if (lower.includes(hex.toLowerCase())) return hex;
  }
  for (const kw of keywords ?? []) {
    if (new RegExp(`\\b${escapeRe(kw)}\\b`, 'i').test(body)) return kw;
  }
  return null;
}

function evaluateRule(rule, html) {
  switch (rule.kind) {
    case 'gradientContainsAny': {
      for (const m of gradientBodies(html)) {
        const hit = sideMatch(m[1], rule.hexes, rule.keywords);
        if (hit) return { match: hit, snippet: clip(m[0]) };
      }
      return null;
    }
    case 'gradientContainsPair': {
      for (const m of gradientBodies(html)) {
        const a = sideMatch(m[1], rule.hexesA, rule.keywordsA);
        const b = sideMatch(m[1], rule.hexesB, rule.keywordsB);
        if (a && b) return { match: `${a} → ${b}`, snippet: clip(m[0]) };
      }
      return null;
    }
    case 'literalAny': {
      const hay = rule.scope === 'outsideGlobalTokenBlocks' ? stripGlobalTokenBlocks(html) : html;
      const lower = hay.toLowerCase();
      for (const v of rule.values ?? []) {
        if (lower.includes(v.toLowerCase())) return { match: v, snippet: v };
      }
      return null;
    }
    case 'emojiInElement': {
      const tags = (rule.elements ?? []).map(escapeRe).join('|');
      for (const e of rule.emoji ?? []) {
        if (!html.includes(e)) continue;
        const m = new RegExp(`<(?:${tags})\\b[^>]*>[^<]*${escapeRe(e)}`, 'i').exec(html);
        if (m) return { match: e, snippet: clip(m[0]) };
      }
      return null;
    }
    case 'emojiInClass': {
      const cls = escapeRe(rule.classSubstring ?? 'icon');
      for (const e of rule.emoji ?? []) {
        if (!html.includes(e)) continue;
        const m = new RegExp(
          `<[a-z][a-z0-9-]*\\b[^>]*class=["'][^"']*${cls}[^"']*["'][^>]*>[^<]*${escapeRe(e)}`,
          'i'
        ).exec(html);
        if (m) return { match: e, snippet: clip(m[0]) };
      }
      return null;
    }
    case 'regexAny': {
      for (const p of rule.patterns ?? []) {
        const m = new RegExp(p, 'i').exec(html);
        if (m) return { match: clip(m[0], 60), snippet: clip(m[0]) };
      }
      return null;
    }
    case 'countHexOutsideRoot': {
      const style = /<style[^>]*>([\s\S]*?)<\/style>/i.exec(html);
      if (!style) return null;
      const css = (style[1] ?? '').replace(/:root\s*\{[^}]*\}/g, '');
      const hexes = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
      if (hexes.length <= (rule.threshold ?? 12)) return null;
      return { count: hexes.length, snippet: hexes.slice(0, 6).join(' ') };
    }
    case 'countLiteralOutsideStyle': {
      const stripped = html.replace(/<style[\s\S]*?<\/style>/gi, '');
      const n = stripped.split(rule.value).length - 1;
      if (n <= (rule.threshold ?? 6)) return null;
      return { count: n, snippet: rule.value };
    }
    default:
      return null;
  }
}

function fill(template, hit) {
  return String(template ?? '')
    .replaceAll('{match}', hit.match ?? '')
    .replaceAll('{count}', String(hit.count ?? ''));
}

function evaluateSlopRules(rawContent) {
  const html = stripComments(rawContent);
  const findings = [];
  for (const rule of slopRules.rules ?? []) {
    if ((rule.suppressedBy ?? []).some((id) => findings.some((f) => f.id === id))) continue;
    const hit = evaluateRule(rule, html);
    if (!hit) continue;
    findings.push({
      id: rule.id,
      severity: rule.severity ?? 'P2',
      message: fill(rule.message, hit),
      fix: fill(rule.fix, hit),
      snippet: hit.snippet ?? ''
    });
  }
  const order = { P0: 0, P1: 1, P2: 2 };
  return findings.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
}

function formatFinding(f) {
  const parts = [`[${f.severity}] ${f.id} — ${f.message}`];
  if (f.fix) parts.push(`→ ${f.fix}`);
  return parts.join(' ');
}

function checkProfileGates(content, profile) {
  if (!profile) return { failures: [], warnings: [] };

  const failures = [];
  const warnings = [];

  const sectionCount = (content.match(/<section\b/gi) || []).length;
  if (typeof profile.minSectionCount === 'number' && sectionCount < profile.minSectionCount) {
    failures.push(`Expected at least ${profile.minSectionCount} <section> blocks, found ${sectionCount}.`);
  }

  if (profile.mustHaveH1 && !hasRegex(content, /<h1\b[^>]*>[^<]+<\/h1>/i)) {
    failures.push('Expected an <h1> for this skill profile.');
  }

  if (profile.mustHaveCta && !hasRegex(content, /<(a|button)\b[^>]*>([^<]{2,})<\/(a|button)>/i)) {
    failures.push('Expected at least one CTA element (<a> or <button>).');
  }

  if (Array.isArray(profile.requiredAny) && profile.requiredAny.length > 0) {
    const normalized = content.toLowerCase();
    const foundAny = profile.requiredAny.some((token) => normalized.includes(token.toLowerCase()));
    if (!foundAny) {
      failures.push(`Expected one of profile keywords: ${profile.requiredAny.join(', ')}.`);
    }
  }

  if (!hasRegex(content, /aria-|role=|alt=/i)) {
    warnings.push('No accessibility attributes detected (aria/role/alt).');
  }

  return { failures, warnings };
}

const args = parseArgs(process.argv);
const targets = args.files.length > 0 ? args.files : ['.'];
const files = collectHtmlFiles(targets);

if (files.length === 0) {
  console.error('No HTML files found for quality gate evaluation.');
  process.exit(2);
}

let gates = { profiles: {}, skills: {} };
if (fs.existsSync(gatesPath)) {
  gates = JSON.parse(fs.readFileSync(gatesPath, 'utf8'));
}

const explicitProfileName = args.skill ? gates.skills?.[args.skill] : '';
const explicitProfile = explicitProfileName ? (gates.profiles?.[explicitProfileName] ?? null) : null;

// gates.exempt maps a repo-relative HTML path to
//   { checks: [...], rules: [...], reason }.
// `checks` matches the message text of a structural check (the original
// mechanism). `rules` names anti-slop RULE IDS, so an exemption says which rule
// it silences rather than pattern-matching prose — the granularity the rule
// table makes possible. Every entry is a documented decision, not a mute button.
const exemptions = gates.exempt ?? {};

/**
 * Two different questions, two different scopes.
 *
 * `profileGate` — minSectionCount / mustHaveH1 / mustHaveCta / requiredAny —
 * are ACCEPTANCE CRITERIA for a finished deliverable produced for a stated
 * skill. They only apply when the caller names the skill (`--skill`), which is
 * how an agent invokes this on its own output. A directory sweep over the pack
 * is looking at seeds and reference examples, not deliverables, so it must not
 * hold them to deliverable criteria.
 *
 * `categoryProfile` carries the one fact that IS true of a seed as much as a
 * deliverable: what kind of surface this skill produces. A sprite sheet or a
 * wireframe canvas is not a document, so `requireSemanticLayout:false` applies
 * to its template just as much as to its finished output. That flag is read
 * from the profile inferred from the file's path even in sweep mode.
 */
function resolveProfiles(file) {
  if (args.skill) {
    return {
      profileName: explicitProfileName,
      categoryProfile: explicitProfile,
      profileGate: explicitProfile
    };
  }
  const skill = inferSkillFromPath(file);
  const name = skill ? gates.skills?.[skill] : '';
  return {
    profileName: name,
    categoryProfile: name ? (gates.profiles?.[name] ?? null) : null,
    profileGate: null
  };
}

let failedFiles = 0;
let exemptedChecks = 0;
console.log('HTML Skill Quality Gate Report');
console.log(
  `Skill: ${args.skill || 'not set (sweep: generic gates only, category profile inferred per file)'}${explicitProfileName ? ` (${explicitProfileName})` : ''}`
);
console.log('');

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  const { profileName, categoryProfile, profileGate } = resolveProfiles(file);

  const generic = checkGenericGates(content, categoryProfile);
  const prof = checkProfileGates(content, profileGate);

  const rel = path.relative(process.cwd(), file) || file;
  const gateRel = path.relative(root, file).split(path.sep).join('/');
  const exempt = exemptions[gateRel];
  const exemptChecks = exempt?.checks ?? [];
  const exemptRules = exempt?.rules ?? [];

  // P0 joins the structural failures; P1/P2 are advisories.
  const slop = evaluateSlopRules(content);
  const slopFailures = [];
  const slopAdvisories = [];
  for (const f of slop) {
    if (exemptRules.includes(f.id)) {
      exemptedChecks += 1;
      continue;
    }
    (f.severity === 'P0' ? slopFailures : slopAdvisories).push(formatFinding(f));
  }

  const kept = [];
  for (const f of [...generic.failures, ...prof.failures, ...slopFailures]) {
    const matched = exemptChecks.find((c) => f.startsWith(c) || f.includes(c));
    if (matched) {
      exemptedChecks += 1;
      continue;
    }
    kept.push(f);
  }

  const failures = kept;
  const warnings = [...slopAdvisories, ...generic.warnings, ...prof.warnings];

  if (failures.length > 0) {
    failedFiles += 1;
    console.log(`FAIL ${rel}${profileName ? ` [${profileName}]` : ''}`);
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
  } else {
    console.log(`PASS ${rel}${profileName ? ` [${profileName}]` : ''}`);
  }

  if (exempt) {
    console.log(`  ~ exempt: ${exempt.reason}`);
  }
  for (const w of warnings) {
    console.log(`  ! ${w}`);
  }
}

console.log('');
if (exemptedChecks > 0) {
  console.log(
    `${exemptedChecks} check(s) suppressed by documented exemptions in workflow-skills/quality-gates.json.`
  );
}
if (failedFiles > 0) {
  console.error(`Quality gate failed on ${failedFiles}/${files.length} file(s).`);
  process.exit(1);
}

console.log(`Quality gate passed on ${files.length}/${files.length} file(s).`);
