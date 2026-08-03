#!/usr/bin/env node
/**
 * Generate the editor agent mirrors from each component's canonical agents.
 *
 * Both components ship the same shape — a canonical agent source dir and an
 * editor mirror dir — and `verify-repo-layout.mjs` already encodes the mapping:
 *
 *   xx-stack/                 runtime/agents  -> adapters/agents
 *   opencode-orchestration/   opencode/agents -> vscode/agents
 *
 * The opencode-orchestration mirror was hand-maintained with no sync and no
 * check for a long time, and drifted exactly the way you would expect: its
 * eight files were 20-45% shorter than their sources (build was missing ~50
 * lines), it covered 8 of 18 agents, and even its frontmatter `description`
 * had gone stale. It is generated now, same as the xx-stack one.
 *
 * The expected set is DERIVED by reading each component's agent dir — it is
 * never a hardcoded list. That is the whole point: adding a canonical agent
 * must fail `npm run agents:check` until the agent is either mirrored (run
 * `npm run agents:sync`) or explicitly listed in that component's NOT_MIRRORED
 * with a reason. A hardcoded roster silently skips whatever it does not know
 * about, which is exactly how this check spent eleven agents reporting green.
 *
 * Same directory-derived pattern as scripts/check-rules-coverage.mjs.
 *
 * Exit 0 = mirrors current. Exit 1 = drift (or a stale/missing opt-out).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// opencode-orchestration/scripts is a symlink to xx-stack/scripts, so
// import.meta.url always resolves inside xx-stack/ no matter which component
// invoked this. Resolve the repo root and address components explicitly rather
// than guessing from cwd.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");

/**
 * Canonical agents in xx-stack/runtime/agents that deliberately get NO mirror.
 * Each entry is a decision, not a shrug — if you add one, say why.
 */
