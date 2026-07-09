#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

const agentSpecs = [
  {
    name: 'build',
    runtimePath: 'runtime/agents/build.md',
    adapterPath: 'adapters/agents/build.agent.md',
    tools: ['codebase', 'editFiles', 'runCommands', 'readFile', 'findTestFailures'],
  },
  {
    name: 'deep-thinker',
    runtimePath: 'runtime/agents/deep-thinker.md',
    adapterPath: 'adapters/agents/deep-thinker.agent.md',
    tools: ['codebase', 'readFile'],
  },
  {
    name: 'design-engineer',
    runtimePath: 'runtime/agents/design-engineer.md',
    adapterPath: 'adapters/agents/design-engineer.agent.md',
    tools: ['codebase', 'readFile', 'editFiles', 'runCommands'],
  },
  {
    name: 'execution-orchestrator',
    runtimePath: 'runtime/agents/execution-orchestrator.md',
    adapterPath: 'adapters/agents/execution-orchestrator.agent.md',
    tools: ['codebase', 'editFiles', 'runCommands', 'readFile', 'findTestFailures'],
  },
  {
    name: 'fast-build',
    runtimePath: 'runtime/agents/fast-build.md',
    adapterPath: 'adapters/agents/fast-build.agent.md',
    tools: ['codebase', 'editFiles', 'runCommands', 'readFile', 'findTestFailures'],
  },
  {
    name: 'incident-commander',
    runtimePath: 'runtime/agents/incident-commander.md',
    adapterPath: 'adapters/agents/incident-commander.agent.md',
    tools: ['codebase', 'editFiles', 'runCommands', 'readFile'],
  },
  {
    name: 'plan',
    runtimePath: 'runtime/agents/plan.md',
    adapterPath: 'adapters/agents/plan.agent.md',
    tools: ['codebase', 'readFile', 'runCommands'],
  },
  {
    name: 'release-manager',
    runtimePath: 'runtime/agents/release-manager.md',
    adapterPath: 'adapters/agents/release-manager.agent.md',
    tools: ['codebase', 'editFiles', 'runCommands', 'readFile', 'findTestFailures'],
  },
];

const generatedBanner = '<!-- Generated from runtime/agents/*.md by scripts/sync-vscode-agents.mjs. Do not edit by hand. -->';

function parseArgs(argv) {
  return {
    check: argv.includes('--check'),
    write: argv.includes('--write') || !argv.includes('--check'),
  };
}

function splitFrontmatter(content, filePath) {
  if (!content.startsWith('---\n')) {
    throw new Error(`Missing YAML frontmatter: ${filePath}`);
  }

  const end = content.indexOf('\n---\n', 4);
  if (end === -1) {
    throw new Error(`Unterminated YAML frontmatter: ${filePath}`);
  }

  return {
    frontmatter: content.slice(4, end),
    body: content.slice(end + 5).replace(/^\n+/, ''),
  };
}

function readScalar(frontmatter, fieldName) {
  const match = frontmatter.match(new RegExp(`^${fieldName}:\\s*(.+)$`, 'm'));
  if (!match) {
    throw new Error(`Missing '${fieldName}' in runtime frontmatter`);
  }

  return match[1].trim();
}

function renderAdapter(frontmatter, body, spec) {
  const name = readScalar(frontmatter, 'name');
  const description = readScalar(frontmatter, 'description');

  return [
    '---',
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description)}`,
    'tools:',
    ...spec.tools.map((tool) => `  - ${tool}`),
    '---',
    '',
    generatedBanner,
    '',
    body.trimStart(),
  ].join('\n').replace(/\s*$/, '\n');
}

async function syncAgent(spec, options) {
  const runtimeAbs = path.join(repoRoot, spec.runtimePath);
  const adapterAbs = path.join(repoRoot, spec.adapterPath);
  const runtimeContent = await fs.readFile(runtimeAbs, 'utf8');
  const { frontmatter, body } = splitFrontmatter(runtimeContent, runtimeAbs);
  const nextContent = renderAdapter(frontmatter, body, spec);

  let currentContent = null;
  try {
    currentContent = await fs.readFile(adapterAbs, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code !== 'ENOENT') {
      throw error;
    }
  }

  const changed = currentContent !== nextContent;
  if (options.write && changed) {
    await fs.writeFile(adapterAbs, nextContent, 'utf8');
  }

  return { ...spec, changed };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const results = [];

  for (const spec of agentSpecs) {
    results.push(await syncAgent(spec, options));
  }

  const changed = results.filter((result) => result.changed);
  if (options.check && changed.length > 0) {
    console.error('VS Code agent mirrors are out of sync with runtime agents:');
    for (const result of changed) {
      console.error(`- ${result.adapterPath}`);
    }
    process.exitCode = 1;
    return;
  }

  const verb = options.check ? 'verified' : 'synced';
  for (const result of results) {
    console.log(`[xx-stack] ${verb}: ${result.adapterPath}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});