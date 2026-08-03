#!/usr/bin/env node
/**
 * Generate the VS Code agent mirrors under adapters/agents/ from the canonical
 * agents in runtime/agents/.
 *
 * The expected set is DERIVED by reading runtime/agents/ — it is never a
 * hardcoded list. That is the whole point: adding a canonical agent must fail
 * `npm run agents:check` until the agent is either mirrored (run
 * `npm run agents:sync`) or explicitly listed in NOT_MIRRORED below with a
 * reason. A hardcoded roster silently skips whatever it does not know about,
 * which is exactly how this check spent eleven agents reporting green.
 *
 * Same directory-derived pattern as scripts/check-rules-coverage.mjs.
 *
 * Exit 0 = mirrors current. Exit 1 = drift (or a stale/missing opt-out).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const agentsDir = path.join(repoRoot, "runtime", "agents");
const adaptersDir = path.join(repoRoot, "adapters", "agents");

/**
 * Canonical agents that deliberately get NO VS Code mirror. Each entry is a
 * decision, not a shrug — if you add one, say why.
 */
const NOT_MIRRORED = new Map([
  [
    "ping",
    "Runner health probe, not an agent persona: denies read/edit/bash/skill and echoes text.",
  ],
  [
    "planning",
    "Compatibility alias for the legacy 'planning' task type; `plan` is the mirrored agent.",
  ],
  [
    "researcher",
    "Compatibility alias for the legacy 'researcher' task type; `research` is the mirrored agent.",
  ],
]);

/**
 * Explicit VS Code tool lists for agents whose surface is not simply implied by
 * their runtime `permission` block — chiefly the build/test lanes that need
 * `findTestFailures`. Everything else is derived by toolsFor() below, so a new
 * agent picks up a sane default without touching this map.
 */
const TOOL_OVERRIDES = new Map([
  ["build", ["codebase", "editFiles", "runCommands", "readFile", "findTestFailures"]],
  ["deep-thinker", ["codebase", "readFile"]],
  ["design-engineer", ["codebase", "readFile", "editFiles", "runCommands"]],
  [
    "execution-orchestrator",
    ["codebase", "editFiles", "runCommands", "readFile", "findTestFailures"],
  ],
  ["fast-build", ["codebase", "editFiles", "runCommands", "readFile", "findTestFailures"]],
  ["incident-commander", ["codebase", "editFiles", "runCommands", "readFile"]],
  ["plan", ["codebase", "readFile", "runCommands"]],
  ["release-manager", ["codebase", "editFiles", "runCommands", "readFile", "findTestFailures"]],
  // Test/QA lanes: same reasoning as the build lanes above.
  ["qa-lead", ["codebase", "readFile", "runCommands", "findTestFailures"]],
  ["rust-rewrite", ["codebase", "editFiles", "runCommands", "readFile", "findTestFailures"]],
  ["model-trainer", ["codebase", "editFiles", "runCommands", "readFile", "findTestFailures"]],
  [
    "parallel-execution-orchestrator",
    ["codebase", "editFiles", "runCommands", "readFile", "findTestFailures"],
  ],
]);

const generatedBanner =
  "<!-- Generated from runtime/agents/*.md by scripts/sync-vscode-agents.mjs. Do not edit by hand. -->";

/**
 * Default tool surface, derived from the runtime frontmatter `permission`
 * block: everyone reads, `edit: deny` drops editFiles, `bash: deny` drops
 * runCommands.
 */
function toolsFor(name, frontmatter) {
  const override = TOOL_OVERRIDES.get(name);
  if (override) return override;

  const permissionOf = (field) => {
    const match = frontmatter.match(new RegExp(`^\\s{2}${field}:\\s*(\\S+)\\s*$`, "m"));
    return match ? match[1].trim() : "ask";
  };

  const tools = ["codebase", "readFile"];
  if (permissionOf("edit") !== "deny") tools.push("editFiles");
  if (permissionOf("bash") !== "deny") tools.push("runCommands");
  return tools;
}

function parseArgs(argv) {
  return {
    check: argv.includes("--check"),
    write: argv.includes("--write") || !argv.includes("--check"),
  };
}

/**
 * Read runtime/agents/ and build the expected mirror set. `*.nano.md` files are
 * derived variants of their canonical agent (see scripts/check-nano-tiers.mjs),
 * not separate agents, so they are skipped here.
 */
async function discoverAgents() {
  const entries = await fs.readdir(agentsDir, { withFileTypes: true });
  const names = entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.endsWith(".nano.md"))
    .filter((e) => !e.name.startsWith("."))
    .map((e) => e.name.replace(/\.md$/, ""))
    .sort();

  if (names.length === 0) {
    throw new Error(
      `No canonical agents found in ${agentsDir}. Refusing to report success on an empty agent tree.`
    );
  }

  return names;
}