const XX_STACK_NOT_MIRRORED = new Map([
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
 * The components this script generates for. `agentsDir`/`mirrorDir` are
 * repo-relative so every message names a path you can paste into an editor.
 */
const COMPONENTS = [
  {
    name: "xx-stack",
    agentsDir: "xx-stack/runtime/agents",
    mirrorDir: "xx-stack/adapters/agents",
    notMirrored: XX_STACK_NOT_MIRRORED,
  },
  {
    name: "opencode-orchestration",
    agentsDir: "opencode-orchestration/opencode/agents",
    mirrorDir: "opencode-orchestration/vscode/agents",
    // The OpenCode source registers `plan`/`research` under their canonical
    // names and ships no `ping`, so nothing here needs an opt-out.
    notMirrored: new Map(),
  },
];

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

/** Banner names the component-relative source, e.g. `opencode/agents/*.md`. */
function generatedBannerFor(component) {
  const sourceLabel = component.agentsDir.split("/").slice(1).join("/");
  return `<!-- Generated from ${sourceLabel}/*.md by scripts/sync-vscode-agents.mjs. Do not edit by hand. -->`;
}

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
 * Read a component's agent dir and build the expected mirror set. `*.nano.md`
 * files are derived variants of their canonical agent (see
 * scripts/check-nano-tiers.mjs), not separate agents, so they are skipped here.
 */
async function discoverAgents(component) {
  const entries = await fs.readdir(path.join(repoRoot, component.agentsDir), {
    withFileTypes: true,
  });
  const names = entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.endsWith(".nano.md"))
    .filter((e) => !e.name.startsWith("."))
    .map((e) => e.name.replace(/\.md$/, ""))
    .sort();

  if (names.length === 0) {
    throw new Error(
      `No canonical agents found in ${component.agentsDir}. Refusing to report success on an empty agent tree.`
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

function readScalar(frontmatter, fieldName, filePath) {
  const match = frontmatter.match(new RegExp(`^${fieldName}:\\s*(.+)$`, "m"));
  if (!match) {
    throw new Error(`Missing '${fieldName}' in frontmatter: ${filePath}`);
  }

  return match[1].trim();
}

/**
 * The mirror carries name, description, tools and the full canonical body.
 * It deliberately does NOT carry the source's `model:` pin: those are OpenCode
 * provider ids (`sglang-remote/...`, `llama-cpp-local/...`) that mean nothing
 * to the VS Code / Copilot agent surface, and emitting them would ship a model
 * reference the host cannot resolve.
 */
function renderAdapter(frontmatter, body, tools, banner, filePath) {
  const name = readScalar(frontmatter, "name", filePath);
  const description = readScalar(frontmatter, "description", filePath);

  return [
    "---",
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description)}`,
    "tools:",
    ...tools.map((tool) => `  - ${tool}`),
    "---",
    "",
    banner,
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
  const nextContent = renderAdapter(
    frontmatter,
    body,
    toolsFor(spec.name, frontmatter),
    spec.banner,
    runtimeAbs
  );

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

async function listMirrors(component) {
  try {
    const entries = await fs.readdir(path.join(repoRoot, component.mirrorDir), {
      withFileTypes: true,
    });
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

async function syncComponent(component, options) {
  const canonical = await discoverAgents(component);
  const problems = [];

  // A NOT_MIRRORED entry for an agent that no longer exists is a stale opt-out:
  // it would silently swallow a future agent that reuses the name.
  for (const name of component.notMirrored.keys()) {
    if (!canonical.includes(name)) {
      problems.push(
        `stale NOT_MIRRORED opt-out: "${name}" has no ${component.agentsDir}/${name}.md`
      );
    }
  }

  const banner = generatedBannerFor(component);
  const specs = canonical
    .filter((name) => !component.notMirrored.has(name))
    .map((name) => ({
      name,
      banner,
      runtimePath: `${component.agentsDir}/${name}.md`,
      adapterPath: `${component.mirrorDir}/${name}.agent.md`,
    }));

  // A mirror file with no canonical source is an orphan.
  const expectedMirrors = new Set(specs.map((s) => s.name));
  for (const name of await listMirrors(component)) {
    if (!expectedMirrors.has(name)) {
      const reason = component.notMirrored.get(name);
      problems.push(
        reason
          ? `orphan mirror: ${component.mirrorDir}/${name}.agent.md exists but "${name}" is in NOT_MIRRORED (${reason})`
          : `orphan mirror: ${component.mirrorDir}/${name}.agent.md has no ${component.agentsDir}/${name}.md`
      );
    }
  }

  const results = [];
  for (const spec of specs) {
    results.push(await syncAgent(spec, options));
  }

  return { component, canonical, results, problems };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const reports = [];
  for (const component of COMPONENTS) {
    reports.push(await syncComponent(component, options));
  }

  const outOfSync = reports.filter(
    (r) => r.results.some((result) => result.changed) || r.problems.length > 0
  );

  if (options.check && outOfSync.length > 0) {
    console.error("Editor agent mirrors are out of sync with their canonical agents:");
    for (const report of outOfSync) {
      for (const result of report.results.filter((r) => r.changed)) {
        console.error(`- ${result.adapterPath}${result.missing ? "  (missing)" : ""}`);
      }
      for (const problem of report.problems) {
        console.error(`- [${report.component.name}] ${problem}`);
      }
    }
    console.error("");
    console.error("Run `npm run agents:sync`, or add a NOT_MIRRORED entry with a reason in");
    console.error("scripts/sync-vscode-agents.mjs if the agent deliberately has no editor mirror.");
    process.exitCode = 1;
    return;
  }

  for (const report of reports) {
    for (const problem of report.problems) {
      console.error(`[${report.component.name}] warning: ${problem}`);
    }
  }

  const verb = options.check ? "verified" : "synced";
  for (const report of reports) {
    for (const result of report.results) {
      console.log(`[${report.component.name}] ${verb}: ${result.adapterPath}`);
    }
    console.log(
      `[${report.component.name}] ${report.results.length} mirror(s) ${verb}; ` +
        `${report.component.notMirrored.size} agent(s) opted out; ` +
        `${report.canonical.length} canonical agent(s) accounted for.`
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
