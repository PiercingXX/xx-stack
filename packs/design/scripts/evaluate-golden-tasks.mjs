#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const designPackRoot = path.join(root, 'packs', 'design');
const tasksPath = path.join(designPackRoot, 'evals', 'golden-tasks', 'tasks.json');
const responsesDirArg = process.argv[2];
const responsesDir = responsesDirArg
  ? path.resolve(process.cwd(), responsesDirArg)
  : path.join(designPackRoot, 'evals', 'golden-tasks', 'responses');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function containsCaseInsensitive(haystack, needle) {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function countWords(text) {
  return (text.match(/\b[\p{L}\p{N}_-]+\b/gu) || []).length;
}

function countNonEmptyLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean).length;
}

function normalizeRegexRule(rule, defaultMessage) {
  if (typeof rule === 'string') {
    return {
      pattern: rule,
      flags: 'i',
      message: defaultMessage.replace('%s', rule)
    };
  }

  return {
    pattern: rule.pattern,
    flags: rule.flags || '',
    message: rule.message || defaultMessage.replace('%s', rule.pattern)
  };
}

function checkRegexRules(content, rules, invert, checksState) {
  for (const rawRule of rules || []) {
    const rule = normalizeRegexRule(
      rawRule,
      invert ? 'contains forbidden pattern /%s/' : 'missing required pattern /%s/'
    );
    const regex = new RegExp(rule.pattern, rule.flags);
    const matched = regex.test(content);

    checksState.checks += 1;
    if ((!invert && matched) || (invert && !matched)) {
      checksState.passed += 1;
    } else {
      checksState.problems.push(rule.message);
    }
  }
}

function checkOrderedSubstrings(content, task, checksState) {
  if (!Array.isArray(task.orderedSubstrings) || task.orderedSubstrings.length === 0) {
    return;
  }

  const normalized = content.toLowerCase();
  let lastIndex = -1;

  checksState.checks += 1;
  for (const token of task.orderedSubstrings) {
    const index = normalized.indexOf(token.toLowerCase(), lastIndex + 1);
    if (index === -1 || index < lastIndex) {
      checksState.problems.push(`ordered sequence violated at \"${token}\"`);
      return;
    }
    lastIndex = index;
  }

  checksState.passed += 1;
}

function checkHeadings(content, task, checksState) {
  for (const heading of task.requiredHeadings || []) {
    checksState.checks += 1;
    if (containsCaseInsensitive(content, heading)) {
      checksState.passed += 1;
    } else {
      checksState.problems.push(`missing required heading \"${heading}\"`);
    }
  }
}

function checkMinimums(content, task, checksState) {
  if (typeof task.minimumWordCount === 'number') {
    const wordCount = countWords(content);
    checksState.checks += 1;
    if (wordCount >= task.minimumWordCount) {
      checksState.passed += 1;
    } else {
      checksState.problems.push(`word count ${wordCount} below minimum ${task.minimumWordCount}`);
    }
  }

  if (typeof task.minimumNonEmptyLines === 'number') {
    const lineCount = countNonEmptyLines(content);
    checksState.checks += 1;
    if (lineCount >= task.minimumNonEmptyLines) {
      checksState.passed += 1;
    } else {
      checksState.problems.push(`non-empty line count ${lineCount} below minimum ${task.minimumNonEmptyLines}`);
    }
  }
}

if (!fs.existsSync(tasksPath)) {
  console.error(`Missing tasks file: ${tasksPath}`);
  process.exit(2);
}

if (!fs.existsSync(responsesDir)) {
  console.error(`Missing responses directory: ${responsesDir}`);
  process.exit(2);
}

const spec = readJson(tasksPath);
const results = [];

for (const task of spec.tasks || []) {
  const responsePath = path.join(responsesDir, `${task.id}.md`);
  if (!fs.existsSync(responsePath)) {
    results.push({
      id: task.id,
      agent: task.agent,
      status: 'FAIL',
      score: 0,
      checks: 0,
      passed: 0,
      message: `Missing response file ${path.relative(root, responsePath)}`
    });
    continue;
  }

  const content = fs.readFileSync(responsePath, 'utf8');
  const checksState = {
    checks: 0,
    passed: 0,
    problems: []
  };

  for (const token of task.mustInclude || []) {
    checksState.checks += 1;
    if (containsCaseInsensitive(content, token)) {
      checksState.passed += 1;
    } else {
      checksState.problems.push(`missing required token \"${token}\"`);
    }
  }

  for (const token of task.mustNotInclude || []) {
    checksState.checks += 1;
    if (containsCaseInsensitive(content, token)) {
      checksState.problems.push(`contains forbidden token \"${token}\"`);
    } else {
      checksState.passed += 1;
    }
  }

  checkHeadings(content, task, checksState);
  checkOrderedSubstrings(content, task, checksState);
  checkRegexRules(content, task.requiredRegex, false, checksState);
  checkRegexRules(content, task.forbiddenRegex, true, checksState);
  checkMinimums(content, task, checksState);

  const score = checksState.checks === 0 ? 100 : Math.round((checksState.passed / checksState.checks) * 100);
  const status = checksState.problems.length === 0 ? 'PASS' : 'FAIL';

  results.push({
    id: task.id,
    agent: task.agent,
    status,
    score,
    checks: checksState.checks,
    passed: checksState.passed,
    message: checksState.problems.join('; ')
  });
}

console.log('Golden Task Evaluation Report');
console.log('');
console.log('| Task | Agent | Status | Score | Checks | Notes |');
console.log('|---|---|---|---:|---:|---|');
for (const r of results) {
  const notes = (r.message || 'OK').replace(/\|/g, '\\|');
  console.log(`| ${r.id} | ${r.agent} | ${r.status} | ${r.score}% | ${r.passed}/${r.checks} | ${notes} |`);
}

const failed = results.filter((r) => r.status !== 'PASS');
console.log('');
if (failed.length > 0) {
  console.error(`Golden tasks failed: ${failed.length}/${results.length}`);
  process.exit(1);
}

console.log(`Golden tasks passed: ${results.length}/${results.length}`);