function splitFrontmatter(content, filePath) {
  if (!content.startsWith("---\n")) {
    throw new Error(`Missing YAML frontmatter: ${filePath}`);
  }

  const end = content.indexOf("\n---\n", 4);
  if (end === -1) {
    throw new Error(`Unterminated YAML frontmatter: ${filePath}`);
  }

  return {
    frontmatter: content.slice(4, end),
    body: content.slice(end + 5).replace(/^\n+/, ""),
  };
}

function readScalar(frontmatter, fieldName) {
  const match = frontmatter.match(new RegExp(`^${fieldName}:\\s*(.+)$`, "m"));
  if (!match) {
    throw new Error(`Missing '${fieldName}' in runtime frontmatter`);
  }

  return match[1].trim();
}

function renderAdapter(frontmatter, body, tools) {
  const name = readScalar(frontmatter, "name");
  const description = readScalar(frontmatter, "description");

  return [
    "---",
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description)}`,
    "tools:",
    ...tools.map((tool) => `  - ${tool}`),
    "---",
    "",
    generatedBanner,
    "",
    body.trimStart(),
  ]
    .join("\n")
    .replace(/\s*$/, "\n");
}

async function syncAgent(spec, options) {
  const runtimeAbs = path.join(repoRoot, spec.runtimePath);
  const adapterAbs = path.join(repoRoot, spec.adapterPath);
  const runtimeContent = await fs.readFile(runtimeAbs, "utf8");
  const { frontmatter, body } = splitFrontmatter(runtimeContent, runtimeAbs);
  const nextContent = renderAdapter(frontmatter, body, toolsFor(spec.name, frontmatter));

  let currentContent = null;
  try {
    currentContent = await fs.readFile(adapterAbs, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") {
      throw error;
    }
  }

  const changed = currentContent !== nextContent;
  const missing = currentContent === null;
  if (options.write && changed) {
    await fs.mkdir(path.dirname(adapterAbs), { recursive: true });
    await fs.writeFile(adapterAbs, nextContent, "utf8");
  }

  return { ...spec, changed, missing };
}

async function listAdapterMirrors() {
  try {
    const entries = await fs.readdir(adaptersDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".agent.md"))
      .map((e) => e.name.replace(/\.agent\.md$/, ""));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const canonical = await discoverAgents();
  const problems = [];

  // A NOT_MIRRORED entry for an agent that no longer exists is a stale opt-out:
  // it would silently swallow a future agent that reuses the name.
  for (const name of NOT_MIRRORED.keys()) {
    if (!canonical.includes(name)) {
      problems.push(`stale NOT_MIRRORED opt-out: "${name}" has no runtime/agents/${name}.md`);
    }
  }

  const specs = canonical
    .filter((name) => !NOT_MIRRORED.has(name))
    .map((name) => ({
      name,
      runtimePath: `runtime/agents/${name}.md`,
      adapterPath: `adapters/agents/${name}.agent.md`,
    }));

  // An adapter file with no canonical source is an orphan mirror.
  const expectedMirrors = new Set(specs.map((s) => s.name));
  for (const name of await listAdapterMirrors()) {
    if (!expectedMirrors.has(name)) {
      const reason = NOT_MIRRORED.get(name);
      problems.push(
        reason
          ? `orphan mirror: adapters/agents/${name}.agent.md exists but "${name}" is in NOT_MIRRORED (${reason})`
          : `orphan mirror: adapters/agents/${name}.agent.md has no runtime/agents/${name}.md`
      );
    }
  }

  const results = [];
  for (const spec of specs) {
    results.push(await syncAgent(spec, options));
  }

  const changed = results.filter((result) => result.changed);
  if (options.check && (changed.length > 0 || problems.length > 0)) {
    console.error("VS Code agent mirrors are out of sync with runtime agents:");
    for (const result of changed) {
      console.error(`- ${result.adapterPath}${result.missing ? "  (missing)" : ""}`);
    }
    for (const problem of problems) {
      console.error(`- ${problem}`);
    }
    console.error("");
    console.error("Run `npm run agents:sync`, or add a NOT_MIRRORED entry with a reason in");
    console.error(
      "scripts/sync-vscode-agents.mjs if the agent deliberately has no VS Code mirror."
    );
    process.exitCode = 1;
    return;
  }

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`[xx-stack] warning: ${problem}`);
    }
  }

  const verb = options.check ? "verified" : "synced";
  for (const result of results) {
    console.log(`[xx-stack] ${verb}: ${result.adapterPath}`);
  }
  console.log(
    `[xx-stack] ${results.length} mirror(s) ${verb}; ${NOT_MIRRORED.size} agent(s) opted out; ` +
      `${canonical.length} canonical agent(s) accounted for.`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
