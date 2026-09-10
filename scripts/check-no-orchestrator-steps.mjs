#!/usr/bin/env node
/**
 * Regression guard: the two unattended orchestrators must NOT carry an
 * OpenCode `steps` key.
 *
 * OpenCode treats `steps` as a hard tool-call cap. When it's set, the runtime
 * injects CRITICAL-MAXIMUM-STEPS-REACHED at the cap, disables tools, and the
 * model spirals on the same handoff text because spawn/handoff is a tool. The
 * unattended orchestrators must run until the model stops, so they omit `steps`
 * entirely (never 0 or 99999) — in YAML frontmatter and in runtime/config.json.
 *
 * This fails CI if either orchestrator regains a `steps` key on the canonical
 * or the opencode mirror, or in either config.json.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORCHESTRATORS = ["execution-orchestrator", "parallel-execution-orchestrator"];

const failures = [];

function assertJsonConfig(path_, purpose) {
  const text = fs.readFileSync(path_, "utf8");
  const json = JSON.parse(text);
  for (const name of ORCHESTRATORS) {
    const agent = json.agent?.[name];
    if (!agent) {
      failures.push(`${path_} :: ${purpose} is missing agent entry "${name}"`);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(agent, "steps")) {
      failures.push(
        `${path_} :: ${purpose} agent "${name}" still declares "steps": ${JSON.stringify(agent.steps)}`
      );
    }
  }
}

function assertAgentFile(relPath) {
  const abs = path.join(repoRoot, relPath);
  const text = fs.readFileSync(abs, "utf8");
  if (!text.startsWith("---\n")) {
    failures.push(`${relPath} :: does not start with YAML frontmatter`);
    return;
  }
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) {
    failures.push(`${relPath} :: could not find the end of YAML frontmatter`);
    return;
  }
  const frontmatter = text.slice(4, end);
  const stepsMatch = /(^|\n)steps\s*:\s*\d+/.exec(frontmatter);
  if (stepsMatch) {
    failures.push(
      `${relPath} :: orchestrator frontmatter still declares "steps": ${stepsMatch[0].trim()}`
    );
  }
}

assertJsonConfig(path.join(repoRoot, "runtime/config.json"), "canonical config");
assertJsonConfig(
  path.join(repoRoot, "opencode-orchestration/opencode/config.json"),
  "opencode mirror config"
);

for (const name of ORCHESTRATORS) {
  assertAgentFile(`runtime/agents/${name}.md`);
  assertAgentFile(`opencode-orchestration/opencode/agents/${name}.md`);
}

console.log("orchestrator steps regression check");
console.log("");
if (failures.length === 0) {
  console.log(
    "PASS  execution-orchestrator and parallel-execution-orchestrator carry no `steps` key."
  );
} else {
  for (const f of failures) console.log(`FAIL  ${f}`);
  console.log("");
  console.log(`${failures.length} step-cap regression(s) found. An unattended orchestrator with`);
  console.log("a `steps` cap will be shut down mid-loop at the tool-call limit. Delete the key;");
  console.log("do not set it to 0 or 99999.");
}

process.exitCode = failures.length === 0 ? 0 : 1;
