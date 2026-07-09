#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const gatesPath = path.join(root, 'packs', 'design', 'runtime', 'skills', 'design', 'quality-gates.json');

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

function checkGenericGates(content) {
  const failures = [];
  const warnings = [];

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
      pass: hasRegex(content, /<(main|section|header|footer|article|nav)\b/i),
      message: 'No semantic layout tags found.'
    },
    {
      name: 'noExternalStyles',
      pass: !hasRegex(content, /<link[^>]+href=["']https?:\/\//i),
      message: 'External stylesheet detected; expected self-contained artifact.'
    },
    {
      name: 'noExternalScripts',
      pass: !hasRegex(content, /<script[^>]+src=["']https?:\/\//i),
      message: 'External script detected; expected self-contained artifact.'
    }
  ];

  for (const c of checks) {
    if (!c.pass) failures.push(c.message);
  }

  if (hasRegex(content, /linear-gradient\([^)]*(#6a0dad|#8a2be2|purple)/i)) {
    warnings.push('Potential purple-gradient anti-pattern detected.');
  }
  if (hasRegex(content, /[\u{1F300}-\u{1FAFF}]/u)) {
    warnings.push('Emoji characters detected; ensure they are not primary UI icons.');
  }
  if (!hasRegex(content, /@media\s*\(/i)) {
    warnings.push('No @media query found; verify responsive behavior.');
  }

  return { failures, warnings };
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

const profileName = args.skill ? gates.skills?.[args.skill] : '';
const profile = profileName ? gates.profiles?.[profileName] : null;

let failedFiles = 0;
console.log('HTML Skill Quality Gate Report');
console.log(`Skill: ${args.skill || 'not set'}${profileName ? ` (${profileName})` : ''}`);
console.log('');

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');

  const generic = checkGenericGates(content);
  const prof = checkProfileGates(content, profile);

  const failures = [...generic.failures, ...prof.failures];
  const warnings = [...generic.warnings, ...prof.warnings];

  const rel = path.relative(process.cwd(), file) || file;
  if (failures.length > 0) {
    failedFiles += 1;
    console.log(`FAIL ${rel}`);
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
  } else {
    console.log(`PASS ${rel}`);
  }

  for (const w of warnings) {
    console.log(`  ! ${w}`);
  }
}

console.log('');
if (failedFiles > 0) {
  console.error(`Quality gate failed on ${failedFiles}/${files.length} file(s).`);
  process.exit(1);
}

console.log(`Quality gate passed on ${files.length}/${files.length} file(s).`);
